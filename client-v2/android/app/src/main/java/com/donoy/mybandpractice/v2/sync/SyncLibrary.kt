package com.donoy.mybandpractice.v2.sync

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

const val SYNC_CHUNK = 16 * 1024
const val SYNC_LOW_BUFFER = 1024 * 1024

data class SyncFile(val name: String, val bytes: Long, val sha256: String)

data class SyncSong(
    val slug: String,
    val title: String,
    val artist: String,
    val durationSeconds: Double?,
    val hasLyrics: Boolean,
    val hasStems: Boolean,
    val totalBytes: Long,
    val files: List<SyncFile>,
)

data class SyncSetlist(
    val id: String,
    val name: String,
    val songs: List<String>,
    val totalBytes: Long,
    val files: List<SyncFile>,
)

data class SyncManifest(val songs: List<SyncSong>, val setlists: List<SyncSetlist>)

private val AUDIO = Regex("""\.(flac|ogg|opus|mp3|wav|m4a)$""", RegexOption.IGNORE_CASE)

fun buildSyncManifest(root: File, onProgress: (String) -> Unit): SyncManifest {
    val songsDir = File(root, "songs")
    val songs = ArrayList<SyncSong>()
    val slugs = songsDir.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name }.orEmpty()
    for (dir in slugs) {
        val slug = dir.name
        if (slug.startsWith(".")) continue
        val raw = ArrayList<Pair<String, Long>>()
        dir.walkTopDown().filter { it.isFile }.forEach { file ->
            val rel = file.relativeTo(root).invariantSeparatorsPath
            if (rel.split('/').any { it.startsWith(".") } || rel.endsWith(".part")) return@forEach
            raw += rel to file.length()
        }
        val hasChunks = raw.any { it.first == "songs/$slug/stems/chunks/chunks.json" }
        val send = raw.filter { (name, _) ->
            if (!hasChunks) return@filter true
            val stem = name.startsWith("songs/$slug/stems/") &&
                !name.startsWith("songs/$slug/stems/chunks/") &&
                AUDIO.containsMatchIn(name)
            !stem
        }
        val files = ArrayList<SyncFile>()
        for ((name, bytes) in send) {
            onProgress(name)
            val sha = sha256(File(root, name)) ?: continue
            files += SyncFile(name, bytes, sha)
        }
        val meta = runCatching { JSONObject(File(dir, "meta.json").readText()) }.getOrNull()
        val audio = meta?.optJSONObject("audio")
        val duration = when {
            audio != null && audio.has("output_duration_seconds") -> audio.optDouble("output_duration_seconds")
            meta != null && meta.has("yt_duration_seconds") -> meta.optDouble("yt_duration_seconds")
            else -> null
        }
        val stemNames = raw.mapNotNull { (name, _) ->
            val marker = "songs/$slug/stems/chunks/"
            if (!name.startsWith(marker)) return@mapNotNull null
            name.removePrefix(marker).substringBefore('/').takeIf { it.isNotEmpty() && !it.contains('.') }
        }.toSet().filter { it.lowercase() !in setOf("mix", "mixdown", "original") }
        songs += SyncSong(
            slug = slug,
            title = meta?.optString("title").orEmpty().ifBlank { slug },
            artist = meta?.optString("artist").orEmpty().ifBlank { "Unknown" },
            durationSeconds = duration,
            hasLyrics = raw.any { it.first == "songs/$slug/lyrics.md" },
            hasStems = stemNames.isNotEmpty(),
            totalBytes = files.sumOf { it.bytes },
            files = files,
        )
    }
    val setlists = ArrayList<SyncSetlist>()
    val setDir = File(root, "setlists")
    for (file in setDir.listFiles()?.filter { it.isFile && it.name.endsWith(".json") }.orEmpty()) {
        onProgress(file.name)
        val parsed = runCatching { JSONObject(file.readText()) }.getOrNull() ?: continue
        val sha = sha256(file) ?: continue
        val songIds = parsed.optJSONArray("songs")
        val names = if (songIds == null) emptyList() else (0 until songIds.length()).mapNotNull { i ->
            songIds.optString(i).takeIf { it.isNotEmpty() }
        }
        val rel = file.relativeTo(root).invariantSeparatorsPath
        setlists += SyncSetlist(
            id = file.name.removeSuffix(".json"),
            name = parsed.optString("name").ifBlank { file.name },
            songs = names,
            totalBytes = file.length(),
            files = listOf(SyncFile(rel, file.length(), sha)),
        )
    }
    return SyncManifest(songs.sortedBy { it.slug }, setlists)
}

