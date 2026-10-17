// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import android.app.Activity
import android.content.Context
import android.net.VpnService
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LinkUpVpnModule : Module() {
  private val context: Context get() = appContext.reactContext ?: error("Open LinkUp first.")
  private var consentPromise: Promise? = null
  private var consentToken = 0L
  private val consentRequest = 47219
  private val listener: (Map<String, Any>) -> Unit = { sendEvent("change", it) }
  private fun perform(promise: Promise, task: () -> Any?) {
    LinkUpVpnController.prepare(context)
    LinkUpVpnController.executor.execute {
      try { promise.resolve(task()) }
      catch (error: Exception) {
        // Never forward underlying WireGuard/Keystore exceptions or configs to JS.
        val message = if (error is IllegalArgumentException || error is IllegalStateException) error.message else null
        promise.reject("PRIVATE_NETWORK", message ?: "The private network could not complete this action. Check enrollment and try again.", null)
      }
    }
  }
  private fun cancelConsent() {
    LinkUpVpnController.invalidate()
    consentPromise?.reject("CANCELLED", "Private network connection cancelled.", null); consentPromise = null
  }
  private fun connect(promise: Promise) {
    if (consentPromise != null || LinkUpVpnController.connecting) { promise.reject("BUSY", "Private network connection is already starting.", null); return }
    try {
      LinkUpVpnController.prepare(context)
      val activity = appContext.currentActivity ?: error("Open LinkUp before connecting.")
      check(!activity.isFinishing && !activity.isDestroyed)
      val intent = VpnService.prepare(activity)
      val token = LinkUpVpnController.token()
      if (intent == null) {
        perform(promise) { LinkUpVpnController.beginConnect(); LinkUpVpnController.connect(token) }
      } else {
        consentPromise = promise; consentToken = token
        // Mark connecting only after Android returns; leaving LinkUp during the
        // system consent dialog must not create a tunnel implicitly.
        activity.startActivityForResult(intent, consentRequest)
      }
    } catch (_: Exception) { consentPromise = null; promise.reject("PRIVATE_NETWORK", "Open LinkUp and approve Android's VPN request to connect.", null) }
  }
  override fun definition() = ModuleDefinition {
    Name("LinkUpVpn")
    Events("change")
    OnCreate { LinkUpVpnController.addListener(listener) }
    AsyncFunction("status") { promise: Promise -> perform(promise) { LinkUpVpnController.status() } }
    AsyncFunction("initialize") { identity: String, promise: Promise -> perform(promise) { LinkUpVpnController.initialize(identity) } }
    AsyncFunction("configure") { raw: String, promise: Promise -> cancelConsent(); perform(promise) { LinkUpVpnController.configure(raw) } }.runOnQueue(Queues.MAIN)
    AsyncFunction("connect") { promise: Promise -> connect(promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { promise: Promise -> cancelConsent(); perform(promise) { LinkUpVpnController.stop(); null } }.runOnQueue(Queues.MAIN)
    AsyncFunction("erase") { promise: Promise -> cancelConsent(); perform(promise) { LinkUpVpnController.erase(); null } }.runOnQueue(Queues.MAIN)
    OnActivityResult { _, result ->
      if (result.requestCode == consentRequest) {
        val promise = consentPromise; consentPromise = null
        if (promise != null) {
          val token = consentToken
          if (result.resultCode == Activity.RESULT_OK && !LinkUpVpnController.cancelled(token)) {
            perform(promise) { LinkUpVpnController.beginConnect(); LinkUpVpnController.connect(token) }
          } else promise.reject("CANCELLED", "Android VPN permission was not granted.", null)
        }
      }
    }
    OnActivityDestroys { cancelConsent(); LinkUpVpnController.requestStop() }
    OnDestroy { cancelConsent(); LinkUpVpnController.removeListener(listener); LinkUpVpnController.requestStop() }
  }
}
