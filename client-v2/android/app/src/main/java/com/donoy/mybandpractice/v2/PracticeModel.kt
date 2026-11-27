package com.donoy.mybandpractice.v2

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.donoy.mybandpractice.v2.core.Player
import com.donoy.mybandpractice.v2.core.waveformPeaks
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

enum class PlaybackMode { Sequential, RepeatAll, RepeatOne }

fun nextPlaybackMode(mode: PlaybackMode): PlaybackMode = when (mode) {
    PlaybackMode.Sequential -> PlaybackMode.RepeatAll
    PlaybackMode.RepeatAll -> PlaybackMode.RepeatOne
    PlaybackMode.RepeatOne -> PlaybackMode.Sequential
}

fun playbackModeLabel(mode: PlaybackMode): String = when (mode) {
    PlaybackMode.Sequential -> "Play all"
    PlaybackMode.RepeatAll -> "Repeat all"
    PlaybackMode.RepeatOne -> "Repeat one"
}

class PracticeModel(app: Application) : AndroidViewModel(app) {
    val player: Player?
    val nativeError: String?
    private val feeder: PcmFeeder?
    private val prefs = app.getSharedPreferences("mbp", Application.MODE_PRIVATE)
    private var saveJob: Job? = null
    private var peakJob: Job? = null
    private var endHandled = false
    private var dragging = false

    var songs by mutableStateOf<List<SongRecord>>(emptyList())
        private set
    var setlists by mutableStateOf<List<SetlistRecord>>(emptyList())
        private set
    var sizes by mutableStateOf<Map<String, Long>>(emptyMap())
        private set
    var query by mutableStateOf("")
    var modeId by mutableStateOf(prefs.getString("mode", null))
    var current by mutableStateOf<SongRecord?>(null)
        private set
    var playing by mutableStateOf(false)
        private set
    var buffering by mutableStateOf(false)
        private set
    var position by mutableFloatStateOf(0f)
        private set
    var duration by mutableFloatStateOf(0f)
        private set
    var status by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var pendingSlug by mutableStateOf<String?>(null)
        private set
    var stemGains by mutableStateOf(loadStems())
        private set
    var volume by mutableFloatStateOf(prefs.getFloat("volume", 1f))
        private set
    var muted by mutableStateOf(prefs.getBoolean("muted", false))
        private set
    var pitch by mutableIntStateOf(prefs.getInt("pitch", 0))
        private set
    var rate by mutableFloatStateOf(prefs.getFloat("rate", 1f))
        private set
    var loopStart by mutableStateOf<Double?>(null)
        private set
    var loopEnd by mutableStateOf<Double?>(null)
        private set
    var loopEnabled by mutableStateOf(false)
        private set
    var playbackMode by mutableStateOf(PlaybackMode.Sequential)
        private set
    var markers by mutableStateOf<List<Marker>>(emptyList())
        private set
    var stanzaTags by mutableStateOf<List<StanzaTag>>(emptyList())
        private set
    var lyrics by mutableStateOf<List<LyricsBlock>>(emptyList())
        private set
    var lyricsNote by mutableStateOf<String?>(null)
        private set
    var lyricsLoading by mutableStateOf(false)
        private set
    var chords by mutableStateOf<ChordsFile?>(null)
        private set
    var peaks by mutableStateOf(FloatArray(0))
        private set

    val activeSetlist: SetlistRecord?
        get() = setlists.find { it.id == modeId }

    val playlist: List<SongRecord>
        get() {
            val setlist = activeSetlist ?: return songs
            val bySlug = songs.associateBy { it.slug }
            return setlist.songs.mapNotNull { bySlug[it] }
        }

    val filtered: List<SongRecord>
        get() {
            val q = query.trim().lowercase()
            val base = playlist
            if (q.isEmpty()) return base
            return base.filter {
                it.title.lowercase().contains(q) ||
                    it.artist.lowercase().contains(q) ||
                    it.slug.lowercase().contains(q)
            }
        }

    val loop: Pair<Double, Double>?
        get() {
            val a = loopStart
            val b = loopEnd
            return if (a != null && b != null && b - a >= MIN_LOOP) a to b else null
        }

    init {
        val opened = try {
            Player() to null
        } catch (err: Throwable) {
            null to (err.message ?: err.toString())
        }
        player = opened.first
        nativeError = opened.second
        feeder = player?.let { PcmFeeder(it).also { feeder -> feeder.start() } }
        status = nativeError
        if (modeId != null && activeSetlist == null) {
            // resolved after reload
        }
        reloadLibrary()
        viewModelScope.launch {
            while (isActive) {
                tick()
                delay(100)
            }
        }
    }