fun SyncManifest.toJson(): JSONObject {
    val root = JSONObject()
    val songsJson = JSONArray()
    for (song in songs) {
        val o = JSONObject()
        o.put("slug", song.slug)
        o.put("title", song.title)
        o.put("artist", song.artist)
        if (song.durationSeconds == null) o.put("durationSeconds", JSONObject.NULL) else o.put("durationSeconds", song.durationSeconds)
        o.put("hasLyrics", song.hasLyrics)
        o.put("hasStems", song.hasStems)
        o.put("totalBytes", song.totalBytes)
        o.put("files", filesJson(song.files))
        songsJson.put(o)
    }
    val setJson = JSONArray()
    for (setlist in setlists) {
        val o = JSONObject()
        o.put("id", setlist.id)
        o.put("name", setlist.name)
        o.put("songs", JSONArray(setlist.songs))
        o.put("totalBytes", setlist.totalBytes)
        o.put("files", filesJson(setlist.files))
        setJson.put(o)
    }
    root.put("songs", songsJson)
    root.put("setlists", setJson)
    return root
}

fun parseSyncManifest(o: JSONObject): SyncManifest {
    val songsJson = o.optJSONArray("songs") ?: JSONArray()
    val songs = (0 until songsJson.length()).mapNotNull { i ->
        val s = songsJson.optJSONObject(i) ?: return@mapNotNull null
        SyncSong(
            slug = s.optString("slug"),
            title = s.optString("title"),
            artist = s.optString("artist"),
            durationSeconds = if (s.isNull("durationSeconds")) null else s.optDouble("durationSeconds"),
            hasLyrics = s.optBoolean("hasLyrics"),
            hasStems = s.optBoolean("hasStems"),
            totalBytes = s.optLong("totalBytes"),
            files = parseFiles(s.optJSONArray("files")),
        )
    }
    val setJson = o.optJSONArray("setlists") ?: JSONArray()
    val setlists = (0 until setJson.length()).mapNotNull { i ->
        val s = setJson.optJSONObject(i) ?: return@mapNotNull null
        val ids = s.optJSONArray("songs")
        SyncSetlist(
            id = s.optString("id"),
            name = s.optString("name"),
            songs = if (ids == null) emptyList() else (0 until ids.length()).mapNotNull { ids.optString(it).takeIf { n -> n.isNotEmpty() } },
            totalBytes = s.optLong("totalBytes"),
            files = parseFiles(s.optJSONArray("files")),
        )
    }
    return SyncManifest(songs, setlists)
}

fun upToDateSlugs(root: File, manifest: SyncManifest): Set<String> {
    val ready = HashSet<String>()
    for (song in manifest.songs) {
        val current = song.files.filter { !it.name.endsWith("/practice.json") }.all { file ->
            val local = safeFile(root, file.name) ?: return@all false
            local.isFile && local.length() == file.bytes
        }
        if (current && song.files.isNotEmpty()) ready += song.slug
    }
    return ready
}

fun safeFile(root: File, relative: String): File? {
    if (relative.isBlank() || relative.startsWith("/") || relative.contains("..")) return null
    val file = File(root, relative)
    val rootPath = root.canonicalFile
    val parent = file.parentFile?.canonicalFile ?: return null
    if (parent != rootPath && !parent.path.startsWith(rootPath.path + File.separator)) return null
    return file
}

fun sha256(file: File): String? {
    if (!file.isFile) return null
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buf = ByteArray(1024 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            digest.update(buf, 0, n)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

private fun filesJson(files: List<SyncFile>): JSONArray {
    val array = JSONArray()
    for (file in files) {
        array.put(JSONObject().put("name", file.name).put("bytes", file.bytes).put("sha256", file.sha256))
    }
    return array
}

private fun parseFiles(array: JSONArray?): List<SyncFile> {
    if (array == null) return emptyList()
    return (0 until array.length()).mapNotNull { i ->
        val o = array.optJSONObject(i) ?: return@mapNotNull null
        val name = o.optString("name")
        if (name.isBlank()) return@mapNotNull null
        SyncFile(name, o.optLong("bytes"), o.optString("sha256"))
    }
}
