package fr.smartbunker.symbioplayer.nativeplayer

import android.util.Base64
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class EpgEntry(
    val id: String,
    val title: String,
    val description: String,
    val startTimestamp: Long,
    val stopTimestamp: Long,
    val rawStart: String,
)

object EpgService {
    private fun normalizeOutputExt(preferredOutput: String?): String {
        val lower = preferredOutput?.trim()?.lowercase() ?: "m3u8"
        return if (lower == "ts") "ts" else "m3u8"
    }

    fun buildEpgUrl(baseStreamUrl: String, username: String, password: String, streamId: Long): String {
        val u = URLEncoder.encode(username, "UTF-8")
        val p = URLEncoder.encode(password, "UTF-8")
        return "$baseStreamUrl/player_api.php?username=$u&password=$p&action=get_simple_data_table&stream_id=$streamId"
    }

    fun buildLiveStreamUrl(
        baseStreamUrl: String,
        username: String,
        password: String,
        streamId: Long,
        preferredOutput: String?,
    ): String {
        val ext = normalizeOutputExt(preferredOutput)
        return "$baseStreamUrl/live/$username/$password/$streamId.$ext"
    }

    fun buildCatchupUrl(
        baseStreamUrl: String,
        username: String,
        password: String,
        streamId: Long,
        durationMinutes: Int,
        startFormatted: String,
        preferredOutput: String?,
    ): String {
        val ext = normalizeOutputExt(preferredOutput)
        return "$baseStreamUrl/timeshift/$username/$password/$durationMinutes/$startFormatted/$streamId.$ext"
    }

    fun fetchEpg(url: String): List<EpgEntry> {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 15_000
        conn.setRequestProperty("User-Agent", "OTTPlayer/1.0 (Android TV)")

        return try {
            if (conn.responseCode != 200) return emptyList()
            val reader = BufferedReader(InputStreamReader(conn.inputStream))
            val body = reader.readText()
            reader.close()

            val json = JSONObject(body)
            val listings = json.optJSONArray("epg_listings") ?: return emptyList()
            val result = mutableListOf<EpgEntry>()

            for (i in 0 until listings.length()) {
                val item = listings.getJSONObject(i)
                result.add(
                    EpgEntry(
                        id = item.optString("id", ""),
                        title = decodeBase64(item.optString("title", "")),
                        description = decodeBase64(item.optString("description", "")),
                        startTimestamp = item.optLong("start_timestamp", 0),
                        stopTimestamp = item.optLong("stop_timestamp", 0),
                        rawStart = item.optString("start", ""),
                    )
                )
            }
            result
        } catch (e: Exception) {
            emptyList()
        } finally {
            conn.disconnect()
        }
    }

    private fun decodeBase64(str: String): String {
        if (str.isBlank()) return ""
        return try {
            String(Base64.decode(str, Base64.DEFAULT), Charsets.UTF_8)
        } catch (e: Exception) {
            str
        }
    }

    fun formatCatchupStart(entry: EpgEntry): String? {
        val raw = entry.rawStart
        if (raw.length < 16) return null
        // "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DD:HH-MM"
        return try {
            val date = raw.substring(0, 10)
            val time = raw.substring(11, 16).replace(':', '-')
            "$date:$time"
        } catch (e: Exception) {
            null
        }
    }
}
