package fr.smartbunker.symbioplayer.nativeplayer

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.media3.ui.PlayerView

/**
 * Inline native preview surfaces — floating ExoPlayer PlayerViews
 * positioned over the WebView at viewport coordinates supplied by JS.
 *
 * Lifted from `tv_app_v2/android/.../MainActivity.java` (the
 * inlinePreviewSessions map + 6 attach/update/play/stop/detach/stopAll
 * methods + applyPreviewBounds + ensureInlinePreviewRoot). Lives in
 * the plugin instead of the host Activity so MainActivity stays
 * stock — the plugin holds an instance per-Activity and its
 * lifecycle hooks pause/resume/release the active sessions.
 *
 * Why we need this at all
 * -----------------------
 * Tauri's WebView can't play live IPTV streams in a `<video>` element
 * (provider has no CORS) — and the Live hero is not a 60-second clip
 * but a continuous "watch the focused channel" surface. Native is
 * the only option, but the user explicitly wanted the surface to
 * render INLINE (over the hero region) rather than as a fullscreen
 * Activity. This manager makes that work.
 *
 * Threading: every public method posts to Activity.runOnUiThread so
 * callers from the Tauri JNI worker pool can fire-and-forget.
 */
class InlinePreviewManager(private val activity: Activity) {

    private val sessions = mutableMapOf<String, InlinePreviewSession>()
    private var previewRoot: FrameLayout? = null

    private class InlinePreviewSession(
        val id: String,
        val playerView: PlayerView,
        var playerManager: ExoPlayerManager?,
        var currentUrl: String = "",
        var currentIsLive: Boolean = true,
        var currentMuted: Boolean = true,
    )

    fun onPause() {
        activity.runOnUiThread {
            sessions.values.forEach { it.playerManager?.pause() }
        }
    }

    fun onResume() {
        activity.runOnUiThread {
            sessions.values.forEach { it.playerManager?.resume() }
        }
    }

    fun onDestroy() {
        activity.runOnUiThread {
            sessions.values.forEach {
                it.playerManager?.release()
                it.playerManager = null
            }
            previewRoot?.removeAllViews()
            sessions.clear()
        }
    }

    fun attach(
        id: String,
        x: Double, y: Double, width: Double, height: Double,
        zIndex: Int,
        viewportWidth: Double, viewportHeight: Double,
    ) {
        if (id.isBlank()) return
        activity.runOnUiThread {
            ensureRoot()
            removeOthers(id)
            val existing = sessions[id]
            if (existing == null) {
                val playerView = PlayerView(activity).apply {
                    useController = false
                    keepScreenOn = false
                    visibility = View.VISIBLE
                }
                val manager = ExoPlayerManager(activity)
                playerView.player = manager.initialize(true)
                val session = InlinePreviewSession(id, playerView, manager)
                sessions[id] = session
                previewRoot!!.addView(playerView)
                playerView.translationZ = maxOf(DEFAULT_Z, zIndex).toFloat()
                playerView.bringToFront()
                if (!applyBounds(playerView, x, y, width, height, zIndex, viewportWidth, viewportHeight)) {
                    previewRoot?.post {
                        applyBounds(playerView, x, y, width, height, zIndex, viewportWidth, viewportHeight)
                    }
                }
            } else {
                if (!applyBounds(existing.playerView, x, y, width, height, zIndex, viewportWidth, viewportHeight)) {
                    previewRoot?.post {
                        applyBounds(existing.playerView, x, y, width, height, zIndex, viewportWidth, viewportHeight)
                    }
                }
            }
        }
    }

    fun update(
        id: String,
        x: Double, y: Double, width: Double, height: Double,
        zIndex: Int,
        viewportWidth: Double, viewportHeight: Double,
    ) {
        if (id.isBlank()) return
        activity.runOnUiThread {
            val s = sessions[id] ?: return@runOnUiThread
            if (!applyBounds(s.playerView, x, y, width, height, zIndex, viewportWidth, viewportHeight)) {
                previewRoot?.post {
                    applyBounds(s.playerView, x, y, width, height, zIndex, viewportWidth, viewportHeight)
                }
            }
        }
    }

    /** Returns false if no session exists for this id. */
    fun hasSession(id: String): Boolean = sessions.containsKey(id)

