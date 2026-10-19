// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.os.Handler
import android.os.Looper
import java.util.UUID
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

class TihoUpdatesModule : Module() {
  private val busy = AtomicBoolean(false)
  @Volatile private var canceled = false
  @Volatile private var connection: HttpsURLConnection? = null
  @Volatile private var verified: Verified? = null
  private data class Verified(val sha: String, val bytes: Long, val code: Long)
  private val context: Context get() = appContext.reactContext?.applicationContext ?: error("Android application is unavailable.")
  private val folder: File get() = File(context.cacheDir, "updates").also { it.mkdirs() }
  private val apk: File get() = File(folder, "tiho-update.apk")

  override fun definition() = ModuleDefinition {
    Name("TihoUpdates")
    AsyncFunction("installed") {
      val p = installed()
      // The React provider remounts when the vault locks while Android's
      // install-permission screen is open. Keep the verified download usable
      // on return; install() still rechecks its digest and signing certificate.
      val pending = verified
      val updateReady = !busy.get() && pending != null && pending.code > code(p) && apk.isFile && apk.length() == pending.bytes
      mapOf("version" to (p.versionName ?: ""), "versionCode" to code(p), "packageName" to p.packageName, "updateReady" to updateReady)
    }
    AsyncFunction("copyVaultKey") Coroutine { value: String ->
      require(value.length <= 100 && Regex("[a-fA-F0-9]{64}").matches(value.replace(Regex("[\\s-]"), ""))) { "Invalid vault key." }
      withContext(Dispatchers.Main) {
        val clip = ClipData.newPlainText("LinkUp vault key", value)
        val token = UUID.randomUUID().toString()
        clip.description.extras = PersistableBundle().apply {
          putBoolean("android.content.extra.IS_SENSITIVE", true)
          putString("tiho.copy.token", token)
        }
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(clip)
        // Never clear something the user copied afterwards. Read only our
        // non-secret clip metadata; do not retain the key in this callback.
        Handler(Looper.getMainLooper()).postDelayed({
          runCatching {
            if (clipboard.primaryClipDescription?.extras?.getString("tiho.copy.token") == token) {
              if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip()
              else clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
            }
          }
        }, 60_000)
        Unit
      }
    }
    AsyncFunction("download") Coroutine { url: String, sha: String, bytes: Double, expectedCode: Double ->
      require(UpdatePolicy.source(url) && Regex("[a-f0-9]{64}").matches(sha)) { "Invalid update source." }
      require(bytes == bytes.toLong().toDouble() && bytes.toLong() in 1..UpdatePolicy.MAX_BYTES && expectedCode == expectedCode.toLong().toDouble() && expectedCode > 0) { "Invalid update size or version." }
      check(busy.compareAndSet(false, true)) { "An update is already downloading." }
      canceled = false
      verified = null
      val partial = File(folder, "tiho-update.part")
      try {
        withContext(Dispatchers.IO) {
          apk.delete(); partial.delete()
          val deadline = android.os.SystemClock.elapsedRealtime() + 300_000
          var next = url
          var redirects = 0
          while (true) {
            check(!canceled && android.os.SystemClock.elapsedRealtime() < deadline) { "Update download was canceled or timed out." }
            val c = URL(next).openConnection() as HttpsURLConnection
            connection = c
            c.instanceFollowRedirects = false
            c.connectTimeout = 15_000; c.readTimeout = 20_000
            c.setRequestProperty("Accept", "application/octet-stream")
            val status = c.responseCode
            if (status in listOf(301, 302, 303, 307, 308)) {
              val location = c.getHeaderField("Location") ?: error("Missing update redirect.")
              next = URL(URL(next), location).toString()
              c.disconnect()
              check(++redirects <= 5 && UpdatePolicy.redirect(next)) { "Untrusted update redirect." }
              continue
            }
            check(status == 200) { "GitHub could not download this update ($status)." }
            val length = c.contentLengthLong
            check(length == -1L || length == bytes.toLong()) { "Update size does not match its release." }
            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            c.inputStream.use { input -> partial.outputStream().use { output ->
              val buffer = ByteArray(64 * 1024)
              while (true) {
                check(!canceled && android.os.SystemClock.elapsedRealtime() < deadline) { "Update download was canceled or timed out." }
                val count = input.read(buffer)
                if (count == -1) break
                received += count
                check(received <= bytes.toLong()) { "Update is larger than its signed release." }
                digest.update(buffer, 0, count); output.write(buffer, 0, count)
              }
            } }
            check(received == bytes.toLong() && hex(digest.digest()) == sha) { "Update integrity verification failed." }
            validateApk(partial, expectedCode.toLong())
            check(!canceled && partial.renameTo(apk)) { "Could not save this update." }
            verified = Verified(sha, received, expectedCode.toLong())
            break
          }
        }
        true
      } finally {
        connection?.disconnect(); connection = null
        partial.delete(); busy.set(false)
        if (verified == null) apk.delete()
      }
    }
    AsyncFunction("cancel") { canceled = true; connection?.disconnect() }
    AsyncFunction("install") Coroutine { ->
      check(!busy.get()) { "Wait for the download to finish." }
      val v = verified ?: error("Download and verify the update first.")
      withContext(Dispatchers.IO) {
        check(apk.length() == v.bytes) { "Downloaded update changed. Download it again." }
        val digest = MessageDigest.getInstance("SHA-256")
        apk.inputStream().use { input -> val b = ByteArray(64 * 1024); while (true) { val n = input.read(b); if (n == -1) break; digest.update(b, 0, n) } }
        check(hex(digest.digest()) == v.sha) { "Downloaded update changed. Download it again." }
        validateApk(apk, v.code)
      }
      withContext(Dispatchers.Main) {
        val activity = appContext.currentActivity ?: error("Open LinkUp before installing an update.")
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
          activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
          "permission"
        } else {
          val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
          activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
          "installer"
        }
      }
    }
    OnDestroy { canceled = true; connection?.disconnect(); verified = null }
  }

  @Suppress("DEPRECATION")
  private fun flags() = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
  @Suppress("DEPRECATION")
  private fun installed() = context.packageManager.getPackageInfo(context.packageName, flags())
  @Suppress("DEPRECATION")
  private fun code(p: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong()
  @Suppress("DEPRECATION")
  private fun signers(p: PackageInfo): List<ByteArray> = (if (Build.VERSION.SDK_INT >= 28) p.signingInfo?.apkContentsSigners else p.signatures)?.map { it.toByteArray() } ?: emptyList()
  @Suppress("DEPRECATION")
  private fun validateApk(file: File, expected: Long) {
    val candidate = context.packageManager.getPackageArchiveInfo(file.absolutePath, flags()) ?: error("Invalid Android package.")
    val current = installed()
    check(UpdatePolicy.candidate(current.packageName, candidate.packageName, code(current), code(candidate), expected, signers(current), signers(candidate))) {
      "Update is not a newer LinkUp APK signed by this installation’s publisher."
    }
  }
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}
