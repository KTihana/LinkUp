// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

// No PIN verifier is stored. Authenticated decryption is the verifier, and its
// key also depends on a non-exportable Android Keystore HMAC key.
internal object PinProtection {
  fun validate(pin: String) { require(pin.matches(Regex("[0-9]{6}"))) { "Use a six-digit LinkUp PIN." } }
  fun derive(pin: String, salt: ByteArray, pepper: (ByteArray) -> ByteArray): ByteArray {
    validate(pin); require(salt.size == 16)
    val input = ("linkup/app-pin/v1:" + pin).toByteArray(Charsets.UTF_8)
    val secret = try { pepper(input) } finally { input.fill(0) }
    val chars = secret.joinToString("") { "%02x".format(it) }.toCharArray()
    secret.fill(0)
    val spec = PBEKeySpec(chars, salt, 600_000, 256); chars.fill('\u0000')
    return try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded } finally { spec.clearPassword() }
  }
  fun crypt(mode: Int, key: ByteArray, nonce: ByteArray, value: ByteArray): ByteArray {
    require(key.size == 32 && nonce.size == 12)
    return Cipher.getInstance("AES/GCM/NoPadding").run {
      init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
      updateAAD("linkup/app-pin/v1".toByteArray(Charsets.UTF_8)); doFinal(value)
    }
  }
}
internal data class PinAttempts(val failures: Int = 0, val blockedUntil: Long = 0) {
  fun delay(): Long = if (failures < 5) 0L else (30_000L * (1L shl (failures - 5).coerceIn(0, 7))).coerceAtMost(3_600_000)
  fun afterReboot(): PinAttempts = copy(blockedUntil = delay())
  fun remaining(now: Long): Long = (blockedUntil - now).coerceIn(0, 3_600_000)
  // Reserve an attempt durably BEFORE deriving/decrypting. Killing the process
  // cannot turn a rejected attempt into a free guess. Success clears the state.
  fun reserve(now: Long): PinAttempts {
    check(remaining(now) == 0L) { "Too many attempts. Try again in ${(remaining(now) + 999) / 1000} seconds." }
    val count = (failures + 1).coerceAtMost(100)
    return PinAttempts(count, now + PinAttempts(count).delay())
  }
}
