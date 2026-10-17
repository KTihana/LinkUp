// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush

internal object LinkUpAlerts {
  @Volatile var foreground = false
  @Volatile var activeThread = ""
  const val CHANNEL = "linkup.messages.v1"
  fun channels(c: Context) {
    if (Build.VERSION.SDK_INT >= 26) c.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH).apply { description = "Direct and group messages"; lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE })
  }
  fun permitted(c: Context) = (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) && NotificationManagerCompat.from(c).areNotificationsEnabled()
  fun open(c: Context, thread: String): PendingIntent {
    val route = when { thread.startsWith("peer:") -> "page=Conversation&peer=${thread.removePrefix("peer:")}"; thread.startsWith("group:") -> "page=Conversation&group=${thread.removePrefix("group:")}"; else -> "page=Chats" }
    val intent = c.packageManager.getLaunchIntentForPackage(c.packageName)!!.apply { data = Uri.parse("common:///?$route"); addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP) }
    return PendingIntent.getActivity(c, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
  fun generic(c: Context, text: String = "New activity · unlock LinkUp to receive messages") {
    if (!permitted(c) || !LinkUpNotificationStore.enabled(c)) return
    channels(c)
    runCatching { NotificationManagerCompat.from(c).notify("linkup.locked", 1, NotificationCompat.Builder(c, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("LinkUp").setContentText(text).setContentIntent(open(c, "")).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()) }
  }
  @Synchronized fun show(c: Context, thread: String, id: String, name: String, sender: String, text: String, createdAt: Long, canReply: Boolean) {
    if (!permitted(c) || !LinkUpNotificationStore.allowed(c)) return
    require(thread.matches(Regex("(?:peer:[a-f0-9]{64}|group:[a-f0-9]{32})")) && id.length <= 130 && name.length <= 60 && sender.length <= 50 && text.length <= 4000)
    val ledger = JSONArray(LinkUpNotificationStore.secret(c, "ledger") ?: "[]")
    for (i in 0 until ledger.length()) if (ledger.getString(i) == "$thread:$id") return
    if (foreground && activeThread == thread) {
      val kept = JSONArray(); for (i in maxOf(0, ledger.length() - 999) until ledger.length()) kept.put(ledger.getString(i)); kept.put("$thread:$id")
      LinkUpNotificationStore.secret(c, "ledger", kept.toString()); return
    }
    channels(c)
    val preview = LinkUpNotificationStore.prefs(c).getBoolean("previews", false)
    val title = name
    val body = if (preview) text.take(500) else if (canReply) "New message" else "Group invitation"
    val person = Person.Builder().setName(sender).build()
    val publicVersion = NotificationCompat.Builder(c, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("LinkUp").setContentText("New message").build()
    val reply = Intent(c, LinkUpReplyReceiver::class.java).apply { action = "linkup.REPLY"; data = Uri.parse("linkup-reply:///$thread"); putExtra("thread", thread) }
    val replyIntent = PendingIntent.getBroadcast(c, 0, reply, PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    val action = NotificationCompat.Action.Builder(android.R.drawable.ic_menu_send, "Reply", replyIntent).addRemoteInput(RemoteInput.Builder("reply").setLabel("Message").build()).setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).setAllowGeneratedReplies(false).setAuthenticationRequired(true).build()
    val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
    val previous = c.getSystemService(NotificationManager::class.java).activeNotifications.firstOrNull { it.tag == thread && it.id == 1 }
    previous?.notification?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }?.messages?.takeLast(5)?.forEach { style.addMessage(it) }
    style.addMessage(body, createdAt, person)
    if (thread.startsWith("group:")) style.setConversationTitle(title).setGroupConversation(true)
    val notification = NotificationCompat.Builder(c, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(body).setStyle(style).setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(publicVersion).setContentIntent(open(c, thread)).setAutoCancel(true).setOnlyAlertOnce(false).setGroup("linkup.messages").apply { if (canReply) addAction(action) }.build()
    NotificationManagerCompat.from(c).notify(thread, 1, notification)
    val summary = NotificationCompat.Builder(c, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("LinkUp").setContentText("New messages").setGroup("linkup.messages").setGroupSummary(true).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN).setContentIntent(open(c, "")).setOnlyAlertOnce(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
    NotificationManagerCompat.from(c).notify("linkup.summary", 2, summary)
    NotificationManagerCompat.from(c).cancel("linkup.locked", 1)
    val kept = JSONArray(); for (i in maxOf(0, ledger.length() - 999) until ledger.length()) kept.put(ledger.getString(i)); kept.put("$thread:$id")
    LinkUpNotificationStore.secret(c, "ledger", kept.toString())
  }
}

class LinkUpReplyReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != "linkup.REPLY") return
    // The explicit PendingIntent has a fixed data URI. Do not trust mutable
    // extras to choose a different recipient when RemoteInput fills it in.
    if (intent.data?.scheme != "linkup-reply") return
    val thread = intent.data?.path?.removePrefix("/") ?: return
    val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence("reply")?.toString() ?: return
    runCatching {
      LinkUpNotificationStore.enqueueReply(context, thread, text)
      LinkUpAlerts.generic(context, "Reply queued · sending when connected")
      LinkUpMessageWorker.enqueue(context)
    }.onFailure { LinkUpAlerts.generic(context, "Unlock your phone and open LinkUp to reply") }
  }
}

