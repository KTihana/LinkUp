// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import com.wireguard.config.InetEndpoint
import com.wireguard.config.InetNetwork
import com.wireguard.config.Interface
import com.wireguard.config.Peer
import com.wireguard.crypto.Key
import com.wireguard.crypto.KeyPair
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** One serialized owner for the in-process WireGuard backend. Never auto-starts. */
internal object LinkUpVpnController {
  val executor = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }
  private val generation = AtomicLong()
  private val listeners = CopyOnWriteArraySet<(Map<String, Any>) -> Unit>()
  private val downListeners = CopyOnWriteArraySet<() -> Unit>()
  private var context: Context? = null
  private var backend: GoBackend? = null
  private var expiry: ScheduledFuture<*>? = null
  private var publicKey: String? = null
  private var identity: String? = null
  @Volatile private var enrollment: VpnEnrollment? = null
  @Volatile var connected = false; private set
  @Volatile var connecting = false; private set
  private val tunnel = object : Tunnel {
    override fun getName() = "LinkUp"
    override fun onStateChange(state: Tunnel.State) {
      connected = state == Tunnel.State.UP
      if (!connected) {
        connecting = false
        // Service revocation and process lifecycle are authoritative, even if
        // React is paused or has not observed the Android activity change.
        generation.incrementAndGet()
        downListeners.forEach { runCatching { it() } }
        context?.stopService(Intent(context, LinkUpVpnService::class.java))
      }
      executor.execute { if (!connected) { expiry?.cancel(false); expiry = null }; emit() }
    }
  }

  fun prepare(c: Context) { if (context == null) context = c.applicationContext }
  private fun ctx() = checkNotNull(context)
  private fun store() = LinkUpVpnStore(ctx())
  fun addListener(listener: (Map<String, Any>) -> Unit) { listeners.add(listener) }
  fun removeListener(listener: (Map<String, Any>) -> Unit) { listeners.remove(listener) }
  fun addDownListener(listener: () -> Unit) { downListeners.add(listener) }
  fun removeDownListener(listener: () -> Unit) { downListeners.remove(listener) }
  private fun emit() { val status = snapshot(); listeners.forEach { runCatching { it(status) } } }
  fun token() = generation.get()
  fun cancelled(token: Long) = token != generation.get()

  /** A lease ties every socket to one consent/enrollment/tunnel generation. */
  internal data class Route(val generation: Long, val enrollment: VpnEnrollment) {
    val host: String get() = enrollment.address.removeSuffix("/32")
  }
  fun route(peer: String? = null): Route {
    val config = enrollment ?: error("Configure a private network first.")
    val route = Route(generation.get(), config)
    requireRoute(route)
    require(peer == null || "$peer/32" in config.peers) { "This friend address is not part of the approved private network." }
    return route
  }
  fun requireRoute(route: Route) {
    check(connected && generation.get() == route.generation && enrollment === route.enrollment &&
      route.enrollment.expiresAt > System.currentTimeMillis()) { "Private network disconnected. Reconnect before sending." }
  }
  fun network(route: Route): Network {
    requireRoute(route)
    val manager = ctx().getSystemService(ConnectivityManager::class.java)
    val network = manager.allNetworks.singleOrNull { candidate ->
      manager.getNetworkCapabilities(candidate)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true &&
        manager.getLinkProperties(candidate)?.linkAddresses?.any { it.address.hostAddress == route.host } == true
    } ?: error("Android has not made this private network interface available. Try again.")
    requireRoute(route)
    return network
  }

  /** Called immediately, before queuing teardown, to cancel consent/slow DNS races. */
  fun invalidate() { generation.incrementAndGet(); connecting = false }
  fun requestStop() { invalidate(); executor.execute { runCatching { stop() }; emit() } }

  private fun cache(secret: VpnSecret) {
    publicKey = secret.publicKey(); identity = secret.identity; enrollment = stableEnrollment(enrollment, secret.enrollment)
  }
  fun status(): Map<String, Any> {
    if (Build.VERSION.SDK_INT >= 28 && store().accessible()) store().load()?.use { cache(it) }
    return snapshot()
  }
  private fun snapshot(): Map<String, Any> {
    val c = context ?: return mapOf("supported" to false, "initialized" to false, "configured" to false,
      "connected" to false, "connecting" to false, "consentRequired" to false)
    val result = mutableMapOf<String, Any>("supported" to (Build.VERSION.SDK_INT >= 28), "initialized" to store().exists(),
      "configured" to (enrollment != null), "connected" to connected, "connecting" to connecting,
      "consentRequired" to (VpnService.prepare(c) != null))
    publicKey?.let { result["publicKey"] = it }; identity?.let { result["identity"] = it }
    enrollment?.let { saved ->
      result["config"] = saved.publicMap()
      if (connected) runCatching {
        val stats = backend?.getStatistics(tunnel)?.peer(Key.fromBase64(saved.hubPublicKey))
        val at = stats?.latestHandshakeEpochMillis() ?: 0
        if (at > 0) result["lastHandshakeAt"] = at
      }
    }
    return result
  }

  fun initialize(id: String): Map<String, Any> {
    require(VpnPolicy.identity(id)) { "Invalid account identity." }
    check(Build.VERSION.SDK_INT >= 28) { "Private networks require Android 9 or newer." }
    val saved = store().load()
    if (saved != null) saved.use {
      check(it.identity == id) { "Remove the previous account's private network before continuing." }
      cache(it)
    } else {
      val pair = KeyPair()
      VpnSecret(id, pair.privateKey.bytes, null).use { store().save(it, true); cache(it) }
    }
    emit(); return snapshot()
  }

  fun configure(raw: String): Map<String, Any> {
    val config = VpnEnrollment.parse(raw); config.requireFresh()
    val saved = store().load() ?: error("Create this phone's public network key first.")
    saved.use {
      require(config.identity == it.identity && config.devicePublicKey == it.publicKey()) { "Enrollment belongs to another account or phone." }
      stop()
      VpnSecret(it.identity, it.privateKey.copyOf(), config).use { updated -> store().save(updated); cache(updated) }
    }
    emit(); return snapshot()
  }

  fun beginConnect() { check(!connecting) { "Private network connection is already starting." }; connecting = true; emit() }

  private fun rejectConflictingNetwork() {
    val interfaces = NetworkInterface.getNetworkInterfaces()?.toList() ?: emptyList()
    check(interfaces.none { iface -> iface.isUp && iface.inetAddresses.toList().any { address ->
      val bytes = address.address; address is Inet4Address && bytes[0] == 10.toByte() && bytes[1] == 203.toByte()
    } }) { "Another network already uses 10.203.0.0/16. Disconnect it before starting this private network." }
    val manager = ctx().getSystemService(ConnectivityManager::class.java)
    check(manager.allNetworks.none { network -> manager.getLinkProperties(network)?.routes?.any { route ->
      val destination = route.destination
      val bytes = destination.address.address
      if (destination.address !is Inet4Address || destination.prefixLength == 0) false else {
        val prefix = destination.prefixLength.coerceAtMost(16)
        val mask = (-1L shl (32 - prefix)) and 0xffff_ffffL
        val value = bytes.fold(0L) { acc, part -> (acc shl 8) or (part.toInt() and 255).toLong() }
        (value and mask) == (0x0acb0000L and mask)
      }
    } == true }) { "An existing network route overlaps this private network. Disconnect it before continuing." }
  }

  fun connect(token: Long): Map<String, Any> {
    try {
      check(!cancelled(token)) { "Connection cancelled." }
      if (connected) { connecting = false; return snapshot() }
      check(VpnService.prepare(ctx()) == null) { "Android VPN permission was not granted." }
      val saved = store().load() ?: error("Create this phone's private network first.")
      saved.use {
        val config = it.enrollment ?: error("Import your private network enrollment first.")
        config.requireFresh(); rejectConflictingNetwork()
        val interfaze = Interface.Builder().setKeyPair(it.pair()).addAddress(InetNetwork.parse(config.address))
          .includeApplication(ctx().packageName).setMtu(1280).build()
        check(ctx().packageName == "org.commonchat.app") { "Unsupported application package." }
        val peer = Peer.Builder().setPublicKey(Key.fromBase64(config.hubPublicKey)).setEndpoint(InetEndpoint.parse(config.endpoint))
          .setPersistentKeepalive(25).addAllowedIps(config.peers.map(InetNetwork::parse)).build()
        val wg = Config.Builder().setInterface(interfaze).addPeer(peer).build()
        check(!cancelled(token)) { "Connection cancelled." }
        check(store().accessible() && ctx().getSystemService(PowerManager::class.java).isInteractive) { "Keep your phone unlocked while connecting." }
        ContextCompat.startForegroundService(ctx(), Intent(ctx(), LinkUpVpnService::class.java))
        val engine = backend ?: GoBackend(ctx()).also { backend = it }
        try {
          engine.setState(tunnel, Tunnel.State.UP, wg)
          check(!cancelled(token)) { "Connection cancelled." }
          check(store().accessible() && ctx().getSystemService(PowerManager::class.java).isInteractive) { "Private network stopped because your phone locked." }
          cache(it)
          expiry?.cancel(false)
          expiry = executor.schedule({ requestStop() }, (config.expiresAt - System.currentTimeMillis()).coerceAtLeast(1), TimeUnit.MILLISECONDS)
        } catch (error: Exception) { stop(); throw error }
      }
      connecting = false; emit(); return snapshot()
    } catch (error: Exception) { connecting = false; emit(); throw error }
  }

  fun stop() {
    invalidate(); downListeners.forEach { runCatching { it() } }; expiry?.cancel(false); expiry = null
    try { backend?.setState(tunnel, Tunnel.State.DOWN, null) } finally {
      connected = false
      // Also stop the VPN service if the backend's down transition failed.
      ctx().stopService(Intent(ctx(), GoBackend.VpnService::class.java))
      ctx().stopService(Intent(ctx(), LinkUpVpnService::class.java)); emit()
    }
  }

  fun erase() {
    stop(); store().erase(); publicKey = null; identity = null; enrollment = null; emit()
  }
}
