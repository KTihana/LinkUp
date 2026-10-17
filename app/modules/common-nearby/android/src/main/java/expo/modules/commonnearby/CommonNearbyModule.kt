// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class CommonNearbyModule : Module() {
  private val generation = AtomicInteger(0)
  private val permissionRequests = AtomicInteger(0)
  private val connected = ConcurrentHashMap.newKeySet<String>()
  private val linkGuard = Any()
  @Volatile private var foreground = true
  private var wifi: WifiLink? = null
  private var privateWifi: WifiLink? = null
  private var bluetooth: CommonBleLink? = null

  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("LinkUp Nearby requires an active Android application.")

  @Synchronized private fun wifi(): WifiLink = wifi ?: WifiLink(context, ::emit).also { wifi = it }
  @Synchronized private fun privateWifi(): WifiLink = privateWifi ?: WifiLink(context, ::emit, true).also { privateWifi = it }
  @Synchronized private fun bluetooth(): CommonBleLink = bluetooth ?: CommonBleLink(context, ::emit).also { bluetooth = it }

  private fun emit(name: String, value: Map<String, Any?>) {
    if (name == "link") {
      val id = value["linkId"] as? String ?: return
      if (value["state"] == "connected") {
        val accepted = synchronized(linkGuard) {
          if (!foreground || connected.size >= 4) false else { connected.add(id); true }
        }
        if (!accepted) {
          if (id.startsWith("wifi:")) wifi?.close(id) else if (id.startsWith("vpn:")) privateWifi?.close(id) else bluetooth?.close(id)
          return
        }
      } else connected.remove(id)
    }
    sendEvent(name, value)
  }

  override fun definition() = ModuleDefinition {
    Name("CommonNearby")
    Events("packet", "link", "bluetoothPeer", "error")

    AsyncFunction("capabilities") {
      val supported = context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)
      mapOf(
        "platform" to "android",
        "wifi" to supported,
        "hotspot" to (supported && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O),
        "bluetooth" to (bluetooth().capability()["supported"] == true)
      )
    }

    AsyncFunction("startWifi") Coroutine { hotspot: Boolean ->
      val token = generation.get()
      if (hotspot) {
        request(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES)
        } else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), token)
      }
      ensureForeground(token)
      wifi().startWifi(hotspot).await { wifi?.stop() }.also { ensureCurrent(token) }
    }

    AsyncFunction("connectWifi") Coroutine { host: String, port: Int, pin: String ->
      val token = generation.get()
      ensureForeground(token)
      val id = wifi().connectWifi(host, port, pin).await { wifi?.stop() }
      ensureCurrent(token)
      check(connected.contains(id)) { "Nearby connection was closed or its connection limit was reached." }
      mapOf("linkId" to id)
    }

    AsyncFunction("startPrivateNetwork") Coroutine { ->
      val token = generation.get()
      ensureForeground(token)
      LinkUpVpnController.route()
      wifi?.stop(); bluetooth?.stop()
      privateWifi().startPrivateNetwork().await { privateWifi?.stop() }.also { ensureCurrent(token) }
    }

    AsyncFunction("connectPrivateNetwork") Coroutine { host: String, port: Int, pin: String ->
      val token = generation.get()
      ensureForeground(token)
      LinkUpVpnController.route(host)
      wifi?.stop(); bluetooth?.stop()
      val id = privateWifi().connectWifi(host, port, pin).await { privateWifi?.stop() }
      ensureCurrent(token)
      check(connected.contains(id)) { "Private network connection was closed." }
      mapOf("linkId" to id)
    }

    AsyncFunction("startBluetooth") Coroutine { ->
      val token = generation.get()
      val helper = bluetooth()
      request(helper.requiredPermissions(), token)
      ensureForeground(token)
      helper.startBluetooth().await { helper.stop() }.also { ensureCurrent(token) }
    }

    AsyncFunction("connectBluetooth") Coroutine { deviceId: String ->
      val token = generation.get()
      val helper = bluetooth()
      request(helper.requiredPermissions(), token)
      ensureForeground(token)
      val id = helper.connectBluetooth(deviceId).await { helper.stop() }
      ensureCurrent(token)
      check(connected.contains(id)) { "Nearby connection was closed or its connection limit was reached." }
      mapOf("linkId" to id)
    }

    AsyncFunction("send") Coroutine { linkId: String, payload: String ->
      val token = generation.get()
      ensureForeground(token)
      require(connected.contains(linkId)) { "Nearby connection is closed." }
      if (linkId.startsWith("wifi:")) wifi().send(linkId, payload).await { wifi?.close(linkId) }
      else if (linkId.startsWith("vpn:")) privateWifi().send(linkId, payload).await { privateWifi?.close(linkId) }
      else if (linkId.startsWith("ble:")) bluetooth().send(linkId, payload).await { bluetooth?.close(linkId) }
      else throw IllegalArgumentException("Unknown nearby connection.")
      ensureCurrent(token)
    }

    AsyncFunction("close") { linkId: String ->
      if (linkId.startsWith("wifi:")) wifi?.close(linkId)
      else if (linkId.startsWith("vpn:")) privateWifi?.close(linkId)
      else if (linkId.startsWith("ble:")) bluetooth?.close(linkId)
      else throw IllegalArgumentException("Unknown nearby connection.")
      connected.remove(linkId)
    }

    AsyncFunction("stop") { stop() }

    OnActivityEntersForeground { foreground = true }
    OnActivityEntersBackground {
      foreground = false
      // Runtime permission UI can briefly pause the Activity. No radio is
      // started until permission completion and foreground are both confirmed.
      if (permissionRequests.get() == 0) stop()
    }
    OnActivityDestroys { stop() }
    OnDestroy {
      stop()
      wifi?.destroy()
      privateWifi?.destroy()
      bluetooth?.destroy()
      wifi = null
      privateWifi = null
      bluetooth = null
    }
  }

  private fun stop() {
    generation.incrementAndGet()
    wifi?.stop()
    privateWifi?.stop()
    bluetooth?.stop()
    connected.clear()
  }

  private fun ensureCurrent(token: Int) = check(generation.get() == token) { "Nearby operation was canceled." }

  private suspend fun ensureForeground(token: Int) {
    ensureCurrent(token)
    withTimeout(5_000) {
      while (!foreground) { ensureCurrent(token); delay(50) }
    }
    ensureCurrent(token)
  }

  private suspend fun request(permissions: Array<String>, token: Int) {
    if (permissions.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) return
    permissionRequests.incrementAndGet()
    try {
      withContext(Dispatchers.Main) {
        suspendCancellableCoroutine<Unit> { continuation ->
          val manager = appContext.permissions
          if (manager == null) {
            continuation.resumeWithException(IllegalStateException("Android permission service is unavailable."))
            return@suspendCancellableCoroutine
          }
          manager.askForPermissions({ result ->
            if (!continuation.isActive) return@askForPermissions
            if (permissions.all { result[it]?.status == PermissionsStatus.GRANTED }) continuation.resume(Unit)
            else continuation.resumeWithException(IllegalStateException("Nearby permission was not granted."))
          }, *permissions)
        }
      }
      ensureCurrent(token)
      ensureForeground(token)
    } finally {
      permissionRequests.decrementAndGet()
      if (!foreground && permissionRequests.get() == 0) stop()
    }
  }

  private suspend fun <T> CompletableFuture<T>.await(cancel: () -> Unit): T = suspendCancellableCoroutine { continuation ->
    whenComplete { value, error ->
      if (!continuation.isActive) return@whenComplete
      if (error != null) continuation.resumeWithException(if (error is CompletionException) error.cause ?: error else error)
      else continuation.resume(value)
    }
    continuation.invokeOnCancellation { cancel(); this.cancel(true) }
  }
}
