package fr.smartbunker.symbioplayer.nativeplayer

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke

/**
 * JS-side argument shape for `start_player`. Must mirror the
 * `StartPlayerArgs` Rust struct's serde rename camel-case so Tauri's
 * JSON serialiser routes them through cleanly.
 *
 * Defaults match the legacy Capacitor plugin's behaviour so the JS
 * caller can omit anything but `url`.
 */
@InvokeArg
class StartPlayerArgs {
    lateinit var url: String
    var type: String = "live"
    var title: String = ""
    var subtitle: String = ""
    var channelData: String = "{}"
    var resumePosition: Long = 0L
}

/**
 * Tauri 2.0 port of the legacy `OttPlayerPlugin#startPlayer` —
 * launches `PlayerActivity` (the lifted ExoPlayer-based fullscreen
 * player) via `startActivityForResult` and pipes the close result back
 * to the JS caller as a JSObject.
 *
 * Drops all 6 inline-preview methods from the legacy plugin
 * (attach/update/play/stop/detach/stopAll); the WebView's `<video>`
 * preview is a better fit for the hero fade-out effect and the user
 * explicitly chose to keep it.
 */
@TauriPlugin
class NativePlayerPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun startPlayer(invoke: Invoke) {
        val args = invoke.parseArgs(StartPlayerArgs::class.java)

        if (args.url.isEmpty()) {
            invoke.reject("Missing stream URL")
            return
        }

        val intent = Intent(activity, PlayerActivity::class.java).apply {
            putExtra("url", args.url)
            putExtra("type", args.type)
            putExtra("title", args.title)
            putExtra("subtitle", args.subtitle)
            putExtra("channelData", args.channelData)
            putExtra("resumePosition", args.resumePosition)
        }

        // Tauri 2.0 mirrors Capacitor's pattern: pass the Invoke + a
        // method name; the framework reflectively dispatches to the
        // matching @ActivityCallback when the launched Activity returns.
        startActivityForResult(invoke, intent, "handlePlayerResult")
    }

    /**
     * Receives PlayerActivity's setResult() data and forwards it to
     * JS. Field names match the legacy plugin's JSObject keys so the
     * frontend's bindings keep working unchanged.
     */
    @ActivityCallback
    fun handlePlayerResult(invoke: Invoke, result: ActivityResult) {
        val ret = JSObject()
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            ret.put("lastPosition", data?.getLongExtra("lastPosition", 0) ?: 0)
            ret.put("lastDuration", data?.getLongExtra("lastDuration", 0) ?: 0)
            ret.put("exitReason", data?.getStringExtra("exitReason") ?: "back")
            ret.put("errorMessage", data?.getStringExtra("errorMessage") ?: "")
            ret.put("errorId", data?.getStringExtra("errorId") ?: "")
            ret.put("selectedSubtitleLang", data?.getStringExtra("selectedSubtitleLang") ?: "")
            ret.put("selectedAudioLang", data?.getStringExtra("selectedAudioLang") ?: "")
        } else {
            ret.put("lastPosition", 0)
            ret.put("lastDuration", 0)
            ret.put("exitReason", "cancelled")
            ret.put("errorMessage", "")
            ret.put("errorId", "")
            ret.put("selectedSubtitleLang", "")
            ret.put("selectedAudioLang", "")
        }
        invoke.resolve(ret)
    }
}
