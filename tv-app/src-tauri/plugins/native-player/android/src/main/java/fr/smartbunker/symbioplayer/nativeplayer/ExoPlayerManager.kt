package fr.smartbunker.symbioplayer.nativeplayer

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.trackselection.AdaptiveTrackSelection
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class ExoPlayerManager(private val context: Context) {
    data class AudioTrackOption(
        val id: String,
        val label: String,
        val language: String,
        val groupIndex: Int,
        val trackIndex: Int,
    )

    companion object {
        private const val TAG = "ExoPlayerManager"

        private const val UA = "Mozilla/5.0 (Linux; Android 12; TV) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

        // ── Live buffer parameters (low-latency, quick zap) ─────────────────
        private const val LIVE_MIN_BUFFER_MS       = 6_000
        private const val LIVE_MAX_BUFFER_MS        = 30_000
        private const val LIVE_PLAYBACK_BUFFER_MS   = 1_500
        private const val LIVE_REBUFFER_MS          = 3_000

        // ── VOD buffer parameters (smooth playback, larger window) ──────────
        private const val VOD_MIN_BUFFER_MS         = 10_000
        private const val VOD_MAX_BUFFER_MS         = 25_000
        private const val VOD_PLAYBACK_BUFFER_MS    = 2_500
        private const val VOD_REBUFFER_MS           = 5_000
        private const val VOD_BACK_BUFFER_MS        = 0
        // Cap allocator growth for progressive-heavy streams (large MKV spikes on low heap devices).
        private const val VOD_TARGET_BUFFER_BYTES   = 12 * 1024 * 1024

        // ── ABR tuning ──────────────────────────────────────────────────────
        private const val INITIAL_BITRATE_ESTIMATE  = 800_000L    // 800 kbps — conservative start
        private const val BANDWIDTH_FRACTION        = 0.75f       // use 75% of measured bandwidth
        private const val MAX_VIDEO_WIDTH            = 1920
        private const val MAX_VIDEO_HEIGHT           = 1080

        // ── Error recovery ──────────────────────────────────────────────────
        private const val MAX_AUTO_RETRIES          = 3
        private const val RETRY_DELAY_MS            = 2_000L
        private const val LIVE_VIDEO_RECOVERY_COOLDOWN_MS = 8_000L
        private const val LIVE_DROPPED_FRAMES_THRESHOLD = 120
        private const val LIVE_DROPPED_FRAMES_WINDOW_MS = 3_000L
    }

    var player: ExoPlayer? = null
        private set

    var onError: ((PlaybackException) -> Unit)? = null
    var onStateChange: ((Int) -> Unit)? = null

    private var trackSelector: DefaultTrackSelector? = null
    private var bandwidthMeter: DefaultBandwidthMeter? = null
    private var currentIsLive = false
    private var currentUrl = ""
    private var currentResumeMs = 0L
    private var autoRetryCount = 0
    private val handler = Handler(Looper.getMainLooper())
    private var preferredVideoMimeHints: List<String> = defaultVideoMimeOrder()
    private var preferredAudioMimeHints: List<String> = defaultAudioMimeOrder()
    private var lastVideoCodecHint: String? = null
    private var lastAudioCodecHint: String? = null
    private var lastLiveVideoRecoveryAtMs = 0L

    fun initialize(isLive: Boolean = false): ExoPlayer {
        release()
        currentIsLive = isLive

        // ── Bandwidth meter ─────────────────────────────────────────────────
        bandwidthMeter = DefaultBandwidthMeter.Builder(context)
            .setInitialBitrateEstimate(INITIAL_BITRATE_ESTIMATE)
            .build()

        // ── Track selector with ABR constraints ─────────────────────────────
        val adaptiveFactory = AdaptiveTrackSelection.Factory(
            /* minDurationForQualityIncreaseMs */  10_000,
            /* maxDurationForQualityDecreaseMs */   25_000,
            /* minDurationToRetainAfterDiscardMs */ 25_000,
            /* bandwidthFraction */                 BANDWIDTH_FRACTION,
        )

        trackSelector = DefaultTrackSelector(context, adaptiveFactory).apply {
            parameters = buildUponParameters()
                .setMaxVideoSize(MAX_VIDEO_WIDTH, MAX_VIDEO_HEIGHT)
                .setPreferredVideoMimeTypes(
                    MimeTypes.VIDEO_H264,
                    MimeTypes.VIDEO_H265,
                    MimeTypes.VIDEO_VP9,
                    MimeTypes.VIDEO_AV1,
                    MimeTypes.VIDEO_VP8,
                    MimeTypes.VIDEO_H263,
                    MimeTypes.VIDEO_DOLBY_VISION,
                    MimeTypes.VIDEO_MPEG2,
                    MimeTypes.VIDEO_MP4V,
                )
                .setPreferredAudioMimeTypes(
                    MimeTypes.AUDIO_AAC,
                    MimeTypes.AUDIO_E_AC3,
                    MimeTypes.AUDIO_AC3,
                    MimeTypes.AUDIO_MPEG,
                    MimeTypes.AUDIO_OPUS,
                )
                .setExceedVideoConstraintsIfNecessary(true)
                .setExceedRendererCapabilitiesIfNecessary(true)
                // Tunneling can trigger black-screen issues on some TVs/ROMs.
                .setTunnelingEnabled(false)
                .setAllowVideoMixedMimeTypeAdaptiveness(true)
                .setAllowAudioMixedMimeTypeAdaptiveness(true)
                .build()
        }

        // ── Load control (live vs VOD) ──────────────────────────────────────
        val loadControl = if (isLive) {
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                    LIVE_MIN_BUFFER_MS, LIVE_MAX_BUFFER_MS,
                    LIVE_PLAYBACK_BUFFER_MS, LIVE_REBUFFER_MS
                )
                .setPrioritizeTimeOverSizeThresholds(true)
                .build()
        } else {
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                    VOD_MIN_BUFFER_MS, VOD_MAX_BUFFER_MS,
                    VOD_PLAYBACK_BUFFER_MS, VOD_REBUFFER_MS
                )
                .setBackBuffer(VOD_BACK_BUFFER_MS, true)
                .setTargetBufferBytes(VOD_TARGET_BUFFER_BYTES)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build()
        }

        // ── Renderers: prefer hardware decoders, enable tunneling ───────────
        val renderersFactory = DefaultRenderersFactory(context)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
            .setEnableDecoderFallback(true)

        // ── Build player ────────────────────────────────────────────────────
        val exoPlayer = ExoPlayer.Builder(context)
            .setRenderersFactory(renderersFactory)
            .setTrackSelector(trackSelector!!)
            .setLoadControl(loadControl)
            .setBandwidthMeter(bandwidthMeter!!)
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .build()

        exoPlayer.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                handlePlayerError(error)
            }
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    autoRetryCount = 0
                }
                onStateChange?.invoke(state)
            }
        })
        exoPlayer.addAnalyticsListener(object : AnalyticsListener {
            override fun onDroppedVideoFrames(
                eventTime: AnalyticsListener.EventTime,
                droppedFrames: Int,
                elapsedMs: Long
            ) {
                if (!currentIsLive) return
                if (elapsedMs <= LIVE_DROPPED_FRAMES_WINDOW_MS &&
                    droppedFrames >= LIVE_DROPPED_FRAMES_THRESHOLD
                ) {
                    android.util.Log.w(
                        TAG,
                        "Live dropped-frame burst detected: dropped=$droppedFrames elapsed=${elapsedMs}ms"
                    )
                    recoverLiveVideo("dropped_frames")
                }
            }

            override fun onVideoCodecError(
                eventTime: AnalyticsListener.EventTime,
                videoCodecError: Exception
            ) {
                if (!currentIsLive) return
                android.util.Log.e(TAG, "Live video codec error", videoCodecError)
                recoverLiveVideo("video_codec_error")
            }
        })

        player = exoPlayer
        autoRetryCount = 0
        return exoPlayer
    }

    fun play(
        url: String,
        isLive: Boolean = false,
        resumePositionMs: Long = 0,
        videoCodecHint: String? = null,
        audioCodecHint: String? = null,
    ) {
        val p = player ?: return
        currentUrl = url
        currentIsLive = isLive
        currentResumeMs = resumePositionMs
        lastVideoCodecHint = videoCodecHint
        lastAudioCodecHint = audioCodecHint
        autoRetryCount = 0
        applyCodecHints(videoCodecHint, audioCodecHint)

        val requestHeaders = buildRequestHeaders(url)
        val dataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(UA)
            .setConnectTimeoutMs(20_000)
            .setReadTimeoutMs(30_000)
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(requestHeaders)

        val uri = Uri.parse(url)
        val mediaSource: MediaSource = if (isHls(url)) {
            HlsMediaSource.Factory(dataSourceFactory)
                .setAllowChunklessPreparation(true)
                .createMediaSource(MediaItem.fromUri(uri))
        } else {
            ProgressiveMediaSource.Factory(dataSourceFactory)
                .createMediaSource(MediaItem.fromUri(uri))
        }

        // Explicitly reset previous source to free buffered allocations before loading a new one.
        p.stop()
        p.clearMediaItems()
        p.setMediaSource(mediaSource)
        p.playWhenReady = true
        p.prepare()

        if (!isLive && resumePositionMs > 0) {
            p.seekTo(resumePositionMs)
        }
    }

    private fun buildRequestHeaders(url: String): Map<String, String> {
        val out = mutableMapOf<String, String>()
        out["Accept"] = "*/*"
        out["Connection"] = "keep-alive"
        try {
            val uri = Uri.parse(url)
            val scheme = uri.scheme ?: "http"
            val host = uri.host
            if (!host.isNullOrBlank()) {
                val port = when {
                    uri.port > 0 -> ":${uri.port}"
                    scheme.equals("https", ignoreCase = true) -> ":443"
                    else -> ":80"
                }
                val origin = "$scheme://$host$port"
                out["Origin"] = origin
                out["Referer"] = "$origin/"
            }
        } catch (_: Exception) {
            // Keep defaults when URL parsing fails.
        }
        return out
    }

    // ── Error recovery with auto-retry ──────────────────────────────────────
    private fun handlePlayerError(error: PlaybackException) {
        if (isOutOfMemory(error.cause)) {
            android.util.Log.e(TAG, "Playback aborted due to memory pressure; skipping auto-retry", error)
            onError?.invoke(error)
            return
        }

        val isRecoverable = when (error.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
            PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
            PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW,
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED -> true
            else -> false
        }

        if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            android.util.Log.w(TAG, "Behind live window — seeking to default position")
            player?.let {
                it.seekToDefaultPosition()
                it.prepare()
            }
            return
        }

        if (isRecoverable && autoRetryCount < MAX_AUTO_RETRIES) {
            autoRetryCount++
            val delay = RETRY_DELAY_MS * autoRetryCount
            android.util.Log.w(TAG, "Auto-retry $autoRetryCount/$MAX_AUTO_RETRIES in ${delay}ms " +
                    "| error=${error.errorCodeName} | url=$currentUrl")
            handler.postDelayed({
                player?.let {
                    it.prepare()
                    it.playWhenReady = true
                }
            }, delay)
        } else {
            android.util.Log.e(TAG, "Playback failed (retries exhausted or non-recoverable) " +
                    "| error=${error.errorCodeName} | retries=$autoRetryCount")
            onError?.invoke(error)
        }
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

    private fun recoverLiveVideo(reason: String) {
        if (!currentIsLive || currentUrl.isBlank()) return
        val now = System.currentTimeMillis()
        if (now - lastLiveVideoRecoveryAtMs < LIVE_VIDEO_RECOVERY_COOLDOWN_MS) {
            android.util.Log.d(TAG, "recoverLiveVideo skipped (cooldown) reason=$reason")
            return
        }
        lastLiveVideoRecoveryAtMs = now
        android.util.Log.w(TAG, "recoverLiveVideo reason=$reason url=$currentUrl")
        play(
            url = currentUrl,
            isLive = true,
            resumePositionMs = 0,
            videoCodecHint = lastVideoCodecHint,
            audioCodecHint = lastAudioCodecHint,
        )
    }

    fun pause() { player?.pause() }
    fun resume() { player?.play() }
    fun seekTo(positionMs: Long) { player?.seekTo(positionMs) }

    fun seekBy(deltaMs: Long) {
        val p = player ?: return
        val target = (p.currentPosition + deltaMs).coerceIn(0, getDuration().coerceAtLeast(0))
        p.seekTo(target)
    }

    fun getCurrentPosition(): Long = player?.currentPosition ?: 0
    fun getDuration(): Long = player?.duration?.let { if (it == C.TIME_UNSET) 0 else it } ?: 0
    fun getBufferedPosition(): Long = player?.bufferedPosition ?: 0
    fun isPlaying(): Boolean = player?.isPlaying ?: false

    fun getAvailableAudioTracks(): List<AudioTrackOption> {
        val p = player ?: return emptyList()
        val options = mutableListOf<AudioTrackOption>()
        for ((groupIndex, group) in p.currentTracks.groups.withIndex()) {
            if (group.type != C.TRACK_TYPE_AUDIO) continue
            val trackGroup = group.mediaTrackGroup
            for (trackIndex in 0 until trackGroup.length) {
                val format = trackGroup.getFormat(trackIndex)
                val lang = normalizeLang(format.language)
                val channels = if (format.channelCount > 0) " ${format.channelCount}ch" else ""
                val role = if ((format.roleFlags and C.ROLE_FLAG_COMMENTARY) != 0) " commentary" else ""
                val codec = format.codecs?.substringBefore(",").orEmpty()
                val codecLabel = if (codec.isNotBlank()) " [$codec]" else ""
                val supportLabel = if (group.isTrackSupported(trackIndex)) "" else " [unsupported]"
                val displayLang = if (lang.isBlank()) "Audio" else lang.uppercase()
                val displayTitle = format.label?.takeIf { it.isNotBlank() } ?: displayLang
                val label = "$displayTitle$channels$role$codecLabel$supportLabel"
                options.add(
                    AudioTrackOption(
                        id = "$groupIndex:$trackIndex",
                        label = label,
                        language = lang,
                        groupIndex = groupIndex,
                        trackIndex = trackIndex,
                    )
                )
            }
        }
        return options
    }

    fun getCurrentAudioTrackId(): String? {
        val p = player ?: return null
        for ((groupIndex, group) in p.currentTracks.groups.withIndex()) {
            if (group.type != C.TRACK_TYPE_AUDIO) continue
            val trackGroup = group.mediaTrackGroup
            for (trackIndex in 0 until trackGroup.length) {
                if (group.isTrackSelected(trackIndex)) return "$groupIndex:$trackIndex"
            }
        }
        return null
    }

    fun selectAudioTrack(optionId: String): Boolean {
        val p = player ?: return false
        val option = getAvailableAudioTracks().firstOrNull { it.id == optionId } ?: return false
        val group = p.currentTracks.groups.getOrNull(option.groupIndex) ?: return false
        val trackGroup = group.mediaTrackGroup
        if (option.trackIndex < 0 || option.trackIndex >= trackGroup.length) return false
        val format = trackGroup.getFormat(option.trackIndex)
        val lang = normalizeLang(format.language)

        p.trackSelectionParameters = p.trackSelectionParameters
            .buildUpon()
            .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
            .addOverride(TrackSelectionOverride(trackGroup, listOf(option.trackIndex)))
            .setPreferredAudioLanguage(if (lang.isBlank()) null else lang)
            .build()
        android.util.Log.d(TAG, "Selected audio track: ${option.label} (${option.id})")
        return true
    }

    fun selectAudioTrackByLanguage(languageCode: String): Boolean {
        val wanted = normalizeLang(languageCode)
        if (wanted.isBlank()) return false
        val options = getAvailableAudioTracks()
        val match = options.firstOrNull { normalizeLang(it.language) == wanted } ?: return false
        return selectAudioTrack(match.id)
    }

    fun release() {
        handler.removeCallbacksAndMessages(null)
        player?.release()
        player = null
        trackSelector = null
        bandwidthMeter = null
    }

    private fun isHls(url: String): Boolean {
        val lower = url.lowercase()
        return lower.contains(".m3u8") || lower.contains("/live/") || lower.contains("/timeshift/")
    }

    private fun applyCodecHints(videoCodecHint: String?, audioCodecHint: String?) {
        val ts = trackSelector ?: return
        val videoOrder = codecHintToVideoMimes(videoCodecHint)
        val audioOrder = codecHintToAudioMimes(audioCodecHint)
        preferredVideoMimeHints = videoOrder
        preferredAudioMimeHints = audioOrder
        ts.parameters = ts.buildUponParameters()
            .setPreferredVideoMimeTypes(*videoOrder.toTypedArray())
            .setPreferredAudioMimeTypes(*audioOrder.toTypedArray())
            .build()
        android.util.Log.d(
            TAG,
            "applyCodecHints video='$videoCodecHint' -> $videoOrder | audio='$audioCodecHint' -> $audioOrder"
        )
    }

    private fun codecHintToVideoMimes(hint: String?): List<String> {
        val h = hint?.lowercase()?.trim().orEmpty()
        val preferred = when {
            h.contains("av1") -> listOf(MimeTypes.VIDEO_AV1)
            h.contains("hevc") || h.contains("h265") || h.contains("x265") ->
                listOf(MimeTypes.VIDEO_H265)
            h.contains("avc") || h.contains("h264") || h.contains("x264") ->
                listOf(MimeTypes.VIDEO_H264)
            h.contains("vp9") -> listOf(MimeTypes.VIDEO_VP9)
            h.contains("vp8") -> listOf(MimeTypes.VIDEO_VP8)
            h.contains("mpeg2") -> listOf(MimeTypes.VIDEO_MPEG2)
            h.contains("mpeg4") || h.contains("xvid") || h.contains("divx") ->
                listOf(MimeTypes.VIDEO_MP4V)
            h.contains("h263") -> listOf(MimeTypes.VIDEO_H263)
            h.contains("dovi") || h.contains("dolbyvision") -> listOf(MimeTypes.VIDEO_DOLBY_VISION)
            else -> emptyList()
        }
        return (preferred + defaultVideoMimeOrder()).distinct()
    }

    private fun codecHintToAudioMimes(hint: String?): List<String> {
        val h = hint?.lowercase()?.trim().orEmpty()
        val preferred = when {
            h.contains("eac3") || h.contains("ec-3") -> listOf(MimeTypes.AUDIO_E_AC3)
            h.contains("ac3") || h.contains("a52") -> listOf(MimeTypes.AUDIO_AC3)
            h.contains("aac") || h.contains("mp4a") -> listOf(MimeTypes.AUDIO_AAC)
            h.contains("mp3") || h.contains("mpeg") -> listOf(MimeTypes.AUDIO_MPEG)
            h.contains("opus") -> listOf(MimeTypes.AUDIO_OPUS)
            h.contains("vorbis") -> listOf(MimeTypes.AUDIO_VORBIS)
            h.contains("flac") -> listOf(MimeTypes.AUDIO_FLAC)
            h.contains("dts") -> listOf(MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD)
            else -> emptyList()
        }
        return (preferred + defaultAudioMimeOrder()).distinct()
    }

    private fun defaultVideoMimeOrder(): List<String> = listOf(
        MimeTypes.VIDEO_H264,
        MimeTypes.VIDEO_H265,
        MimeTypes.VIDEO_VP9,
        MimeTypes.VIDEO_AV1,
        MimeTypes.VIDEO_VP8,
        MimeTypes.VIDEO_H263,
        MimeTypes.VIDEO_DOLBY_VISION,
        MimeTypes.VIDEO_MPEG2,
        MimeTypes.VIDEO_MP4V,
    )

    private fun defaultAudioMimeOrder(): List<String> = listOf(
        MimeTypes.AUDIO_AAC,
        MimeTypes.AUDIO_E_AC3,
        MimeTypes.AUDIO_AC3,
        MimeTypes.AUDIO_MPEG,
        MimeTypes.AUDIO_OPUS,
        MimeTypes.AUDIO_VORBIS,
        MimeTypes.AUDIO_FLAC,
        MimeTypes.AUDIO_DTS,
    )

    private fun normalizeLang(lang: String?): String {
        val raw = lang?.trim()?.lowercase().orEmpty()
        if (raw.isBlank()) return ""
        val base = raw.substringBefore('-').substringBefore('_')
        return when (base) {
            "eng" -> "en"
            "fre", "fra" -> "fr"
            "ger", "deu" -> "de"
            "spa" -> "es"
            "ita" -> "it"
            "por" -> "pt"
            "ara" -> "ar"
            "dut", "nld" -> "nl"
            "pol" -> "pl"
            "rus" -> "ru"
            "tur" -> "tr"
            "chi", "zho" -> "zh"
            "jpn" -> "ja"
            "kor" -> "ko"
            "swe" -> "sv"
            "nor" -> "no"
            "dan" -> "da"
            "fin" -> "fi"
            "cze", "ces" -> "cs"
            "rum", "ron" -> "ro"
            "hun" -> "hu"
            "gre", "ell" -> "el"
            "heb" -> "he"
            "ukr" -> "uk"
            "per", "fas" -> "fa"
            "hin" -> "hi"
            "tha" -> "th"
            "vie" -> "vi"
            "ind" -> "id"
            "ben" -> "bn"
            "alb", "sqi" -> "sq"
            else -> base
        }
    }
}
