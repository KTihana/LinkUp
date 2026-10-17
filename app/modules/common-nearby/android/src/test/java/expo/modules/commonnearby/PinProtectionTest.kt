// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import org.junit.Assert.*
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class PinProtectionTest {
  private fun derive(pin: String, device: Int) = PinProtection.derive(pin, ByteArray(16) { 7 }) { input ->
    Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(ByteArray(32) { device.toByte() }, "HmacSHA256")); doFinal(input) }
  }
  @Test fun pinAndDeviceAreBothRequired() {
    val nonce = ByteArray(12) { 3 }; val master = ByteArray(32) { it.toByte() }
    val key = derive("847291", 1)
    val wrapped = PinProtection.crypt(Cipher.ENCRYPT_MODE, key, nonce, master)
    assertArrayEquals(master, PinProtection.crypt(Cipher.DECRYPT_MODE, key, nonce, wrapped))
    for (wrong in listOf(derive("847292", 1), derive("847291", 2))) {
      try { PinProtection.crypt(Cipher.DECRYPT_MODE, wrong, nonce, wrapped); fail("Wrong PIN/device opened key") } catch (_: javax.crypto.AEADBadTagException) {}
      wrong.fill(0)
    }
    wrapped[0] = (wrapped[0].toInt() xor 1).toByte()
    try { PinProtection.crypt(Cipher.DECRYPT_MODE, key, nonce, wrapped); fail("Modified record opened") } catch (_: javax.crypto.AEADBadTagException) {}
    key.fill(0)
  }
  @Test fun onlySixAsciiDigitsAreAccepted() {
    for (pin in listOf("", "12345", "1234567", "１２３４５６", "abcdef", "123 45")) {
      try { PinProtection.validate(pin); fail("Accepted invalid PIN") } catch (_: IllegalArgumentException) {}
    }
    PinProtection.validate("014729")
  }
  @Test fun retriesSurviveReconstructionAndEscalateWithoutDeletingData() {
    var attempts = PinAttempts(); var now = 1000L
    repeat(4) { attempts = attempts.reserve(now); assertEquals(0L, attempts.remaining(now)) }
    attempts = attempts.reserve(now); assertEquals(30_000L, attempts.remaining(now))
    // Reconstruct the persisted state as a restarted process would.
    attempts = PinAttempts(attempts.failures, attempts.blockedUntil)
    try { attempts.reserve(now); fail("Lockout bypassed") } catch (_: IllegalStateException) {}
    now += 30_000; attempts = attempts.reserve(now); assertEquals(60_000L, attempts.remaining(now))
    repeat(12) { now = attempts.blockedUntil; attempts = attempts.reserve(now) }
    assertEquals(3_600_000L, attempts.remaining(now))
    val rebooted = attempts.afterReboot()
    assertEquals(3_600_000L, rebooted.remaining(0))
    assertEquals(0L, rebooted.remaining(3_600_000))
    assertEquals(0L, PinAttempts().remaining(now)) // successful unlock resets only retry state
  }
}
