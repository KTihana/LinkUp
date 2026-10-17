// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

// App-owned PIN: never invokes Keyguard/BiometricPrompt or uses a phone PIN.
// Retry state is app-sandbox protection, not a hardware anti-rollback counter.
class LinkUpPinUnlockModule : Module() {
  companion object { private val mutex = Any() }
  private val namespace = "linkup.app-pin.v1"
  private fun prefs() = (appContext.reactContext ?: error("Open LinkUp first")).getSharedPreferences(namespace, Context.MODE_PRIVATE)
  private fun validAlias(alias: String) = alias.matches(Regex(Regex.escape(namespace) + "\\.[a-f0-9]{32}"))
  private fun key(alias: String, create: Boolean): SecretKey {
    require(validAlias(alias))
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    check(create) { "This PIN belongs to another installation. Use another saved unlock method." }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).setKeySize(256).setUserAuthenticationRequired(false).build())
    }.generateKey()
  }
  private fun derive(pin: String, salt: ByteArray, alias: String, create: Boolean = false): ByteArray {
    val secret = key(alias, create)
    return PinProtection.derive(pin, salt) { input -> Mac.getInstance("HmacSHA256").run { init(secret); doFinal(input) } }
  }
  private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun decode(record: JSONObject, field: String, size: Int): ByteArray = Base64.decode(record.getString(field), Base64.NO_WRAP).also { require(it.size == size) }
  private fun record(raw: String): JSONObject {
    require(raw.length <= 1024)
    return JSONObject(raw).also {
      require(it.length() == 5 && it.getInt("version") == 1 && validAlias(it.getString("alias")))
      decode(it, "salt", 16); decode(it, "nonce", 12); decode(it, "wrapped", 48)
    }
  }
  private fun prune(alias: String?) {
    if (alias == null || !validAlias(alias)) return
    if (prefs().all.values.filterIsInstance<String>().any { it.contains(alias) }) return
    KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }
  }
  override fun definition() = ModuleDefinition {
    Name("LinkUpPinUnlock")
    AsyncFunction("status") { synchronized(mutex) {
      mapOf("available" to (Build.VERSION.SDK_INT >= 26), "enabled" to (prefs().getString("current", null) != null))
    } }
    AsyncFunction("enable") { value: String, pin: String -> synchronized(mutex) {
      PinProtection.validate(pin); require(value.matches(Regex("[a-f0-9]{64}")))
      val old = prefs().getString("current", null)?.let { record(it).getString("alias") }
      val alias = namespace + "." + UUID.randomUUID().toString().replace("-", "")
      val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
      val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
      val raw = ByteArray(32) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
      var derived: ByteArray? = null
      try {
        derived = derive(pin, salt, alias, true)
        val wrapped = PinProtection.crypt(Cipher.ENCRYPT_MODE, derived, nonce, raw)
        val verified = PinProtection.crypt(Cipher.DECRYPT_MODE, derived, nonce, wrapped)
        try { check(java.security.MessageDigest.isEqual(raw, verified)) } finally { verified.fill(0) }
        val saved = JSONObject().put("version", 1).put("alias", alias).put("salt", encode(salt)).put("nonce", encode(nonce)).put("wrapped", encode(wrapped)).toString()
        check(prefs().edit().putString("current", saved).putInt("failures", 0).putLong("blockedUntil", 0).commit()) { "Could not save the PIN. Keep your existing unlock method." }
        check(prefs().getString("current", null) == saved)
        runCatching { prune(old) }
      } finally { raw.fill(0); derived?.fill(0); runCatching { prune(alias) } }
      Unit
    } }
    AsyncFunction("read") { pin: String -> synchronized(mutex) {
      PinProtection.validate(pin)
      val saved = record(prefs().getString("current", null) ?: error("Set up your LinkUp PIN first."))
      val now = SystemClock.elapsedRealtime()
      val boot = Settings.Global.getInt((appContext.reactContext ?: error("Open LinkUp first")).contentResolver, Settings.Global.BOOT_COUNT)
      var previous = PinAttempts(prefs().getInt("failures", 0).coerceIn(0, 100), prefs().getLong("blockedUntil", 0))
      if (prefs().getInt("blockedBoot", -1) != boot) previous = previous.afterReboot()
      val attempts = previous.reserve(now)
      check(prefs().edit().putInt("failures", attempts.failures).putLong("blockedUntil", attempts.blockedUntil).putInt("blockedBoot", boot).commit()) { "Could not save the attempt. Please try again." }
      val derived = derive(pin, decode(saved, "salt", 16), saved.getString("alias"))
      val raw = try { PinProtection.crypt(Cipher.DECRYPT_MODE, derived, decode(saved, "nonce", 12), decode(saved, "wrapped", 48)) }
      catch (_: javax.crypto.AEADBadTagException) { error(if (attempts.remaining(now) > 0) "Incorrect PIN. Try again in ${(attempts.remaining(now) + 999) / 1000} seconds." else "Incorrect LinkUp PIN. Try again.") }
      finally { derived.fill(0) }
      try {
        check(prefs().edit().putInt("failures", 0).putLong("blockedUntil", 0).commit())
        raw.joinToString("") { "%02x".format(it) }
      } finally { raw.fill(0) }
    } }
    AsyncFunction("disable") { synchronized(mutex) {
      val old = prefs().getString("current", null)?.let { record(it).getString("alias") }
      check(prefs().edit().remove("current").remove("failures").remove("blockedUntil").commit()); prune(old)
    } }
    AsyncFunction("erase") { synchronized(mutex) { nativeCompletion {
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val aliases = java.util.Collections.list(store.aliases()).filter { validAlias(it) }
      for (alias in aliases) store.deleteEntry(alias)
      check(prefs().edit().clear().commit())
    } } }
    AsyncFunction("archive") { id: String -> synchronized(mutex) {
      require(id.matches(Regex("[a-f0-9]{64}")))
      val current = prefs().getString("current", null)
      val saved = JSONObject().put("current", current ?: JSONObject.NULL).put("failures", prefs().getInt("failures", 0)).put("blockedUntil", prefs().getLong("blockedUntil", 0)).put("blockedBoot", prefs().getInt("blockedBoot", -1)).toString()
      check(prefs().edit().putString("archived:$id", saved).commit()); check(prefs().getString("archived:$id", null) == saved)
    } }
    AsyncFunction("detach") { id: String -> synchronized(mutex) {
      require(id.matches(Regex("[a-f0-9]{64}"))); check(prefs().contains("archived:$id"))
      check(prefs().edit().remove("current").remove("failures").remove("blockedUntil").commit())
    } }
  }
}
