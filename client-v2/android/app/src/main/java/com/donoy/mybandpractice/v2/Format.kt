package com.donoy.mybandpractice.v2

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

const val MAX_GAIN_DB = 6.0
const val MAX_GAIN = 1.995262314968879
const val UNITY_POS = 0.8
const val MIN_LOOP = 0.25

val STEM_ORDER = listOf("vocals", "drums", "bass", "other")
val PITCH_PRESETS = listOf(-5, -2, -1, 0, 1, 2, 5)
val RATE_PRESETS = listOf(0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5)
val MARKER_PRESETS = listOf("Int", "1A", "1B", "1サビ", "2A", "2B", "2サビ", "Solo", "Out")

private val SEMITONES = listOf("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
private val FLAT_TO_SHARP = mapOf("Db" to "C#", "Eb" to "D#", "Gb" to "F#", "Ab" to "G#", "Bb" to "A#")

fun clamp(n: Double, minV: Double, maxV: Double) = min(maxV, max(minV, n))
fun clampF(n: Float, minV: Float, maxV: Float) = min(maxV, max(minV, n))

fun posToGain(pos: Double): Double {
    val p = clamp(pos, 0.0, 1.0)
    if (p <= UNITY_POS) return p / UNITY_POS
    val db = ((p - UNITY_POS) / (1 - UNITY_POS)) * MAX_GAIN_DB
    return 10.0.pow(db / 20.0)
}

fun gainToPos(gain: Double): Double {
    val g = max(0.0, gain)
    if (g <= 1.0) return g * UNITY_POS
    val db = 20.0 * log10(min(g, MAX_GAIN))
    return UNITY_POS + (db / MAX_GAIN_DB) * (1 - UNITY_POS)
}

fun formatGain(gain: Double): String {
    if (gain <= 1.0) return "${kotlin.math.round(gain * 100).toInt()}%"
    return "+${"%.1f".format(20.0 * log10(gain))}dB"
}

fun formatDuration(seconds: Double?): String {
    if (seconds == null || !seconds.isFinite() || seconds < 0) return "–:––"
    val s = floor(seconds).toInt()
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

fun formatTimePrecise(seconds: Double?): String {
    if (seconds == null || !seconds.isFinite() || seconds < 0) return "0:00.0"
    val total = max(0.0, seconds)
    val m = floor(total / 60).toInt()
    val s = floor(total % 60).toInt()
    val t = floor((total % 1) * 10).toInt()
    return "$m:${s.toString().padStart(2, '0')}.$t"
}

fun formatBytes(n: Long): String {
    if (n < 1024) return "$n B"
    val units = listOf("KB", "MB", "GB")
    var v = n.toDouble() / 1024.0
    var i = 0
    while (v >= 1024 && i < units.lastIndex) {
        v /= 1024.0
        i++
    }
    return "${"%.1f".format(v)} ${units[i]}"
}

/** The name for a new mark: the first of the usual names that no mark has yet. */
fun nextMarkLabel(markers: List<Marker>): String {
    val used = markers.map { it.label }.toSet()
    return MARKER_PRESETS.firstOrNull { it !in used } ?: "M${markers.size + 1}"
}

/** How far from the playhead a mark may be to be offered as the one that was meant. */
const val MARK_NEAR_WINDOW = 5.0

/** The mark within [window] seconds of a time, the nearest one. */
fun markerNear(markers: List<Marker>, time: Double, window: Double = MARK_NEAR_WINDOW): Marker? =
    markers.filter { abs(it.time - time) <= window }.minByOrNull { abs(it.time - time) }

/**
 * Where the section that starts at [start] ends: at the next mark that leaves a loop long
 * enough to be one, or at the end of the song.
 */
fun sectionEnd(markers: List<Marker>, start: Double, duration: Double): Double =
    markers.asSequence().map { it.time }.filter { it > start + MIN_LOOP }.minOrNull() ?: duration

fun transposeChord(chord: String, semitones: Int): String {
    if (chord.isBlank() || chord == "N.C." || semitones == 0) return chord
    return Regex("([A-G][b#]?)").replace(chord) { match ->
        val raw = match.groupValues[1]
        val root = FLAT_TO_SHARP[raw] ?: raw
        val idx = SEMITONES.indexOf(root)
        if (idx < 0) raw else SEMITONES[(idx + semitones).mod(12)]
    }
}

fun toLeadSheetNotation(chord: String): String {
    if (chord.isBlank() || chord == "N.C." || chord == "--" || chord == "X") return chord
    val slash = chord.indexOf('/')
    val base = if (slash >= 0) chord.substring(0, slash) else chord
    val bass = if (slash >= 0) chord.substring(slash + 1) else ""
    val (root, qual) = if (base.length >= 2 && (base[1] == '#' || base[1] == 'b')) {
        base.substring(0, 2) to base.substring(2)
    } else if (base.isNotEmpty()) {
        base.substring(0, 1) to base.substring(1)
    } else {
        "" to ""
    }
    val mapped = when (qual) {
        "maj7", "Maj7" -> "Δ7"
        "maj", "Maj" -> "Δ"
        "min7", "m7" -> "-7"
        "m7-5", "m7b5", "hdim7" -> "ø7"
        "dim7" -> "°7"
        "dim" -> "°"
        "aug" -> "+"
        "min6", "m6" -> "-6"
        "maj6" -> "6"
        "minmaj7", "mM7" -> "-Δ7"
        else -> qual
    }
    return root + mapped + if (bass.isNotEmpty()) "/$bass" else ""
}

sealed class LyricsBlock {
    data class Heading(val text: String) : LyricsBlock()
    data class Artist(val text: String) : LyricsBlock()
    data class Section(val text: String) : LyricsBlock()
    data class Stanza(val lines: List<String>) : LyricsBlock()
}

fun parseLyricsBlocks(markdown: String): List<LyricsBlock> {
    val body = markdown.replace(Regex("^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?"), "").trim()
    val blocks = ArrayList<LyricsBlock>()
    val buf = ArrayList<String>()
    fun flush() {
        if (buf.isNotEmpty()) {
            blocks += LyricsBlock.Stanza(buf.toList())
            buf.clear()
        }
    }
    for (raw in body.split(Regex("\\r?\\n"))) {
        val line = raw.trim()
        if (line.isEmpty()) {
            flush()
            continue
        }
        if (Regex("^#{1,3}\\s+").containsMatchIn(line)) {
            flush()
            blocks += LyricsBlock.Heading(line.replace(Regex("^#{1,3}\\s+"), ""))
            continue
        }
        if (Regex("^\\*[^*]+\\*$").matches(line)) {
            flush()
            blocks += LyricsBlock.Artist(line.substring(1, line.length - 1))
            continue
        }
        if (Regex("^\\[[^]]+]$").matches(line)) {
            flush()
            blocks += LyricsBlock.Section(line)
            continue
        }
        buf += raw.trimEnd()
    }
    flush()
    return blocks
}

fun downsamplePeaks(hi: FloatArray, bars: Int): FloatArray {
    if (hi.isEmpty() || bars <= 0) return FloatArray(0)
    if (bars == hi.size) return hi
    val out = FloatArray(bars)
    val ratio = hi.size.toFloat() / bars.toFloat()
    for (i in 0 until bars) {
        val start = (i * ratio).toInt()
        val end = max(start + 1, ((i + 1) * ratio).toInt()).coerceAtMost(hi.size)
        var peak = 0f
        for (j in start until end) if (hi[j] > peak) peak = hi[j]
        out[i] = peak
    }
    return out
}

fun syntheticPeaks(seed: String, bars: Int = 160): FloatArray {
    var h = 2166136261L.toInt()
    for (ch in seed) {
        h = h xor ch.code
        h *= 16777619
    }
    val peaks = FloatArray(bars)
    for (i in 0 until bars) {
        h = h xor (h shl 13)
        h = h xor (h ushr 17)
        h = h xor (h shl 5)
        val r = (h.toUInt().toDouble()) / 4294967295.0
        val t = i.toDouble() / bars
        val env = 0.35 + 0.65 * sin(Math.PI * t).pow(0.7)
        peaks[i] = clamp(env * (0.45 + 0.55 * r), 0.08, 1.0).toFloat()
    }
    return peaks
}

fun pickMarkerRow(markers: List<Marker>, time: Double): Int {
    fun clearance(row: Int): Double {
        var best = 8.0
        for (m in markers) {
            if (m.row != row) continue
            val d = kotlin.math.abs(m.time - time)
            if (d < best) best = d
        }
        return best
    }
    return if (clearance(1) > clearance(0)) 1 else 0
}
