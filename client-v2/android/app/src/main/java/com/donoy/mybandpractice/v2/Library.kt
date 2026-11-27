package com.donoy.mybandpractice.v2

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class SongRecord(
    val slug: String,
    val title: String,
    val artist: String,
    val durationSeconds: Double?,
    val dir: File,
    val chunksDir: File?,
    val hasLyrics: Boolean,
    val stems: List<String>,
    val lyricist: String?,
    val composer: String?,
    val sourceUrl: String?,
)

data class SetlistRecord(
    val id: String,
    val name: String,
    val songs: List<String>,
)

data class Marker(
    val id: String,
    val time: Double,
    val label: String,
    val row: Int = 0,
    val stanzaIndex: Int? = null,
)

data class StanzaTag(
    val id: String,
    val stanzaIndex: Int,
    val label: String,
)

data class PracticeFile(
    val markers: List<Marker>,
    val stanzaTags: List<StanzaTag>,
)

data class ChordHit(val start: Double, val end: Double, val chord: String)

data class BarChord(
    val chord: String,
    val start: Double,
    val end: Double,
    val beats: Double = 1.0,
    val isDominant: Boolean = false,
)

data class Bar(
    val number: Int,
    val start: Double,
    val end: Double,
    val beats: Int,
    val chords: List<BarChord>,
    val cadence: String? = null,
)

data class ChordsFile(
    val key: String?,
    val bpm: Double?,
    val chords: List<ChordHit>,
    val bars: List<Bar>,
)

fun songsRoot(context: Context): File = File(context.filesDir, "songs").apply { mkdirs() }

fun setlistsRoot(context: Context): File = File(context.filesDir, "setlists").apply { mkdirs() }

fun scanSongs(context: Context): List<SongRecord> {
    val root = songsRoot(context)
    return root.listFiles()
        ?.filter { it.isDirectory && songLooksPresent(it) }
        ?.map { readSong(it) }
        ?.sortedWith(compareBy({ it.title.lowercase() }, { it.slug }))
        ?: emptyList()
}

fun scanSetlists(context: Context): List<SetlistRecord> {
    val root = setlistsRoot(context)
    return root.listFiles()
        ?.filter { it.isFile && it.extension == "json" }
        ?.mapNotNull { file ->
            runCatching {
                val o = JSONObject(file.readText())
                val songs = o.optJSONArray("songs") ?: JSONArray()
                SetlistRecord(
                    id = file.nameWithoutExtension,
                    name = o.optString("name").ifBlank { file.nameWithoutExtension },
                    songs = (0 until songs.length()).map { songs.getString(it) },
                )
            }.getOrNull()
        }
        ?.sortedBy { it.name.lowercase() }
        ?: emptyList()
}

fun saveSetlist(context: Context, setlist: SetlistRecord) {
    val o = JSONObject()
    o.put("name", setlist.name)
    o.put("songs", JSONArray(setlist.songs))
    File(setlistsRoot(context), "${setlist.id}.json").writeText(o.toString())
}

fun deleteSetlist(context: Context, id: String) {
    File(setlistsRoot(context), "$id.json").delete()
}

fun setlistIdFor(name: String, existing: List<SetlistRecord>): String {
    val ascii = name
        .lowercase()
        .replace(Regex("[^a-z0-9\\s-]"), "")
        .trim()
        .replace(Regex("[\\s_]+"), "-")
        .replace(Regex("-+"), "-")
        .trim('-')
    val base = ascii.ifBlank { "sl-${System.currentTimeMillis().toString(36)}" }
    var id = base
    var n = 2
    val taken = existing.map { it.id }.toSet()
    while (id in taken) {
        id = "$base-$n"
        n++
    }
    return id
}

