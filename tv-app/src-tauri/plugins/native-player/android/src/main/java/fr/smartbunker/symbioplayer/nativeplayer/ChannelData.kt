package fr.smartbunker.symbioplayer.nativeplayer

import org.json.JSONObject

data class ChannelInfo(
    val streamId: Long,
    val name: String,
    val logo: String,
    val tvArchive: Boolean,
    val audioCodec: String,
    val videoCodec: String,
)

data class LivePlayerData(
    val baseStreamUrl: String,
    val username: String,
    val password: String,
    val preferredOutput: String,
    val currentIndex: Int,
    val channels: List<ChannelInfo>,
) {
    companion object {
        fun fromJson(json: String): LivePlayerData? {
            return try {
                val obj = JSONObject(json)
                val channelsArr = obj.optJSONArray("channels")
                val channels = mutableListOf<ChannelInfo>()
                if (channelsArr != null) {
                    for (i in 0 until channelsArr.length()) {
                        val ch = channelsArr.getJSONObject(i)
                        channels.add(
                            ChannelInfo(
                                streamId = ch.optLong("stream_id", 0),
                                name = ch.optString("name", ""),
                                logo = ch.optString("stream_icon", ""),
                                tvArchive = ch.optBoolean("tv_archive", false),
                                audioCodec = ch.optString("audio_codec", ""),
                                videoCodec = ch.optString("video_codec", ""),
                            )
                        )
                    }
                }
                LivePlayerData(
                    baseStreamUrl = obj.optString("base_stream_url", ""),
                    username = obj.optString("username", ""),
                    password = obj.optString("password", ""),
                    preferredOutput = obj.optString("preferred_output", "m3u8"),
                    currentIndex = obj.optInt("currentIndex", 0),
                    channels = channels,
                )
            } catch (e: Exception) {
                null
            }
        }
    }
}
