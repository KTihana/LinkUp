// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommonBleFramingTest {
  private fun rejects(block: () -> Unit) {
    var rejected = false
    try { block() } catch (error: Exception) { rejected = true }
    assertTrue("Invalid framing must be rejected", rejected)
  }

  private fun frames(text: String, mtu: Int = 23, id: Int = 71): List<ByteArray> {
    val sender = CommonBleFraming.Sender(text.toByteArray(Charsets.UTF_8), id)
    val result = mutableListOf<ByteArray>()
    do { result.add(sender.next(mtu)) } while (!sender.confirmed())
    return result
  }

  @Test fun maximumPacketRoundTripsAtMinimumAndMaximumMtu() {
    val text = "🙂".repeat(CommonBleFraming.MAX_PACKET_BYTES / 4)
    for (mtu in listOf(23, 517)) {
      val receiver = CommonBleFraming.Receiver()
      var delivered: String? = null
      for ((index, frame) in frames(text, mtu).withIndex()) {
        assertTrue(frame.size <= minOf(mtu - 3, 512))
        delivered = receiver.accept(frame, mtu, index.toLong())
      }
      assertEquals(text, delivered)
      assertFalse(receiver.pending)
    }
  }

  @Test fun senderWaitsForAttCompletionBeforeNextFragment() {
    val sender = CommonBleFraming.Sender("abcdefghijk".toByteArray(), 1)
    sender.next(23)
    rejects { sender.next(23) }
    assertFalse(sender.confirmed())
    sender.next(23)
    assertTrue(sender.confirmed())
    rejects { sender.confirmed() }
    rejects { sender.next(23) }
  }

  @Test fun outOfOrderDuplicateAndSwappedTransfersAreRejectedAndCleared() {
    val data = frames("abcdefghijklmnopq")
    val receiver = CommonBleFraming.Receiver()
    rejects { receiver.accept(data[1], 23, 1) }
    assertFalse(receiver.pending)
    assertNull(receiver.accept(data[0], 23, 2))
    rejects { receiver.accept(data[0], 23, 3) }
    assertFalse(receiver.pending)
    receiver.accept(data[0], 23, 4)
    val swapped = data[1].copyOf().also { ByteBuffer.wrap(it).putInt(2, 999) }
    rejects { receiver.accept(swapped, 23, 5) }
    assertFalse(receiver.pending)
  }

  @Test fun oversizedNegativeZeroAndChangingLengthAreRejectedBeforeAllocation() {
    val original = frames("abcdefghijklmnopq")[0]
    for (length in listOf(0, -1, CommonBleFraming.MAX_PACKET_BYTES + 1)) {
      val receiver = CommonBleFraming.Receiver()
      val changed = original.copyOf().also { ByteBuffer.wrap(it).putInt(8, length) }
      rejects { receiver.accept(changed, 23, 0) }
      assertFalse(receiver.pending)
    }
    val receiver = CommonBleFraming.Receiver()
    val data = frames("abcdefghijklmnopq")
    receiver.accept(data[0], 23, 0)
    val changed = data[1].copyOf().also { ByteBuffer.wrap(it).putInt(8, 16) }
    rejects { receiver.accept(changed, 23, 1) }
  }

  @Test fun idleAndTotalTimeoutsRejectPartialPacketAndClearBuffer() {
    val data = frames("abcdefghijk")
    val receiver = CommonBleFraming.Receiver()
    receiver.accept(data[0], 23, 0)
    assertFalse(receiver.expired(29_999))
    assertTrue(receiver.expired(30_000))
    rejects { receiver.accept(data[1], 23, 30_000) }
    assertFalse(receiver.pending)
    val slow = frames("a".repeat(80))
    for (index in 0..6) receiver.accept(slow[index], 23, index * 29_000L)
    assertTrue(receiver.expired(180_000))
    rejects { receiver.accept(slow[7], 23, 180_000) }
    assertFalse(receiver.pending)
  }

  @Test fun invalidVersionOversizedFrameAndDeclaredOverflowAreRejected() {
    val data = frames("abcdefghijk")
    rejects { CommonBleFraming.Receiver().accept(data[0].copyOf().also { it[1] = 2 }, 23, 0) }
    rejects { CommonBleFraming.Receiver().accept(data[0] + byteArrayOf(1), 23, 0) }
    val overflow = data[0].copyOf().also { ByteBuffer.wrap(it).putInt(8, 1) }
    rejects { CommonBleFraming.Receiver().accept(overflow, 23, 0) }
    rejects { CommonBleFraming.Sender(ByteArray(0), 1) }
    rejects { CommonBleFraming.Sender(ByteArray(CommonBleFraming.MAX_PACKET_BYTES + 1), 1) }
  }

  @Test fun malformedUtf8RejectedInsteadOfReplacementCharacters() {
    val sender = CommonBleFraming.Sender(byteArrayOf(0xc3.toByte(), 0x28), 1)
    rejects { CommonBleFraming.Receiver().accept(sender.next(23), 23, 0) }
  }

  @Test fun successfulPacketAllowsNextDistinctTransfer() {
    val receiver = CommonBleFraming.Receiver()
    assertEquals("first", receiver.accept(frames("first")[0], 23, 0))
    assertEquals("second", receiver.accept(frames("second", id = 99)[0], 23, 1))
  }
}
