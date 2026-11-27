package com.donoy.mybandpractice.v2

/**
 * Harmonic-role coloring from `web/src/utils/chordStore.ts`
 * (`analyzeChordHarmonics` + `analyzeBarChordsWithContext`).
 */

private val H_SEMITONES = listOf("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
private val H_FLAT = mapOf("Db" to "C#", "Eb" to "D#", "Gb" to "F#", "Ab" to "G#", "Bb" to "A#")

private val QUALITY_CANON = mapOf(
    "" to "maj", "M" to "maj", "maj" to "maj",
    "m" to "min", "min" to "min", "-" to "min",
    "m7" to "min7", "min7" to "min7", "-7" to "min7",
    "7" to "7", "maj7" to "maj7", "M7" to "maj7",
    "6" to "6", "maj6" to "6", "m6" to "min6", "min6" to "min6",
    "dim" to "dim", "°" to "dim", "o" to "dim",
    "dim7" to "dim7", "°7" to "dim7",
    "hdim7" to "hdim7", "m7-5" to "hdim7", "m7b5" to "hdim7", "ø7" to "hdim7",
    "minmaj7" to "minmaj7", "mM7" to "minmaj7",
    "aug" to "aug", "+" to "aug", "sus2" to "sus2", "sus4" to "sus4",
)

private val MAJOR_SCALE = intArrayOf(0, 2, 4, 5, 7, 9, 11)
private val MINOR_SCALE = intArrayOf(0, 2, 3, 5, 7, 8, 10)
private val MAJOR_QUAL = arrayOf(
    arrayOf("maj", "maj7", "6"),
    arrayOf("min", "min7", "min6"),
    arrayOf("min", "min7"),
    arrayOf("maj", "maj7", "6"),
    arrayOf("maj", "7", "maj7"),
    arrayOf("min", "min7"),
    arrayOf("dim", "hdim7"),
)
private val MINOR_QUAL = arrayOf(
    arrayOf("min", "min7", "min6", "minmaj7"),
    arrayOf("dim", "hdim7"),
    arrayOf("maj", "maj7"),
    arrayOf("min", "min7"),
    arrayOf("min", "min7", "maj", "7"),
    arrayOf("maj", "maj7"),
    arrayOf("maj", "maj7", "dim7", "hdim7"),
)
private val MAJOR_ROMAN = mapOf(
    0 to "I", 1 to "♭II", 2 to "II", 3 to "♭III", 4 to "III", 5 to "IV",
    6 to "♯IV", 7 to "V", 8 to "♭VI", 9 to "VI", 10 to "♭VII", 11 to "VII",
)
private val MINOR_ROMAN = mapOf(
    0 to "i", 1 to "♭II", 2 to "ii", 3 to "III", 4 to "♯iii", 5 to "iv",
    6 to "♯iv", 7 to "v", 8 to "VI", 9 to "♯vi", 10 to "VII", 11 to "♯vii",
)

const val ROLE_TONIC = "tonic"
const val ROLE_DOMINANT = "dominant"
const val ROLE_SEC = "secondary-dominant"
const val ROLE_SUBV = "sub-v"
const val ROLE_TWO = "related-two"
const val ROLE_DIATONIC = "diatonic"
const val ROLE_NON = "nondiatonic"

class ChordAnalysis(
    var isDiatonic: Boolean,
    var roman: String,
    var baseRoman: String,
    var secondaryRoman: String?,
    var harmonicRole: String,
    var isDominant: Boolean,
    var targetDegree: String?,
    var targetRoot: String?,
    var resolvesToNext: Boolean = false,
    var resolutionType: String? = null,
    var resolutionLabel: String? = null,
    var description: String,
)

data class BarCadence(val badgeText: String, val title: String, val className: String)

data class HarmonicSheet(
    val chords: Map<String, ChordAnalysis>,
    val cadences: Map<Int, BarCadence>,
)

fun chordAnalysisKey(bar: Int, start: Double) = "$bar|$start"

private data class Parts(val rootCanon: String, val qualRaw: String, val qual: String)

private fun canonQuality(raw: String) = QUALITY_CANON[raw] ?: raw

private fun parseParts(chord: String): Parts {
    if (chord.isBlank() || chord == "N.C." || chord == "--" || chord == "X") {
        return Parts("", "", "N.C.")
    }
    val base = chord.substringBefore('/')
    val root: String
    val qualRaw: String
    if (base.length >= 2 && (base[1] == '#' || base[1] == 'b')) {
        root = base.substring(0, 2)
        qualRaw = base.substring(2)
    } else if (base.isNotEmpty()) {
        root = base.substring(0, 1)
        qualRaw = base.substring(1)
    } else {
        root = ""
        qualRaw = ""
    }
    return Parts(H_FLAT[root] ?: root, qualRaw, canonQuality(qualRaw))
}

private fun isMinorOrDim(qual: String) = qual == "min" || qual == "min7" || qual == "min6" ||
    qual == "hdim7" || qual == "dim" || qual == "dim7" || qual == "minmaj7"

private fun isDominant7(qual: String, qualRaw: String): Boolean {
    if (isMinorOrDim(qual)) return false
    if (qual == "maj7" || qualRaw == "maj7" || qualRaw == "Maj7" || qualRaw == "M7" || qualRaw.contains("Δ")) {
        return false
    }
    return qual == "7" || qualRaw == "7" || qualRaw == "9" || qualRaw == "11" || qualRaw == "13" ||
        qualRaw.contains("7") || qualRaw.contains("9") || qualRaw.contains("11") ||
        qualRaw.contains("13") || qualRaw.contains("alt")
}

private fun isMajorTriadOrDom(qual: String, qualRaw: String): Boolean {
    if (isMinorOrDim(qual)) return false
    return qual == "maj" || isDominant7(qual, qualRaw) || qual == "sus4" || qual == "sus2" || qual == "aug"
}

private fun blank(chord: String) = ChordAnalysis(
    isDiatonic = false,
    roman = if (chord.isBlank()) "N.C." else chord,
    baseRoman = if (chord.isBlank() || chord == "N.C." || chord == "--" || chord == "X") "N.C." else chord,
    secondaryRoman = null,
    harmonicRole = ROLE_NON,
    isDominant = false,
    targetDegree = null,
    targetRoot = null,
    description = chord.ifBlank { "Non-chord / Rest (コードなし)" },
)

fun analyzeChordHarmonics(chord: String, key: String): ChordAnalysis {
    if (chord.isBlank() || chord == "N.C." || chord == "--" || chord == "X" || key.isBlank()) {
        return blank(chord).also { it.roman = "N.C."; it.description = "Non-chord / Rest (コードなし)" }
    }
    val km = Regex("^([A-G][#b]?)(m)?$").find(key) ?: return blank(chord)
    val keyRoot = H_FLAT[km.groupValues[1]] ?: km.groupValues[1]
    val isMinor = km.groupValues[2].isNotEmpty()
    val keyIdx = H_SEMITONES.indexOf(keyRoot)
    if (keyIdx < 0) return blank(chord)
    val parts = parseParts(chord)
    val rootIdx = H_SEMITONES.indexOf(parts.rootCanon)
    if (rootIdx < 0) return blank(chord)

    val offset = (rootIdx - keyIdx).mod(12)
    val scale = if (isMinor) MINOR_SCALE else MAJOR_SCALE
    val degree = scale.indexOf(offset)
    val romanTable = if (isMinor) MINOR_ROMAN else MAJOR_ROMAN
    var baseRoman = romanTable[offset] ?: "?"
    val allowed = if (degree >= 0) (if (isMinor) MINOR_QUAL else MAJOR_QUAL)[degree] else emptyArray()
    val isDiatonic = degree >= 0 && (parts.qual == "sus2" || parts.qual == "sus4" || allowed.contains(parts.qual))
    if (isDiatonic) {
        val dim = parts.qual == "dim" || parts.qual == "hdim7" || parts.qual == "dim7"
        val min = parts.qual == "min" || parts.qual == "min7" || parts.qual == "min6" || parts.qual == "minmaj7"
        val majAtV = isMinor && offset == 7 && (parts.qual == "maj" || parts.qual == "7" || parts.qual == "maj7")
        baseRoman = when {
            dim -> "${baseRoman.lowercase()}°"
            min -> baseRoman.lowercase()
            majAtV -> "V"
            else -> baseRoman
        }
    }
    var role = if (isDiatonic) if (offset == 0) ROLE_TONIC else ROLE_DIATONIC else ROLE_NON
    var secondary: String? = null
    var targetDegree: String? = null
    var targetRoot: String? = null
    var isDominant = false
    val isDom7 = isDominant7(parts.qual, parts.qualRaw)
    val isMajDom = isMajorTriadOrDom(parts.qual, parts.qualRaw)

    if (offset == 7 && isMajDom) {
        role = ROLE_DOMINANT
        isDominant = true
        baseRoman = if (isDom7) "V7" else "V"
        targetDegree = if (isMinor) "i" else "I"
        targetRoot = keyRoot
    } else if (!isMinor) {
        when {
            offset == 9 && isMajDom -> {
                targetDegree = "ii"; targetRoot = H_SEMITONES[(keyIdx + 2) % 12]
                secondary = if (isDom7) "V7/ii" else "V/ii"
            }
            offset == 11 && isMajDom -> {
                targetDegree = "iii"; targetRoot = H_SEMITONES[(keyIdx + 4) % 12]
                secondary = if (isDom7) "V7/iii" else "V/iii"
            }
            offset == 0 && isDom7 -> {
                targetDegree = "IV"; targetRoot = H_SEMITONES[(keyIdx + 5) % 12]
                secondary = "V7/IV"
            }
            offset == 2 && isMajDom -> {
                targetDegree = "V"; targetRoot = H_SEMITONES[(keyIdx + 7) % 12]
                secondary = if (isDom7) "V7/V" else "V/V"
            }
            offset == 4 && isMajDom -> {
                targetDegree = "vi"; targetRoot = H_SEMITONES[(keyIdx + 9) % 12]
                secondary = if (isDom7) "V7/vi" else "V/vi"
            }
            isDom7 && offset == 1 -> {
                targetDegree = "I"; targetRoot = H_SEMITONES[keyIdx]; secondary = "SubV/I"
            }
            isDom7 && offset == 3 -> {
                targetDegree = "ii"; targetRoot = H_SEMITONES[(keyIdx + 2) % 12]; secondary = "SubV/ii"
            }
            isDom7 && offset == 6 -> {
                targetDegree = "IV"; targetRoot = H_SEMITONES[(keyIdx + 5) % 12]; secondary = "SubV/IV"
            }
            isDom7 && offset == 8 -> {
                targetDegree = "V"; targetRoot = H_SEMITONES[(keyIdx + 7) % 12]; secondary = "SubV/V"
            }
            isDom7 && offset == 10 -> {
                targetDegree = "vi"; targetRoot = H_SEMITONES[(keyIdx + 9) % 12]; secondary = "SubV/vi"
            }
        }
    } else {
        when {
            offset == 10 && isDom7 -> {
                targetDegree = "III"; targetRoot = H_SEMITONES[(keyIdx + 3) % 12]; secondary = "V7/III"
            }
            offset == 0 && isMajDom -> {
                targetDegree = "iv"; targetRoot = H_SEMITONES[(keyIdx + 5) % 12]
                secondary = if (isDom7) "V7/iv" else "V/iv"
            }
            offset == 2 && isMajDom -> {
                targetDegree = "V"; targetRoot = H_SEMITONES[(keyIdx + 7) % 12]
                secondary = if (isDom7) "V7/V" else "V/V"
            }
            offset == 3 && isDom7 -> {
                targetDegree = "VI"; targetRoot = H_SEMITONES[(keyIdx + 8) % 12]; secondary = "V7/VI"
            }
            offset == 5 && isMajDom -> {
                targetDegree = "VII"; targetRoot = H_SEMITONES[(keyIdx + 10) % 12]
                secondary = if (isDom7) "V7/VII" else "V/VII"
            }
            isDom7 && offset == 1 -> {
                targetDegree = "i"; targetRoot = H_SEMITONES[keyIdx]; secondary = "SubV/i"
            }
            isDom7 && offset == 6 -> {
                targetDegree = "iv"; targetRoot = H_SEMITONES[(keyIdx + 5) % 12]; secondary = "SubV/iv"
            }
            isDom7 && offset == 8 -> {
                targetDegree = "V"; targetRoot = H_SEMITONES[(keyIdx + 7) % 12]; secondary = "SubV/V"
            }
        }
    }
    return ChordAnalysis(
        isDiatonic = isDiatonic,
        roman = baseRoman,
        baseRoman = baseRoman,
        secondaryRoman = secondary,
        harmonicRole = role,
        isDominant = isDominant,
        targetDegree = targetDegree,
        targetRoot = targetRoot,
        description = "$chord [$baseRoman]",
    )
}

private class FlatChord(
    val keyId: String,
    val barNumber: Int,
    val symbol: String,
    val analysis: ChordAnalysis,
)

fun analyzeBarChords(bars: List<Bar>, displayKey: String?, pitch: Int): HarmonicSheet {
    if (displayKey.isNullOrBlank() || bars.isEmpty()) {
        return HarmonicSheet(emptyMap(), emptyMap())
    }
    val flat = ArrayList<FlatChord>()
    for (bar in bars) {
        for (chord in bar.chords) {
            val symbol = transposeChord(chord.chord, pitch)
            flat += FlatChord(
                chordAnalysisKey(bar.number, chord.start),
                bar.number,
                symbol,
                analyzeChordHarmonics(symbol, displayKey),
            )
        }
    }
    for (i in flat.indices) {
        val cur = flat[i]
        val analysis = cur.analysis
        if (cur.symbol == "N.C." || cur.symbol == "--" || cur.symbol == "X") continue
        val next = flat.subList(i + 1, flat.size).firstOrNull {
            it.symbol != "N.C." && it.symbol != "--" && it.symbol != "X"
        } ?: continue
        val curRoot = parseParts(cur.symbol).rootCanon
        val nextRoot = parseParts(next.symbol).rootCanon
        val curIdx = H_SEMITONES.indexOf(curRoot)
        val nextIdx = H_SEMITONES.indexOf(nextRoot)
        if (curIdx < 0 || nextIdx < 0) continue
        val intervalDown = (curIdx - nextIdx).mod(12)
        if (intervalDown == 7) {
            if (analysis.harmonicRole == ROLE_DOMINANT) {
                analysis.resolvesToNext = true
                analysis.resolutionType = "5th-down"
                analysis.resolutionLabel = "➔ ${next.analysis.baseRoman}"
            } else if (analysis.secondaryRoman != null && !analysis.secondaryRoman!!.startsWith("SubV")) {
                val target = analysis.targetRoot?.let { H_FLAT[it] ?: it }.orEmpty()
                if (nextRoot == target || next.analysis.isDominant) {
                    analysis.harmonicRole = ROLE_SEC
                    analysis.isDominant = true
                    analysis.resolvesToNext = true
                    analysis.resolutionType = if (nextRoot == target) "5th-down" else "cycle"
                    analysis.resolutionLabel = if (nextRoot == target) {
                        "➔ ${analysis.targetDegree}"
                    } else {
                        "➔ ${next.analysis.baseRoman}"
                    }
                    analysis.roman = analysis.secondaryRoman!!
                }
            }
        } else if (intervalDown == 1 && analysis.secondaryRoman?.startsWith("SubV") == true) {
            val target = analysis.targetRoot?.let { H_FLAT[it] ?: it }.orEmpty()
            if (nextRoot == target) {
                analysis.harmonicRole = ROLE_SUBV
                analysis.isDominant = true
                analysis.resolvesToNext = true
                analysis.resolutionType = "half-step-down"
                analysis.resolutionLabel = "➔ ${analysis.targetDegree}"
                analysis.roman = analysis.secondaryRoman!!
            }
        }
        val curQual = parseParts(cur.symbol).qual
        if (isMinorOrDim(curQual) && next.analysis.harmonicRole == ROLE_SEC && intervalDown == 7) {
            val hdim = curQual == "hdim7" || curQual == "dim"
            analysis.harmonicRole = ROLE_TWO
            analysis.targetDegree = next.analysis.targetDegree
            analysis.targetRoot = next.analysis.targetRoot
            analysis.secondaryRoman = "${if (hdim) "iiø" else "ii"}/${next.analysis.targetDegree}"
            analysis.roman = analysis.secondaryRoman!!
        }
    }

    val cadences = HashMap<Int, BarCadence>()
    for (bar in bars) {
        val barChords = flat.filter {
            it.barNumber == bar.number && it.symbol != "N.C." && it.symbol != "--" && it.symbol != "X"
        }
        if (barChords.isEmpty()) continue
        val nextBar = flat.firstOrNull {
            it.barNumber == bar.number + 1 && it.symbol != "N.C." && it.symbol != "--" && it.symbol != "X"
        }
        var cadence: BarCadence? = null
        for (i in barChords.indices) {
            val cur = barChords[i]
            val next = if (i + 1 < barChords.size) barChords[i + 1] else nextBar
            val after = when {
                i + 2 < barChords.size -> barChords[i + 2]
                i + 1 == barChords.size -> null
                else -> nextBar
            }
            if (cur != null && next != null && after != null) {
                val twoFive = (cur.analysis.harmonicRole == ROLE_DIATONIC || cur.analysis.harmonicRole == ROLE_TWO) &&
                    next.analysis.harmonicRole == ROLE_DOMINANT &&
                    (after.analysis.harmonicRole == ROLE_TONIC || after.analysis.baseRoman.lowercase() == "i")
                if (twoFive) {
                    cadence = BarCadence("Ⅱ-Ⅴ-Ⅰ", "Ⅱ-Ⅴ-Ⅰ Cadence", "cadence-251")
                    break
                }
                if (cur.analysis.harmonicRole == ROLE_TWO &&
                    next.analysis.harmonicRole == ROLE_SEC &&
                    next.analysis.resolvesToNext
                ) {
                    val tgt = next.analysis.targetDegree ?: ""
                    cadence = BarCadence("Ⅱ-Ⅴ/$tgt", "セカンダリー・ツーファイブ Ⅱ-Ⅴ/$tgt", "cadence-sec-251")
                    break
                }
            }
            if (next == null) continue
            cadence = when {
                cur.analysis.harmonicRole == ROLE_DOMINANT && cur.analysis.resolvesToNext ->
                    BarCadence("Ⅴ➔Ⅰ", "Dominant Motion (Ⅴ ➔ Ⅰ)", "cadence-51")
                cur.analysis.harmonicRole == ROLE_SEC && cur.analysis.resolvesToNext -> {
                    val tgt = cur.analysis.targetDegree ?: ""
                    BarCadence("Ⅴ/$tgt➔$tgt", "セカンダリードミナント Ⅴ/$tgt", "cadence-sec-51")
                }
                cur.analysis.harmonicRole == ROLE_SUBV && cur.analysis.resolvesToNext -> {
                    val tgt = cur.analysis.targetDegree ?: ""
                    BarCadence("SubV➔$tgt", "裏コード SubV ➔ $tgt", "cadence-sub-v")
                }
                cur.analysis.resolutionType == "cycle" ->
                    BarCadence("Ⅴ➔Ⅴ", "ドミナント連鎖", "cadence-cycle")
                else -> null
            }
            if (cadence != null) break
        }
        if (cadence == null && bar.cadence == "2-5-1") {
            cadence = BarCadence("Ⅱ-Ⅴ-Ⅰ", "Ⅱ-Ⅴ-Ⅰ", "cadence-251")
        } else if (cadence == null && bar.cadence == "5-1") {
            cadence = BarCadence("Ⅴ➔Ⅰ", "Ⅴ ➔ Ⅰ", "cadence-51")
        }
        if (cadence != null) cadences[bar.number] = cadence
    }
    return HarmonicSheet(flat.associate { it.keyId to it.analysis }, cadences)
}
