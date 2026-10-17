// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.os.SystemClock
import java.security.SecureRandom
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Foreground BLE packet pipe. The advertised service contains no profile, friend name or identity.
 * ATT confirmations only pace fragments: the signed protocol above this pipe authenticates peers
 * and confirms application delivery. This class never requests permissions or enables the radio.
 * All mutable GATT state is confined to one handler; generations reject late Android callbacks.
 */
@SuppressLint("MissingPermission")
internal class CommonBleLink(
  private val context: Context,
  private val emit: (String, Map<String, Any?>) -> Unit
) {
  companion object {
    val SERVICE_UUID: UUID = UUID.fromString("b8e7f1a0-6e3b-4c28-9bd8-9756d6f74a20")
    private val RX_UUID = UUID.fromString("ad8d43de-e521-4732-85bf-d2d2b4ad2829")
    private val TX_UUID = UUID.fromString("ad8d43df-e521-4732-85bf-d2d2b4ad2829")
    private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private const val MAX_LINKS = 4
    private const val MAX_DISCOVERED = 64
    private const val CONNECT_TIMEOUT_MS = 20_000L
    private const val PEER_TIMEOUT_MS = 60_000L
    private const val START_TIMEOUT_MS = 15_000L
  }

  private data class Peer(val id: String, val device: BluetoothDevice, var seenAt: Long)
  private class Transmission(val frames: CommonBleFraming.Sender, val future: CompletableFuture<Unit>, now: Long) {
    val startedAt = now
    var progressedAt = now
    var awaiting = false
  }
  private class Link(val id: String, val device: BluetoothDevice, val central: Boolean, now: Long) {
    val receiver = CommonBleFraming.Receiver()
    val connected = CompletableFuture<String>()
    val connectDeadline = now + CONNECT_TIMEOUT_MS
    var gatt: BluetoothGatt? = null
    var receiveCharacteristic: BluetoothGattCharacteristic? = null
    var transmitCharacteristic: BluetoothGattCharacteristic? = null
    var mtu = 23
    var ready = false
    var subscribing = false
    var earlyPacket: String? = null
    var transmission: Transmission? = null
    val pendingIncoming = AtomicInteger()
  }

  private val thread = HandlerThread("CommonBluetooth").apply { start() }
  private val handler = Handler(thread.looper)
  private val generation = AtomicLong()
  private val destroyed = AtomicBoolean()
  private val random = SecureRandom()
  private val pendingDiscoveries = AtomicInteger()
  private val pendingServerWrites = AtomicInteger()
  private val manager get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private val adapter: BluetoothAdapter? get() = runCatching { manager?.adapter }.getOrNull()
  private var activeGeneration = 0L
  private var starting: CompletableFuture<Map<String, Any?>>? = null
  private var startDeadline = 0L
  private var started = false
  private var scanner: BluetoothLeScanner? = null
  private var scanCallback: ScanCallback? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var server: BluetoothGattServer? = null
  private var serverTransmit: BluetoothGattCharacteristic? = null
  private val links = linkedMapOf<String, Link>()
  private val peers = linkedMapOf<String, Peer>()
  private val peripheralQueue = ArrayDeque<Link>()
  private var peripheralInFlight: Link? = null
  private var peripheralInFlightAt = 0L
  private val peripheralQuarantine = linkedMapOf<String, Long>()

  fun requiredPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31) {
    arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
  } else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

  fun capability(): Map<String, Any?> {
    val hardware = context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && adapter != null
    val granted = requiredPermissions().all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    val radio = if (hardware && granted) runCatching { adapter?.isEnabled }.getOrNull() else null
    val peripheral = if (hardware && granted) runCatching { adapter?.isMultipleAdvertisementSupported }.getOrNull() else null
    return mapOf("supported" to hardware, "enabled" to radio, "peripheral" to peripheral,
      "permissionsGranted" to granted, "service" to SERVICE_UUID.toString())
  }

  fun startBluetooth(): CompletableFuture<Map<String, Any?>> {
    val future = CompletableFuture<Map<String, Any?>>()
    if (destroyed.get()) return future.failed("Bluetooth is unavailable after this screen closes.")
    val token = generation.incrementAndGet()
    future.whenComplete { _, _ -> if (future.isCancelled && generation.get() == token) stop() }
    handler.post {
      cleanup("Bluetooth session replaced.")
      if (generation.get() != token || destroyed.get() || future.isCancelled) {
        future.failed("Bluetooth session stopped.")
        return@post
      }
      activeGeneration = token
      starting = future
      startDeadline = now() + START_TIMEOUT_MS
      try {
        checkPermissions()
        val radio = adapter ?: error("This phone does not support Bluetooth.")
        check(context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) { "This phone does not support Bluetooth Low Energy." }
        check(radio.isEnabled) { "Turn on Bluetooth in your phone settings first." }
        check(radio.isMultipleAdvertisementSupported) { "This phone cannot host a nearby Bluetooth session." }
        scanner = radio.bluetoothLeScanner ?: error("Bluetooth scanning is unavailable on this phone.")
        advertiser = radio.bluetoothLeAdvertiser ?: error("Bluetooth advertising is unavailable on this phone.")
        server = manager?.openGattServer(context, serverCallbacks(token)) ?: error("Bluetooth hosting is unavailable on this phone.")
        val receive = BluetoothGattCharacteristic(RX_UUID, BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE)
        val transmit = BluetoothGattCharacteristic(TX_UUID, BluetoothGattCharacteristic.PROPERTY_INDICATE, 0).apply {
          addDescriptor(BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
        }
        serverTransmit = transmit
        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY).apply {
          addCharacteristic(receive)
          addCharacteristic(transmit)
        }
        check(server?.addService(service) == true) { "Could not start Bluetooth hosting." }
        handler.postDelayed(sweep, 1_000)
      } catch (error: Exception) { failSession(error.message ?: "Could not start Bluetooth.") }
    }
    return future
  }

  fun connectBluetooth(deviceId: String): CompletableFuture<String> {
    val future = CompletableFuture<String>()
    val token = generation.get()
    if (destroyed.get()) return future.failed("Bluetooth is unavailable.")
    handler.post {
      if (!current(token) || !started || future.isCancelled) {
        future.failed("Start Bluetooth nearby discovery first.")
        return@post
      }
      try {
        checkPermissions()
        val peer = peers.values.firstOrNull { it.id == deviceId && now() - it.seenAt < PEER_TIMEOUT_MS }
          ?: error("This nearby phone is no longer visible. Scan again.")
        val existing = links.values.firstOrNull { it.central && it.device.address == peer.device.address }
        if (existing != null) {
          check(existing.ready) { "This Bluetooth phone is already connecting." }
          future.complete(existing.id)
          return@post
        }
        check(links.size < MAX_LINKS) { "Too many nearby Bluetooth connections. Close one first." }
        val link = Link("ble:${UUID.randomUUID()}", peer.device, true, now())
        links[link.id] = link
        link.connected.whenComplete { value, error -> if (error == null) future.complete(value) else future.completeExceptionally(error) }
        future.whenComplete { _, _ -> if (future.isCancelled) close(link.id) }
        try {
          link.gatt = peer.device.connectGatt(context, false, clientCallbacks(token, link), BluetoothDevice.TRANSPORT_LE)
          check(link.gatt != null) { "Could not connect to this Bluetooth phone." }
        } catch (error: Exception) { closeLink(link, error.message ?: "Could not connect to this Bluetooth phone.") }
      } catch (error: Exception) { future.failed(error.message ?: "Could not connect to this Bluetooth phone.") }
    }
    return future
  }

  fun send(linkId: String, payload: String): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    val token = generation.get()
    if (destroyed.get()) return future.failed("Bluetooth is unavailable.")
    // Reject by character length before allocating a UTF-8 buffer from untrusted bridge input.
    if (payload.isEmpty() || payload.length > CommonBleFraming.MAX_PACKET_BYTES) return future.failed("Bluetooth packet is too large or empty.")
    val bytes = payload.toByteArray(Charsets.UTF_8)
    if (bytes.size > CommonBleFraming.MAX_PACKET_BYTES) return future.failed("Bluetooth packet is too large.")
    handler.post {
      if (!current(token) || future.isCancelled) { future.failed("Bluetooth session stopped."); return@post }
      try {
        checkPermissions()
        val link = links[linkId] ?: error("This Bluetooth connection is closed.")
        check(link.ready) { "This Bluetooth connection is not ready." }
        check(link.transmission == null) { "A Bluetooth packet is still sending. Try again after it completes." }
        link.transmission = Transmission(CommonBleFraming.Sender(bytes, random.nextInt()), future, now())
        future.whenComplete { _, _ -> if (future.isCancelled) close(linkId) }
        if (link.central) writeCentral(link) else { peripheralQueue.addLast(link); writePeripheral() }
      } catch (error: Exception) { future.failed(error.message ?: "Could not send Bluetooth packet.") }
    }
    return future
  }

  fun close(linkId: String) {
    if (!destroyed.get()) handler.post { links[linkId]?.let { closeLink(it, "Bluetooth connection closed.") } }
  }

  fun stop() {
    generation.incrementAndGet() // Revokes callback delivery immediately, before queued cleanup.
    if (!destroyed.get()) handler.post { cleanup("Bluetooth session stopped.") }
  }

  fun destroy() {
    generation.incrementAndGet()
    if (destroyed.compareAndSet(false, true)) handler.post {
      cleanup("Bluetooth session stopped.")
      thread.quitSafely()
    }
  }

  private fun current(token: Long) = activeGeneration == token && generation.get() == token && !destroyed.get()
  private fun now() = SystemClock.elapsedRealtime()
  private fun checkPermissions() {
    check(requiredPermissions().all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) { "Nearby Bluetooth permission is required." }
  }
  private fun <T> CompletableFuture<T>.failed(message: String): CompletableFuture<T> {
    completeExceptionally(IllegalStateException(message))
    return this
  }
  private fun event(name: String, data: Map<String, Any?>) { runCatching { emit(name, data) } }
  private fun reportError(message: String) { event("error", mapOf("kind" to "bluetooth", "message" to message)) }

  private fun beginAdvertisingAndScanning(token: Long) {
    val advertisement = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) { handler.post {
        if (!current(token)) return@post
        try {
          val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) { discovered(token, result) }
            override fun onBatchScanResults(results: MutableList<ScanResult>) { results.take(MAX_DISCOVERED).forEach { discovered(token, it) } }
            override fun onScanFailed(errorCode: Int) { handler.post { if (current(token)) failSession("Nearby Bluetooth scanning failed. Restart Bluetooth and try again.") } }
          }
          scanCallback = callback
          scanner?.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()),
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build(), callback)
          started = true
          starting?.complete(mapOf("service" to SERVICE_UUID.toString()))
          starting = null
        } catch (exception: Exception) { failSession("Could not scan for nearby Bluetooth phones.") }
      } }
      override fun onStartFailure(errorCode: Int) { handler.post { if (current(token)) failSession("This phone could not advertise a Bluetooth session. Try again.") } }
    }
    advertiseCallback = advertisement
    advertiser?.startAdvertising(AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
      .setConnectable(true).setTimeout(0).setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_LOW).build(),
      AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE_UUID)).setIncludeDeviceName(false).setIncludeTxPowerLevel(false).build(), advertisement)
  }

  private fun discovered(token: Long, result: ScanResult) {
    if (generation.get() != token) return
    if (pendingDiscoveries.incrementAndGet() > MAX_DISCOVERED) {
      pendingDiscoveries.decrementAndGet()
      return
    }
    handler.post {
      pendingDiscoveries.decrementAndGet()
      if (!current(token) || !started) return@post
      try {
        val address = result.device.address
        val existing = peers[address]
        if (existing != null) { existing.seenAt = now(); return@post }
        if (peers.size >= MAX_DISCOVERED) return@post
        val peer = Peer("peer:${UUID.randomUUID()}", result.device, now())
        peers[address] = peer
        // Device names and addresses can reveal a profile. Keep discovery labels generic.
        event("bluetoothPeer", mapOf("deviceId" to peer.id, "label" to "Nearby phone"))
      } catch (exception: Exception) { failSession("Nearby Bluetooth permission is no longer available.") }
    }
  }

  private fun clientCallbacks(token: Long, link: Link) = object : BluetoothGattCallback() {
    private fun live(gatt: BluetoothGatt): Boolean = current(token) && links[link.id] === link && link.gatt === gatt
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) { handler.post {
      if (!live(gatt)) { runCatching { gatt.close() }; return@post }
      if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
        closeLink(link, "Bluetooth phone disconnected.")
      } else if (newState == BluetoothProfile.STATE_CONNECTED) {
        try { if (!gatt.requestMtu(517)) discoverServices(link) }
        catch (exception: Exception) { closeLink(link, "Could not negotiate Bluetooth connection.") }
      }
    } }
    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) { handler.post {
      if (!live(gatt)) return@post
      if (!link.ready && !link.subscribing) {
        link.mtu = if (status == BluetoothGatt.GATT_SUCCESS) mtu.coerceIn(23, 517) else 23
        discoverServices(link)
      }
    } }
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) { handler.post {
      if (!live(gatt) || link.ready || link.subscribing) return@post
      try {
        check(status == BluetoothGatt.GATT_SUCCESS) { "Could not read nearby Bluetooth service." }
        val service = gatt.getService(SERVICE_UUID) ?: error("This phone does not provide a LinkUp Bluetooth service.")
        val rx = service.getCharacteristic(RX_UUID) ?: error("Nearby Bluetooth service is incomplete.")
        val tx = service.getCharacteristic(TX_UUID) ?: error("Nearby Bluetooth service is incomplete.")
        check(rx.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0 && tx.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) { "Nearby Bluetooth service is incompatible." }
        val descriptor = tx.getDescriptor(CCCD_UUID) ?: error("Nearby Bluetooth service cannot send replies.")
        link.receiveCharacteristic = rx
        link.transmitCharacteristic = tx
        check(gatt.setCharacteristicNotification(tx, true)) { "Could not subscribe to nearby Bluetooth replies." }
        link.subscribing = true
        val accepted = if (Build.VERSION.SDK_INT >= 33) {
          gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE) == BluetoothGatt.GATT_SUCCESS
        } else {
          @Suppress("DEPRECATION")
          descriptor.value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
          @Suppress("DEPRECATION")
          gatt.writeDescriptor(descriptor)
        }
        check(accepted) { "Could not subscribe to nearby Bluetooth replies." }
      } catch (exception: Exception) { closeLink(link, exception.message ?: "Nearby Bluetooth service is incompatible.") }
    } }
    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) { handler.post {
      if (!live(gatt) || !link.subscribing || link.ready || descriptor.uuid != CCCD_UUID || descriptor.characteristic.uuid != TX_UUID) return@post
      if (status == BluetoothGatt.GATT_SUCCESS) ready(link) else closeLink(link, "Could not subscribe to nearby Bluetooth replies.")
    } }
    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) { handler.post {
      if (!live(gatt) || characteristic.uuid != RX_UUID || link.transmission?.awaiting != true) return@post
      if (status != BluetoothGatt.GATT_SUCCESS) closeLink(link, "Bluetooth packet transfer failed.")
      else { confirm(link); if (links[link.id] === link && link.transmission != null) writeCentral(link) }
    } }
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      if (characteristic.uuid == TX_UUID) incoming(gatt, value)
    }
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT < 33 && characteristic.uuid == TX_UUID) incoming(gatt, characteristic.value ?: byteArrayOf())
    }
    private fun incoming(gatt: BluetoothGatt, value: ByteArray) {
      if (generation.get() != token || value.size > 512) return
      if (link.pendingIncoming.incrementAndGet() > 16) {
        link.pendingIncoming.decrementAndGet()
        return // Bounded packet loss fails the application RPC; it never produces a receipt.
      }
      val bytes = value.copyOf()
      handler.post {
        link.pendingIncoming.decrementAndGet()
        if (live(gatt) && (link.ready || link.subscribing)) {
          try { receive(link, bytes) }
          catch (exception: Exception) { closeLink(link, "Invalid Bluetooth packet received.") }
        }
      }
    }
  }

  private fun discoverServices(link: Link) {
    try { check(link.gatt?.discoverServices() == true) { "Could not read nearby Bluetooth service." } }
    catch (exception: Exception) { closeLink(link, "Could not read nearby Bluetooth service.") }
  }

  private fun serverCallbacks(token: Long) = object : BluetoothGattServerCallback() {
    private fun peripheral(device: BluetoothDevice): Link? = links.values.firstOrNull { !it.central && it.device.address == device.address }
    override fun onServiceAdded(status: Int, service: BluetoothGattService) { handler.post {
      if (!current(token) || service.uuid != SERVICE_UUID) return@post
      if (status != BluetoothGatt.GATT_SUCCESS) failSession("Could not start Bluetooth hosting.")
      else try { beginAdvertisingAndScanning(token) } catch (exception: Exception) { failSession("Could not advertise nearby Bluetooth session.") }
    } }
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) { handler.post {
      if (!current(token)) return@post
      try {
        val existing = peripheral(device)
        if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
          existing?.let { closeLink(it, "Bluetooth phone disconnected.") }
        } else if (newState == BluetoothProfile.STATE_CONNECTED && existing == null) {
          if (links.size >= MAX_LINKS || peripheralQuarantine.size >= MAX_DISCOVERED || !started ||
              (peripheralQuarantine[device.address] ?: 0L) > now()) runCatching { server?.cancelConnection(device) }
          else { val link = Link("ble:${UUID.randomUUID()}", device, false, now()); links[link.id] = link }
        }
      } catch (exception: Exception) { failSession("Nearby Bluetooth permission is no longer available.") }
    } }
    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) { handler.post {
      if (current(token)) runCatching { peripheral(device)?.mtu = mtu.coerceIn(23, 517) }
    } }
    override fun onDescriptorWriteRequest(device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
      val bytes = value.copyOf()
      handler.post {
        if (!current(token)) return@post
        val link = runCatching { peripheral(device) }.getOrNull()
        val enabled = bytes.contentEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
        val disabled = bytes.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)
        val accepted = link != null && descriptor.uuid == CCCD_UUID && descriptor.characteristic.uuid == TX_UUID &&
          !preparedWrite && responseNeeded && offset == 0 && (enabled || disabled)
        val responded = respond(device, requestId, if (accepted) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null)
        if (accepted && link != null) {
          if (!responded) closeLink(link, "Bluetooth subscription response failed.")
          else if (enabled && !link.ready) ready(link)
          else if (disabled) closeLink(link, "Bluetooth reply subscription closed.")
        }
      }
    }
    override fun onDescriptorReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, descriptor: BluetoothGattDescriptor) { handler.post {
      if (!current(token)) return@post
      val link = runCatching { peripheral(device) }.getOrNull()
      val accepted = link != null && descriptor.uuid == CCCD_UUID && descriptor.characteristic.uuid == TX_UUID && offset == 0
      respond(device, requestId, if (accepted) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0,
        if (accepted && link?.ready == true) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)
    } }
    override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
      if (generation.get() != token || value.size > 512) return
      if (pendingServerWrites.incrementAndGet() > 64) {
        pendingServerWrites.decrementAndGet()
        return // Leave an ATT request unconfirmed rather than allocating an unbounded queue.
      }
      val bytes = value.copyOf()
      handler.post {
        pendingServerWrites.decrementAndGet()
        if (!current(token)) return@post
        val link = runCatching { peripheral(device) }.getOrNull()
        if (link == null || !link.ready || characteristic.uuid != RX_UUID || preparedWrite || offset != 0 || !responseNeeded) {
          respond(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null)
          return@post
        }
        try {
          val packet = link.receiver.accept(bytes, link.mtu, now())
          if (!respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)) {
            closeLink(link, "Bluetooth packet response failed.")
          } else if (packet != null) event("packet", mapOf("linkId" to link.id, "payload" to packet))
        } catch (exception: Exception) {
          respond(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
          closeLink(link, "Invalid Bluetooth packet received.")
        }
      }
    }
    override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, characteristic: BluetoothGattCharacteristic) { handler.post {
      if (current(token)) respond(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, 0, null)
    } }
    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) { handler.post {
      if (current(token)) respond(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null)
    } }
    override fun onNotificationSent(device: BluetoothDevice, status: Int) { handler.post {
      if (!current(token)) return@post
      val link = peripheralInFlight ?: return@post
      if (runCatching { link.device.address != device.address }.getOrDefault(true)) return@post
      peripheralInFlight = null
      if (links[link.id] !== link) { writePeripheral(); return@post }
      if (status != BluetoothGatt.GATT_SUCCESS) closeLink(link, "Bluetooth packet transfer failed.")
      else {
        confirm(link)
        if (link.transmission != null) peripheralQueue.addLast(link)
      }
      writePeripheral()
    } }
  }

  private fun respond(device: BluetoothDevice, requestId: Int, status: Int, offset: Int, value: ByteArray?): Boolean =
    runCatching { server?.sendResponse(device, requestId, status, offset, value) == true }.getOrDefault(false)

  private fun ready(link: Link) {
    link.ready = true
    event("link", mapOf("linkId" to link.id, "state" to "connected", "kind" to "bluetooth"))
    link.connected.complete(link.id)
    link.earlyPacket?.let { event("packet", mapOf("linkId" to link.id, "payload" to it)) }
    link.earlyPacket = null
  }

  private fun receive(link: Link, bytes: ByteArray) {
    val packet = link.receiver.accept(bytes, link.mtu, now()) ?: return
    if (link.ready) event("packet", mapOf("linkId" to link.id, "payload" to packet))
    else {
      check(link.earlyPacket == null) { "Too many Bluetooth packets before connection was ready." }
      link.earlyPacket = packet
    }
  }

  private fun writeCentral(link: Link) {
    val transfer = link.transmission ?: return
    try {
      val characteristic = link.receiveCharacteristic ?: error("Bluetooth connection is not ready.")
      val gatt = link.gatt ?: error("Bluetooth connection is closed.")
      val bytes = transfer.frames.next(link.mtu)
      transfer.awaiting = true
      val accepted = if (Build.VERSION.SDK_INT >= 33) {
        gatt.writeCharacteristic(characteristic, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
      } else {
        @Suppress("DEPRECATION")
        characteristic.value = bytes
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        @Suppress("DEPRECATION")
        gatt.writeCharacteristic(characteristic)
      }
      check(accepted) { "Could not write Bluetooth fragment." }
    } catch (exception: Exception) { closeLink(link, "Bluetooth packet transfer failed.") }
  }

  private fun writePeripheral() {
    if (peripheralInFlight != null) return
    while (peripheralQueue.isNotEmpty()) {
      val link = peripheralQueue.removeFirst()
      val transfer = link.transmission
      if (links[link.id] !== link || transfer == null || !link.ready) continue
      try {
        val characteristic = serverTransmit ?: error("Bluetooth hosting is closed.")
        val gattServer = server ?: error("Bluetooth hosting is closed.")
        val bytes = transfer.frames.next(link.mtu)
        transfer.awaiting = true
        peripheralInFlight = link
        peripheralInFlightAt = now()
        val accepted = if (Build.VERSION.SDK_INT >= 33) {
          gattServer.notifyCharacteristicChanged(link.device, characteristic, true, bytes) == BluetoothGatt.GATT_SUCCESS
        } else {
          @Suppress("DEPRECATION")
          characteristic.value = bytes
          @Suppress("DEPRECATION")
          gattServer.notifyCharacteristicChanged(link.device, characteristic, true)
        }
        check(accepted) { "Could not send Bluetooth indication." }
        return
      } catch (exception: Exception) { closeLink(link, "Bluetooth packet transfer failed.") }
    }
  }

  private fun confirm(link: Link) {
    val transfer = link.transmission ?: return
    transfer.awaiting = false
    transfer.progressedAt = now()
    if (transfer.frames.confirmed()) {
      link.transmission = null
      transfer.future.complete(Unit) // Transport completion only; never a messenger delivery receipt.
    }
  }

  private val sweep = object : Runnable {
    override fun run() {
      val token = activeGeneration
      if (!current(token)) return
      val clock = now()
      if (starting != null && clock >= startDeadline) { failSession("Bluetooth startup timed out. Try again."); return }
      peers.entries.removeAll { clock - it.value.seenAt >= PEER_TIMEOUT_MS }
      peripheralQuarantine.entries.removeAll { it.value <= clock }
      // Android's server completion callback has only a device address, not an operation ID.
      // Never attribute a late completion from a closed link to a new indication.
      if (peripheralInFlight != null && clock - peripheralInFlightAt >= CommonBleFraming.IDLE_TIMEOUT_MS) {
        failSession("Bluetooth packet transfer timed out. Restart the nearby session.")
        return
      }
      links.values.toList().forEach { link ->
        val transfer = link.transmission
        if (!link.ready && clock >= link.connectDeadline) closeLink(link, "Bluetooth connection timed out.")
        else if (link.receiver.expired(clock) || (transfer != null &&
            (clock - transfer.progressedAt >= CommonBleFraming.IDLE_TIMEOUT_MS || clock - transfer.startedAt >= CommonBleFraming.TRANSFER_TIMEOUT_MS))) {
          closeLink(link, "Bluetooth packet transfer timed out.")
        }
      }
      writePeripheral()
      handler.postDelayed(this, 1_000)
    }
  }

  private fun closeLink(link: Link, reason: String) {
    if (links.remove(link.id) !== link) return
    peripheralQueue.removeAll { it === link }
    link.receiver.clear()
    link.earlyPacket = null
    link.connected.failed(reason)
    link.transmission?.future?.failed(reason)
    link.transmission = null
    if (link.central) {
      runCatching { link.gatt?.disconnect() }
      runCatching { link.gatt?.close() }
      link.gatt = null
    } else {
      runCatching { peripheralQuarantine[link.device.address] = now() + CONNECT_TIMEOUT_MS }
      runCatching { server?.cancelConnection(link.device) }
    }
    event("link", mapOf("linkId" to link.id, "state" to "closed", "kind" to "bluetooth"))
  }

  private fun failSession(message: String) {
    generation.incrementAndGet()
    val hadStarted = started
    cleanup(message)
    if (hadStarted) reportError(message)
  }

  private fun cleanup(reason: String) {
    handler.removeCallbacks(sweep)
    starting?.failed(reason)
    starting = null
    started = false
    links.values.toList().forEach { closeLink(it, reason) }
    peripheralQueue.clear()
    peripheralInFlight = null
    peripheralInFlightAt = 0L
    scanCallback?.let { callback -> runCatching { scanner?.stopScan(callback) } }
    advertiseCallback?.let { callback -> runCatching { advertiser?.stopAdvertising(callback) } }
    runCatching { server?.clearServices() }
    runCatching { server?.close() }
    scanner = null
    scanCallback = null
    advertiser = null
    advertiseCallback = null
    server = null
    serverTransmit = null
    peers.clear()
    peripheralQuarantine.clear()
    activeGeneration = 0L
  }
}
