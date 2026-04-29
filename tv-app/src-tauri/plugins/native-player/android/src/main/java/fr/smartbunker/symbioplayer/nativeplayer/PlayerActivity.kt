package fr.smartbunker.symbioplayer.nativeplayer

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.Player
import androidx.media3.ui.PlayerView
import fr.smartbunker.symbioplayer.nativeplayer.R
import org.json.JSONObject
import java.net.URI

class PlayerActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PlayerActivity"
    }

    private lateinit var playerManager: ExoPlayerManager
    private lateinit var playerView: PlayerView
    private lateinit var loadingOverlay: View
    private lateinit var errorOverlay: View
    private lateinit var errorMessage: TextView
    private lateinit var retryButton: Button

    private var streamUrl: String = ""
    private var originalLiveUrl: String = ""
    private var streamType: String = "live"
    private var streamTitle: String = ""
    private var streamSubtitle: String = ""
    private var resumePosition: Long = 0L
    private var liveOverlay: LiveOverlayManager? = null
    private var vodOverlay: VodOverlayManager? = null
    private var liveData: LivePlayerData? = null
    private var isCatchupActive = false
    private var currentAudioCodecHint: String? = null
    private var currentVideoCodecHint: String? = null
    private var lastErrorText: String = ""
    private var lastErrorId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterImmersiveMode()

        setContentView(R.layout.activity_player)

        playerView = findViewById(R.id.playerView)
        loadingOverlay = findViewById(R.id.loadingOverlay)
        errorOverlay = findViewById(R.id.errorOverlay)
        errorMessage = findViewById(R.id.errorMessage)
        retryButton = findViewById(R.id.retryButton)

        streamUrl = intent.getStringExtra("url") ?: ""
        streamType = intent.getStringExtra("type") ?: "live"
        streamTitle = intent.getStringExtra("title") ?: ""
        streamSubtitle = intent.getStringExtra("subtitle") ?: ""
        resumePosition = intent.getLongExtra("resumePosition", 0L)

        android.util.Log.d(TAG, "onCreate | type=$streamType | url=$streamUrl | isLive=${isLiveMode()}")

        playerManager = ExoPlayerManager(this)
        val player = playerManager.initialize(isLive = isLiveMode())

        playerView.player = player
        playerView.keepScreenOn = true

        playerManager.onStateChange = { state ->
            runOnUiThread {
                android.util.Log.d(TAG, "onStateChange: $state (READY=${Player.STATE_READY}) catchup=$isCatchupActive")
                when (state) {
                    Player.STATE_BUFFERING -> {
                        loadingOverlay.visibility = View.VISIBLE
                        errorOverlay.visibility = View.GONE
                    }
                    Player.STATE_READY -> {
                        loadingOverlay.visibility = View.GONE
                        errorOverlay.visibility = View.GONE
                        onPlaybackReady()
                    }
                    Player.STATE_ENDED -> {
                        if (isLiveMode()) {
                            android.util.Log.w(TAG, "STATE_ENDED in live mode — returning to live stream")
                            returnToLiveStream()
                        } else {
                            finishWithResult("ended")
                        }
                    }
                    Player.STATE_IDLE -> {}
                }
            }
        }

        playerManager.onError = { error ->
            android.util.Log.e(TAG, "ExoPlayer error: ${error.errorCodeName} | cause: ${error.cause?.message} | catchup=$isCatchupActive | url: $streamUrl", error)
            runOnUiThread {
                if (isLiveMode() && isCatchupActive) {
                    android.util.Log.w(TAG, "Catchup playback failed — returning to live stream")
                    returnToLiveStream()
                } else {
                    loadingOverlay.visibility = View.GONE
                    errorOverlay.visibility = View.VISIBLE
                    val errorId = classifyPlaybackErrorId(error)
                    val msg = buildReadablePlaybackError(error, errorId)
                    lastErrorId = errorId
                    lastErrorText = msg
                    android.util.Log.e(TAG, "Playback failure details:\n$msg")
                    errorMessage.text = msg
                }
            }
        }

        retryButton.setOnClickListener {
            errorOverlay.visibility = View.GONE
            loadingOverlay.visibility = View.VISIBLE
            startPlayback()
        }

        if (isLiveMode()) {
            setupLiveOverlay()
        } else {
            setupVodOverlay()
        }

        loadingOverlay.visibility = View.VISIBLE
        startPlayback()

        // Register back handler via onBackPressedDispatcher — required on
        // Android 13+ where predictive back bypasses onKeyDown entirely.
        // On Android TV, both onKeyDown and the dispatcher may fire for the
        // same back press — onKeyDown now just returns true (consumed) without
        // calling handleBackNavigation(), letting this be the single handler.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                handleBackNavigation()
            }
        })
    }

    /**
     * JS sends `type: "episode"` (matches PlayerOpen.kind) but legacy
     * Capacitor sent `type: "series"`. Accept both so prev/next
     * episode buttons + media-key skip handlers light up regardless
     * of which JS layer launched us.
     */
    private fun isSeriesMode(): Boolean =
        streamType == "series" || streamType == "episode"

    private fun handleBackNavigation() {
        // Live: catchup -> overlay-dismiss -> exit. Mirrors the VOD
        // layered-back pattern below so a single BACK press while the
        // overlay is visible just hides it (lets the user keep
        // watching the channel uncluttered). A second BACK with the
        // overlay already hidden exits the player.
        if (isLiveMode()) {
            if (isCatchupActive) {
                android.util.Log.d(TAG, "handleBackNavigation: catchup → returnToLiveStream")
                returnToLiveStream()
                return
            }
            val consumed = liveOverlay?.handleKeyBack() == true
            android.util.Log.d(
                TAG,
                "handleBackNavigation: live overlay handleKeyBack consumed=$consumed",
            )
            if (consumed) return
            finishWithResult("back")
            return
        }

        // VOD keeps layered dismissal: submenu -> overlay -> exit.
        if (vodOverlay?.handleKeyBack() == true) return
        finishWithResult("back")
    }

    private fun onPlaybackReady() {
        if (isLiveMode()) {
            android.util.Log.d(TAG, "Playback ready (live) → showing overlay")
            liveOverlay?.showWithTimer()
        } else {
            android.util.Log.d(TAG, "Playback ready (VOD) → showing overlay")
            vodOverlay?.applyPreferredSelections()
            vodOverlay?.showWithTimer()
        }
    }

    private fun returnToLiveStream() {
        android.util.Log.d(TAG, "returnToLiveStream | originalLiveUrl=$originalLiveUrl")
        isCatchupActive = false
        liveOverlay?.onCatchupFailed()
        errorOverlay.visibility = View.GONE
        if (originalLiveUrl.isNotBlank()) {
            streamUrl = originalLiveUrl
            loadingOverlay.visibility = View.VISIBLE
            playerManager.play(
                originalLiveUrl,
                isLive = true,
                videoCodecHint = currentVideoCodecHint,
                audioCodecHint = currentAudioCodecHint,
            )
        }
    }

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private fun setupVodOverlay() {
        playerView.useController = false

        val rootFrame = findViewById<FrameLayout>(R.id.playerRoot)
            ?: (playerView.parent as? FrameLayout)
        if (rootFrame == null) {
            android.util.Log.e(TAG, "setupVodOverlay | rootFrame not found")
            return
        }

        val overlayView = LayoutInflater.from(this).inflate(R.layout.overlay_vod, rootFrame, false)
        rootFrame.addView(overlayView)

        val seriesMode = isSeriesMode()

        vodOverlay = VodOverlayManager(
            root = overlayView,
            playerManager = playerManager,
            onBack = { finishWithResult("back") },
            onPrevEpisode = if (seriesMode) {{ finishWithResult("prev_episode") }} else null,
            onNextEpisode = if (seriesMode) {{ finishWithResult("next_episode") }} else null,
            isSeries = seriesMode,
        )

        vodOverlay?.initialize(streamTitle, streamSubtitle)

        // Set up SubtitleManager with TMDB metadata for on-demand fetching
        val cueView: TextView = overlayView.findViewById(R.id.vodSubtitleCue)
        // Keep subtitle cues visible even when the action overlay auto-hides:
        // move the cue view outside the fading `vodOverlayRoot` container.
        (cueView.parent as? ViewGroup)?.removeView(cueView)
        rootFrame.addView(cueView)
        val subMgr = SubtitleManager(cueView, playerManager)

        // Extract tmdb_id, season, episode from channelData for on-demand subtitle API calls
        val channelDataJson = intent.getStringExtra("channelData") ?: "{}"
        try {
            val json = JSONObject(channelDataJson)
            subMgr.tmdbId = json.optString("tmdb_id", "")
            subMgr.season = json.optInt("season", 0)
            subMgr.episode = json.optInt("episode", 0)
            currentAudioCodecHint = json.optString("audioCodec", "")
            currentVideoCodecHint = json.optString("videoCodec", "")
            vodOverlay?.setPreferredSelections(
                subtitleLang = json.optString("preferredSubtitleLang", ""),
                audioLang = json.optString("preferredAudioLang", ""),
            )
        } catch (e: Exception) {
            android.util.Log.e(TAG, "Failed to parse channelData for subtitle metadata", e)
        }

        vodOverlay?.subtitleManager = subMgr
        android.util.Log.d(TAG, "setupVodOverlay | initialized: title=$streamTitle | tmdb=${subMgr.tmdbId}")
    }

    // Subtitle tracks are now fetched on demand by SubtitleManager

    private fun isLiveMode(): Boolean {
        return streamType == "live" || streamType == "catchup"
    }

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private fun setupLiveOverlay() {
        playerView.useController = false

        val channelDataJson = intent.getStringExtra("channelData") ?: "{}"
        android.util.Log.d(TAG, "setupLiveOverlay | channelData length=${channelDataJson.length}")

        liveData = LivePlayerData.fromJson(channelDataJson)
        if (liveData == null) {
            android.util.Log.e(TAG, "setupLiveOverlay | FAILED to parse channelData, falling back to VOD overlay")
            setupVodOverlay()
            return
        }

        val data = liveData!!
        android.util.Log.d(TAG, "setupLiveOverlay | channels=${data.channels.size} currentIndex=${data.currentIndex} base=${data.baseStreamUrl}")
        data.channels.getOrNull(data.currentIndex)?.let { ch ->
            currentAudioCodecHint = ch.audioCodec
            currentVideoCodecHint = ch.videoCodec
        }

        val rootFrame = findViewById<FrameLayout>(R.id.playerRoot)
            ?: (playerView.parent as? FrameLayout)
        if (rootFrame == null) {
            android.util.Log.e(TAG, "setupLiveOverlay | rootFrame not found, falling back to VOD overlay")
            setupVodOverlay()
            return
        }

        val overlayView = LayoutInflater.from(this).inflate(R.layout.overlay_live, rootFrame, false)
        rootFrame.addView(overlayView)

        liveOverlay = LiveOverlayManager(
            root = overlayView,
            liveData = data,
            onChannelZap = { newIndex, newUrl ->
                isCatchupActive = false
                streamUrl = newUrl
                originalLiveUrl = newUrl
                data.channels.getOrNull(newIndex)?.let { ch ->
                    currentAudioCodecHint = ch.audioCodec
                    currentVideoCodecHint = ch.videoCodec
                }
                playerManager.play(
                    newUrl,
                    isLive = true,
                    videoCodecHint = currentVideoCodecHint,
                    audioCodecHint = currentAudioCodecHint,
                )
            },
            onCatchup = { catchupUrl ->
                android.util.Log.d(TAG, "Starting catchup: $catchupUrl")
                isCatchupActive = true
                playerManager.play(
                    catchupUrl,
                    isLive = true,
                    videoCodecHint = currentVideoCodecHint,
                    audioCodecHint = currentAudioCodecHint,
                )
            },
            onBackToLive = { currentChannelIndex ->
                isCatchupActive = false
                val ch = data.channels.getOrNull(currentChannelIndex)
                if (ch != null) {
                    currentAudioCodecHint = ch.audioCodec
                    currentVideoCodecHint = ch.videoCodec
                    val liveUrl = EpgService.buildLiveStreamUrl(
                        data.baseStreamUrl,
                        data.username,
                        data.password,
                        ch.streamId,
                        data.preferredOutput,
                    )
                    streamUrl = liveUrl
                    originalLiveUrl = liveUrl
                    playerManager.play(
                        liveUrl,
                        isLive = true,
                        videoCodecHint = currentVideoCodecHint,
                        audioCodecHint = currentAudioCodecHint,
                    )
                }
            },
            onClose = { finishWithResult("back") },
        )

        liveOverlay?.initialize()
        android.util.Log.d(TAG, "setupLiveOverlay | overlay initialized successfully")
    }

    private fun startPlayback() {
        android.util.Log.d(TAG, "startPlayback | type=$streamType | url=$streamUrl | resume=$resumePosition")
        if (isLiveMode() && originalLiveUrl.isBlank()) {
            originalLiveUrl = streamUrl
        }
        val isLive = streamType == "live" || streamType == "catchup"
        playerManager.play(
            streamUrl,
            isLive,
            resumePosition,
            videoCodecHint = currentVideoCodecHint,
            audioCodecHint = currentAudioCodecHint,
        )
    }

    private fun buildReadablePlaybackError(
        error: androidx.media3.common.PlaybackException,
        errorId: String,
    ): String {
        val root = rootCause(error)
        val rootMessage = root?.message?.trim().orEmpty()
        val category = when {
            isOutOfMemory(root) -> "Memory pressure"
            root is java.net.SocketTimeoutException ||
                error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
                "Network timeout"
            root is java.io.IOException -> "Network/stream error"
            error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_DECODER_INIT_FAILED ||
                error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_DECODING_FAILED ->
                "Decoder error"
            else -> "Playback error"
        }

        val streamKind = when (streamType.lowercase()) {
            "series" -> "Series"
            "vod" -> "VOD"
            "live" -> "Live"
            "catchup" -> "Catchup"
            else -> streamType
        }
        val host = try {
            URI(streamUrl).host ?: "unknown-host"
        } catch (_: Exception) {
            "unknown-host"
        }

        val primary = when {
            rootMessage.isNotBlank() -> rootMessage
            error.localizedMessage?.isNotBlank() == true -> error.localizedMessage!!
            else -> getString(R.string.stream_unavailable)
        }

        return buildString {
            appendLine("$category while loading stream.")
            appendLine("Error ID: $errorId")
            appendLine("Type: $streamKind")
            appendLine("Title: ${streamTitle.ifBlank { "Unknown title" }}")
            appendLine("Host: $host")
            appendLine("Code: ${error.errorCodeName}")
            append("Details: $primary")
        }
    }

    private fun classifyPlaybackErrorId(error: androidx.media3.common.PlaybackException): String {
        val root = rootCause(error)
        return when {
            isOutOfMemory(root) -> "ERR_MEM"
            root is java.net.SocketTimeoutException ||
                error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
                "ERR_NET_TIMEOUT"
            root is java.io.IOException -> "ERR_NET_IO"
            error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_DECODER_INIT_FAILED ->
                "ERR_DECODER_INIT"
            error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_DECODING_FAILED ->
                "ERR_DECODER_RUNTIME"
            error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW ->
                "ERR_LIVE_WINDOW"
            else -> "ERR_PLAYBACK"
        }
    }

    private fun rootCause(error: Throwable): Throwable {
        var current: Throwable = error
        while (current.cause != null && current.cause !== current) {
            current = current.cause!!
        }
        return current
    }

    private fun isOutOfMemory(cause: Throwable?): Boolean {
        var current = cause
        while (current != null) {
            if (current is OutOfMemoryError) return true
            if (current.message?.contains("OutOfMemoryError", ignoreCase = true) == true) return true
            current = current.cause
        }
        return false
    }

    private fun finishWithResult(reason: String) {
        val selectedSubtitleLang = vodOverlay?.getSelectedSubtitleLanguage()
        val selectedAudioLang = vodOverlay?.getSelectedAudioLanguage()
        val resultIntent = Intent().apply {
            putExtra("lastPosition", playerManager.getCurrentPosition())
            putExtra("lastDuration", playerManager.getDuration())
            putExtra("exitReason", reason)
            putExtra("errorMessage", lastErrorText)
            putExtra("errorId", lastErrorId)
            putExtra("selectedSubtitleLang", selectedSubtitleLang)
            putExtra("selectedAudioLang", selectedAudioLang)
        }
        // Deliver result via static callback (reliable, no ActivityResultRegistry).
        // Also set Activity result as fallback.
        NativePlayerPlugin.onResult?.invoke(resultIntent)
        NativePlayerPlugin.onResult = null
        setResult(Activity.RESULT_OK, resultIntent)
        finish()
    }

    @Suppress("DEPRECATION")
    private fun enterImmersiveMode() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // Consume BACK/ESCAPE on key-down but defer finish() to onKeyUp.
        // If we finish() here, the activity destroys before key-up arrives,
        // and the orphaned key-up event propagates to WryActivity, causing
        // a duplicate back navigation in the WebView.
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
            return true
        }

        // Live mode: delegate to overlay manager
        if (isLiveMode() && liveOverlay != null) {
            when (keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> return liveOverlay!!.handleKeyLeft()
                KeyEvent.KEYCODE_DPAD_RIGHT -> return liveOverlay!!.handleKeyRight()
                KeyEvent.KEYCODE_DPAD_UP -> return liveOverlay!!.handleKeyUp()
                KeyEvent.KEYCODE_DPAD_DOWN -> return liveOverlay!!.handleKeyDown()
                KeyEvent.KEYCODE_DPAD_CENTER,
                KeyEvent.KEYCODE_ENTER,
                KeyEvent.KEYCODE_NUMPAD_ENTER,
                KeyEvent.KEYCODE_BUTTON_A,
                KeyEvent.KEYCODE_BUTTON_SELECT ->
                    return liveOverlay!!.handleKeyEnter()
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                    if (playerManager.isPlaying()) playerManager.pause()
                    else playerManager.resume()
                    liveOverlay?.onUserInteraction()
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_PLAY -> {
                    playerManager.resume()
                    liveOverlay?.onUserInteraction()
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                    playerManager.pause()
                    liveOverlay?.onUserInteraction()
                    return true
                }
            }
            liveOverlay?.onUserInteraction()
            return super.onKeyDown(keyCode, event)
        }

        // VOD mode: delegate to VOD overlay manager
        if (vodOverlay != null) {
            when (keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER,
                KeyEvent.KEYCODE_ENTER,
                KeyEvent.KEYCODE_NUMPAD_ENTER,
                KeyEvent.KEYCODE_BUTTON_A,
                KeyEvent.KEYCODE_BUTTON_SELECT ->
                    return vodOverlay!!.handleKeyCenter()
                KeyEvent.KEYCODE_DPAD_LEFT ->
                    return vodOverlay!!.handleKeyLeft()
                KeyEvent.KEYCODE_DPAD_RIGHT ->
                    return vodOverlay!!.handleKeyRight()
                KeyEvent.KEYCODE_DPAD_UP ->
                    return vodOverlay!!.handleKeyUp()
                KeyEvent.KEYCODE_DPAD_DOWN ->
                    return vodOverlay!!.handleKeyDown()
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                    if (playerManager.isPlaying()) playerManager.pause()
                    else playerManager.resume()
                    vodOverlay?.onUserInteraction()
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_PLAY -> {
                    playerManager.resume()
                    vodOverlay?.onUserInteraction()
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                    playerManager.pause()
                    vodOverlay?.onUserInteraction()
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_STEP_BACKWARD -> {
                    playerManager.seekBy(-30_000)
                    vodOverlay?.onUserInteraction()
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_STEP_FORWARD -> {
                    playerManager.seekBy(30_000)
                    vodOverlay?.onUserInteraction()
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_NEXT -> {
                    if (isSeriesMode()) finishWithResult("next_episode")
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                    if (isSeriesMode()) finishWithResult("prev_episode")
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD -> {
                    if (isSeriesMode()) finishWithResult("next_episode")
                    else { playerManager.seekBy(30_000); vodOverlay?.onUserInteraction() }
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD -> {
                    if (isSeriesMode()) finishWithResult("prev_episode")
                    else { playerManager.seekBy(-30_000); vodOverlay?.onUserInteraction() }
                    return true
                }
            }
            vodOverlay?.onUserInteraction()
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        // BACK/ESCAPE: just consume — onBackPressedDispatcher handles the action.
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
            return true
        }

        // Prevent default focused-view click behavior on TV remotes.
        // We handle these keys explicitly in onKeyDown via overlay managers.
        val handledKeys = setOf(
            KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_BUTTON_A,
            KeyEvent.KEYCODE_BUTTON_SELECT,
            KeyEvent.KEYCODE_BACK,
            KeyEvent.KEYCODE_ESCAPE,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_MEDIA_REWIND,
            KeyEvent.KEYCODE_MEDIA_STEP_BACKWARD,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
            KeyEvent.KEYCODE_MEDIA_STEP_FORWARD,
            KeyEvent.KEYCODE_MEDIA_NEXT,
            KeyEvent.KEYCODE_MEDIA_PREVIOUS,
            KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD,
            KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD,
        )
        if ((vodOverlay != null || liveOverlay != null) && handledKeys.contains(keyCode)) {
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    override fun onPause() {
        super.onPause()
        playerManager.pause()
    }

    override fun onResume() {
        super.onResume()
        enterImmersiveMode()
        playerManager.resume()
    }

    override fun onDestroy() {
        liveOverlay?.destroy()
        vodOverlay?.destroy()
        playerManager.release()
        super.onDestroy()
    }
}
