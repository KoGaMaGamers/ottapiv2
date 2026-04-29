package fr.smartbunker.symbioplayer.nativeplayer

import android.app.Activity
import android.content.Intent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class StartPlayerArgs {
    lateinit var url: String
    var type: String = "live"
    var title: String? = ""
    var subtitle: String? = ""
    var channelData: String? = "{}"
    var resumePosition: Long = 0L
}

/**
 * Tauri 2.0 native-player plugin. Launches PlayerActivity and pipes
 * the result back to JS.
 *
 * Uses a static callback pattern instead of ActivityResultLauncher
 * because Tauri constructs plugins when the host Activity is already
 * RESUMED, and the non-lifecycle ActivityResultRegistry.register()
 * overload unreliably fires callbacks on subsequent launches.
 *
 * PlayerActivity calls NativePlayerPlugin.onPlayerFinished() directly
 * from its finishWithResult() method.
 */
@TauriPlugin
class NativePlayerPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /** Static callback — set before each launch, called by PlayerActivity. */
        var onResult: ((Intent?) -> Unit)? = null
    }

    private var pendingInvoke: Invoke? = null

    @Command
    fun startPlayer(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StartPlayerArgs::class.java)

            if (args.url.isEmpty()) {
                invoke.reject("Missing stream URL")
                return
            }

            // Clear any stale pending invoke
            pendingInvoke?.let { stale ->
                val cancel = JSObject()
                cancel.put("lastPosition", 0)
                cancel.put("lastDuration", 0)
                cancel.put("exitReason", "cancelled")
                cancel.put("errorMessage", "")
                cancel.put("errorId", "")
                cancel.put("selectedSubtitleLang", "")
                cancel.put("selectedAudioLang", "")
                stale.resolve(cancel)
            }

            pendingInvoke = invoke
            android.util.Log.d("NativePlayer", "startPlayer: setting callback and launching")

            // Set the static callback BEFORE starting the Activity
            onResult = { resultData -> handlePlayerResult(resultData) }

            val intent = Intent(activity, PlayerActivity::class.java).apply {
                putExtra("url", args.url)
                putExtra("type", args.type ?: "live")
                putExtra("title", args.title ?: "")
                putExtra("subtitle", args.subtitle ?: "")
                putExtra("channelData", args.channelData ?: "{}")
                putExtra("resumePosition", args.resumePosition)
            }

            activity.startActivity(intent)
        } catch (e: Exception) {
            pendingInvoke = null
            invoke.reject("Native player error: ${e.message}")
        }
    }

    private fun handlePlayerResult(data: Intent?) {
        android.util.Log.d("NativePlayer", "handlePlayerResult called, pendingInvoke=${pendingInvoke != null}")
        val invoke = pendingInvoke ?: return
        pendingInvoke = null

        val ret = JSObject()
        ret.put("lastPosition", data?.getLongExtra("lastPosition", 0) ?: 0)
        ret.put("lastDuration", data?.getLongExtra("lastDuration", 0) ?: 0)
        ret.put("exitReason", data?.getStringExtra("exitReason") ?: "back")
        ret.put("errorMessage", data?.getStringExtra("errorMessage") ?: "")
        ret.put("errorId", data?.getStringExtra("errorId") ?: "")
        ret.put("selectedSubtitleLang", data?.getStringExtra("selectedSubtitleLang") ?: "")
        ret.put("selectedAudioLang", data?.getStringExtra("selectedAudioLang") ?: "")
        android.util.Log.d("NativePlayer", "resolving invoke with exitReason=${ret.getString("exitReason")}")
        invoke.resolve(ret)
        android.util.Log.d("NativePlayer", "invoke.resolve() completed")
    }
}