    fun reloadLibrary() {
        viewModelScope.launch(Dispatchers.IO) {
            val context = getApplication<Application>()
            val nextSongs = scanSongs(context)
            val nextLists = scanSetlists(context)
            val nextSizes = nextSongs.associate { it.slug to directoryBytes(it.dir) }
            withContext(Dispatchers.Main) {
                songs = nextSongs
                setlists = nextLists
                sizes = nextSizes
                if (activeSetlist == null) modeId = null
                current?.slug?.let { slug ->
                    current = nextSongs.find { it.slug == slug }
                }
            }
        }
    }

    fun importTree(uri: Uri) {
        val engine = player
        if (engine == null) {
            status = nativeError ?: "再生コアを読み込めません"
            return
        }
        viewModelScope.launch {
            busy = true
            status = "コピーしています"
            val result = withContext(Dispatchers.IO) {
                runCatching { importLibraryTree(getApplication(), uri) }
            }
            busy = false
            result.fold(
                onSuccess = {
                    status = null
                    reloadLibrary()
                },
                onFailure = { status = it.message ?: it.toString() },
            )
        }
    }

    fun playSong(song: SongRecord) {
        val engine = player
        val chunks = song.chunksDir
        if (engine == null) {
            status = nativeError ?: "再生コアを読み込めません"
            return
        }
        if (chunks == null) {
            status = "chunks がありません"
            return
        }
        rememberLoop()
        viewModelScope.launch {
            pendingSlug = song.slug
            buffering = true
            status = null
            val loaded = withContext(Dispatchers.IO) {
                runCatching { engine.loadChunksDir(chunks.absolutePath) }
            }
            if (loaded.isFailure) {
                pendingSlug = null
                buffering = false
                status = loaded.exceptionOrNull()?.message ?: "読み込めません"
                return@launch
            }
            current = song
            duration = engine.duration().toFloat()
            position = 0f
            endHandled = false
            restoreLoop(song.slug)
            loadSidecars(song)
            loadPeaks(song)
            applyGains()
            engine.play()
            pendingSlug = null
        }
    }

    fun toggle() {
        val engine = player ?: return
        if (current == null) return
        if (engine.playing()) engine.pause() else {
            if (engine.ended()) engine.seek(0.0)
            engine.play()
        }
    }

    fun seek(seconds: Double) {
        val engine = player ?: return
        if (current == null) return
        val dur = duration.toDouble().coerceAtLeast(0.0)
        val t = clamp(seconds, 0.0, (dur - 0.01).coerceAtLeast(0.0))
        runCatching { engine.seek(t) }
        position = t.toFloat()
        endHandled = false
    }

    fun beginDrag() {
        dragging = true
    }

    fun dragTo(seconds: Float) {
        position = seconds
    }

    fun endDrag(seconds: Float) {
        dragging = false
        seek(seconds.toDouble())
    }

    fun skip(delta: Double) {
        val engine = player ?: return
        seek(engine.position() + delta)
    }

    fun playNext() = stepPlaylist(1)

    fun playPrev() = stepPlaylist(-1)

    fun cycleMode() {
        playbackMode = nextPlaybackMode(playbackMode)
    }

    fun setStem(name: String, gain: Double) {
        val next = stemGains.toMutableMap()
        next[name] = clamp(gain, 0.0, MAX_GAIN).toFloat()
        stemGains = next
        player?.setStemGain(name, next.getValue(name))
        persistMixer()
    }

    fun resetStems() {
        stemGains = STEM_ORDER.associateWith { 1f }
        applyGains()
        persistMixer()
    }

    fun setVolume(gain: Double) {
        volume = clamp(gain, 0.0, MAX_GAIN).toFloat()
        if (volume > 0.001f) muted = false
        applyMaster()
        persistMixer()
    }

    fun toggleMute() {
        muted = !muted
        applyMaster()
        persistMixer()
    }

    fun updatePitch(semitones: Int) {
        pitch = semitones.coerceIn(-12, 12)
        player?.setPitch(pitch)
        persistMixer()
    }

    fun updateRate(value: Float) {
        rate = clampF(value, 0.5f, 1.5f)
        player?.setPlaybackRate(rate.toDouble())
        persistMixer()
    }

    fun setLoop(start: Double?, end: Double?) {
        loopStart = start
        loopEnd = end
        if (start == null || end == null) loopEnabled = false
        rememberLoop()
    }

    fun enableLoop(on: Boolean) {
        if (loop == null) return
        loopEnabled = on
        rememberLoop()
    }

