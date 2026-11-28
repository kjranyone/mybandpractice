package com.donoy.mybandpractice.v2

import android.content.Context
import android.content.SharedPreferences
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import com.donoy.mybandpractice.v2.core.Player
import java.util.concurrent.Executors

/** AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_EXCLUSIVE, which is hidden from the SDK. */
private const val AUDIOFOCUS_LOSS_TRANSIENT_EXCLUSIVE = 4

/**
 * Process-wide audio: the Rust player, the AudioTrack that feeds it and the song that is
 * loaded. It outlives the activity, so playback continues in the background and a
 * recreated PracticeModel picks up where the engine is. PlaybackService keeps the process
 * alive while something plays.
 */
object Playback {
    @Volatile var player: Player? = null
        private set
    /** The player's JNI side, for the calls that run dozens of times a second. */
    @Volatile var audio: NativeAudio? = null
        private set
    @Volatile var feeder: PcmFeeder? = null
        private set
    /** Why there is no audio output, or null. */
    @Volatile var error: String? = null
        private set
    /** Why playback stopped although nothing asked for it, or null. */
    @Volatile var outputError: String? = null
        internal set
    /** The song loaded into the engine, or null before the first one. */
    @Volatile var current: SongRecord? = null
        private set
    /** Set by the PracticeModel while it exists: next and previous from the notification. */
    @Volatile var listener: Listener? = null
    /** A song is being decoded; the service must not stop in the meantime. */
    @Volatile var loading = false
        private set
    /** Paused because another app took the focus for a moment. */
    @Volatile var waitingForFocus = false
        private set

    interface Listener {
        /** Shows a song that the service loaded while the model was not involved. */
        fun adopt(song: SongRecord)

        /** Skips to the next (1) or previous (-1) song. */
        fun step(direction: Int)
    }

    private lateinit var app: Context
    private lateinit var prefs: SharedPreferences
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var master = 1f
    private var duck = 1f
    private var resumeWhenFocused = false

    /** Opens the audio output once per process. Safe to call again. */
    fun open(context: Context) {
        if (player != null) return
        app = context.applicationContext
        prefs = app.getSharedPreferences("mbp", Context.MODE_PRIVATE)
        player = try {
            Player()
        } catch (err: Throwable) {
            error = err.message ?: err.toString()
            null
        }
        audio = player?.let { engine ->
            try {
                NativeAudio(engine)
            } catch (err: Throwable) {
                error = err.message ?: "音声出力を開けません"
                null
            }
        }
        feeder = audio?.let { bridge ->
            try {
                PcmFeeder(bridge).also { it.start() }
            } catch (err: Throwable) {
                error = err.message ?: "音声出力を開けません"
                null
            }
        }
    }

    fun play() {
        val engine = player ?: return
        if (current == null) return
        if (waitingForFocus) {
            // keep the place: the song starts when the other app is done
            resumeWhenFocused = true
            return
        }
        engine.play()
        feeder?.wake()
        PlaybackService.running(app)
    }

    /** [waiting] keeps the service up so that the song continues when the focus returns. */
    fun pause(waiting: Boolean = false) {
        val engine = player ?: return
        resumeWhenFocused = waiting && engine.playing()
        waitingForFocus = waiting
        engine.pause()
        saveProgress()
        PlaybackService.sync(app)
    }

    fun toggle() {
        val engine = player ?: return
        if (current == null) return
        if (engine.playing()) {
            pause()
        } else {
            if (engine.ended()) runCatching { engine.seek(0.0) }
            play()
        }
    }

    fun seekTo(seconds: Double) {
        val engine = player ?: return
        runCatching { engine.seek(seconds) }
        saveProgress()
    }

    /** The volume control; [focusChanged] scales it while another app may duck us. */
    fun setMaster(gain: Float) {
        master = gain
        applyMaster()
    }

    /** Another app took or returned the audio focus (AudioManager.AUDIOFOCUS_*). */
    fun focusChanged(change: Int) {
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                duck = 1f
                applyMaster()
                waitingForFocus = false
                if (resumeWhenFocused) {
                    resumeWhenFocused = false
                    play()
                }
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                duck = 1f
                applyMaster()
                resumeWhenFocused = false
                waitingForFocus = false
                if (player?.playing() == true) pause() else PlaybackService.sync(app)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AUDIOFOCUS_LOSS_TRANSIENT_EXCLUSIVE ->
                if (player?.playing() == true) pause(waiting = true)
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                duck = 0.2f
                applyMaster()
            }
        }
    }

    /** Unplugged headphones: the song goes on from the speaker otherwise. */
    fun outputDisconnected() {
        if (player?.playing() == true) pause()
    }

    /** Decodes a song into the engine on the calling thread; returns the failure, if any. */
    fun load(song: SongRecord): Throwable? {
        val engine = player ?: return IllegalStateException("再生コアを読み込めません")
        val chunks = song.chunksDir ?: return IllegalStateException("chunks がありません")
        loading = true
        try {
            engine.loadChunksDir(chunks.absolutePath)
            current = song
            saveProgress()
            return null
        } catch (err: Throwable) {
            return err
        } finally {
            loading = false
        }
    }

    /**
     * Loads the song that played last at its last position, paused. [done] runs on the main
     * thread with the song, or null when there is nothing to restore.
     */
    fun restore(done: (SongRecord?) -> Unit) {
        val wanted = savedSong()
        if (wanted == null) {
            main.post { done(null) }
            return
        }
        // read before loading: loading stores position 0 as the new progress
        val start = savedPosition()
        loading = true
        io.execute {
            try {
                val record = songAt(app, wanted)
                val failure = record?.let { load(it) }
                if (record == null) {
                    prefs.edit().remove("last_song").remove("last_pos").apply()
                } else if (failure == null && start > 0f) {
                    player?.let { runCatching { it.seek(start.toDouble()) } }
                    saveProgress()
                }
                main.post { done(if (failure == null) record else null) }
            } finally {
                loading = false
            }
        }
    }

    fun saveProgress() {
        if (!::prefs.isInitialized) return
        val song = current ?: return
        val engine = player ?: return
        prefs.edit()
            .putString("last_song", song.slug)
            .putFloat("last_pos", engine.position().toFloat())
            .apply()
    }

    fun savedSong(): String? = if (::prefs.isInitialized) prefs.getString("last_song", null) else null

    private fun savedPosition(): Float = prefs.getFloat("last_pos", 0f)

    /** Forgets [slug] when it is the loaded song, for example because it was deleted. */
    fun forget(slug: String) {
        if (current?.slug != slug) return
        current = null
        prefs.edit().remove("last_song").remove("last_pos").apply()
    }

    private fun applyMaster() {
        player?.setMasterGain(master * duck)
    }
}
