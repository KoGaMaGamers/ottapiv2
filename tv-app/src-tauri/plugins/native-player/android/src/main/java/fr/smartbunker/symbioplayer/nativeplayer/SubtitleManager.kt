package fr.smartbunker.symbioplayer.nativeplayer

import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.View
import android.widget.TextView
import androidx.media3.common.C
import androidx.media3.common.TrackSelectionParameters
import java.net.URL
import kotlin.concurrent.thread

/**
 * Downloads and renders VTT subtitles as a text overlay,
 * with configurable sync offset (±seconds).
 */
class SubtitleManager(
    private val cueView: TextView,
    private val playerManager: ExoPlayerManager,
) {
    companion object {
        private const val TAG = "SubtitleManager"
        private const val TICK_MS = 100L
        private const val API_ORIGIN = "https://ottapi.smartbunker.fr"
    }

    data class Cue(val startMs: Long, val endMs: Long, val text: String)
    data class Track(val lang: String, val label: String, val url: String)

    data class SubtitleLang(val code: String, val label: String)

    val SUBTITLE_LANGS = listOf(
        SubtitleLang("en", "English"),
        SubtitleLang("fr", "Français"),
        SubtitleLang("de", "Deutsch"),
        SubtitleLang("es", "Español"),
        SubtitleLang("it", "Italiano"),
        SubtitleLang("pt", "Português"),
        SubtitleLang("ar", "\u0627\u0644\u0639\u0631\u0628\u064A\u0629"),
        SubtitleLang("nl", "Nederlands"),
        SubtitleLang("pl", "Polski"),
        SubtitleLang("ru", "\u0420\u0443\u0441\u0441\u043A\u0438\u0439"),
        SubtitleLang("tr", "Türkçe"),
        SubtitleLang("zh", "\u4E2D\u6587"),
        SubtitleLang("ja", "\u65E5\u672C\u8A9E"),
        SubtitleLang("ko", "\uD55C\uAD6D\uC5B4"),
        SubtitleLang("sv", "Svenska"),
        SubtitleLang("no", "Norsk"),
        SubtitleLang("da", "Dansk"),
        SubtitleLang("fi", "Suomi"),
        SubtitleLang("cs", "Čeština"),
        SubtitleLang("ro", "Română"),
        SubtitleLang("hu", "Magyar"),
        SubtitleLang("el", "\u0395\u03BB\u03BB\u03B7\u03BD\u03B9\u03BA\u03AC"),
        SubtitleLang("he", "\u05E2\u05D1\u05E8\u05D9\u05EA"),
        SubtitleLang("uk", "\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430"),
        SubtitleLang("fa", "\u0641\u0627\u0631\u0633\u06CC"),
        SubtitleLang("hi", "\u0939\u093F\u0928\u094D\u0926\u0940"),
        SubtitleLang("th", "\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22"),
        SubtitleLang("vi", "Tiếng Việt"),
        SubtitleLang("id", "Indonesia"),
        SubtitleLang("bn", "\u09AC\u09BE\u0982\u09B2\u09BE"),
        SubtitleLang("sq", "Shqip"),
    )

    // Cache: lang code → "loading" | "missing" | vtt URL string
    val langCache = mutableMapOf<String, String>()

    private val handler = Handler(Looper.getMainLooper())
    private var cues: List<Cue> = emptyList()
    private var tickRunnable: Runnable? = null
    private var lastCueText: String? = null
    @Volatile private var isDestroyed = false
    @Volatile private var fetchGeneration = 0L

    var syncOffsetMs: Long = 0L
    var subtitleTextSizeSp: Float = 20f
        private set
    var activeTrack: Track? = null
        private set
    private var activeEmbeddedLang: String? = null

    var tmdbId: String = ""
    var season: Int = 0
    var episode: Int = 0

    init {
        val scaledDensity = cueView.context.resources.displayMetrics.scaledDensity
        subtitleTextSizeSp = (cueView.textSize / scaledDensity).coerceIn(14f, 36f)
    }

    /**
     * Fetch subtitle for a language from the API, then load the VTT.
     * Calls onResult on the main thread with the Track if found, null if missing.
     */
    fun fetchAndLoad(lang: String, onResult: (Track?) -> Unit) {
        if (isDestroyed) {
            onResult(null)
            return
        }
        if (tmdbId.isBlank()) {
            onResult(null)
            return
        }
        val generation = ++fetchGeneration

        langCache[lang] = "loading"
        android.util.Log.d(TAG, "fetchAndLoad: lang=$lang tmdb=$tmdbId s=$season e=$episode")

        thread {
            try {
                val params = StringBuilder("tmdb_id=$tmdbId&lang=$lang")
                if (season > 0) params.append("&season=$season")
                if (episode > 0) params.append("&episode=$episode")
                val apiUrl = "$API_ORIGIN/api/v1/subtitles?$params"
                android.util.Log.d(TAG, "API request: $apiUrl")

                val raw = URL(apiUrl).readText(Charsets.UTF_8)
                android.util.Log.d(TAG, "API response length: ${raw.length}")

                val entries = parseJsonArray(raw)
                val entry = entries.firstOrNull { it.lang == lang && it.vttUrl.isNotBlank() }

                if (entry != null) {
                    var vttUrl = entry.vttUrl
                    if (vttUrl.startsWith("/")) vttUrl = "$API_ORIGIN$vttUrl"
                    android.util.Log.d(TAG, "Found VTT for $lang: $vttUrl")

                    langCache[lang] = vttUrl
                    val track = Track(lang, entry.label, vttUrl)

                    // Now actually download and parse the VTT
                    val vttRaw = URL(vttUrl).readText(Charsets.UTF_8)
                    val parsed = parseVTT(vttRaw)
                    android.util.Log.d(TAG, "Parsed ${parsed.size} cues for $lang")

                    handler.post {
                        if (isDestroyed || generation != fetchGeneration) {
                            onResult(null)
                            return@post
                        }
                        disableEmbeddedSubtitles()
                        stop()
                        activeTrack = track
                        activeEmbeddedLang = null
                        cues = parsed
                        startTick()
                        onResult(track)
                    }
                } else {
                    android.util.Log.d(TAG, "No subtitle found for $lang")
                    langCache[lang] = "missing"
                    handler.post {
                        if (!isDestroyed && generation == fetchGeneration) onResult(null)
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "fetchAndLoad failed for $lang", e)
                langCache[lang] = "missing"
                handler.post {
                    if (!isDestroyed && generation == fetchGeneration) onResult(null)
                }
            }
        }
    }

    fun loadTrack(track: Track?) {
        if (isDestroyed) return
        disableEmbeddedSubtitles()
        stop()
        activeTrack = track
        activeEmbeddedLang = null
        cues = emptyList()
        lastCueText = null

        if (track == null) {
            handler.post { cueView.visibility = View.GONE }
            return
        }

        android.util.Log.d(TAG, "Loading subtitle: ${track.lang} → ${track.url}")

        thread {
            try {
                val raw = URL(track.url).readText(Charsets.UTF_8)
                val parsed = parseVTT(raw)
                android.util.Log.d(TAG, "Parsed ${parsed.size} cues for ${track.lang}")
                handler.post {
                    if (isDestroyed) return@post
                    cues = parsed
                    startTick()
                }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "Failed to load subtitle: ${track.url}", e)
            }
        }
    }

    fun turnOff() {
        disableEmbeddedSubtitles()
        stop()
        activeTrack = null
        activeEmbeddedLang = null
        cues = emptyList()
        lastCueText = null
        handler.post { cueView.visibility = View.GONE }
    }

    fun adjustSync(deltaMs: Long) {
        syncOffsetMs += deltaMs
        android.util.Log.d(TAG, "Sync offset: ${syncOffsetMs}ms")
    }

    fun adjustTextSize(deltaSp: Float) {
        setTextSizeSp(subtitleTextSizeSp + deltaSp)
    }

    fun setTextSizeSp(sizeSp: Float) {
        subtitleTextSizeSp = sizeSp.coerceIn(14f, 36f)
        handler.post {
            cueView.setTextSize(TypedValue.COMPLEX_UNIT_SP, subtitleTextSizeSp)
        }
    }

    fun resetSync() {
        syncOffsetMs = 0
    }

    fun isActive(): Boolean = activeTrack != null && cues.isNotEmpty()
    fun getActiveLanguageCode(): String? = activeEmbeddedLang ?: activeTrack?.lang
    fun isUsingEmbeddedSubtitles(): Boolean = activeEmbeddedLang != null

    fun hasAnyEmbeddedSubtitles(): Boolean {
        return getEmbeddedLanguageCodes().isNotEmpty()
    }

    fun hasEmbeddedForLanguage(lang: String): Boolean {
        val wanted = normalizeLang(lang)
        return getEmbeddedLanguageCodes().contains(wanted)
    }

    fun useEmbeddedLanguage(lang: String): Boolean {
        val wanted = normalizeLang(lang)
        if (wanted.isBlank() || !hasEmbeddedForLanguage(wanted)) return false
        val p = playerManager.player ?: return false
        stop()
        activeTrack = null
        activeEmbeddedLang = wanted
        p.trackSelectionParameters = p.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            .setPreferredTextLanguage(wanted)
            .build()
        handler.post { cueView.visibility = View.GONE }
        android.util.Log.d(TAG, "Using embedded subtitle language: $wanted")
        return true
    }

    private fun startTick() {
        stopTick()
        tickRunnable = object : Runnable {
            override fun run() {
                updateCue()
                handler.postDelayed(this, TICK_MS)
            }
        }
        handler.post(tickRunnable!!)
    }

    private fun stopTick() {
        tickRunnable?.let { handler.removeCallbacks(it) }
        tickRunnable = null
    }

    private fun updateCue() {
        val posMs = playerManager.getCurrentPosition() + syncOffsetMs
        val active = cues.filter { posMs >= it.startMs && posMs < it.endMs }
        val text = active.joinToString("\n") { it.text }.ifBlank { null }

        if (text != lastCueText) {
            lastCueText = text
            if (text != null) {
                cueView.setTextSize(TypedValue.COMPLEX_UNIT_SP, subtitleTextSizeSp)
                cueView.text = text
                cueView.visibility = View.VISIBLE
            } else {
                cueView.visibility = View.GONE
            }
        }
    }

    fun stop() {
        stopTick()
        lastCueText = null
        handler.post {
            cueView.text = ""
            cueView.visibility = View.GONE
        }
    }

    fun destroy() {
        isDestroyed = true
        fetchGeneration++
        stop()
        disableEmbeddedSubtitles()
        handler.removeCallbacksAndMessages(null)
    }

    private fun disableEmbeddedSubtitles() {
        val p = playerManager.player ?: return
        p.trackSelectionParameters = p.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .setPreferredTextLanguage(null)
            .build()
    }

    private fun getEmbeddedLanguageCodes(): Set<String> {
        val p = playerManager.player ?: return emptySet()
        val out = linkedSetOf<String>()
        for (group in p.currentTracks.groups) {
            if (group.type != C.TRACK_TYPE_TEXT) continue
            val trackGroup = group.mediaTrackGroup
            for (i in 0 until trackGroup.length) {
                if (!group.isTrackSupported(i)) continue
                val lang = normalizeLang(trackGroup.getFormat(i).language)
                if (lang.isNotBlank() && lang != "und") out.add(lang)
            }
        }
        return out
    }

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

    // ── Simple JSON parser for subtitle API response ─────────────────────────────

    private data class SubEntry(val lang: String, val label: String, val vttUrl: String)

    private fun parseJsonArray(raw: String): List<SubEntry> {
        val results = mutableListOf<SubEntry>()
        try {
            val arr = org.json.JSONArray(raw)
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val lang = obj.optString("lang", "")
                val label = obj.optString("label", lang)
                val vttUrl = obj.optString("url_vtt", "")
                if (lang.isNotBlank()) {
                    results.add(SubEntry(lang, label, vttUrl))
                }
            }
        } catch (e: Exception) {
            android.util.Log.e(TAG, "parseJsonArray failed", e)
        }
        return results
    }

    // ── VTT parser ──────────────────────────────────────────────────────────────

    private fun parseVTT(raw: String): List<Cue> {
        val result = mutableListOf<Cue>()
        val cleaned = raw
            .removePrefix("\uFEFF")
            .replace("\r\n", "\n")
            .replace("\r", "\n")

        val blocks = cleaned.split(Regex("\n{2,}"))
        for (block in blocks) {
            val lines = block.trim().split("\n")
            val timeLine = lines.indexOfFirst { it.contains("-->") }
            if (timeLine == -1) continue

            val match = Regex("([\\d:,.]+)\\s*-->\\s*([\\d:,.]+)").find(lines[timeLine]) ?: continue
            val startMs = parseVTTTime(match.groupValues[1])
            val endMs = parseVTTTime(match.groupValues[2])
            val text = lines.drop(timeLine + 1).joinToString("\n").trim()
                .let { stripTags(it) }

            if (text.isNotBlank()) {
                result.add(Cue(startMs, endMs, text))
            }
        }
        return result
    }

    private fun parseVTTTime(ts: String): Long {
        val cleaned = ts.replace(",", ".")
        val parts = cleaned.split(":")
        return if (parts.size == 3) {
            val h = parts[0].toLongOrNull() ?: 0
            val m = parts[1].toLongOrNull() ?: 0
            val s = parts[2].toDoubleOrNull() ?: 0.0
            ((h * 3600 + m * 60) * 1000 + (s * 1000).toLong())
        } else {
            val m = parts[0].toLongOrNull() ?: 0
            val s = parts.getOrNull(1)?.toDoubleOrNull() ?: 0.0
            (m * 60000 + (s * 1000).toLong())
        }
    }

    private fun stripTags(text: String): String {
        return text
            .replace(Regex("<\\d{2}:\\d{2}[^>]*>"), "")
            .replace(Regex("<[^>]+>"), "")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&nbsp;", " ")
            .trim()
    }
}
