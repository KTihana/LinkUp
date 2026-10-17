// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.wireguard.crypto.Key
import com.wireguard.crypto.KeyPair
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class VpnEnrollment(
  val identity: String,
  val devicePublicKey: String,
  val label: String,
  val address: String,
  val hubPublicKey: String,
  val endpoint: String,
  val peers: List<String>,
  val expiresAt: Long,
) {
  fun publicMap(): Map<String, Any> = mapOf("schema" to 1, "identity" to identity, "devicePublicKey" to devicePublicKey,
    "label" to label, "address" to address, "hubPublicKey" to hubPublicKey, "endpoint" to endpoint, "peers" to peers, "expiresAt" to expiresAt)
  fun json() = JSONObject(publicMap()).toString()
  fun requireFresh() = VpnPolicy.validate(address, peers, endpoint, expiresAt, System.currentTimeMillis())

  companion object {
    fun parse(raw: String): VpnEnrollment {
      require(raw.toByteArray(Charsets.UTF_8).size <= VpnPolicy.MAX_CONFIG_BYTES) { "Enrollment is too large." }
      val obj = JSONObject(raw)
      val fields = setOf("schema", "identity", "devicePublicKey", "label", "address", "hubPublicKey", "endpoint", "peers", "expiresAt")
      require(obj.keys().asSequence().toSet() == fields && obj.get("schema") == 1) { "Unsupported enrollment format." }
      fun string(name: String) = (obj.get(name) as? String) ?: error("Invalid enrollment field.")
      val identity = string("identity"); require(VpnPolicy.identity(identity)) { "Invalid account identity." }
      val label = string("label"); require(label.length in 1..40 && label.none { it.code < 32 || it.code == 127 }) { "Invalid network name." }
      fun publicKey(name: String): String {
        val value = string(name)
        val decoded = Key.fromBase64(value)
        require(decoded.toBase64() == value && decoded.bytes.any { it != 0.toByte() }) { "Invalid public tunnel key." }
        return value
      }
      val devicePublicKey = publicKey("devicePublicKey"); val hubPublicKey = publicKey("hubPublicKey")
      require(devicePublicKey != hubPublicKey) { "Hub and phone keys must differ." }
      val addresses = obj.get("peers") as? JSONArray ?: error("Invalid friend routes.")
      require(addresses.length() in 1..VpnPolicy.MAX_PEERS) { "Too many friend routes." }
      val peers = (0 until addresses.length()).map { (addresses.get(it) as? String) ?: error("Invalid friend route.") }
      val expiresAt = obj.get("expiresAt")
      require(expiresAt is Long || expiresAt is Int) { "Invalid enrollment expiry." }
      val result = VpnEnrollment(identity, devicePublicKey, label, string("address"), hubPublicKey, string("endpoint"), peers, (expiresAt as Number).toLong())
      require(result.expiresAt in 1..9_007_199_254_740_991L)
      // Persisted expired enrollment can be displayed and replaced, never connected.
      VpnPolicy.validate(result.address, peers, result.endpoint, VpnPolicy.MAX_LIFETIME_MS, 0)
      return result
    }
  }
}

// Status polls decrypt a new record instance. Preserve the active immutable
// enrollment object when its contents are unchanged, so existing socket leases
// remain valid; a real reconfiguration separately advances the generation.
internal fun stableEnrollment(current: VpnEnrollment?, updated: VpnEnrollment?): VpnEnrollment? =
  if (current == updated) current else updated

internal class VpnSecret(val identity: String, val privateKey: ByteArray, val enrollment: VpnEnrollment?) : AutoCloseable {
  fun pair() = KeyPair(Key.fromBytes(privateKey))
  fun publicKey() = pair().publicKey.toBase64()
  override fun close() { privateKey.fill(0) }
}

/** No-backup storage, authenticated with a non-exportable Android Keystore key. */
internal class LinkUpVpnStore(private val context: Context) {
  private val alias = "linkup.private-network.v1"
  private val aad = "linkup/private-network/store/v1".toByteArray(Charsets.US_ASCII)
  private val file = AtomicFile(File(context.noBackupFilesDir, "linkup-private-network-v1.bin"))
  fun exists() = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()
  fun accessible() = Build.VERSION.SDK_INT >= 28 && !context.getSystemService(KeyguardManager::class.java).isDeviceLocked

  private fun key(create: Boolean): SecretKey {
    check(accessible()) { "Unlock your phone to configure its private network." }
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    check(create) { "Private network keys are unavailable. Remove this enrollment and create a new one." }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUnlockedDeviceRequired(true).build())
    }.generateKey()
  }

  fun load(): VpnSecret? {
    if (!exists()) return null
    val encrypted = file.openRead().use { input ->
      require(input.channel.size() in 97..(VpnPolicy.MAX_CONFIG_BYTES + 200).toLong()) { "Invalid saved private network." }
      input.readBytes()
    }
    require(encrypted[0] == 1.toByte())
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, encrypted.copyOfRange(1, 13))); updateAAD(aad)
    }
    val plain = cipher.doFinal(encrypted, 13, encrypted.size - 13)
    try {
      require(plain.size >= 68)
      val buffer = ByteBuffer.wrap(plain)
      val identity = ByteArray(32).also { buffer.get(it) }.joinToString("") { "%02x".format(it) }
      val privateKey = ByteArray(32).also { buffer.get(it) }
      try {
        val configSize = buffer.int; require(configSize == buffer.remaining() && configSize <= VpnPolicy.MAX_CONFIG_BYTES)
        val enrollment = if (configSize == 0) null else VpnEnrollment.parse(plain.copyOfRange(68, plain.size).toString(Charsets.UTF_8))
        val secret = VpnSecret(identity, privateKey, enrollment)
        require(enrollment == null || (enrollment.identity == identity && enrollment.devicePublicKey == secret.publicKey()))
        return secret
      } catch (error: Exception) { privateKey.fill(0); throw error }
    } finally { plain.fill(0) }
  }

  fun save(secret: VpnSecret, create: Boolean = false) {
    require(VpnPolicy.identity(secret.identity) && secret.privateKey.size == 32)
    val config = secret.enrollment?.json()?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
    require(config.size <= VpnPolicy.MAX_CONFIG_BYTES)
    val identity = secret.identity.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    val plain = ByteBuffer.allocate(68 + config.size).put(identity).put(secret.privateKey).putInt(config.size).put(config).array()
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(create)); updateAAD(aad) }
      val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(plain)
      val output = file.startWrite()
      try { output.write(encrypted); file.finishWrite(output) } catch (error: Exception) { file.failWrite(output); throw error }
    } finally { plain.fill(0) }
  }

  fun erase() {
    // Delete the wrapping key first. Even a failed file deletion cannot leave
    // recoverable tunnel private keys behind for a replacement account.
    KeyStore.getInstance("AndroidKeyStore").apply { load(null); if (containsAlias(alias)) deleteEntry(alias) }
    file.delete()
    check(!exists()) { "Could not delete private network enrollment." }
  }
}