    fun play(
        id: String,
        url: String,
        muted: Boolean,
        isLive: Boolean,
        startAtSec: Double,
        videoCodecHint: String?,
        audioCodecHint: String?,
    ) {
        if (id.isBlank() || url.isBlank()) return
        activity.runOnUiThread {
            val s = sessions[id] ?: return@runOnUiThread

            // ExoPlayer's live vs VOD configuration differs (live-edge
            // tolerance, buffer targets) so swap the manager when the
            // mode changes. Most callers stay one mode for a session.
            if (s.playerManager == null || s.currentIsLive != isLive) {
                s.playerManager?.release()
                s.playerManager = ExoPlayerManager(activity)
                s.playerView.player = s.playerManager!!.initialize(isLive)
            }

            if (url != s.currentUrl || s.currentIsLive != isLive) {
                val startMs = (startAtSec * 1000.0).toLong().coerceAtLeast(0L)
                s.playerManager!!.play(
                    url,
                    isLive = isLive,
                    resumePositionMs = startMs,
                    videoCodecHint = videoCodecHint?.ifBlank { null },
                    audioCodecHint = audioCodecHint?.ifBlank { null },
                )
                s.currentUrl = url
                s.currentIsLive = isLive
            } else {
                s.playerManager?.resume()
            }

            s.playerManager?.player?.volume = if (muted) 0f else 1f
            s.currentMuted = muted
        }
    }

    fun stop(id: String) {
        if (id.isBlank()) return
        activity.runOnUiThread {
            val s = sessions[id] ?: return@runOnUiThread
            s.playerManager?.release()
            s.playerManager = null
            s.currentUrl = ""
        }
    }

    fun detach(id: String) {
        if (id.isBlank()) return
        activity.runOnUiThread {
            val s = sessions.remove(id) ?: return@runOnUiThread
            s.playerManager?.release()
            previewRoot?.removeView(s.playerView)
        }
    }

    fun stopAll() {
        activity.runOnUiThread {
            sessions.values.forEach { s ->
                s.playerManager?.release()
                s.playerManager = null
                s.currentUrl = ""
            }
            previewRoot?.removeAllViews()
            sessions.clear()
        }
    }

    private fun removeOthers(keepId: String) {
        if (sessions.isEmpty()) return
        val ids = sessions.keys.toList()
        for (id in ids) {
            if (id == keepId) continue
            val s = sessions.remove(id) ?: continue
            s.playerManager?.release()
            s.playerManager = null
            s.currentUrl = ""
            previewRoot?.removeView(s.playerView)
        }
    }

    private fun ensureRoot() {
        if (previewRoot != null) return
        val root = FrameLayout(activity).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            clipChildren = true
            clipToPadding = true
        }
        previewRoot = root
        // addContentView layers the FrameLayout over whatever the host
        // Activity has set as content (Tauri's WebView). MATCH_PARENT
        // sized; preview surfaces inside are then absolute-positioned
        // via leftMargin/topMargin computed from the JS viewport coords.
        activity.addContentView(root, root.layoutParams)
    }

    /**
     * Maps JS viewport coordinates (CSS pixels with origin at top-left
     * of the WebView) into native pixel coordinates of `previewRoot`.
     * Returns false when the root hasn't laid out yet so the caller
     * can re-post the call after `previewRoot.post {}`.
     */
    private fun applyBounds(
        playerView: PlayerView,
        x: Double, y: Double, width: Double, height: Double,
        zIndex: Int,
        viewportWidth: Double, viewportHeight: Double,
    ): Boolean {
        val rootW = previewRoot?.width ?: 0
        val rootH = previewRoot?.height ?: 0
        val hasViewport = viewportWidth > 1.0 && viewportHeight > 1.0
        if (!hasViewport || rootW <= 1 || rootH <= 1) return false

        val sx = rootW / viewportWidth
        val sy = rootH / viewportHeight

        val px = (x * sx).toInt()
        val py = (y * sy).toInt()
        val pw = maxOf(1, (width * sx).toInt())
        val ph = maxOf(1, (height * sy).toInt())
        val lp = FrameLayout.LayoutParams(pw, ph).apply {
            leftMargin = px
            topMargin = py
        }
        playerView.layoutParams = lp
        playerView.translationZ = maxOf(DEFAULT_Z, zIndex).toFloat()
        return true
    }

    companion object {
        private const val DEFAULT_Z = 1000
    }
}