    fun loopIn() {
        val t = position.toDouble()
        val end = loopEnd ?: (t + 4.0).coerceAtMost(duration.toDouble())
        val start = t.coerceAtMost(end - MIN_LOOP)
        loopStart = start
        loopEnd = end.coerceAtLeast(start + MIN_LOOP)
        rememberLoop()
    }

    fun loopOut() {
        val t = position.toDouble()
        val start = loopStart ?: (t - 4.0).coerceAtLeast(0.0)
        val end = t.coerceAtLeast(start + MIN_LOOP)
        loopStart = start
        loopEnd = end
        rememberLoop()
    }

    fun clearLoop() {
        loopStart = null
        loopEnd = null
        loopEnabled = false
        rememberLoop()
    }

    fun moveLoop(start: Double, end: Double) {
        val dur = duration.toDouble().coerceAtLeast(MIN_LOOP)
        val a = start.coerceIn(0.0, dur - MIN_LOOP)
        val b = end.coerceIn(a + MIN_LOOP, dur)
        loopStart = a
        loopEnd = b
        rememberLoop()
    }

    fun addMarker(time: Double, label: String) {
        val song = current ?: return
        val text = label.trim().ifBlank { suggestMarkerLabel(markers.size) }
        markers = (markers + Marker(newId(), time, text, pickMarkerRow(markers, time))).sortedBy { it.time }
        schedulePracticeSave(song)
    }

    fun updateMarker(id: String, time: Double? = null, label: String? = null, stanzaIndex: Int? = null, clearStanza: Boolean = false) {
        val song = current ?: return
        markers = markers.map {
            if (it.id != id) it
            else it.copy(
                time = time ?: it.time,
                label = label ?: it.label,
                stanzaIndex = if (clearStanza) null else stanzaIndex ?: it.stanzaIndex,
            )
        }.sortedBy { it.time }
        schedulePracticeSave(song)
    }

    fun removeMarker(id: String) {
        val song = current ?: return
        markers = markers.filter { it.id != id }
        schedulePracticeSave(song)
    }

    fun addStanzaTag(stanzaIndex: Int, label: String) {
        val song = current ?: return
        stanzaTags = stanzaTags + StanzaTag(newId(), stanzaIndex, label.trim().ifBlank { "Tag" })
        schedulePracticeSave(song)
    }

    fun removeStanzaTag(id: String) {
        val song = current ?: return
        stanzaTags = stanzaTags.filter { it.id != id }
        schedulePracticeSave(song)
    }

    fun deleteSong(song: SongRecord) {
        viewModelScope.launch(Dispatchers.IO) {
            song.dir.deleteRecursively()
            withContext(Dispatchers.Main) {
                if (current?.slug == song.slug) {
                    player?.pause()
                    current = null
                    lyrics = emptyList()
                    markers = emptyList()
                    stanzaTags = emptyList()
                    chords = null
                }
                reloadLibrary()
            }
        }
    }

    fun createSetlist(name: String): SetlistRecord {
        val record = SetlistRecord(setlistIdFor(name, setlists), name.trim(), emptyList())
        saveSetlist(getApplication(), record)
        setlists = (setlists + record).sortedBy { it.name.lowercase() }
        return record
    }

    fun updateSetlist(record: SetlistRecord) {
        saveSetlist(getApplication(), record)
        setlists = setlists.map { if (it.id == record.id) record else it }
    }

    fun removeSetlist(id: String) {
        deleteSetlist(getApplication(), id)
        setlists = setlists.filter { it.id != id }
        if (modeId == id) modeId = null
        prefs.edit().putString("mode", modeId).apply()
    }

    fun selectMode(id: String?) {
        modeId = id
        prefs.edit().putString("mode", id).apply()
    }

    override fun onCleared() {
        saveJob?.cancel()
        current?.let { flushPractice(it) }
        feeder?.stop()
        player?.close()
    }

    private fun tick() {
        val engine = player ?: return
        playing = engine.playing()
        buffering = engine.buffering() || pendingSlug != null
        val dur = engine.duration()
        if (dur > 0) duration = dur.toFloat()
        if (!dragging && current != null) position = engine.position().toFloat()
        val err = engine.lastError()
        if (err.isNotEmpty()) status = err
        val region = loop
        if (playing && loopEnabled && region != null && position >= region.second - 0.04) {
            seek(region.first)
            return
        }
        if (engine.ended() && current != null) {
            if (!endHandled) {
                endHandled = true
                when (playbackMode) {
                    PlaybackMode.RepeatOne -> {
                        seek(0.0)
                        engine.play()
                    }
                    PlaybackMode.Sequential -> stepPlaylist(1, stopAtEnd = true)
                    PlaybackMode.RepeatAll -> stepPlaylist(1, wrap = true)
                }
            }
        } else {
            endHandled = false
        }
    }

