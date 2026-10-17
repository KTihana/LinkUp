// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.DataInputStream
import java.io.DataOutputStream
import java.math.BigInteger
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManager
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import javax.net.ssl.X509KeyManager
import javax.security.auth.x500.X500Principal

/** Foreground, session-only sockets. Application authentication is done by the
 * signed nearby protocol; this class never interprets or stores application data.
 * TLS pins belong only to these sockets, never the app's HTTPS trust manager. */
internal class WifiLink(
  private val context: Context,
  private val emit: (String, Map<String, Any?>) -> Unit,
  private val privateNetwork: Boolean = false,
) {
  companion object {
    const val MAX_PACKET_BYTES = 128 * 1024
    private const val MAX_LINKS = 4
    private const val SESSION_MS = 15 * 60 * 1000L
    private const val CONNECT_MS = 10_000
    private const val READ_MS = 120_000

    /** Parse numeric IPv4 only, without DNS. No public Internet destinations. */
    internal fun localAddress(host: String): Inet4Address {
      require(host.length in 7..15 && host.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+"))) {
        "Nearby Wi-Fi needs a private numeric IPv4 address."
      }
      val pieces = host.split('.').map {
        require(it == "0" || !it.startsWith('0')) { "IPv4 addresses must use canonical decimal notation." }
        it.toInt().also { value -> require(value in 0..255) { "Invalid IPv4 address." } }
      }
      val (a, b, c, d) = pieces
      require((a == 10 || a == 172 && b in 16..31 || a == 192 && b == 168 ||
        a == 169 && b == 254 || a == 127) && d != 255 && !(a == 127 && b == 0 && c == 0 && d == 0)) {
        "Nearby Wi-Fi accepts private or loopback IPv4 addresses only."
      }
      return InetAddress.getByAddress(pieces.map { it.toByte() }.toByteArray()) as Inet4Address
    }
  }

  private data class Link(val socket: SSLSocket, val output: DataOutputStream)
  private val io = Executors.newFixedThreadPool(MAX_LINKS + 2)
  private val clock = Executors.newScheduledThreadPool(1)
  private val main = Handler(Looper.getMainLooper())
  private val generation = AtomicInteger(0)
  private val sends = AtomicInteger(0)
  private val links = ConcurrentHashMap<String, Link>()
  private val pendingSockets = ConcurrentHashMap<String, Socket>()
  private val pending = ConcurrentHashMap.newKeySet<CompletableFuture<*>>()
  private val guard = Any()
  private val kind = if (privateNetwork) "vpn" else "wifi"
  private val keyPrefix = if (privateNetwork) "linkup-vpn-session-" else "common-nearby-session-"
  @Volatile private var route: LinkUpVpnController.Route? = null
  private val vpnDown: () -> Unit = { stop() }
  @Volatile private var server: SSLServerSocket? = null
  @Volatile private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
  @Volatile private var alias: String? = null
  @Volatile private var expiry: ScheduledFuture<*>? = null

  init { if (privateNetwork) LinkUpVpnController.addDownListener(vpnDown) }

  fun startPrivateNetwork(): CompletableFuture<Map<String, Any?>> {
    check(privateNetwork)
    stop()
    val lease = LinkUpVpnController.route()
    route = lease
    val token = generation.get()
    val result = CompletableFuture<Map<String, Any?>>()
    pending.add(result)
    result.whenComplete { _, _ -> pending.remove(result) }
    io.execute {
      try {
        LinkUpVpnController.network(lease)
        result.complete(startServer(localAddress(lease.host), token))
      } catch (error: Exception) { failStart(token, result, error) }
    }
    return result
  }

  fun startWifi(hotspot: Boolean): CompletableFuture<Map<String, Any?>> {
    check(!privateNetwork)
    stop()
    val token = generation.get()
    val result = CompletableFuture<Map<String, Any?>>()
    pending.add(result)
    result.whenComplete { _, _ -> pending.remove(result) }
    if (!hotspot) {
      io.execute {
        try {
          val host = wifiAddress()
          result.complete(startServer(host, token))
        } catch (error: Exception) {
          failStart(token, result, error)
        }
      }
      return result
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      result.completeExceptionally(IllegalStateException("Creating a local hotspot needs Android 8 or newer."))
      return result
    }
    val before = interfaceAddresses()
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    // Timeout includes Android's reservation callback. A late callback is closed.
    val timeout = clock.schedule({
      failStart(token, result, IllegalStateException("Android did not start the hotspot in time."))
    }, 30, TimeUnit.SECONDS)
    result.whenComplete { _, _ -> timeout.cancel(false) }
    main.post {
      try {
        requireCurrent(token)
        wifi.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
          override fun onStarted(value: WifiManager.LocalOnlyHotspotReservation) {
            synchronized(guard) {
              if (generation.get() != token || result.isDone) {
                value.close()
                return
              }
              reservation = value
            }
            io.execute {
              try {
                val configuration = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                  value.softApConfiguration
                } else null
                @Suppress("DEPRECATION")
                val ssid = configuration?.ssid ?: value.wifiConfiguration?.SSID?.removeSurrounding("\"")
                @Suppress("DEPRECATION")
                val password = configuration?.passphrase ?: value.wifiConfiguration?.preSharedKey?.removeSurrounding("\"")
                require(!ssid.isNullOrEmpty() && ssid.toByteArray(Charsets.UTF_8).size <= 32 &&
                  !password.isNullOrEmpty() && password.length in 8..63) { "Android supplied an unsupported hotspot configuration." }
                val host = hotspotAddress(before, token)
                val session = startServer(host, token).toMutableMap()
                session["ssid"] = ssid
                session["password"] = password
                result.complete(session)
              } catch (error: Exception) {
                failStart(token, result, error)
              }
            }
          }
          override fun onFailed(reason: Int) {
            failStart(token, result, IllegalStateException("Android could not create the local hotspot (code $reason). Check Wi-Fi and hotspot settings."))
          }
          override fun onStopped() {
            if (generation.get() == token) {
              result.completeExceptionally(IllegalStateException("The local hotspot was stopped."))
              emit("error", mapOf("kind" to "wifi", "message" to "Android stopped the local hotspot."))
              stop()
            }
          }
        }, main)
      } catch (error: Exception) {
        failStart(token, result, error)
      }
    }
    return result
  }

  private fun failStart(token: Int, result: CompletableFuture<*>, error: Exception) {
    val failed = result.completeExceptionally(error)
    if (failed && generation.get() == token) stop()
  }

  private fun startServer(host: Inet4Address, token: Int): Map<String, Any?> {
    requireCurrent(token)
    val keyAlias = keyPrefix + UUID.randomUUID()
      val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val createdAt = System.currentTimeMillis()
    var listener: SSLServerSocket? = null
    try {
      // Remove orphaned session keys left after process termination. No identity
      // or vault key shares this module-specific alias prefix.
      synchronized(guard) {
        requireCurrent(token)
        keys.aliases().toList().filter { it.startsWith(keyPrefix) }.forEach { keys.deleteEntry(it) }
      }
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
        initialize(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .setCertificateSubject(X500Principal("CN=Common Nearby"))
          .setCertificateSerialNumber(BigInteger(128, SecureRandom()).add(BigInteger.ONE))
          .setCertificateNotBefore(Date(createdAt - 60_000))
          .setCertificateNotAfter(Date(createdAt + SESSION_MS))
          .build())
        generateKeyPair()
      }
      val certificate = keys.getCertificate(keyAlias) as X509Certificate
      certificate.checkValidity()
      certificate.verify(certificate.publicKey)
      val manager = object : X509KeyManager {
        override fun getCertificateChain(alias: String): Array<X509Certificate>? =
          if (alias == keyAlias) arrayOf(certificate) else null
        override fun getPrivateKey(alias: String): PrivateKey? =
          if (alias == keyAlias) keys.getKey(keyAlias, null) as PrivateKey else null
        override fun getClientAliases(keyType: String, issuers: Array<out Principal>?): Array<String>? = null
        override fun chooseClientAlias(keyType: Array<out String>, issuers: Array<out Principal>?, socket: Socket?): String? = null
        override fun getServerAliases(keyType: String, issuers: Array<out Principal>?): Array<String>? =
          if (keyType == "EC") arrayOf(keyAlias) else null
        override fun chooseServerAlias(keyType: String, issuers: Array<out Principal>?, socket: Socket?): String? =
          if (keyType == "EC") keyAlias else null
      }
      val tls = SSLContext.getInstance("TLS").apply { init(arrayOf<KeyManager>(manager), null, SecureRandom()) }
      listener = tls.serverSocketFactory.createServerSocket() as SSLServerSocket
      listener.enabledProtocols = listener.supportedProtocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.toTypedArray()
      require(listener.enabledProtocols.isNotEmpty()) { "TLS 1.2 is unavailable." }
      listener.needClientAuth = false
      listener.reuseAddress = false
      // Private-network hubs allow only this application protocol port.
      listener.bind(InetSocketAddress(host, if (privateNetwork) 47443 else 0), MAX_LINKS)
      synchronized(guard) {
        requireCurrent(token)
        server = listener
        alias = keyAlias
        expiry = clock.schedule({ if (generation.get() == token) stop() }, SESSION_MS, TimeUnit.MILLISECONDS)
      }
      val activeListener = listener
      io.execute { accept(activeListener, token) }
      val pin = MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
      return mapOf("host" to host.hostAddress, "port" to listener.localPort, "pin" to pin)
    } catch (error: Exception) {
      runCatching { listener?.close() }
      runCatching { keys.deleteEntry(keyAlias) }
      throw error
    }
  }

  private fun accept(listener: SSLServerSocket, token: Int) {
    while (generation.get() == token && !listener.isClosed) {
      val socket = try { listener.accept() as SSLSocket } catch (_: Exception) {
        if (generation.get() == token && !listener.isClosed) {
          emit("error", mapOf("kind" to kind, "message" to "The private connection listener stopped unexpectedly."))
          stop()
        }
        break
      }
      val id = "$kind:" + UUID.randomUUID()
      val accepted = synchronized(guard) {
        if (generation.get() != token || links.size + pendingSockets.size >= MAX_LINKS ||
          !isLocal(socket.inetAddress) || (privateNetwork && !allowedPrivatePeer(socket.inetAddress))) false
        else { pendingSockets[id] = socket; true }
      }
      if (!accepted) { runCatching { socket.close() }; continue }
      io.execute {
        try {
          socket.soTimeout = CONNECT_MS
          socket.startHandshake()
          attach(id, socket, token)
        } catch (_: Exception) {
          pendingSockets.remove(id)
          runCatching { socket.close() }
        }
      }
    }
  }

  fun connectWifi(host: String, port: Int, pin: String): CompletableFuture<String> {
    val address = localAddress(host)
    require(port in 1024..65535) { "Invalid nearby port." }
    require(!privateNetwork || port == 47443) { "Private network messaging requires port 47443." }
    require(pin.matches(Regex("[0-9a-f]{64}"))) { "Invalid nearby certificate fingerprint." }
    val expected = ByteArray(32) { index -> pin.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    val token = generation.get()
    if (privateNetwork) {
      val lease = LinkUpVpnController.route(host)
      synchronized(guard) {
        val current = route
        if (current != null) LinkUpVpnController.requireRoute(current)
        route = lease
      }
    }
    val id = "$kind:" + UUID.randomUUID()
    val socket = if (privateNetwork) {
      val lease = checkNotNull(route)
      Socket().also { raw ->
        try {
          // Bind to the VPN Network itself, not merely its source IP. Android
          // cannot reroute this socket through Wi-Fi/cellular after tunnel loss.
          LinkUpVpnController.network(lease).bindSocket(raw)
          raw.bind(InetSocketAddress(localAddress(lease.host), 0))
        } catch (error: Exception) { raw.close(); throw error }
      }
    } else matchingNetwork(address)?.socketFactory?.createSocket() ?: Socket()
    try {
      synchronized(guard) {
        require(links.size + pendingSockets.size < MAX_LINKS) { "Too many nearby connections." }
        pendingSockets[id] = socket
      }
    } catch (error: Exception) { socket.close(); throw error }
    val result = CompletableFuture<String>()
    pending.add(result)
    result.whenComplete { _, _ -> pending.remove(result) }
    io.execute {
      try {
        requireCurrent(token)
        socket.connect(InetSocketAddress(address, port), CONNECT_MS)
        val trust = object : X509TrustManager {
          override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
          override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw java.security.cert.CertificateException("Client certificates are unsupported.")
          override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            if (chain.size != 1) throw java.security.cert.CertificateException("Expected one pinned session certificate.")
            chain[0].checkValidity()
            val actual = MessageDigest.getInstance("SHA-256").digest(chain[0].encoded)
            if (!MessageDigest.isEqual(expected, actual)) throw java.security.cert.CertificateException("Nearby certificate fingerprint does not match the QR code.")
            chain[0].verify(chain[0].publicKey)
          }
        }
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), SecureRandom()) }
        val encrypted = tls.socketFactory.createSocket(socket, host, port, true) as SSLSocket
        synchronized(guard) {
          requireCurrent(token)
          require(pendingSockets.containsKey(id)) { "Nearby connection was canceled." }
          pendingSockets[id] = encrypted
        }
        encrypted.enabledProtocols = encrypted.supportedProtocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.toTypedArray()
        encrypted.soTimeout = CONNECT_MS
        encrypted.startHandshake()
        // Pin again after the handshake as well (including session resumption).
        val certificate = encrypted.session.peerCertificates.single() as X509Certificate
        certificate.checkValidity()
        require(MessageDigest.isEqual(expected, MessageDigest.getInstance("SHA-256").digest(certificate.encoded))) {
          "Nearby TLS certificate changed."
        }
        attach(id, encrypted, token)
        result.complete(id)
      } catch (error: Exception) {
        close(id)
        runCatching { socket.close() }
        result.completeExceptionally(error)
      }
    }
    return result
  }

  private fun attach(id: String, socket: SSLSocket, token: Int) {
    socket.soTimeout = READ_MS
    socket.tcpNoDelay = true
    synchronized(guard) {
      requireCurrent(token)
      require(pendingSockets.remove(id) != null) { "Nearby connection was canceled." }
      links[id] = Link(socket, DataOutputStream(socket.outputStream))
      // Keep connected/closed ordering atomic with stop(). A handshake finishing
      // during Stop must never emit connected after its link was already closed.
      emit("link", mapOf("linkId" to id, "state" to "connected", "kind" to kind))
    }
    io.execute {
      try {
        val input = DataInputStream(socket.inputStream)
        while (generation.get() == token && links.containsKey(id)) {
          // A total frame deadline also limits peers which trickle bytes just
          // before each individual socket read timeout.
          val deadline = clock.schedule({ close(id) }, READ_MS.toLong(), TimeUnit.MILLISECONDS)
          try {
            val size = input.readInt()
            require(size in 1..MAX_PACKET_BYTES) { "Invalid nearby frame length." }
            val buffer = ByteArray(size)
            input.readFully(buffer)
            val packet = Charsets.UTF_8.newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
              .decode(ByteBuffer.wrap(buffer)).toString()
            synchronized(guard) {
              requireCurrent(token)
              if (links.containsKey(id)) emit("packet", mapOf("linkId" to id, "payload" to packet))
            }
          } finally { deadline.cancel(false) }
        }
      } catch (_: Exception) {
        // Frames, EOF and idle timeout all close this link without logging data.
      } finally { close(id) }
    }
  }

  fun send(id: String, payload: String): CompletableFuture<Unit> {
    require(payload.length <= MAX_PACKET_BYTES) { "Nearby packet is too large." }
    val bytes = payload.toByteArray(Charsets.UTF_8)
    require(bytes.size in 1..MAX_PACKET_BYTES) { "Nearby packet is empty or too large." }
    val result = CompletableFuture<Unit>()
    val link = links[id] ?: return result.apply { completeExceptionally(IllegalStateException("Nearby connection is closed.")) }
    if (sends.incrementAndGet() > 8) {
      sends.decrementAndGet()
      return result.apply { completeExceptionally(IllegalStateException("Nearby send queue is full.")) }
    }
    // Socket SO_TIMEOUT affects reads only. A scheduled close bounds blocked writes.
    val timeout = clock.schedule({
      if (!result.isDone) { close(id); result.completeExceptionally(IllegalStateException("Nearby send timed out.")) }
    }, 15, TimeUnit.SECONDS)
    pending.add(result)
    result.whenComplete { _, _ -> timeout.cancel(false); pending.remove(result); sends.decrementAndGet() }
    io.execute {
      try {
        synchronized(link.output) {
          if (privateNetwork) LinkUpVpnController.requireRoute(checkNotNull(route))
          require(links[id] === link) { "Nearby connection is closed." }
          link.output.writeInt(bytes.size)
          link.output.write(bytes)
          link.output.flush()
        }
        result.complete(Unit)
      } catch (error: Exception) { close(id); result.completeExceptionally(error) }
    }
    return result
  }

  fun close(id: String) {
    synchronized(guard) {
      pendingSockets.remove(id)?.let { runCatching { it.close() } }
      links.remove(id)?.let {
        runCatching { it.socket.close() }
        emit("link", mapOf("linkId" to id, "state" to "closed", "kind" to kind))
      }
    }
  }

  fun stop() {
    synchronized(guard) {
      generation.incrementAndGet()
      route = null
      expiry?.cancel(false)
      expiry = null
      runCatching { server?.close() }
      server = null
      runCatching { reservation?.close() }
      reservation = null
      alias?.let { name -> runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(name) } }
      alias = null
      pendingSockets.keys.toList().forEach(::close)
      links.keys.toList().forEach(::close)
      pending.toList().forEach { it.completeExceptionally(IllegalStateException("Nearby Wi-Fi stopped.")) }
    }
  }

  fun destroy() { if (privateNetwork) LinkUpVpnController.removeDownListener(vpnDown); stop(); io.shutdownNow(); clock.shutdownNow() }
  private fun requireCurrent(token: Int) {
    check(generation.get() == token) { "Nearby operation was canceled." }
    if (privateNetwork) LinkUpVpnController.requireRoute(checkNotNull(route) { "Private network disconnected." })
  }
  private fun allowedPrivatePeer(address: InetAddress): Boolean = runCatching {
    val lease = checkNotNull(route)
    LinkUpVpnController.requireRoute(lease)
    "${address.hostAddress}/32" in lease.enrollment.peers
  }.getOrDefault(false)
  private fun isLocal(address: InetAddress): Boolean = address is Inet4Address && runCatching { localAddress(address.hostAddress!!); true }.getOrDefault(false)

  private fun wifiAddress(): Inet4Address {
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val candidates = manager.allNetworks.flatMap { network ->
      val capabilities = manager.getNetworkCapabilities(network)
      if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) {
        manager.getLinkProperties(network)?.linkAddresses.orEmpty().map { it.address }.filterIsInstance<Inet4Address>().filter(::isLocal)
      } else emptyList()
    }.distinct()
    require(candidates.size == 1) { "Join a Wi-Fi network with a private IPv4 address before starting Nearby Wi-Fi." }
    return candidates.single()
  }

  private fun interfaceAddresses(): Map<String, List<Inet4Address>> = NetworkInterface.getNetworkInterfaces().toList()
    .filter { it.isUp && !it.isLoopback }.associate { network ->
      network.name to network.inetAddresses.toList().filterIsInstance<Inet4Address>().filter(::isLocal)
    }

  private fun hotspotAddress(before: Map<String, List<Inet4Address>>, token: Int): Inet4Address {
    val station = runCatching { wifiAddress() }.getOrNull()
    repeat(50) {
      requireCurrent(token)
      val current = interfaceAddresses()
      // Binding 0.0.0.0 could expose the listener through other networks. Require
      // an identifiable AP interface; unfamiliar OEM layouts fail explicitly.
      val apAddresses = current.filterKeys { name -> name.matches(Regex("(?i)(wlan|wifi|swlan|ap|softap|br).*")) }
        .values.flatten().filter { it != station }.distinct()
      val newlyAssigned = apAddresses.filter { address -> before.values.flatten().none { it == address } }
      if (newlyAssigned.size == 1) return newlyAssigned.single()
      Thread.sleep(100)
    }
    throw IllegalStateException("The hotspot started, but its local interface could not be identified safely on this phone.")
  }

  private fun matchingNetwork(address: Inet4Address): Network? {
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    // A VPN's routing/kill-switch policy belongs to the user. Never bind a
    // Wi-Fi socket around an active VPN merely to make local delivery work.
    if (manager.allNetworks.any { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }) return null
    return manager.allNetworks.firstOrNull { network ->
      val capabilities = manager.getNetworkCapabilities(network)
      val properties = manager.getLinkProperties(network)
      capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true &&
        properties?.routes?.any { route -> route.destination.prefixLength > 0 && route.destination.contains(address) } == true
    }
  }
}
