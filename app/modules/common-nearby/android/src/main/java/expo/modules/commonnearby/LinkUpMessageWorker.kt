// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.content.Context
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// WorkManager owns the wakelock/retries. No perpetual foreground service or
// polling timer, and no background service-start exemption is assumed.
class LinkUpMessageWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
  override fun doWork(): Result {
    if (!LinkUpNotificationStore.enabled(applicationContext) || !LinkUpNotificationStore.deliveryAllowed(applicationContext)) return Result.success()
    if (!LinkUpNotificationStore.allowed(applicationContext)) {
      LinkUpAlerts.generic(applicationContext)
      return if (runAttemptCount < 12) Result.retry() else Result.success()
    }
    val job = java.util.UUID.randomUUID().toString(); val completion = Completion()
    val host = (applicationContext as ReactApplication).reactHost ?: return Result.retry()
    jobs[job] = completion
    var listener: ReactInstanceEventListener? = null
    UiThreadUtil.runOnUiThread {
      fun start(context: ReactContext) {
        if (!jobs.containsKey(job)) return
        val data = Arguments.createMap().apply { putString("jobId", job) }
        HeadlessJsTaskContext.getInstance(context).startTask(HeadlessJsTaskConfig("LinkUpMessages", data, 65000, true))
      }
      val context = host.currentReactContext
      if (context != null) start(context)
      else {
        listener = object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) { host.removeReactInstanceEventListener(this); start(context) }
        }
        host.addReactInstanceEventListener(listener!!); host.start()
      }
    }
    return try {
      if (completion.latch.await(75, TimeUnit.SECONDS) && completion.success) Result.success()
      else if (runAttemptCount < 12) Result.retry() else Result.failure()
    } finally {
      jobs.remove(job)
      listener?.let { host.removeReactInstanceEventListener(it) }
    }
  }
  companion object {
    private class Completion { val latch = CountDownLatch(1); @Volatile var success = false }
    private val jobs = ConcurrentHashMap<String, Completion>()
    fun finish(id: String, success: Boolean) { jobs[id]?.let { it.success = success; it.latch.countDown() } }
    private val enqueuer = java.util.concurrent.Executors.newSingleThreadExecutor()
    fun enqueue(c: Context) {
      val app = c.applicationContext
      enqueuer.execute { runCatching { enqueueBounded(app) } }
    }
    private fun enqueueBounded(c: Context) {
      if (!LinkUpNotificationStore.enabled(c)) return
      val manager = WorkManager.getInstance(c)
      if (manager.getWorkInfosForUniqueWork("linkup.messages").get(5, TimeUnit.SECONDS).count { !it.state.isFinished } >= 2) return
      val request = OneTimeWorkRequestBuilder<LinkUpMessageWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
        // Older Android versions emulate expedited jobs with a foreground
        // service. Use ordinary work there without assuming that exemption.
        .apply { if (Build.VERSION.SDK_INT >= 31) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST) }.build()
      manager.enqueueUniqueWork("linkup.messages", ExistingWorkPolicy.APPEND_OR_REPLACE, request).result.get(5, TimeUnit.SECONDS)
    }
  }
}