fun loadPractice(dir: File): PracticeFile {
    val file = File(dir, "practice.json")
    if (!file.isFile) return PracticeFile(emptyList(), emptyList())
    return runCatching {
        val o = JSONObject(file.readText())
        val markers = o.optJSONArray("markers") ?: JSONArray()
        val tags = o.optJSONArray("stanzaTags") ?: JSONArray()
        PracticeFile(
            markers = (0 until markers.length()).mapNotNull { i ->
                val m = markers.optJSONObject(i) ?: return@mapNotNull null
                val id = m.optString("id")
                val label = m.optString("label")
                if (id.isBlank() || !m.has("time") || label.isBlank()) return@mapNotNull null
                Marker(
                    id = id,
                    time = m.getDouble("time"),
                    label = label,
                    row = m.optInt("row", 0),
                    stanzaIndex = if (m.has("stanzaIndex") && !m.isNull("stanzaIndex")) m.getInt("stanzaIndex") else null,
                )
            }.sortedBy { it.time },
            stanzaTags = (0 until tags.length()).mapNotNull { i ->
                val t = tags.optJSONObject(i) ?: return@mapNotNull null
                val id = t.optString("id")
                val label = t.optString("label")
                if (id.isBlank() || !t.has("stanzaIndex") || label.isBlank()) return@mapNotNull null
                StanzaTag(id, t.getInt("stanzaIndex"), label)
            },
        )
    }.getOrDefault(PracticeFile(emptyList(), emptyList()))
}

fun savePractice(dir: File, practice: PracticeFile) {
    val markers = JSONArray()
    for (m in practice.markers) {
        val o = JSONObject()
        o.put("id", m.id)
        o.put("time", m.time)
        o.put("label", m.label)
        o.put("row", m.row)
        if (m.stanzaIndex != null) o.put("stanzaIndex", m.stanzaIndex) else o.put("stanzaIndex", JSONObject.NULL)
        markers.put(o)
    }
    val tags = JSONArray()
    for (t in practice.stanzaTags) {
        tags.put(JSONObject().put("id", t.id).put("stanzaIndex", t.stanzaIndex).put("label", t.label))
    }
    File(dir, "practice.json").writeText(JSONObject().put("markers", markers).put("stanzaTags", tags).toString())
}

fun loadLyrics(dir: File): String? {
    val file = File(dir, "lyrics.md")
    if (!file.isFile) return null
    return file.readText()
}

fun loadChords(dir: File): ChordsFile? {
    val file = File(dir, "chords.json")
    if (!file.isFile) return null
    return runCatching {
        val o = JSONObject(file.readText())
        val hitsJson = o.optJSONArray("chords") ?: JSONArray()
        val hits = (0 until hitsJson.length()).mapNotNull { i ->
            val c = hitsJson.optJSONObject(i) ?: return@mapNotNull null
            val name = c.optString("chord")
            if (name.isBlank() || !c.has("start") || !c.has("end")) return@mapNotNull null
            ChordHit(c.getDouble("start"), c.getDouble("end"), name)
        }
        val barsJson = o.optJSONArray("bars")
        val bars = if (barsJson != null && barsJson.length() > 0) {
            (0 until barsJson.length()).mapNotNull { i ->
                val b = barsJson.optJSONObject(i) ?: return@mapNotNull null
                val chords = b.optJSONArray("chords") ?: JSONArray()
                Bar(
                    number = b.optInt("bar_number", i + 1),
                    start = b.optDouble("start"),
                    end = b.optDouble("end"),
                    beats = b.optInt("beats", 4),
                    cadence = b.optString("cadence").ifBlank { null },
                    chords = (0 until chords.length()).mapNotNull { j ->
                        val c = chords.optJSONObject(j) ?: return@mapNotNull null
                        val name = c.optString("chord")
                        if (name.isBlank()) return@mapNotNull null
                        BarChord(
                            name,
                            c.optDouble("start"),
                            c.optDouble("end"),
                            beats = c.optDouble("beats", 1.0),
                            isDominant = c.optBoolean("is_dominant", false),
                        )
                    },
                )
            }
        } else {
            syntheticBars(hits, o.optDouble("bpm", 120.0))
        }
        ChordsFile(
            key = o.optString("key").ifBlank { null },
            bpm = if (o.has("bpm")) o.optDouble("bpm") else null,
            chords = hits,
            bars = bars,
        )
    }.getOrNull()
}

