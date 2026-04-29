package fr.smartbunker.symbioplayer.nativeplayer

import android.animation.ObjectAnimator
import android.graphics.Color
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import fr.smartbunker.symbioplayer.nativeplayer.R

/**
 * VOD overlay with two D-pad focus zones:
 *   Zone 0  →  seek bar   (Left/Right = ±10s)
 *   Zone 1  →  control row (Left/Right = move between buttons, Enter = activate)
 *
 * D-pad Down walks zone 0→1, Up walks 1→0→hide.
 * First any-key press when hidden shows the overlay (zone 0).
 */
class VodOverlayManager(
    private val root: View,
    private val playerManager: ExoPlayerManager,
    private val onBack: () -> Unit,
    private val onPrevEpisode: (() -> Unit)? = null,
    private val onNextEpisode: (() -> Unit)? = null,
    private val isSeries: Boolean = false,
) {
    companion object {
        private const val TAG = "VodOverlay"
        private const val ZONE_SEEK = 0
        private const val ZONE_CONTROLS = 1

        private const val COL_RED   = "#E50914"
        private const val COL_WHITE = "#FFFFFF"
        private const val COL_DIM   = "#80FFFFFF"
    }

    private enum class SubMenuTarget {
        LANGUAGE,
        AUDIO,
        ADJUST,
    }

    private val handler = Handler(Looper.getMainLooper())
    private val overlayRoot: View = root.findViewById(R.id.vodOverlayRoot)

    // Top bar
    private val titleView: TextView = root.findViewById(R.id.vodTitle)
    private val subtitleView: TextView = root.findViewById(R.id.vodSubtitle)
    private val backBtn: View = root.findViewById(R.id.vodBackBtn)

    // Seek zone
    private val seekBarContainer: View = root.findViewById(R.id.vodSeekBarContainer)
    private val bufferedFill: View = root.findViewById(R.id.vodBufferedFill)
    private val playedFill: View = root.findViewById(R.id.vodPlayedFill)
    private val seekThumb: View = root.findViewById(R.id.vodSeekThumb)
    private val seekFocusRing: View = root.findViewById(R.id.vodSeekFocusRing)
    private val currentTimeView: TextView = root.findViewById(R.id.vodCurrentTime)
    private val durationView: TextView = root.findViewById(R.id.vodDuration)

    // Control row
    private val prevEpisodeBtn: TextView = root.findViewById(R.id.vodPrevEpisode)
    private val playPauseBtn: TextView = root.findViewById(R.id.vodPlayPause)
    private val nextEpisodeBtn: TextView = root.findViewById(R.id.vodNextEpisode)
    private val subLangBtn: TextView = root.findViewById(R.id.vodCcBtn)
    private val audioBtn: TextView = root.findViewById(R.id.vodAudioBtn)
    private val adjustBtn: TextView = root.findViewById(R.id.vodAdjustBtn)

    // Subtitle menu
    private val subMenu: View = root.findViewById(R.id.vodSubMenu)
    private val subMenuTitle: TextView = root.findViewById(R.id.vodSubMenuTitle)
    private val audioRow: View = root.findViewById(R.id.vodAudioRow)
    private val audioMinus: View = root.findViewById(R.id.vodAudioMinus)
    private val audioPlus: View = root.findViewById(R.id.vodAudioPlus)
    private val audioValue: TextView = root.findViewById(R.id.vodAudioValue)
    private val subSizeRow: View = root.findViewById(R.id.vodSubSizeRow)
    private val subSizeMinus: View = root.findViewById(R.id.vodSubSizeMinus)
    private val subSizePlus: View = root.findViewById(R.id.vodSubSizePlus)
    private val subSizeValue: TextView = root.findViewById(R.id.vodSubSizeValue)
    private val subSyncRow: View = root.findViewById(R.id.vodSubSyncRow)
    private val subSyncMinus: View = root.findViewById(R.id.vodSubSyncMinus)
    private val subSyncPlus: View = root.findViewById(R.id.vodSubSyncPlus)
    private val subSyncValue: TextView = root.findViewById(R.id.vodSubSyncValue)
    private val subTrackScroll: ScrollView = root.findViewById(R.id.vodSubTrackScroll)
    private val subTrackList: LinearLayout = root.findViewById(R.id.vodSubTrackList)

    private var isVisible = false
    private var isSubMenuOpen = false
    private var hideRunnable: Runnable? = null
    private var progressRunnable: Runnable? = null
    private var fadeToken = 0L

    // Focus state
    private var focusZone = ZONE_SEEK
    private var controlFocusIdx = 0
    /** Unified submenu cursor: [track rows..., size row, sync row] */
    private var subMenuCursor = 0
    private var currentSubMenuTarget = SubMenuTarget.LANGUAGE
    private var subMenuUserNavigated = false
    private var audioRefreshRunnable: Runnable? = null

    private val controlButtons = mutableListOf<View>()
    private var audioTracks: List<ExoPlayerManager.AudioTrackOption> = emptyList()
    private var selectedAudioIdx = 0
    private var preferredSubtitleLang: String? = null
    private var preferredAudioLang: String? = null
    private var preferredApplied = false

    var subtitleManager: SubtitleManager? = null

    fun initialize(title: String, subtitle: String) {
        titleView.text = title
        if (subtitle.isNotBlank()) {
            subtitleView.text = subtitle
            subtitleView.visibility = View.VISIBLE
        } else {
            subtitleView.visibility = View.GONE
        }

        if (isSeries) {
            prevEpisodeBtn.visibility = View.VISIBLE
            nextEpisodeBtn.visibility = View.VISIBLE
        }

        // Use our own D-pad state machine only; prevent Android view-focus click
        // dispatch from triggering unintended actions (e.g. exiting player).
        listOf(
            backBtn,
            prevEpisodeBtn,
            playPauseBtn,
            nextEpisodeBtn,
            subLangBtn,
            audioBtn,
            adjustBtn,
            audioRow,
            audioMinus,
            audioPlus,
            subSizeRow,
            subSizeMinus,
            subSizePlus,
            subSyncMinus,
            subSyncPlus,
            subTrackScroll,
            subTrackList,
            subMenu,
        ).forEach { v ->
            v.isFocusable = false
            v.isFocusableInTouchMode = false
        }
        // Keep list navigation fully controlled by our D-pad state machine.
        subTrackScroll.isClickable = false
        subTrackScroll.isSmoothScrollingEnabled = false

        subLangBtn.visibility = View.VISIBLE
        audioBtn.visibility = View.VISIBLE
        adjustBtn.visibility = View.VISIBLE

        buildControlButtonsList()
        setupClickListeners()
        overlayRoot.visibility = View.GONE
        overlayRoot.alpha = 0f
        updateControlButtonsState()
    }

    fun setPreferredSelections(subtitleLang: String?, audioLang: String?) {
        subtitleLang?.trim()?.lowercase()?.takeIf { it.isNotBlank() }?.let {
            preferredSubtitleLang = it
        }
        audioLang?.trim()?.lowercase()?.takeIf { it.isNotBlank() }?.let {
            preferredAudioLang = it
        }
    }

    fun applyPreferredSelections() {
        if (preferredApplied) return
        preferredApplied = true

        preferredAudioLang?.let { lang ->
            if (playerManager.selectAudioTrackByLanguage(lang)) {
                refreshAudioTrackOptions()
                updateAudioDisplay()
                updateControlButtonsState()
            }
        }

        val mgr = subtitleManager ?: return
        val subLang = preferredSubtitleLang ?: return
        if (mgr.useEmbeddedLanguage(subLang)) {
            updateControlButtonsState()
            return
        }
        mgr.fetchAndLoad(subLang) {
            updateControlButtonsState()
        }
    }

    private fun buildControlButtonsList() {
        controlButtons.clear()
        if (isSeries) controlButtons.add(prevEpisodeBtn)
        controlButtons.add(playPauseBtn)
        if (isSeries) controlButtons.add(nextEpisodeBtn)
        if (subLangBtn.visibility == View.VISIBLE) controlButtons.add(subLangBtn)
        if (audioBtn.visibility == View.VISIBLE) controlButtons.add(audioBtn)
        if (adjustBtn.visibility == View.VISIBLE) controlButtons.add(adjustBtn)
        controlFocusIdx = controlButtons.indexOf(playPauseBtn).coerceAtLeast(0)
    }

    private fun setupClickListeners() {
        backBtn.setOnClickListener { onBack() }
        playPauseBtn.setOnClickListener { togglePlayPause(); scheduleHide() }
        prevEpisodeBtn.setOnClickListener { onPrevEpisode?.invoke() }
        nextEpisodeBtn.setOnClickListener { onNextEpisode?.invoke() }
        subLangBtn.setOnClickListener { openSubMenu(SubMenuTarget.LANGUAGE) }
        audioBtn.setOnClickListener { openSubMenu(SubMenuTarget.AUDIO) }
        adjustBtn.setOnClickListener { openSubMenu(SubMenuTarget.ADJUST) }
        overlayRoot.setOnClickListener { toggleVisibility() }

        subSyncMinus.setOnClickListener {
            subtitleManager?.adjustSync(-500)
            updateSyncDisplay()
        }
        subSyncPlus.setOnClickListener {
            subtitleManager?.adjustSync(500)
            updateSyncDisplay()
        }
        subSizeMinus.setOnClickListener {
            subtitleManager?.adjustTextSize(-1f)
            updateSizeDisplay()
            updateControlButtonsState()
        }
        subSizePlus.setOnClickListener {
            subtitleManager?.adjustTextSize(1f)
            updateSizeDisplay()
            updateControlButtonsState()
        }
        audioMinus.setOnClickListener { adjustAudioTrack(-1) }
        audioPlus.setOnClickListener { adjustAudioTrack(1) }
    }

    // ── Visibility ──────────────────────────────────────────────────────────────

    fun showWithTimer() {
        fadeToken++
        overlayRoot.visibility = View.VISIBLE
        ObjectAnimator.ofFloat(overlayRoot, "alpha", overlayRoot.alpha, 1f).apply {
            duration = 200; start()
        }
        isVisible = true
        focusZone = ZONE_SEEK
        controlFocusIdx = controlButtons.indexOf(playPauseBtn).coerceAtLeast(0)
        updatePlayPauseIcon()
        updateFocusVisuals()
        startProgressUpdates()
        scheduleHide()
    }

    private fun scheduleHide() {
        hideRunnable?.let { handler.removeCallbacks(it) }
        if (isSubMenuOpen) return
        hideRunnable = Runnable { fadeOut() }
        handler.postDelayed(hideRunnable!!, 5000)
    }

    private fun fadeOut() {
        if (isSubMenuOpen) return
        val token = ++fadeToken
        ObjectAnimator.ofFloat(overlayRoot, "alpha", 1f, 0f).apply {
            duration = 300; start()
        }
        handler.postDelayed({
            if (token != fadeToken) return@postDelayed
            overlayRoot.visibility = View.GONE
            isVisible = false
            clearFocusVisuals()
            stopProgressUpdates()
        }, 300)
    }

    private fun toggleVisibility() {
        if (isSubMenuOpen) { closeSubMenu(); return }
        if (isVisible) {
            hideRunnable?.let { handler.removeCallbacks(it) }
            fadeOut()
        } else {
            showWithTimer()
        }
    }

    fun onUserInteraction() {
        if (!isVisible) showWithTimer()
        else scheduleHide()
    }

    private fun togglePlayPause() {
        if (playerManager.isPlaying()) {
            playerManager.pause(); playPauseBtn.text = "▶"
        } else {
            playerManager.resume(); playPauseBtn.text = "⏸"
        }
    }

    private fun updatePlayPauseIcon() {
        playPauseBtn.text = if (playerManager.isPlaying()) "⏸" else "▶"
    }

    // ── Focus visuals ───────────────────────────────────────────────────────────

    private fun updateFocusVisuals() {
        val seekActive = focusZone == ZONE_SEEK
        // Seeker focus uses thumb + track thickness only (no outer frame).
        seekFocusRing.visibility = View.GONE
        val seekTrackHeight = if (seekActive) 6 else 4
        listOf(playedFill, bufferedFill).forEach { v ->
            val lp = v.layoutParams
            lp.height = dpToPx(seekTrackHeight)
            v.layoutParams = lp
        }
        seekThumb.visibility = if (seekActive) View.VISIBLE else View.GONE

        for ((i, btn) in controlButtons.withIndex()) {
            btn.isSelected = (focusZone == ZONE_CONTROLS && i == controlFocusIdx)
            val scale = if (btn.isSelected) 1.1f else 1.0f
            btn.scaleX = scale
            btn.scaleY = scale
        }
    }

    private fun clearFocusVisuals() {
        seekFocusRing.visibility = View.GONE
        controlButtons.forEach {
            it.isSelected = false
            it.scaleX = 1f; it.scaleY = 1f
        }
    }

    private fun dpToPx(dp: Int): Int {
        return (dp * root.context.resources.displayMetrics.density).toInt()
    }

    // ── Subtitle menu ───────────────────────────────────────────────────────────

    /**
     * Menu structure (matches React's MediaPlayer CC menu):
     *   [0] = "Off"
     *   [1..N] = All languages from SUBTITLE_LANGS
     *
     * Each language shows a status indicator:
     *   - Not yet fetched: just the label
     *   - Loading: label + "..." spinner
     *   - Missing: label + ✗ (dimmed)
     *   - Active: ● label (red, bold)
     */
    private fun openSubMenu(target: SubMenuTarget) {
        currentSubMenuTarget = target
        isSubMenuOpen = true
        hideRunnable?.let { handler.removeCallbacks(it) }
        val scrollView = root.findViewById<android.widget.ScrollView>(R.id.vodSubTrackScroll)
        // Hard reset any previous submenu state before rebuilding.
        subMenuCursor = 0
        subMenuUserNavigated = false
        subTrackList.scrollTo(0, 0)
        scrollView?.scrollTo(0, 0)
        refreshAudioTrackOptions()
        buildTrackListUI()
        updateAudioDisplay()
        updateSizeDisplay()
        when (target) {
            SubMenuTarget.LANGUAGE -> {
                subSizeRow.visibility = View.GONE
                audioRow.visibility = View.GONE
                subSyncRow.visibility = View.GONE
                subTrackScroll.visibility = View.VISIBLE
                scrollView?.scrollTo(0, 0)
            }
            SubMenuTarget.AUDIO -> {
                subSizeRow.visibility = View.GONE
                audioRow.visibility = View.GONE
                subSyncRow.visibility = View.GONE
                subTrackScroll.visibility = View.VISIBLE
                scrollView?.scrollTo(0, 0)
            }
            SubMenuTarget.ADJUST -> {
                subSizeRow.visibility = View.VISIBLE
                audioRow.visibility = View.GONE
                subSyncRow.visibility = View.VISIBLE
                subTrackScroll.visibility = View.GONE
                updateSyncDisplay()
            }
        }
        subMenuTitle.text = when (target) {
            SubMenuTarget.LANGUAGE -> "Subtitle language"
            SubMenuTarget.AUDIO -> "Audio track"
            SubMenuTarget.ADJUST -> "Subtitle adjust"
        }
        subMenuCursor = when (target) {
            SubMenuTarget.LANGUAGE -> 0
            SubMenuTarget.AUDIO -> 0
            SubMenuTarget.ADJUST -> getSizeCursorIndex() ?: getSyncCursorIndex() ?: 0
        }.coerceIn(0, getSubMenuMaxCursor())
        subMenu.visibility = View.VISIBLE
        updateSubMenuFocus()
        scheduleAudioTrackRefreshIfNeeded()
        // Force focus after layout as well, to avoid stale highlight/scroll state.
        handler.post {
            if (!isSubMenuOpen || currentSubMenuTarget != target) return@post
            if (subMenuUserNavigated) return@post
            if (target == SubMenuTarget.LANGUAGE || target == SubMenuTarget.AUDIO) {
                subMenuCursor = 0
                scrollView?.scrollTo(0, 0)
            }
            updateSubMenuFocus()
        }
        updateControlButtonsState()
    }

    private fun closeSubMenu() {
        isSubMenuOpen = false
        audioRefreshRunnable?.let { handler.removeCallbacks(it) }
        audioRefreshRunnable = null
        subMenuCursor = 0
        subMenu.visibility = View.GONE
        subTrackList.removeAllViews()
        updateControlButtonsState()
        scheduleHide()
    }

    private fun buildTrackListUI() {
        subTrackList.removeAllViews()
        if (currentSubMenuTarget == SubMenuTarget.ADJUST) return
        if (currentSubMenuTarget == SubMenuTarget.AUDIO) {
            buildAudioTrackListUI()
            return
        }

        val mgr = subtitleManager ?: return
        val activeCode = mgr.getActiveLanguageCode()

        // "Off" item
        addTrackItem(
            label = "Off",
            statusText = null,
            isActive = activeCode == null,
            isMissing = false,
            isLoading = false,
        )

        // Section header
        if (mgr.tmdbId.isNotBlank()) {
            addSectionHeader("Languages")
        }

        // All languages
        for (lang in mgr.SUBTITLE_LANGS) {
            val cached = mgr.langCache[lang.code]
            val isActive = activeCode == lang.code
            val isLoading = cached == "loading"
            val isMissing = cached == "missing"
            val isDownloaded = !isLoading && !isMissing && !cached.isNullOrBlank()
            val hasEmbedded = mgr.hasEmbeddedForLanguage(lang.code)
            val isEmbeddedActive = isActive && mgr.isUsingEmbeddedSubtitles()

            addTrackItem(
                label = lang.label,
                statusText = when {
                    isLoading -> "..."
                    isMissing -> "✗"
                    isEmbeddedActive -> "EMB"
                    isActive  -> "✓"
                    cached != null && cached != "loading" && cached != "missing" -> "✓"
                    hasEmbedded -> "EMB"
                    else -> null
                },
                isActive = isActive,
                isMissing = isMissing,
                isLoading = isLoading,
                showAdjustHint = false,
            )
        }

        // "No subtitles" fallback
        if (mgr.tmdbId.isBlank() && !mgr.hasAnyEmbeddedSubtitles()) {
            addNoSubtitlesItem()
        }
    }

    private fun buildAudioTrackListUI() {
        if (audioTracks.isEmpty()) {
            val tv = TextView(root.context).apply {
                text = "   No embedded audio tracks"
                setTextColor(Color.parseColor("#55FFFFFF"))
                textSize = 14f
                setPadding(dpToPx(16), dpToPx(10), dpToPx(16), dpToPx(10))
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                )
            }
            subTrackList.addView(tv)
            return
        }

        val currentId = playerManager.getCurrentAudioTrackId()
        for (opt in audioTracks) {
            addTrackItem(
                label = opt.label,
                statusText = null,
                isActive = opt.id == currentId,
                isMissing = false,
                isLoading = false,
                showAdjustHint = false,
            )
        }
    }

    private fun refreshAudioTrackOptions() {
        audioTracks = playerManager.getAvailableAudioTracks()
        val currentId = playerManager.getCurrentAudioTrackId()
        selectedAudioIdx = audioTracks.indexOfFirst { it.id == currentId }
            .takeIf { it >= 0 } ?: 0
        audioRow.visibility = if (audioTracks.size > 1) View.VISIBLE else View.GONE
    }

    private fun scheduleAudioTrackRefreshIfNeeded() {
        audioRefreshRunnable?.let { handler.removeCallbacks(it) }
        audioRefreshRunnable = null
        if (currentSubMenuTarget != SubMenuTarget.AUDIO || audioTracks.isNotEmpty()) return
        audioRefreshRunnable = Runnable {
            if (!isSubMenuOpen || currentSubMenuTarget != SubMenuTarget.AUDIO) return@Runnable
            refreshAudioTrackOptions()
            buildTrackListUI()
            subMenuCursor = subMenuCursor.coerceIn(0, getSubMenuMaxCursor())
            updateSubMenuFocus()
            updateControlButtonsState()
        }
        // Some streams expose tracks shortly after first readiness; refresh once.
        handler.postDelayed(audioRefreshRunnable!!, 350)
    }

    private fun adjustAudioTrack(delta: Int) {
        if (audioTracks.size <= 1) return
        selectedAudioIdx = (selectedAudioIdx + delta + audioTracks.size) % audioTracks.size
        val selected = audioTracks.getOrNull(selectedAudioIdx) ?: return
        if (playerManager.selectAudioTrack(selected.id)) {
            updateAudioDisplay()
            updateControlButtonsState()
        }
    }

    private fun updateAudioDisplay() {
        if (audioTracks.isEmpty()) {
            audioValue.text = "Default"
            return
        }
        val selected = audioTracks.getOrNull(selectedAudioIdx) ?: audioTracks.first()
        audioValue.text = selected.label
    }

    private fun addSectionHeader(title: String) {
        val tv = TextView(root.context).apply {
            text = title
            setTextColor(Color.parseColor("#99FFFFFF"))
            textSize = 12f
            setTypeface(null, Typeface.BOLD)
            setPadding(dpToPx(16), dpToPx(12), dpToPx(16), dpToPx(4))
            isClickable = false
            isFocusable = false
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
        }
        subTrackList.addView(tv)
    }

    private fun addTrackItem(
        label: String,
        statusText: String?,
        isActive: Boolean,
        isMissing: Boolean,
        isLoading: Boolean,
        showAdjustHint: Boolean = false,
    ) {
        val tv = TextView(root.context).apply {
            val prefix = if (isActive) "● " else "   "
            val suffix = when {
                statusText != null -> "  $statusText"
                else -> ""
            }
            val adjust = if (showAdjustHint) "   → adjust" else ""
            text = "$prefix$label$suffix$adjust"

            setTextColor(when {
                isActive  -> Color.parseColor(COL_RED)
                isMissing -> Color.parseColor("#55FFFFFF")
                isLoading -> Color.parseColor("#AAFFFFFF")
                else      -> Color.WHITE
            })

            textSize = 15f
            if (isActive) setTypeface(null, Typeface.BOLD)
            setPadding(dpToPx(16), dpToPx(10), dpToPx(16), dpToPx(10))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            tag = "track_item"
        }
        subTrackList.addView(tv)
    }

    private fun addNoSubtitlesItem() {
        val tv = TextView(root.context).apply {
            text = "   No subtitles available"
            setTextColor(Color.parseColor("#55FFFFFF"))
            textSize = 14f
            setPadding(dpToPx(16), dpToPx(10), dpToPx(16), dpToPx(10))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
        }
        subTrackList.addView(tv)
    }

    private fun updateSubMenuFocus() {
        // Only focus on track items (skip section headers)
        var trackIdx = 0
        for (i in 0 until subTrackList.childCount) {
            val child = subTrackList.getChildAt(i)
            if (child.tag == "track_item") {
                child.setBackgroundColor(
                    if (trackIdx == subMenuCursor && subMenuCursor < getTrackItemCount())
                        Color.parseColor("#33FFFFFF")
                    else
                        Color.TRANSPARENT
                )
                trackIdx++
            } else {
                child.setBackgroundColor(Color.TRANSPARENT)
            }
        }
        val sizeIdx = getTrackItemCount()
        val audioIdx = getAudioCursorIndex()
        val syncIdx = getSyncCursorIndex()
        subSizeRow.setBackgroundColor(if (subMenuCursor == sizeIdx) Color.parseColor("#26FFFFFF") else Color.TRANSPARENT)
        audioRow.setBackgroundColor(
            if (audioRow.visibility == View.VISIBLE && subMenuCursor == audioIdx) Color.parseColor("#26FFFFFF")
            else Color.TRANSPARENT
        )
        subSyncRow.setBackgroundColor(if (subMenuCursor == syncIdx) Color.parseColor("#26FFFFFF") else Color.TRANSPARENT)

        // Scroll focused item into view inside ScrollView
        if (subMenuCursor < getTrackItemCount()) {
            val focusedView = getTrackItemView(subMenuCursor)
            focusedView?.let { fv ->
                val scrollView = root.findViewById<android.widget.ScrollView>(R.id.vodSubTrackScroll)
                scrollView?.let { sv ->
                    val scrollTarget = fv.top - sv.height / 3
                    // Immediate scroll keeps visual highlight in sync with D-pad cursor.
                    sv.scrollTo(0, scrollTarget.coerceAtLeast(0))
                }
            }
        }
    }

    private fun getTrackItemView(trackIndex: Int): View? {
        var idx = 0
        for (i in 0 until subTrackList.childCount) {
            val child = subTrackList.getChildAt(i)
            if (child.tag == "track_item") {
                if (idx == trackIndex) return child
                idx++
            }
        }
        return null
    }

    private fun getTrackItemCount(): Int {
        var count = 0
        for (i in 0 until subTrackList.childCount) {
            if (subTrackList.getChildAt(i).tag == "track_item") count++
        }
        return count
    }

    private fun selectSubMenuItem() {
        if (currentSubMenuTarget == SubMenuTarget.AUDIO) {
            val selected = audioTracks.getOrNull(subMenuCursor) ?: return
            if (playerManager.selectAudioTrack(selected.id)) {
                refreshAudioTrackOptions()
                buildTrackListUI()
                updateSubMenuFocus()
                updateControlButtonsState()
            }
            return
        }

        val mgr = subtitleManager ?: return
        if (subMenuCursor >= getTrackItemCount()) return

        if (subMenuCursor == 0) {
            // "Off" selected
            mgr.turnOff()
            updateControlButtonsState()
            buildTrackListUI()
            updateSubMenuFocus()
            return
        }

        // Language selected (index 1..N maps to SUBTITLE_LANGS[0..N-1])
        val langIdx = subMenuCursor - 1
        val lang = mgr.SUBTITLE_LANGS.getOrNull(langIdx) ?: return
        val cached = mgr.langCache[lang.code]

        when {
            cached == "loading" -> {
                // Already loading, ignore
                return
            }
            cached == "missing" -> {
                // Already known missing, ignore
                return
            }
            cached != null -> {
                // Already have a VTT URL cached — load it directly
                val track = SubtitleManager.Track(lang.code, lang.label, cached)
                mgr.loadTrack(track)
                updateControlButtonsState()
                buildTrackListUI()
                updateSubMenuFocus()
            }
            else -> {
                // Prefer embedded track if stream already carries this language.
                if (mgr.useEmbeddedLanguage(lang.code)) {
                    updateControlButtonsState()
                    buildTrackListUI()
                    updateSubMenuFocus()
                } else {
                    // Fallback to OTT API on-demand fetch.
                    mgr.fetchAndLoad(lang.code) { track ->
                        // This runs on main thread
                        updateControlButtonsState()
                        buildTrackListUI()
                        updateSubMenuFocus()
                    }
                    // Immediately update UI to show "loading" state
                    buildTrackListUI()
                    updateSubMenuFocus()
                }
            }
        }
    }

    private fun updateControlButtonsState() {
        val active = subtitleManager?.getActiveLanguageCode() != null
        subLangBtn.setTextColor(if (active) Color.parseColor(COL_RED) else Color.parseColor(COL_DIM))

        val audioAvailable = playerManager.getAvailableAudioTracks().size > 1
        audioBtn.setTextColor(if (audioAvailable) Color.parseColor(COL_WHITE) else Color.parseColor(COL_DIM))

        val syncOffset = subtitleManager?.syncOffsetMs ?: 0L
        val textSize = subtitleManager?.subtitleTextSizeSp ?: 20f
        val adjustActive = syncOffset != 0L || kotlin.math.abs(textSize - 20f) > 0.01f
        adjustBtn.setTextColor(if (adjustActive) Color.parseColor(COL_RED) else Color.parseColor(COL_DIM))
    }

    private fun updateSyncDisplay() {
        val offsetSec = (subtitleManager?.syncOffsetMs ?: 0) / 1000.0
        subSyncValue.text = String.format("%+.1fs", offsetSec)
    }

    private fun updateSizeDisplay() {
        val sizeSp = subtitleManager?.subtitleTextSizeSp ?: 20f
        subSizeValue.text = String.format("%.0fsp", sizeSp)
    }

    private fun getAudioCursorIndex(): Int? {
        var idx = getTrackItemCount()
        if (subSizeRow.visibility == View.VISIBLE) idx += 1
        return if (audioRow.visibility == View.VISIBLE) idx else null
    }

    private fun getSizeCursorIndex(): Int? {
        return if (subSizeRow.visibility == View.VISIBLE) getTrackItemCount() else null
    }

    private fun getSyncCursorIndex(): Int? {
        var idx = getTrackItemCount()
        if (subSizeRow.visibility == View.VISIBLE) idx += 1
        if (audioRow.visibility == View.VISIBLE) idx += 1
        return if (subSyncRow.visibility == View.VISIBLE) idx else null
    }

    private fun getSubMenuMaxCursor(): Int {
        return getSyncCursorIndex() ?: getAudioCursorIndex() ?: getSizeCursorIndex() ?: (getTrackItemCount() - 1).coerceAtLeast(0)
    }

    // ── Progress tracking ────────────────────────────────────────────────────

    private fun startProgressUpdates() {
        stopProgressUpdates()
        progressRunnable = object : Runnable {
            override fun run() {
                updateProgress()
                handler.postDelayed(this, 500)
            }
        }
        handler.post(progressRunnable!!)
    }

    private fun stopProgressUpdates() {
        progressRunnable?.let { handler.removeCallbacks(it) }
        progressRunnable = null
    }

    private fun updateProgress() {
        val position = playerManager.getCurrentPosition()
        val duration = playerManager.getDuration()
        val buffered = playerManager.getBufferedPosition()

        currentTimeView.text = formatTime(position)
        durationView.text = formatTime(duration)

        if (duration <= 0) return
        val containerWidth = seekBarContainer.width.toFloat()
        if (containerWidth <= 0) return

        val playedRatio = (position.toFloat() / duration).coerceIn(0f, 1f)
        val bufferedRatio = (buffered.toFloat() / duration).coerceIn(0f, 1f)

        updateTrackWidth(playedFill, (containerWidth * playedRatio).toInt())
        updateTrackWidth(bufferedFill, (containerWidth * bufferedRatio).toInt())

        val thumbOffset = (containerWidth * playedRatio).toInt() - (seekThumb.width / 2)
        val thumbParams = seekThumb.layoutParams as FrameLayout.LayoutParams
        thumbParams.marginStart = thumbOffset.coerceAtLeast(0)
        seekThumb.layoutParams = thumbParams
    }

    private fun updateTrackWidth(view: View, width: Int) {
        val lp = view.layoutParams
        lp.width = width.coerceAtLeast(0)
        view.layoutParams = lp
    }

    private fun formatTime(ms: Long): String {
        if (ms <= 0) return "0:00"
        val total = ms / 1000
        val h = total / 3600; val m = (total % 3600) / 60; val s = total % 60
        return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}"
        else "$m:${s.toString().padStart(2, '0')}"
    }

    // ── D-pad key handling ──────────────────────────────────────────────────

    fun handleKeyCenter(): Boolean {
        if (isSubMenuOpen) {
            subMenuUserNavigated = true
            val sizeIdx = getSizeCursorIndex()
            val audioIdx = getAudioCursorIndex()
            val syncIdx = getSyncCursorIndex()
            when (subMenuCursor) {
                in 0 until getTrackItemCount() -> selectSubMenuItem()
                sizeIdx -> { subtitleManager?.adjustTextSize(1f); updateSizeDisplay(); updateControlButtonsState() }
                audioIdx -> adjustAudioTrack(1)
                syncIdx -> { subtitleManager?.adjustSync(500); updateSyncDisplay(); updateControlButtonsState() }
            }
            return true
        }
        if (!isVisible) { showWithTimer(); return true }

        if (focusZone == ZONE_CONTROLS) {
            val btn = controlButtons.getOrNull(controlFocusIdx)
            when (btn) {
                playPauseBtn -> { togglePlayPause(); updatePlayPauseIcon() }
                prevEpisodeBtn -> onPrevEpisode?.invoke()
                nextEpisodeBtn -> onNextEpisode?.invoke()
                subLangBtn -> openSubMenu(SubMenuTarget.LANGUAGE)
                audioBtn -> openSubMenu(SubMenuTarget.AUDIO)
                adjustBtn -> openSubMenu(SubMenuTarget.ADJUST)
            }
        } else {
            togglePlayPause(); updatePlayPauseIcon()
        }
        scheduleHide()
        return true
    }

    fun handleKeyLeft(): Boolean {
        if (isSubMenuOpen) {
            subMenuUserNavigated = true
            val sizeIdx = getSizeCursorIndex()
            val audioIdx = getAudioCursorIndex()
            val syncIdx = getSyncCursorIndex()
            when (subMenuCursor) {
                sizeIdx -> { subtitleManager?.adjustTextSize(-1f); updateSizeDisplay(); updateControlButtonsState() }
                audioIdx -> adjustAudioTrack(-1)
                syncIdx -> { subtitleManager?.adjustSync(-500); updateSyncDisplay(); updateControlButtonsState() }
            }
            return true
        }
        if (!isVisible) { showWithTimer(); return true }

        when (focusZone) {
            ZONE_SEEK -> {
                playerManager.seekBy(-30_000); updateProgress()
            }
            ZONE_CONTROLS -> {
                controlFocusIdx = (controlFocusIdx - 1).coerceAtLeast(0)
                updateFocusVisuals()
            }
        }
        scheduleHide()
        return true
    }

    fun handleKeyRight(): Boolean {
        if (isSubMenuOpen) {
            subMenuUserNavigated = true
            val sizeIdx = getSizeCursorIndex()
            val audioIdx = getAudioCursorIndex()
            val syncIdx = getSyncCursorIndex()
            when (subMenuCursor) {
                in 0 until getTrackItemCount() -> {
                    // Shortcut: jump from language list to the selected section target.
                    val targetCursor = when (currentSubMenuTarget) {
                        SubMenuTarget.LANGUAGE -> null
                        SubMenuTarget.AUDIO -> audioIdx
                        SubMenuTarget.ADJUST -> sizeIdx ?: syncIdx
                    }
                    if (targetCursor == null) return true
                    subMenuCursor = targetCursor
                    updateSubMenuFocus()
                }
                sizeIdx -> { subtitleManager?.adjustTextSize(1f); updateSizeDisplay(); updateControlButtonsState() }
                audioIdx -> adjustAudioTrack(1)
                syncIdx -> { subtitleManager?.adjustSync(500); updateSyncDisplay(); updateControlButtonsState() }
            }
            return true
        }
        if (!isVisible) { showWithTimer(); return true }

        when (focusZone) {
            ZONE_SEEK -> {
                playerManager.seekBy(30_000); updateProgress()
            }
            ZONE_CONTROLS -> {
                controlFocusIdx = (controlFocusIdx + 1).coerceAtMost(controlButtons.size - 1)
                updateFocusVisuals()
            }
        }
        scheduleHide()
        return true
    }

    fun handleKeyDown(): Boolean {
        if (isSubMenuOpen) {
            subMenuUserNavigated = true
            val maxCursor = getSubMenuMaxCursor()
            subMenuCursor = (subMenuCursor + 1).coerceAtMost(maxCursor)
            updateSubMenuFocus()
            return true
        }
        if (!isVisible) { showWithTimer(); return true }

        if (focusZone < ZONE_CONTROLS) {
            focusZone++
            updateFocusVisuals()
        }
        scheduleHide()
        return true
    }

    fun handleKeyUp(): Boolean {
        if (isSubMenuOpen) {
            subMenuUserNavigated = true
            subMenuCursor = (subMenuCursor - 1).coerceAtLeast(0)
            updateSubMenuFocus()
            return true
        }
        if (!isVisible) { showWithTimer(); return true }

        if (focusZone > ZONE_SEEK) {
            focusZone--
            updateFocusVisuals()
        } else {
            hideRunnable?.let { handler.removeCallbacks(it) }
            fadeOut()
        }
        scheduleHide()
        return true
    }

    fun handleKeyBack(): Boolean {
        if (isSubMenuOpen) { closeSubMenu(); return true }
        if (isVisible) {
            hideRunnable?.let { handler.removeCallbacks(it) }
            fadeOut()
            return true
        }
        return false
    }

    fun destroy() {
        hideRunnable?.let { handler.removeCallbacks(it) }
        stopProgressUpdates()
        subtitleManager?.destroy()
        handler.removeCallbacksAndMessages(null)
    }

    fun getSelectedSubtitleLanguage(): String? {
        return subtitleManager?.getActiveLanguageCode()
            ?.trim()
            ?.lowercase()
            ?.takeIf { it.isNotBlank() }
    }

    fun getSelectedAudioLanguage(): String? {
        val currentId = playerManager.getCurrentAudioTrackId() ?: return null
        val current = playerManager.getAvailableAudioTracks().firstOrNull { it.id == currentId } ?: return null
        return current.language.trim().lowercase().takeIf { it.isNotBlank() }
    }
}
