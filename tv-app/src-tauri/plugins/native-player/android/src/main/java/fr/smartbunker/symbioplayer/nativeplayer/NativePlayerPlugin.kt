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

@InvokeArg
class InlinePreviewBoundsArgs {
    lateinit var id: String
    var x: Double = 0.0
    var y: Double = 0.0
    var width: Double = 1.0
    var height: Double = 1.0
    var zIndex: Int = 1000
    var dpr: Double = 1.0
    var viewportWidth: Double = 0.0
    var viewportHeight: Double = 0.0
}

@InvokeArg
class InlinePreviewPlayArgs {
    lateinit var id: String
    lateinit var url: String
    var muted: Boolean = true
    var isLive: Boolean = true
    var startAtSec: Double = 0.0
    var videoCodecHint: String? = ""
    var audioCodecHint: String? = ""
}

@InvokeArg
class InlinePreviewIdArgs {
    lateinit var id: String
}

/**
 * Tauri 2.0 native-player plugin. Two surfaces:
 *
 *  - `startPlayer`: launches the fullscreen PlayerActivity for movies,
 *    series episodes, or live channels. Returns final position /
 *    exit reason / language picks via a static callback.
 *
 *  - `attach/update/play/stop/detach/stopAll inline previews`:
 *    floating ExoPlayer surfaces overlaid on the WebView at JS-
 *    supplied viewport coordinates. Used by the Live page hero to
 *    play the focused channel inline (the WebView <video> path
 *    can't because IPTV providers don't send CORS headers).
 *    Implementation is in `InlinePreviewManager`.
 */
@TauriPlugin
class NativePlayerPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /** Static callback — set before each launch, called by PlayerActivity. */
        var onResult: ((Intent?) -> Unit)? = null
    }

    private var pendingInvoke: Invoke? = null

    /** Lazy-initialized so the FrameLayout overlay isn't created until
     *  the first inline-preview attach actually arrives — saves a
     *  pointless addContentView for users who never hit the Live page. */
    private val inlinePreview: InlinePreviewManager by lazy {
        InlinePreviewManager(activity)
    }

    // ────────────────────────────────────────────────────────────────────
    // Fullscreen player
    // ────────────────────────────────────────────────────────────────────

    @Command
    fun startPlayer(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StartPlayerArgs::class.java)

            if (args.url.isEmpty()) {
                invoke.reject("Missing stream URL")
                return
            }

            // Tear down any inline previews — fullscreen and inline
            // can't share an ExoPlayer instance and we want all
            // resources concentrated on the fullscreen play.
            inlinePreview.stopAll()

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

    // ────────────────────────────────────────────────────────────────────
    // Inline previews
    // ────────────────────────────────────────────────────────────────────

    @Command
    fun attachInlinePreview(invoke: Invoke) {
        val args = invoke.parseArgs(InlinePreviewBoundsArgs::class.java)
        if (args.id.isBlank()) { invoke.reject("Missing preview id"); return }
        inlinePreview.attach(
            args.id, args.x, args.y, args.width, args.height,
            args.zIndex, args.viewportWidth, args.viewportHeight,
        )
        invoke.resolve()
    }

    @Command
    fun updateInlinePreview(invoke: Invoke) {
        val args = invoke.parseArgs(InlinePreviewBoundsArgs::class.java)
        if (args.id.isBlank()) { invoke.reject("Missing preview id"); return }
        inlinePreview.update(
            args.id, args.x, args.y, args.width, args.height,
            args.zIndex, args.viewportWidth, args.viewportHeight,
        )
        invoke.resolve()
    }

    @Command
    fun playInlinePreview(invoke: Invoke) {
        val args = invoke.parseArgs(InlinePreviewPlayArgs::class.java)
        if (args.id.isBlank() || args.url.isBlank()) {
            invoke.reject("Missing preview id or url")
            return
        }
        if (!inlinePreview.hasSession(args.id)) {
            invoke.reject("Preview surface not attached for id=${args.id}")
            return
        }
        inlinePreview.play(
            args.id, args.url,
            muted = args.muted,
            isLive = args.isLive,
            startAtSec = args.startAtSec,
            videoCodecHint = args.videoCodecHint ?: "",
            audioCodecHint = args.audioCodecHint ?: "",
        )
        invoke.resolve()
    }

    @Command
    fun stopInlinePreview(invoke: Invoke) {
        val args = invoke.parseArgs(InlinePreviewIdArgs::class.java)
        if (args.id.isBlank()) { invoke.reject("Missing preview id"); return }
        inlinePreview.stop(args.id)
        invoke.resolve()
    }

    @Command
    fun detachInlinePreview(invoke: Invoke) {
        val args = invoke.parseArgs(InlinePreviewIdArgs::class.java)
        if (args.id.isBlank()) { invoke.reject("Missing preview id"); return }
        inlinePreview.detach(args.id)
        invoke.resolve()
    }

    @Command
    fun stopAllInlinePreviews(invoke: Invoke) {
        inlinePreview.stopAll()
        invoke.resolve()
    }

    // ────────────────────────────────────────────────────────────────────
    // Lifecycle — pause/resume previews with the host Activity so they
    // don't keep streaming when the app is backgrounded.
    // ────────────────────────────────────────────────────────────────────

    override fun onPause() {
        super.onPause()
        inlinePreview.onPause()
    }

    override fun onResume() {
        super.onResume()
        inlinePreview.onResume()
    }

    override fun onDestroy() {
        inlinePreview.onDestroy()
        super.onDestroy()
    }
}