fun directoryBytes(dir: File): Long =
    dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

fun newId(): String = UUID.randomUUID().toString()

/** Main mix the waveform decodes. Same preference order as the web library. */
fun mainMixFile(song: SongRecord): File? {
    val dir = song.dir
    val named = listOf("ogg", "opus", "flac", "mp3").map { File(dir, "${song.slug}.$it") }
    named.firstOrNull { it.isFile }?.let { return it }
    val audio = dir.listFiles()?.filter { it.isFile } ?: return null
    val exts = listOf(".ogg", ".opus", ".flac", ".mp3", ".wav", ".m4a")
    return exts.firstNotNullOfOrNull { ext ->
        audio.firstOrNull { it.name.lowercase().endsWith(ext) }
    }
}

private fun syntheticBars(hits: List<ChordHit>, bpm: Double): List<Bar> {
    if (hits.isEmpty()) return emptyList()
    val barDur = (60.0 / bpm.coerceAtLeast(1.0)) * 4.0
    val maxT = hits.last().end
    val out = ArrayList<Bar>()
    var t = 0.0
    var n = 1
    while (t < maxT) {
        val end = t + barDur
        val matching = hits.filter { it.end > t && it.start < end }.map {
            BarChord(it.chord, maxOf(t, it.start), minOf(end, it.end))
        }
        out += Bar(
            number = n++,
            start = t,
            end = end,
            beats = 4,
            chords = matching.ifEmpty { listOf(BarChord("N.C.", t, end)) },
        )
        t = end
    }
    return out
}

private fun songLooksPresent(dir: File): Boolean =
    File(dir, "meta.json").isFile || findChunksDir(dir) != null || File(dir, "lyrics.md").isFile

private fun readSong(dir: File): SongRecord {
    val meta = runCatching { JSONObject(File(dir, "meta.json").readText()) }.getOrNull()
    val lyrics = meta?.optJSONObject("lyrics")
    val audio = meta?.optJSONObject("audio")
    val chunks = findChunksDir(dir)
    val stemNames = stemNames(dir, chunks)
    val duration = when {
        audio != null && audio.has("output_duration_seconds") -> audio.optDouble("output_duration_seconds")
        meta != null && meta.has("yt_duration_seconds") -> meta.optDouble("yt_duration_seconds")
        else -> null
    }
    return SongRecord(
        slug = meta?.optString("slug").takeUnless { it.isNullOrBlank() } ?: dir.name,
        title = meta?.optString("title").takeUnless { it.isNullOrBlank() } ?: dir.name,
        artist = meta?.optString("artist").orEmpty(),
        durationSeconds = duration,
        dir = dir,
        chunksDir = chunks,
        hasLyrics = File(dir, "lyrics.md").isFile || (lyrics?.optInt("line_count") ?: 0) > 0,
        stems = stemNames,
        lyricist = lyrics?.optString("lyricist").takeUnless { it.isNullOrBlank() },
        composer = lyrics?.optString("composer").takeUnless { it.isNullOrBlank() },
        sourceUrl = meta?.optString("source_url").takeUnless { it.isNullOrBlank() },
    )
}

private fun stemNames(dir: File, chunks: File?): List<String> {
    val fromChunks = chunks?.let { file ->
        runCatching {
            val stems = JSONObject(File(file, "chunks.json").readText()).optJSONObject("stems") ?: return@runCatching emptyList()
            stems.keys().asSequence().toList().sorted()
        }.getOrNull()
    }
    if (!fromChunks.isNullOrEmpty()) return fromChunks
    val stemDir = File(dir, "stems")
    if (!stemDir.isDirectory) return emptyList()
    return stemDir.listFiles()
        ?.filter { it.isFile && it.extension.lowercase() in setOf("ogg", "opus", "flac", "mp3", "wav") }
        ?.map { it.nameWithoutExtension }
        ?.sorted()
        ?: emptyList()
}