class LinkUpNotificationsModule : Module() {
  private val context: Context get() = appContext.reactContext ?: error("LinkUp unavailable")
  override fun definition() = ModuleDefinition {
    Name("LinkUpNotifications")
    Function("canAccess") { LinkUpNotificationStore.allowed(context) && LinkUpNotificationStore.deliveryAllowed(context) }
    Function("deliveryAllowed") { enabled: Boolean -> LinkUpNotificationStore.prefs(context).edit().putBoolean("deliveryAllowed", enabled).commit(); Unit }
    AsyncFunction("status") {
      mapOf("supported" to (Build.VERSION.SDK_INT >= 28), "enabled" to LinkUpNotificationStore.enabled(context), "permission" to LinkUpAlerts.permitted(context), "previews" to LinkUpNotificationStore.prefs(context).getBoolean("previews", false), "registered" to (LinkUpNotificationStore.prefs(context).getBoolean("registered", false) && System.currentTimeMillis() - LinkUpNotificationStore.prefs(context).getLong("registeredAt", 0) < 86400000), "error" to LinkUpNotificationStore.prefs(context).getString("error", ""), "distributors" to UnifiedPush.getDistributors(context), "distributorLabels" to UnifiedPush.getDistributors(context).associateWith { pkg -> runCatching { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(pkg, 0)).toString().take(60) }.getOrDefault("Push provider") })
    }
    AsyncFunction("enable") { key: String, baseline: String -> LinkUpNotificationStore.enable(context, key, baseline); LinkUpNotificationStore.prefs(context).edit().putLong("enabledAt", System.currentTimeMillis()).apply(); LinkUpAlerts.channels(context) }
    AsyncFunction("disable") { LinkUpNotificationStore.disable(context); runCatching { UnifiedPush.unregister(context) }; androidx.work.WorkManager.getInstance(context).cancelUniqueWork("linkup.messages"); NotificationManagerCompat.from(context).cancelAll() }
    AsyncFunction("register") { distributor: String, vapid: String ->
      check(LinkUpNotificationStore.enabled(context)); require(UnifiedPush.getDistributors(context).contains(distributor)); UnifiedPush.saveDistributor(context, distributor); UnifiedPush.register(context, messageForDistributor = "LinkUp private messages", vapid = vapid.ifEmpty { null })
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("previews") { enabled: Boolean -> check(LinkUpNotificationStore.enabled(context)); LinkUpNotificationStore.prefs(context).edit().putBoolean("previews", enabled).apply(); if (!enabled) NotificationManagerCompat.from(context).cancelAll() }
    AsyncFunction("key") { LinkUpNotificationStore.vaultKey(context) }
    AsyncFunction("registered") { LinkUpNotificationStore.prefs(context).edit().putBoolean("registered", true).putLong("registeredAt", System.currentTimeMillis()).putString("error", "").apply() }
    AsyncFunction("subscription") { LinkUpNotificationStore.secret(context, "subscription") }
    AsyncFunction("replies") { LinkUpNotificationStore.replies(context).toString() }
    AsyncFunction("acknowledge") { id: String -> LinkUpNotificationStore.acknowledge(context, id) }
    AsyncFunction("show") { thread: String, id: String, name: String, sender: String, text: String, createdAt: Double, canReply: Boolean -> LinkUpAlerts.show(context, thread, id, name, sender, text, createdAt.toLong(), canReply) }
    OnActivityEntersForeground { LinkUpAlerts.foreground = true }
    OnActivityEntersBackground { LinkUpAlerts.foreground = false }
    AsyncFunction("activeThread") { thread: String -> LinkUpAlerts.activeThread = thread; if (appContext.currentActivity?.hasWindowFocus() == true) LinkUpAlerts.foreground = true }
    AsyncFunction("clear") { thread: String ->
      NotificationManagerCompat.from(context).cancel(thread, 1); NotificationManagerCompat.from(context).cancel("linkup.locked", 1)
      if (context.getSystemService(NotificationManager::class.java).activeNotifications.none { it.tag?.startsWith("peer:") == true || it.tag?.startsWith("group:") == true }) NotificationManagerCompat.from(context).cancel("linkup.summary", 2)
    }
    AsyncFunction("wake") { if (LinkUpNotificationStore.enabled(context)) LinkUpMessageWorker.enqueue(context) }
    AsyncFunction("healthy") { LinkUpNotificationStore.prefs(context).edit().putString("error", "").apply() }
    AsyncFunction("problem") { LinkUpNotificationStore.prefs(context).edit().putString("error", "Background delivery is waiting. Check your connection, push provider and unsent replies.").apply() }
    AsyncFunction("finish") { id: String, success: Boolean -> LinkUpMessageWorker.finish(id, success) }
  }
}
