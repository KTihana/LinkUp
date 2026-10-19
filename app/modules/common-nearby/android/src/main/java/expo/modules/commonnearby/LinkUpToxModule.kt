// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import androidx.annotation.Keep
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray

/** All toxcore calls and callbacks run on one executor. No keys or payloads are logged or persisted. */
@Keep
class LinkUpToxModule : Module() {
  companion object { init { System.loadLibrary("linkup_tox") } }
  private external fun create(secret: ByteArray): Long
  private external fun destroy(handle: Long)
  private external fun addFriend(handle: Long, publicKey: ByteArray): Int
  private external fun bootstrap(handle: Long, host: String, port: Int, key: ByteArray, tcp: Boolean)
  private external fun iterate(handle: Long): Int
  private external fun sendPacket(handle: Long, friend: Int, packet: ByteArray): Boolean
  private val executor = Executors.newSingleThreadScheduledExecutor()
  private val generation = AtomicLong(0)
  private var handle = 0L
  private var timer: ScheduledFuture<*>? = null
  private var sequence = 0
  private var nodes = JSONArray()
  private var connected = false
  private var lastBootstrap = 0L
  private val peers = mutableMapOf<Int, String>()
  private val numbers = mutableMapOf<String, Int>()
  private val online = mutableSetOf<Int>()
  private data class Outgoing(val friend: Int, val chunks: List<ByteArray>, val promise: Promise, val created: Long, var index: Int = 0)
  private data class Incoming(val count: Int, val chunks: MutableList<ByteArray>, val created: Long, var size: Int = 0)
  private val outgoing = ArrayDeque<Outgoing>()
  private val incoming = mutableMapOf<Pair<Int, Int>, Incoming>()
  private fun now() = android.os.SystemClock.elapsedRealtime()
  private fun decodeHex(value: String): ByteArray {
    require(value.matches(Regex("[a-fA-F0-9]{64}")))
    return ByteArray(32) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }
  private fun stopNative() {
    timer?.cancel(false); timer = null
    for (pending in outgoing) pending.promise.reject("P2P_STOPPED", "Connection stopped. Messages stay queued.", null)
    outgoing.clear(); incoming.clear(); online.clear(); peers.clear(); numbers.clear(); connected = false
    if (handle != 0L) { destroy(handle); handle = 0L }
  }
  private fun stop() { generation.incrementAndGet(); executor.execute { stopNative() } }
  private fun bootstrapNodes(token: Long) {
    lastBootstrap = now()
    for (i in 0 until nodes.length()) {
      check(generation.get() == token)
      val node = nodes.getJSONObject(i); val publicKey = decodeHex(node.getString("publicKey"))
      bootstrap(handle, node.getString("host"), node.getInt("port"), publicKey, false)
      val ports = node.getJSONArray("tcpPorts")
      for (j in 0 until ports.length()) bootstrap(handle, node.getString("host"), ports.getInt(j), publicKey, true)
    }
  }
  private fun tick(token: Long) {
    if (generation.get() != token || handle == 0L) return
    try {
      val interval = iterate(handle).coerceIn(10, 100)
      if (!connected && now() - lastBootstrap > 30000) bootstrapNodes(token)
      incoming.entries.removeAll { now() - it.value.created > 30000 }
      // Rotate peers so one congested connection cannot starve another friend.
      repeat(minOf(8, outgoing.size)) {
        val item = outgoing.removeFirst()
        if (!online.contains(item.friend) || now() - item.created > 30000) {
          item.promise.reject("P2P_OFFLINE", "Your friend is offline. Messages stay queued.", null)
        } else {
          var sent = 0
          while (item.index < item.chunks.size && sent < 8 && sendPacket(handle, item.friend, item.chunks[item.index])) { item.index++; sent++ }
          if (item.index == item.chunks.size) item.promise.resolve(null) else outgoing.addLast(item)
        }
      }
      timer = executor.schedule({ tick(token) }, interval.toLong(), TimeUnit.MILLISECONDS)
    } catch (_: Exception) {
      stopNative(); sendEvent("error", mapOf("message" to "Internet connection interrupted. Reopen LinkUp to retry."))
    }
  }
  // Called only from the native iterate on this executor; keep these names for JNI.
  fun onNetwork(status: Int) { connected = status != 0; sendEvent("network", mapOf("connected" to (status != 0))) }
  fun onConnection(friend: Int, status: Int) {
    val peer = peers[friend] ?: return
    if (status != 0) online.add(friend) else { online.remove(friend); incoming.keys.removeAll { it.first == friend } }
    sendEvent("link", mapOf("linkId" to peer, "state" to if (status != 0) "connected" else "closed", "direct" to (status == 2)))
  }
  fun onPacket(friend: Int, bytes: ByteArray) {
    val peer = peers[friend] ?: return
    if (!online.contains(friend) || bytes.size < 9 || bytes[0].toInt() != 160.toByte().toInt()) return
    val buffer = ByteBuffer.wrap(bytes); buffer.get()
    val id = buffer.int; val index = buffer.short.toInt() and 65535; val count = buffer.short.toInt() and 65535
    if (count !in 1..240 || index >= count) return
    val key = Pair(friend, id)
    if (index == 0) {
      if (incoming.size >= 16 || incoming.keys.count { it.first == friend } >= 2) return
      incoming[key] = Incoming(count, mutableListOf(), now())
    }
    val entry = incoming[key] ?: return
    if (entry.count != count || entry.chunks.size != index || entry.size + bytes.size - 9 > 262144 || now() - entry.created > 30000) { incoming.remove(key); return }
    val chunk = bytes.copyOfRange(9, bytes.size); entry.chunks.add(chunk); entry.size += chunk.size
    if (index + 1 == count) {
      incoming.remove(key)
      val joined = ByteArray(entry.size); var offset = 0
      for (part in entry.chunks) { part.copyInto(joined, offset); offset += part.size }
      sendEvent("packet", mapOf("linkId" to peer, "payload" to joined.toString(Charsets.UTF_8)))
    }
  }
  override fun definition() = ModuleDefinition {
    Name("LinkUpTox")
    Events("packet", "link", "network", "error")
    AsyncFunction("start") { secret: String, contacts: List<Map<String, String>>, promise: Promise ->
      val token = generation.incrementAndGet()
      executor.execute {
        var key: ByteArray? = null
        try {
          stopNative()
          check(generation.get() == token)
          require(contacts.size <= 100)
          key = decodeHex(secret); handle = create(key); check(handle != 0L)
          for (contact in contacts) {
            val peer = contact["publicKey"] ?: error("Missing identity")
            decodeHex(peer)
            val number = addFriend(handle, decodeHex(contact["toxKey"] ?: error("Missing transport identity")))
            check(number >= 0); peers[number] = peer; numbers[peer] = number
          }
          val context = appContext.reactContext ?: error("Open LinkUp first")
          nodes = JSONArray(context.assets.open("tox/bootstrap.json").bufferedReader().use { it.readText() })
          bootstrapNodes(token)
          check(generation.get() == token)
          tick(token); promise.resolve(null)
        } catch (_: Exception) { stopNative(); promise.reject("P2P_START", "Could not start internet P2P. Reopen LinkUp to retry.", null) }
        finally { key?.fill(0) }
      }
    }
    AsyncFunction("send") { peer: String, payload: String, promise: Promise ->
      val token = generation.get()
      executor.execute {
        val friend = numbers[peer]
        val bytes = payload.toByteArray(Charsets.UTF_8)
        if (generation.get() != token || handle == 0L || friend == null || !online.contains(friend)) promise.reject("P2P_OFFLINE", "Your friend is offline. Messages stay queued.", null)
        else if (bytes.isEmpty() || bytes.size > 262144 || outgoing.size >= 16) promise.reject("P2P_BUSY", "Connection busy. Messages stay queued.", null)
        else {
          val id = ++sequence; val count = (bytes.size + 1099) / 1100
          val chunks = (0 until count).map { index ->
            val start = index * 1100; val size = minOf(1100, bytes.size - start)
            ByteBuffer.allocate(9 + size).put(160.toByte()).putInt(id).putShort(index.toShort()).putShort(count.toShort()).put(bytes, start, size).array()
          }
          outgoing.addLast(Outgoing(friend, chunks, promise, now()))
        }
      }
    }
    AsyncFunction("stop") { promise: Promise -> generation.incrementAndGet(); executor.execute { stopNative(); promise.resolve(null) } }
    OnActivityEntersBackground { stop() }
    OnDestroy { stop(); executor.shutdown() }
  }
}