    private fun stepPlaylist(dir: Int, stopAtEnd: Boolean = false, wrap: Boolean = false) {
        val list = playlist
        val slug = current?.slug
        if (list.isEmpty() || slug == null) return
        val index = list.indexOfFirst { it.slug == slug }
        if (index < 0) return
        var next = index + dir
        if (wrap) next = (next + list.size) % list.size
        if (next !in list.indices) {
            if (stopAtEnd) player?.pause()
            return
        }
        playSong(list[next])
    }

    private fun loadSidecars(song: SongRecord) {
        lyricsLoading = true
        viewModelScope.launch(Dispatchers.IO) {
            val text = loadLyrics(song.dir)
            val practice = loadPractice(song.dir)
            val chordFile = loadChords(song.dir)
            val blocks = text?.let { parseLyricsBlocks(it) } ?: emptyList()
            withContext(Dispatchers.Main) {
                if (current?.slug != song.slug) return@withContext
                lyrics = blocks
                lyricsNote = if (text == null) "No lyrics.md for this track." else null
                lyricsLoading = false
                markers = practice.markers
                stanzaTags = practice.stanzaTags
                chords = chordFile
            }
        }
    }

    private fun schedulePracticeSave(song: SongRecord) {
        saveJob?.cancel()
        saveJob = viewModelScope.launch {
            delay(400)
            withContext(Dispatchers.IO) { flushPractice(song) }
        }
    }

    private fun flushPractice(song: SongRecord) {
        savePractice(song.dir, PracticeFile(markers, stanzaTags))
    }

    private fun applyGains() {
        val engine = player ?: return
        val names = (current?.stems?.ifEmpty { null } ?: STEM_ORDER)
        for (name in names) {
            engine.setStemGain(name, stemGains[name] ?: 1f)
        }
        engine.setPitch(pitch)
        engine.setPlaybackRate(rate.toDouble())
        applyMaster()
    }

    private fun loadPeaks(song: SongRecord) {
        peakJob?.cancel()
        peaks = syntheticPeaks(song.slug, 140)
        val file = mainMixFile(song) ?: return
        peakJob = viewModelScope.launch {
            val real = withContext(Dispatchers.IO) {
                runCatching { waveformPeaks(file.absolutePath, 2048u).toFloatArray() }.getOrNull()
            }
            if (real != null && real.isNotEmpty() && current?.slug == song.slug) {
                peaks = downsamplePeaks(real, 140)
            }
        }
    }

    private fun applyMaster() {
        val gain = if (muted) 0f else volume
        player?.setMasterGain(gain)
    }

    private fun persistMixer() {
        val stems = JSONObject()
        for ((k, v) in stemGains) stems.put(k, v.toDouble())
        prefs.edit()
            .putFloat("volume", volume)
            .putBoolean("muted", muted)
            .putInt("pitch", pitch)
            .putFloat("rate", rate)
            .putString("stems", stems.toString())
            .apply()
    }

    private fun loadStems(): Map<String, Float> {
        val base = STEM_ORDER.associateWith { 1f }.toMutableMap()
        val raw = prefs.getString("stems", null) ?: return base
        runCatching {
            val o = JSONObject(raw)
            for (key in o.keys()) {
                base[key] = o.getDouble(key).toFloat().coerceIn(0f, MAX_GAIN.toFloat())
            }
        }
        return base
    }

    private fun rememberLoop() {
        val slug = current?.slug ?: return
        val all = runCatching { JSONObject(prefs.getString("loops", "{}") ?: "{}") }.getOrElse { JSONObject() }
        val region = loop
        if (region == null) {
            all.remove(slug)
        } else {
            all.put(
                slug,
                JSONObject()
                    .put("start", region.first)
                    .put("end", region.second)
                    .put("enabled", loopEnabled),
            )
        }
        prefs.edit().putString("loops", all.toString()).apply()
    }

    private fun restoreLoop(slug: String) {
        val all = runCatching { JSONObject(prefs.getString("loops", "{}") ?: "{}") }.getOrNull()
        val o = all?.optJSONObject(slug)
        if (o == null || !o.has("start") || !o.has("end") || o.getDouble("end") <= o.getDouble("start")) {
            loopStart = null
            loopEnd = null
            loopEnabled = false
            return
        }
        loopStart = o.getDouble("start")
        loopEnd = o.getDouble("end")
        loopEnabled = o.optBoolean("enabled")
    }
}
