package expo.modules.commonnearby

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues

class TihoCallAudioModule : Module() {
  private var routing = false
  private val audio: AudioManager
    get() = appContext.reactContext!!.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  @Suppress("DEPRECATION")
  private fun stopAudio() {
    if (!routing) return
    routing = false
    val manager = audio
    if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice()
    else manager.isSpeakerphoneOn = false
    manager.mode = AudioManager.MODE_NORMAL
  }

  @Suppress("DEPRECATION")
  override fun definition() = ModuleDefinition {
    Name("TihoCallAudio")
    AsyncFunction("speaker") { enabled: Boolean ->
      val manager = audio
      manager.mode = AudioManager.MODE_IN_COMMUNICATION
      routing = true
      if (Build.VERSION.SDK_INT >= 31) {
        val kind = if (enabled) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        val device = manager.availableCommunicationDevices.firstOrNull { it.type == kind }
        if (device != null && !manager.setCommunicationDevice(device)) throw IllegalStateException("Audio output unavailable")
        if (device == null && !enabled) manager.clearCommunicationDevice()
      } else manager.isSpeakerphoneOn = enabled
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { stopAudio() }.runOnQueue(Queues.MAIN)
    OnDestroy { runCatching { stopAudio() } }
  }
}
