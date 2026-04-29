package fr.smartbunker.symbioplayer.nativeplayer

import android.animation.ObjectAnimator
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import fr.smartbunker.symbioplayer.nativeplayer.R
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

class LiveOverlayManager(
    private val root: View,
    private val liveData: LivePlayerData,
    private val onChannelZap: (newIndex: Int, newUrl: String) -> Unit,
    private val onCatchup: (url: String) -> Unit,
    private val onBackToLive: (currentChannelIndex: Int) -> Unit,
    private val onClose: () -> Unit,
) {
    companion object {
        private const val TAG = "LiveOverlay"
    }

    private val handler = Handler(Looper.getMainLooper())
    private val overlayRoot: View = root.findViewById(R.id.liveOverlayRoot)

    private val channelLogo: ImageView = root.findViewById(R.id.channelLogo)
    private val channelName: TextView = root.findViewById(R.id.channelName)
    private val clockTime: TextView = root.findViewById(R.id.clockTime)
    private val clockDate: TextView = root.findViewById(R.id.clockDate)
    private val closeBtn: View = root.findViewById(R.id.closeBtn)

    private val epgLoading: TextView = root.findViewById(R.id.epgLoading)
    private val epgNoData: TextView = root.findViewById(R.id.epgNoData)
    private val epgSection: View = root.findViewById(R.id.epgSection)
    private val epgStrip: LinearLayout = root.findViewById(R.id.epgStrip)
    private val epgNavLeft: View = root.findViewById(R.id.epgNavLeft)
    private val epgNavRight: View = root.findViewById(R.id.epgNavRight)
    private val zapUp: View = root.findViewById(R.id.zapUp)
    private val zapDown: View = root.findViewById(R.id.zapDown)

    private val epgDetailPanel: View = root.findViewById(R.id.epgDetailPanel)
    private val epgDetailTime: TextView = root.findViewById(R.id.epgDetailTime)
    private val epgLiveBadge: View = root.findViewById(R.id.epgLiveBadge)
    private val epgFutureBadge: View = root.findViewById(R.id.epgFutureBadge)
    private val catchupBtn: View = root.findViewById(R.id.catchupBtn)
    private val backToLiveBtn: View = root.findViewById(R.id.backToLiveBtn)
    private val epgDetailTitle: TextView = root.findViewById(R.id.epgDetailTitle)
    private val epgDetailDesc: TextView = root.findViewById(R.id.epgDetailDesc)
    private val epgProgressContainer: View = root.findViewById(R.id.epgProgressContainer)
    private val epgProgressFill: View = root.findViewById(R.id.epgProgressFill)

    private var epgEntries: List<EpgEntry> = emptyList()
    private var epgIndex = 0
    private var channelIndex = liveData.currentIndex
    private var isVisible = true
    private var isCatchupPlaying = false
    private var hideRunnable: Runnable? = null
    private var fadeToken = 0L
    private var logoRequestToken = 0L
    private var epgRequestToken = 0L

    private val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
    private val dateFormat = SimpleDateFormat("EEEE, d MMMM", Locale.getDefault())
    private val epgTimeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())

    fun initialize() {
        updateChannelInfo()
        setupClickListeners()
        startClockUpdates()
        showWithTimer()
        fetchEpgForCurrentChannel()
    }

    private fun currentChannel(): ChannelInfo? {
        return liveData.channels.getOrNull(channelIndex)
    }

    private fun updateChannelInfo() {
        val ch = currentChannel() ?: return
        channelName.text = ch.name
        loadLogo(ch.logo)
    }

    private fun loadLogo(url: String) {
        if (url.isBlank()) {
            channelLogo.visibility = View.GONE
            return
        }
        channelLogo.visibility = View.VISIBLE
        val token = ++logoRequestToken
        thread {
            val bitmap = downloadBitmap(url)
            handler.post {
                if (token != logoRequestToken) return@post
                if (bitmap != null) {
                    channelLogo.setImageBitmap(bitmap)
                } else {
                    channelLogo.visibility = View.GONE
                }
            }
        }
    }

    private fun downloadBitmap(url: String): Bitmap? {
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 5_000
            conn.readTimeout = 5_000
            conn.doInput = true
            conn.connect()
            val bmp = BitmapFactory.decodeStream(conn.inputStream)
            conn.disconnect()
            bmp
        } catch (e: Exception) {
            null
        }
    }

    private fun setupClickListeners() {
        closeBtn.setOnClickListener { onClose() }
        epgNavLeft.setOnClickListener { navigateEpg(-1) }
        epgNavRight.setOnClickListener { navigateEpg(1) }
        zapUp.setOnClickListener { zapChannel(1) }
        zapDown.setOnClickListener { zapChannel(-1) }
        catchupBtn.setOnClickListener { startCatchup() }
        backToLiveBtn.setOnClickListener { returnToLive() }
        overlayRoot.setOnClickListener { toggleVisibility() }
    }

    private fun startClockUpdates() {
        val clockRunnable = object : Runnable {
            override fun run() {
                val now = Date()
                clockTime.text = timeFormat.format(now)
                clockDate.text = dateFormat.format(now)
                updateEpgProgress()
                handler.postDelayed(this, 1000)
            }
        }
        handler.post(clockRunnable)
    }

    // ── Visibility ──────────────────────────────────────────────────────────

    fun showWithTimer() {
        fadeToken++
        overlayRoot.alpha = 1f
        overlayRoot.visibility = View.VISIBLE
        isVisible = true
        scheduleHide()
    }

    private fun scheduleHide() {
        hideRunnable?.let { handler.removeCallbacks(it) }
        hideRunnable = Runnable {
            fadeOut()
        }
        handler.postDelayed(hideRunnable!!, 5000)
    }

    private fun fadeOut() {
        val token = ++fadeToken
        ObjectAnimator.ofFloat(overlayRoot, "alpha", 1f, 0f).apply {
            duration = 300
            start()
        }
        handler.postDelayed({
            if (token != fadeToken) return@postDelayed
            overlayRoot.visibility = View.GONE
            isVisible = false
        }, 300)
    }

    private fun toggleVisibility() {
        if (isVisible) {
            hideRunnable?.let { handler.removeCallbacks(it) }
            fadeOut()
        } else {
            showWithTimer()
        }
    }

    fun onUserInteraction() {
        if (!isVisible) {
            showWithTimer()
        } else {
            scheduleHide()
        }
    }

    // ── EPG ─────────────────────────────────────────────────────────────────

    fun fetchEpgForCurrentChannel() {
        val ch = currentChannel() ?: return
        val token = ++epgRequestToken
        epgLoading.visibility = View.VISIBLE
        epgNoData.visibility = View.GONE
        epgSection.visibility = View.GONE
        epgDetailPanel.visibility = View.GONE

        thread {
            val url = EpgService.buildEpgUrl(
                liveData.baseStreamUrl, liveData.username, liveData.password, ch.streamId
            )
            val entries = EpgService.fetchEpg(url)

            handler.post {
                if (token != epgRequestToken) return@post
                epgEntries = entries
                epgLoading.visibility = View.GONE

                if (entries.isEmpty()) {
                    epgNoData.visibility = View.VISIBLE
                    epgSection.visibility = View.GONE
                    return@post
                }

                epgNoData.visibility = View.GONE
                epgSection.visibility = View.VISIBLE

                val nowSec = System.currentTimeMillis() / 1000
                val nowIdx = entries.indexOfFirst { it.startTimestamp <= nowSec && nowSec < it.stopTimestamp }
                epgIndex = if (nowIdx >= 0) nowIdx else 0

                buildEpgStrip()
                updateEpgDetail()
            }
        }
    }

    private fun buildEpgStrip() {
        epgStrip.removeAllViews()
        val windowSize = 5
        val windowStart = (epgIndex - 2).coerceIn(0, (epgEntries.size - windowSize).coerceAtLeast(0))
        val windowEnd = (windowStart + windowSize).coerceAtMost(epgEntries.size)
        val slots = epgEntries.subList(windowStart, windowEnd)
        val selectedInView = epgIndex - windowStart
        val nowSec = System.currentTimeMillis() / 1000

        for ((vi, entry) in slots.withIndex()) {
            val slot = createEpgSlotView(entry, vi == selectedInView, nowSec)
            val idx = windowStart + vi
            slot.setOnClickListener {
                epgIndex = idx
                buildEpgStrip()
                updateEpgDetail()
                scheduleHide()
            }
            epgStrip.addView(slot)
        }

        epgNavLeft.isEnabled = epgIndex > 0
        epgNavLeft.alpha = if (epgIndex > 0) 1f else 0.3f
        epgNavRight.isEnabled = epgIndex < epgEntries.size - 1
        epgNavRight.alpha = if (epgIndex < epgEntries.size - 1) 1f else 0.3f
    }

    private fun createEpgSlotView(entry: EpgEntry, isSelected: Boolean, nowSec: Long): View {
        val ctx = root.context
        val dp = { value: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), ctx.resources.displayMetrics).toInt() }

        val container = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(3)
                marginEnd = dp(3)
            }
            setPadding(dp(10), dp(8), dp(10), dp(8))
            val isLive = entry.startTimestamp <= nowSec && nowSec < entry.stopTimestamp
            isSelected.let { sel ->
                if (sel) setBackgroundResource(R.drawable.bg_epg_slot)
                else if (isLive) setBackgroundColor(ctx.getColor(R.color.epg_slot_live))
                else setBackgroundResource(R.drawable.bg_epg_slot)
            }
            this.isSelected = isSelected
        }

        val timeView = TextView(ctx).apply {
            text = epgTimeFormat.format(Date(entry.startTimestamp * 1000))
            setTextColor(ctx.getColor(R.color.text_secondary))
            textSize = 12f
        }

        val titleView = TextView(ctx).apply {
            text = entry.title
            setTextColor(ctx.getColor(R.color.text_primary))
            textSize = 13f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }

        container.addView(timeView)
        container.addView(titleView)
        return container
    }

    private fun updateEpgDetail() {
        val entry = epgEntries.getOrNull(epgIndex) ?: run {
            epgDetailPanel.visibility = View.GONE
            return
        }

        epgDetailPanel.visibility = View.VISIBLE
        val nowSec = System.currentTimeMillis() / 1000
        val isLive = entry.startTimestamp <= nowSec && nowSec < entry.stopTimestamp
        val isFuture = entry.startTimestamp > nowSec
        val ch = currentChannel()
        val canCatchup = ch?.tvArchive == true && entry.stopTimestamp < nowSec

        epgDetailTime.text = "${epgTimeFormat.format(Date(entry.startTimestamp * 1000))} – ${epgTimeFormat.format(Date(entry.stopTimestamp * 1000))}"

        epgLiveBadge.visibility = if (isLive) View.VISIBLE else View.GONE
        epgFutureBadge.visibility = if (isFuture) View.VISIBLE else View.GONE

        catchupBtn.visibility = if (canCatchup && !isCatchupPlaying) View.VISIBLE else View.GONE
        backToLiveBtn.visibility = if (isCatchupPlaying) View.VISIBLE else View.GONE

        epgDetailTitle.text = entry.title
        if (entry.description.isNotBlank()) {
            epgDetailDesc.text = entry.description
            epgDetailDesc.visibility = View.VISIBLE
        } else {
            epgDetailDesc.visibility = View.GONE
        }

        if (isLive) {
            epgProgressContainer.visibility = View.VISIBLE
            updateEpgProgress()
        } else {
            epgProgressContainer.visibility = View.GONE
        }
    }

    private fun updateEpgProgress() {
        val entry = epgEntries.getOrNull(epgIndex) ?: return
        val nowSec = System.currentTimeMillis() / 1000
        val isLive = entry.startTimestamp <= nowSec && nowSec < entry.stopTimestamp
        if (!isLive) return

        val total = (entry.stopTimestamp - entry.startTimestamp).toFloat()
        if (total <= 0) return
        val progress = ((nowSec - entry.startTimestamp).toFloat() / total).coerceIn(0f, 1f)

        val parent = epgProgressFill.parent as? ViewGroup ?: return
        val params = epgProgressFill.layoutParams as FrameLayout.LayoutParams
        params.width = (parent.width * progress).toInt()
        epgProgressFill.layoutParams = params
    }

    private fun navigateEpg(direction: Int) {
        val newIndex = epgIndex + direction
        if (newIndex < 0 || newIndex >= epgEntries.size) return
        epgIndex = newIndex
        buildEpgStrip()
        updateEpgDetail()
        scheduleHide()
    }

    // ── Channel zapping ─────────────────────────────────────────────────────

    private fun zapChannel(direction: Int) {
        val newIndex = channelIndex + direction
        if (newIndex < 0 || newIndex >= liveData.channels.size) return

        channelIndex = newIndex
        isCatchupPlaying = false
        val ch = liveData.channels[newIndex]
        val newUrl = EpgService.buildLiveStreamUrl(
            liveData.baseStreamUrl,
            liveData.username,
            liveData.password,
            ch.streamId,
            liveData.preferredOutput,
        )

        updateChannelInfo()
        epgEntries = emptyList()
        epgIndex = 0
        epgSection.visibility = View.GONE
        epgDetailPanel.visibility = View.GONE
        fetchEpgForCurrentChannel()
        showWithTimer()

        onChannelZap(newIndex, newUrl)
    }

    // ── Catchup ─────────────────────────────────────────────────────────────

    private fun startCatchup() {
        val entry = epgEntries.getOrNull(epgIndex)
        if (entry == null) {
            android.util.Log.w(TAG, "startCatchup: no EPG entry at index $epgIndex")
            return
        }

        val ch = currentChannel()
        if (ch == null) {
            android.util.Log.w(TAG, "startCatchup: no current channel at index $channelIndex")
            return
        }

        val startFormatted = EpgService.formatCatchupStart(entry)
        if (startFormatted == null) {
            android.util.Log.w(TAG, "startCatchup: failed to format start time, rawStart='${entry.rawStart}'")
            return
        }

        val durationMin = ((entry.stopTimestamp - entry.startTimestamp) / 60).toInt().coerceAtLeast(1)

        val catchupUrl = EpgService.buildCatchupUrl(
            liveData.baseStreamUrl, liveData.username, liveData.password,
            ch.streamId, durationMin, startFormatted, liveData.preferredOutput
        )

        android.util.Log.d(TAG, "startCatchup: stream=${ch.streamId} duration=${durationMin}m start=$startFormatted")
        android.util.Log.d(TAG, "startCatchup: url=$catchupUrl")

        isCatchupPlaying = true
        updateEpgDetail()
        scheduleHide()
        onCatchup(catchupUrl)
    }

    private fun returnToLive() {
        android.util.Log.d(TAG, "returnToLive: channelIndex=$channelIndex")
        isCatchupPlaying = false
        updateEpgDetail()
        scheduleHide()
        onBackToLive(channelIndex)
    }

    fun onCatchupFailed() {
        android.util.Log.d(TAG, "onCatchupFailed: resetting catchup state")
        isCatchupPlaying = false
        handler.post { updateEpgDetail() }
    }

    // ── D-pad key handling ──────────────────────────────────────────────────

    fun handleKeyLeft(): Boolean {
        if (!isVisible) { showWithTimer(); return true }
        navigateEpg(-1)
        return true
    }

    fun handleKeyRight(): Boolean {
        if (!isVisible) { showWithTimer(); return true }
        navigateEpg(1)
        return true
    }

    fun handleKeyUp(): Boolean {
        if (!isVisible) { showWithTimer(); return true }
        zapChannel(1)
        return true
    }

    fun handleKeyDown(): Boolean {
        if (!isVisible) { showWithTimer(); return true }
        zapChannel(-1)
        return true
    }

    fun handleKeyEnter(): Boolean {
        if (!isVisible) { showWithTimer(); return true }

        val entry = epgEntries.getOrNull(epgIndex) ?: return true
        val nowSec = System.currentTimeMillis() / 1000
        val ch = currentChannel()
        val isPast = entry.stopTimestamp < nowSec

        if (isCatchupPlaying) {
            returnToLive()
        } else if (isPast && ch?.tvArchive == true) {
            startCatchup()
        } else if (isPast && ch?.tvArchive != true) {
            android.util.Log.d(TAG, "handleKeyEnter: catchup not available for channel ${ch?.name} (tvArchive=${ch?.tvArchive})")
        }

        scheduleHide()
        return true
    }

    fun destroy() {
        logoRequestToken++
        epgRequestToken++
        fadeToken++
        hideRunnable?.let { handler.removeCallbacks(it) }
        handler.removeCallbacksAndMessages(null)
    }
}
