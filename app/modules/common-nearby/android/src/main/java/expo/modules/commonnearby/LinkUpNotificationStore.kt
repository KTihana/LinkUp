// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object LinkUpNotificationStore {
  private const val ALIAS = "linkup.notifications.device.v1"
  fun prefs(c: Context) = c.getSharedPreferences("linkup.notifications.v1", Context.MODE_PRIVATE)
  fun deliveryAllowed(c: Context) = prefs(c).getBoolean("deliveryAllowed", false)
  fun enabled(c: Context) = prefs(c).getBoolean("enabled", false)
  fun allowed(c: Context): Boolean {
    val keyguard = c.getSystemService(KeyguardManager::class.java)
    return enabled(c) && Build.VERSION.SDK_INT >= 28 && keyguard.isDeviceSecure && !keyguard.isDeviceLocked
  }
  private fun key(transport: Boolean = false): SecretKey {
    val alias = if (transport) ALIAS + ".transport" else ALIAS
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    require(Build.VERSION.SDK_INT >= 28) { "Background replies require Android 9 or newer" }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUnlockedDeviceRequired(!transport).build())
    }.generateKey()
  }
  private fun seal(text: String, transport: Boolean = false): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(transport)); updateAAD(ALIAS.toByteArray()) }
    return Base64.encodeToString(cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
  }
  private fun open(text: String, transport: Boolean = false): String {
    val bytes = Base64.decode(text, Base64.NO_WRAP)
    require(bytes.size in 29..262144)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(transport), GCMParameterSpec(128, bytes.copyOfRange(0, 12))); updateAAD(ALIAS.toByteArray()) }
    return cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
  }
  @Synchronized fun enable(c: Context, vaultKey: String, baseline: String) {
    require(vaultKey.matches(Regex("[a-f0-9]{64}")))
    require(c.getSystemService(KeyguardManager::class.java).let { it.isDeviceSecure && !it.isDeviceLocked }) { "Set a phone screen lock before enabling background replies" }
    require(baseline.length <= 200000)
    val entries = JSONArray(baseline); require(entries.length() <= 1000)
    for (i in 0 until entries.length()) require(entries.getString(i).matches(Regex("(?:peer:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{32}|group:[a-f0-9]{32}:(?:invite:[a-f0-9]{32}|[a-f0-9]{64}:[a-f0-9]{32}))")))
    val ledger = seal(entries.toString())
    val encrypted = seal(vaultKey)
    require(open(encrypted) == vaultKey)
    check(prefs(c).edit().putString("vault", encrypted).putString("ledger", ledger).putBoolean("enabled", true).commit())
  }
  @Synchronized fun disable(c: Context) {
    val delivery = deliveryAllowed(c)
    check(prefs(c).edit().clear().putBoolean("deliveryAllowed", delivery).commit())
    KeyStore.getInstance("AndroidKeyStore").apply { load(null); if (containsAlias(ALIAS)) deleteEntry(ALIAS); if (containsAlias(ALIAS + ".transport")) deleteEntry(ALIAS + ".transport") }
  }
  fun vaultKey(c: Context): String { check(allowed(c)); return open(prefs(c).getString("vault", null) ?: error("Background messaging unavailable")) }
  @Synchronized fun enqueueReply(c: Context, thread: String, text: String): String {
    check(allowed(c)); require(thread.matches(Regex("(?:peer:[a-f0-9]{64}|group:[a-f0-9]{32})")))
    require(text.isNotBlank() && text.toByteArray().size <= 4000)
    val rows = replies(c); require(rows.length() < 32) { "Reply queue is full" }
    val id = java.util.UUID.randomUUID().toString().replace("-", "")
    rows.put(JSONObject().put("id", id).put("thread", thread).put("text", text).put("createdAt", System.currentTimeMillis()))
    check(prefs(c).edit().putString("replies", seal(rows.toString())).commit()); return id
  }
  @Synchronized fun replies(c: Context): JSONArray {
    check(allowed(c)); val saved = prefs(c).getString("replies", null) ?: return JSONArray()
    // Keep unsent text available for Copy/Discard, including after a prolonged
    // outage. Expiring its transport job must never silently erase the draft.
    return JSONArray(open(saved))
  }
  @Synchronized fun acknowledge(c: Context, id: String) {
    val rows = replies(c); val kept = JSONArray()
    for (i in 0 until rows.length()) if (rows.getJSONObject(i).getString("id") != id) kept.put(rows.getJSONObject(i))
    check(prefs(c).edit().putString("replies", seal(kept.toString())).commit())
  }
  @Synchronized fun secret(c: Context, name: String, value: String) { check(if (name == "subscription") enabled(c) else allowed(c)); check(prefs(c).edit().putString(name, seal(value, name == "subscription")).commit()) }
  @Synchronized fun secret(c: Context, name: String): String? { check(allowed(c)); return prefs(c).getString(name, null)?.let { open(it, name == "subscription") } }
}
