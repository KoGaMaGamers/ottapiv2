package fr.smartbunker.symbioplayer.nativeplayer

import android.app.Activity
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * JS-side argument shape for `start_player`. Mirrors the Rust
 * `StartPlayerArgs` serde camel-case so Tauri's JSON router maps
 * cleanly. Defaults match the legacy Capacitor plugin so callers can
 * omit anything but `url`.
 */
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
 * Tauri 2.0 native-player plugin entry. Launches `PlayerActivity`
 * (the lifted ExoPlayer fullscreen player) and pipes the result back
 * to the JS caller.
 *
 * Registration note:
 *   Tauri constructs plugins when the host WryActivity is already in
 *   RESUMED state. The lifecycle-aware `registerForActivityResult`
 *   overload throws IllegalStateException if called after STARTED.
 *   We use the non-lifecycle `ActivityResultRegistry.register(key,
 *   contract, callback)` overload instead — it skips the lifecycle
 *   check and works at any point. We must manually unregister in
 *   onDestroy to avoid leaks.
 */
@TauriPlugin
class NativePlayerPlugin(private val activity: Activity) : Plugin(activity) {

    /** Pending Invoke kept across the activity-launch round-trip. */
    private var pendingInvoke: Invoke? = null

    private val playerLauncher: ActivityResultLauncher<Intent>

    init {
        val componentActivity = activity as ComponentActivity
        // Non-lifecycle overload: register(key, contract, callback)
        // Does NOT enforce "must register before STARTED" — safe to
        // call at any Activity lifecycle state.
        playerLauncher = componentActivity.activityResultRegistry.register(
            "native-player-launch",
            ActivityResultContracts.StartActivityForResult(),
            ActivityResultCallback { result -> handlePlayerResult(result) }
        )
    }

    override fun onDestroy() {
        playerLauncher.unregister()
        super.onDestroy()
    }

    @Command
    fun startPlayer(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StartPlayerArgs::class.java)

            if (args.url.isEmpty()) {
                invoke.reject("Missing stream URL")
                return
            }

            if (pendingInvoke != null) {
                invoke.reject("Player already launching")
                return
            }

            val intent = Intent(activity, PlayerActivity::class.java).apply {
                putExtra("url", args.url)
                putExtra("type", args.type ?: "live")
                putExtra("title", args.title ?: "")
                putExtra("subtitle", args.subtitle ?: "")
                putExtra("channelData", args.channelData ?: "{}")
                putExtra("resumePosition", args.resumePosition)
            }

            pendingInvoke = invoke
            playerLauncher.launch(intent)
        } catch (e: Exception) {
            invoke.reject("Native player error: ${e.message}")
        }
    }

    /**
     * Fires when PlayerActivity finishes. Mirrors the legacy
     * `handlePlayerResult` JSObject shape exactly so the JS bindings
     * keep working unchanged.
     */
    private fun handlePlayerResult(result: ActivityResult) {
        val invoke = pendingInvoke ?: return
        pendingInvoke = null

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
