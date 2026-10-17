// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction

/** Framing only. Identity authentication, encryption and delivery receipts live above BLE. */
internal object CommonBleFraming {
  const val MAX_PACKET_BYTES = 128 * 1024
  const val HEADER_BYTES = 12
  const val IDLE_TIMEOUT_MS = 30_000L
  const val TRANSFER_TIMEOUT_MS = 180_000L
  private const val MAGIC: Byte = 0x43
  private const val VERSION: Byte = 1

  fun valueLimit(mtu: Int): Int = (mtu.coerceIn(23, 517) - 3).coerceAtMost(512)

  class Sender(val bytes: ByteArray, val transferId: Int) {
    var offset = 0
      private set
    private var index = 0
    private var pendingSize = 0

    init { require(bytes.isNotEmpty() && bytes.size <= MAX_PACKET_BYTES) { "Bluetooth packet is too large or empty." } }

    fun next(mtu: Int): ByteArray {
      check(pendingSize == 0 && offset < bytes.size) { "A Bluetooth fragment is already pending." }
      val size = minOf(valueLimit(mtu) - HEADER_BYTES, bytes.size - offset)
      check(index <= 0xffff)
      pendingSize = size
      return ByteBuffer.allocate(HEADER_BYTES + size).order(ByteOrder.BIG_ENDIAN)
        .put(MAGIC).put(VERSION).putInt(transferId).putShort(index.toShort()).putInt(bytes.size)
        .put(bytes, offset, size).array()
    }

    /** Called only after Android reports completion of this ATT write/indication. */
    fun confirmed(): Boolean {
      check(pendingSize > 0)
      offset += pendingSize
      pendingSize = 0
      index += 1
      return offset == bytes.size
    }
  }

  class Receiver {
    private var data: ByteArray? = null
    private var transferId = 0
    private var nextIndex = 0
    private var offset = 0
    private var startedAt = 0L
    private var lastAt = 0L

    val pending: Boolean get() = data != null

    fun expired(now: Long): Boolean = pending &&
      (now - lastAt >= IDLE_TIMEOUT_MS || now - startedAt >= TRANSFER_TIMEOUT_MS)

    fun clear() {
      data = null
      nextIndex = 0
      offset = 0
      startedAt = 0L
      lastAt = 0L
    }

    fun accept(frame: ByteArray, mtu: Int, now: Long): String? {
      try {
        require(!expired(now)) { "Bluetooth packet timed out." }
        require(frame.size > HEADER_BYTES && frame.size <= valueLimit(mtu)) { "Invalid Bluetooth fragment size." }
        val header = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN)
        require(header.get() == MAGIC && header.get() == VERSION) { "Unsupported Bluetooth frame." }
        val id = header.int
        val index = header.short.toInt() and 0xffff
        val total = header.int
        require(total in 1..MAX_PACKET_BYTES) { "Invalid Bluetooth packet length." }
        if (data == null) {
          require(index == 0) { "Bluetooth packet must start with fragment zero." }
          data = ByteArray(total)
          transferId = id
          startedAt = now
        }
        val target = checkNotNull(data)
        require(id == transferId && total == target.size && index == nextIndex) { "Bluetooth fragments arrived out of order." }
        val count = frame.size - HEADER_BYTES
        require(count <= target.size - offset) { "Bluetooth packet exceeds its declared length." }
        System.arraycopy(frame, HEADER_BYTES, target, offset, count)
        offset += count
        nextIndex += 1
        lastAt = now
        if (offset != target.size) return null
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(target)).toString()
        clear()
        return text
      } catch (error: Exception) {
        clear()
        throw error
      }
    }
  }
}
