package com.donoy.mybandpractice.v2.sync

import org.json.JSONArray
import org.json.JSONObject

/** Offer or answer SDP rebuilt the same way as `web/src/utils/p2pProtocol.ts`. */
data class DecodedSdp(val type: String, val sdp: String)

private val CANDIDATE = Regex(
    """(?m)^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ host\b""",
)

private fun attr(sdp: String, name: String): String {
    val match = Regex("(?m)^a=$name:(.+)$").find(sdp) ?: return ""
    return match.groupValues[1].trim()
}

fun encodeSdp(type: String, sdp: String): String {
    val letter = if (type == "offer") "O" else "A"
    val mini = JSONObject()
    mini.put("t", letter)
    mini.put("p", attr(sdp, "ice-pwd"))
    mini.put("u", attr(sdp, "ice-ufrag"))
    mini.put("f", attr(sdp, "fingerprint"))
    val setup = attr(sdp, "setup").ifBlank { "actpass" }
    mini.put("s", setup)
    val candidates = JSONArray()
    for (match in CANDIDATE.findAll(sdp)) {
        val ip = match.groupValues[5]
        if (ip.startsWith("fe80:", ignoreCase = true) || ip.startsWith("127.")) continue
        val foundation = match.groupValues[1]
        val priority = match.groupValues[4]
        val port = match.groupValues[6]
        candidates.put("$foundation/$priority/$ip/$port")
    }
    mini.put("c", candidates)
    return letter + compressToEncodedUriComponent(mini.toString())
}

fun decodeSdp(payload: String): DecodedSdp? {
    if (payload.isEmpty()) return null
    val letter = payload[0]
    if (letter != 'O' && letter != 'A') return null
    val raw = decompressFromEncodedUriComponent(payload.substring(1)) ?: return null
    val type = if (letter == 'O') "offer" else "answer"
    if (raw.startsWith("v=0")) return DecodedSdp(type, raw)
    val mini = runCatching { JSONObject(raw) }.getOrNull() ?: return null
    if (mini.opt("p") !is String || mini.optJSONArray("c") == null) return null
    val setup = mini.optString("s").ifBlank { "actpass" }
    val lines = mutableListOf(
        "v=0",
        "o=- 0 0 IN IP4 0.0.0.0",
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0",
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
        "c=IN IP4 0.0.0.0",
        "a=ice-ufrag:${mini.optString("u")}",
        "a=ice-pwd:${mini.optString("p")}",
        "a=fingerprint:${mini.optString("f")}",
        "a=setup:$setup",
        "a=mid:0",
        "a=sctp-port:5000",
        "a=max-message-size:262144",
    )
    val candidates = mini.getJSONArray("c")
    for (i in 0 until candidates.length()) {
        val parts = candidates.optString(i).split('/')
        if (parts.size != 4 || parts.any { it.isEmpty() }) continue
        val (foundation, priority, ip, port) = parts
        lines += "a=candidate:$foundation 1 udp $priority $ip $port typ host generation 0"
    }
    return DecodedSdp(type, lines.joinToString("\r\n") + "\r\n")
}

/** Host candidates gathered by Android are appended when the local SDP omits them. */
fun sdpWithHostCandidates(sdp: String, extra: List<String>): String {
    if (sdp.contains("\na=candidate:") || sdp.contains("\r\na=candidate:")) return sdp
    if (extra.isEmpty()) return sdp
    val body = sdp.trimEnd()
    return body + "\r\n" + extra.joinToString("\r\n") { line ->
        if (line.startsWith("a=")) line else "a=$line"
    } + "\r\n"
}
