// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/** Visible lifetime for GoBackend's VPN service; no boot/always-on restart. */
class LinkUpVpnService : Service() {
  private val screenOff = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { if (intent.action == Intent.ACTION_SCREEN_OFF) LinkUpVpnController.requestStop() }
  }
  override fun onCreate() {
    super.onCreate()
    LinkUpVpnController.prepare(applicationContext)
    val channel = "linkup.private-network.v1"
    getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(channel, "Private network", NotificationManager.IMPORTANCE_LOW))
    val stop = PendingIntent.getService(this, 0, Intent(this, LinkUpVpnService::class.java).setAction("linkup.vpn.STOP"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    val notification = NotificationCompat.Builder(this, channel).setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .setContentTitle("LinkUp private network").setContentText("Private friend routes only · stops when your phone locks")
      .setContentIntent(open).setOngoing(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Disconnect", stop).build()
    ServiceCompat.startForeground(this, 7301, notification, if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
    ContextCompat.registerReceiver(this, screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED)
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "linkup.vpn.STOP" || intent == null) { LinkUpVpnController.requestStop(); stopSelf() }
    return START_NOT_STICKY
  }
  override fun onTaskRemoved(rootIntent: Intent?) { LinkUpVpnController.requestStop(); stopSelf(); super.onTaskRemoved(rootIntent) }
  override fun onDestroy() {
    runCatching { unregisterReceiver(screenOff) }
    if (LinkUpVpnController.connected || LinkUpVpnController.connecting) LinkUpVpnController.requestStop()
    super.onDestroy()
  }
  override fun onBind(intent: Intent?): IBinder? = null
}
