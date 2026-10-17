// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.app.KeyguardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Authentication authorizes the Keystore cipher itself. A JS success boolean
// can never substitute for the phone's fingerprint/screen-lock credential.
class LinkUpPhoneUnlockModule : Module() {
  private val alias = "linkup.phone-unlock.v1"
  private val aad = "linkup/phone-unlock/v1".toByteArray()
  private val context: Context get() = appContext.reactContext ?: error("Open LinkUp first")
  private fun prefs() = context.getSharedPreferences(alias, Context.MODE_PRIVATE)
  private var signal: CancellationSignal? = null
  private var pending: Promise? = null
  private var generation = 0
  private var pendingAlias: String? = null
  private fun validAlias(value: String) = value == alias || value.matches(Regex(Regex.escape(alias) + "\\.[a-f0-9]{32}"))
  private fun available(): Boolean = Build.VERSION.SDK_INT >= 30 && context.getSystemService(KeyguardManager::class.java).isDeviceSecure && context.getSystemService(BiometricManager::class.java).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS
  private fun key(keyAlias: String, create: Boolean): SecretKey {
    require(validAlias(keyAlias))
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
    check(create && available()) { "Phone unlock is unavailable. Use your password or saved key." }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUserAuthenticationRequired(true)
        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        .setInvalidatedByBiometricEnrollment(false).build())
    }.generateKey()
  }
  private fun discardPendingKey() {
    val generated = pendingAlias; pendingAlias = null
    if (generated != null && prefs().getString("keyAlias", null) != generated) runCatching {
      KeyStore.getInstance("AndroidKeyStore").apply { load(null); if (containsAlias(generated)) deleteEntry(generated) }
    }
  }
  private fun cancel() {
    generation++; val promise = pending; pending = null
    val old = signal; signal = null; old?.cancel(); discardPendingKey()
    promise?.reject("CANCELLED", "Phone unlock was cancelled.", null)
  }
  private fun authenticate(value: String?, promise: Promise) {
    if (signal != null) { promise.reject("BUSY", "Phone authentication is already open.", null); return }
    try {
      check(available()) { "Set a phone screen lock, or use a LinkUp password." }
      val activity = appContext.currentActivity ?: error("Open LinkUp first")
      check(!activity.isFinishing && !activity.isDestroyed)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      var saved: ByteArray? = null
      val keyAlias = if (value != null) alias + "." + java.util.UUID.randomUUID().toString().replace("-", "") else prefs().getString("keyAlias", alias)!!
      if (value != null) {
        require(value.matches(Regex("[a-f0-9]{64}")))
        // Recovery may replace current protection only after this new cipher
        // receives an authenticated phone credential. Archived aliases survive.
        pendingAlias = keyAlias
        cipher.init(Cipher.ENCRYPT_MODE, key(keyAlias, true))
      } else {
        saved = Base64.decode(prefs().getString("wrapped", null) ?: error("Phone unlock has not been set up."), Base64.NO_WRAP)
        require(saved.size == 92)
        cipher.init(Cipher.DECRYPT_MODE, key(keyAlias, false), GCMParameterSpec(128, saved.copyOfRange(0, 12)))
      }
      cipher.updateAAD(aad)
      val token = ++generation
      signal = CancellationSignal(); pending = promise
      val prompt = BiometricPrompt.Builder(activity).setTitle(if (value == null) "Unlock LinkUp" else "Protect your LinkUp account")
        .setSubtitle("Use your fingerprint or phone screen lock")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL).build()
      prompt.authenticate(BiometricPrompt.CryptoObject(cipher), signal!!, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationError(code: Int, message: CharSequence) {
          if (token != generation) return
          signal = null; pending = null; discardPendingKey(); promise.reject("AUTH_CANCELLED", "Phone authentication did not finish. Try again.", null)
        }
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          if (token != generation) return
          signal = null; pending = null
          try {
            check(!activity.isFinishing && !activity.isDestroyed && !context.getSystemService(KeyguardManager::class.java).isDeviceLocked)
            val authenticated = result.cryptoObject?.cipher ?: error("Authentication did not authorize the key")
            if (value != null) {
              val bytes = value.toByteArray(Charsets.UTF_8)
              val wrapped = try { Base64.encodeToString(authenticated.iv + authenticated.doFinal(bytes), Base64.NO_WRAP) } finally { bytes.fill(0) }
              val previousAlias = prefs().getString("keyAlias", null)
              check(prefs().edit().putString("wrapped", wrapped).putString("keyAlias", keyAlias).putBoolean("ignoreLegacy", true).commit())
              check(prefs().getString("wrapped", null) == wrapped)
              pendingAlias = null
              if (previousAlias != null && previousAlias != keyAlias && validAlias(previousAlias)) runCatching {
                val archived = prefs().all.filterKeys { it.startsWith("archived:") }.values.any { entry -> runCatching { JSONObject(entry as String).optString("keyAlias") == previousAlias }.getOrDefault(false) }
                if (!archived) KeyStore.getInstance("AndroidKeyStore").apply { load(null); if (containsAlias(previousAlias)) deleteEntry(previousAlias) }
              }
              promise.resolve()
            } else {
              val bytes = authenticated.doFinal(saved!!.copyOfRange(12, saved.size))
              try {
                val key = bytes.toString(Charsets.UTF_8); require(key.matches(Regex("[a-f0-9]{64}")))
                promise.resolve(key)
              } finally { bytes.fill(0) }
            }
          } catch (_: Exception) { discardPendingKey(); promise.reject("KEY_UNAVAILABLE", "Your phone could not open this account. Use another saved unlock method.", null) }
        }
      })
    } catch (_: Exception) { signal = null; pending = null; discardPendingKey(); promise.reject("UNAVAILABLE", "Phone unlock is unavailable. Set a screen lock or use a LinkUp password.", null) }
  }
  override fun definition() = ModuleDefinition {
    Name("LinkUpPhoneUnlock")
    AsyncFunction("status") { mapOf("available" to available(), "enabled" to prefs().contains("wrapped"), "ignoreLegacy" to prefs().getBoolean("ignoreLegacy", false)) }
    AsyncFunction("enable") { key: String, promise: Promise -> authenticate(key, promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("read") { promise: Promise -> authenticate(null, promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("disable") { nativeCompletion {
      cancel(); val currentAlias = if (prefs().contains("wrapped")) prefs().getString("keyAlias", alias) else null
      check(prefs().edit().remove("wrapped").remove("keyAlias").commit())
      KeyStore.getInstance("AndroidKeyStore").apply { load(null); if (currentAlias != null && validAlias(currentAlias) && containsAlias(currentAlias)) deleteEntry(currentAlias) }
    } }.runOnQueue(Queues.MAIN)
    AsyncFunction("erase") { nativeCompletion {
      cancel()
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val aliases = java.util.Collections.list(store.aliases()).filter { validAlias(it) }
      for (name in aliases) store.deleteEntry(name)
      check(prefs().edit().clear().commit())
    } }.runOnQueue(Queues.MAIN)
    AsyncFunction("archive") { id: String, legacy: Boolean ->
      require(id.matches(Regex("[a-f0-9]{64}")))
      val archived = JSONObject().put("wrapped", prefs().getString("wrapped", null)).put("keyAlias", prefs().getString("keyAlias", alias)).put("legacy", legacy).toString()
      check(prefs().edit().putString("archived:" + id, archived).commit())
      check(prefs().getString("archived:" + id, null) == archived)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("detach") { id: String ->
      require(id.matches(Regex("[a-f0-9]{64}"))); check(prefs().contains("archived:" + id))
      cancel()
      // Retain archived aliases/ciphertexts. A new account gets a fresh key;
      // deleting a previous account's only unlock key would erase its archive.
      check(prefs().edit().remove("wrapped").remove("keyAlias").putBoolean("ignoreLegacy", true).commit())
    }.runOnQueue(Queues.MAIN)
    OnActivityDestroys { cancel() }
    OnDestroy { cancel() }
  }
}
