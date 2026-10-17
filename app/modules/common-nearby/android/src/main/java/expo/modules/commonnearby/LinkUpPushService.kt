// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import org.json.JSONObject
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

class LinkUpPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    if (!LinkUpNotificationStore.enabled(this)) return
    runCatching {
      val keys = endpoint.pubKeySet ?: error("Push encryption is required")
      val subscription = JSONObject().put("endpoint", endpoint.url).put("keys", JSONObject().put("p256dh", keys.pubKey).put("auth", keys.auth)).toString()
      LinkUpNotificationStore.secret(this, "subscription", subscription)
      LinkUpNotificationStore.prefs(this).edit().putBoolean("registered", false).putString("error", "").apply()
      LinkUpMessageWorker.enqueue(this)
    }.onFailure { LinkUpNotificationStore.prefs(this).edit().putString("error", "Open LinkUp to finish push registration").apply() }
  }
  override fun onMessage(message: PushMessage, instance: String) {
    if (!message.decrypted || message.content.size > 128 || (!LinkUpNotificationStore.enabled(this) || !LinkUpNotificationStore.deliveryAllowed(this))) return
    val wake = runCatching { JSONObject(message.content.toString(Charsets.UTF_8)) }.getOrNull() ?: return
    if (wake.optInt("version") != 1 || wake.optString("type") != "mailbox-wake") return
    // Push content is only a wakeup hint. All messages must independently pass
    // mailbox identity signatures, the accepted-contact check and MLS AEAD.
    if (!LinkUpNotificationStore.allowed(this)) LinkUpAlerts.generic(this)
    LinkUpMessageWorker.enqueue(this)
  }
  override fun onRegistrationFailed(reason: FailedReason, instance: String) { LinkUpNotificationStore.prefs(this).edit().putBoolean("registered", false).putString("error", "Push registration failed: ${reason.name}").apply() }
  override fun onUnregistered(instance: String) { LinkUpNotificationStore.prefs(this).edit().putBoolean("registered", false).putString("error", "Select your push provider again").remove("subscription").apply() }
  override fun onTempUnavailable(instance: String) { LinkUpNotificationStore.prefs(this).edit().putString("error", "Push provider temporarily unavailable").apply() }
}
