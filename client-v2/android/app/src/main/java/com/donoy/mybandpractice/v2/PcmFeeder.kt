package com.donoy.mybandpractice.v2

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread
import kotlin.concurrent.withLock

/** Pulls stereo PCM from the Rust core into an [AudioTrack]. */
class PcmFeeder(private val audio: NativeAudio) {
    @Volatile private var running = false
    /** The output failed for good. The engine is no longer pulled forward, so the song waits. */
    @Volatile var failed = false
        private set
    private var worker: Thread? = null
    private val gate = ReentrantLock()
    /** Signalled by [wake] while nothing plays. Asking the engine fifty times a second
     *  whether it plays again cost more than everything else while a song was paused. */
    private val resumed = gate.newCondition()

    /** The engine was just told to play: the feed starts now instead of at its next look. */
    fun wake() {
        gate.withLock { resumed.signalAll() }
    }

    fun start() {
        if (running) return
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(ENCODING)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNELS)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(SAMPLE_RATE, CHANNELS, ENCODING), SAMPLE_RATE / 5 * 2 * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        running = true
        worker = thread(name = "mbp-pcm", isDaemon = true) {
            // Audio has to keep its turn while the app is in the background.
            runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO) }
            try {
                feed(track)
            } finally {
                runCatching {
                    track.pause()
                    track.flush()
                    track.release()
                }
            }
        }
    }

    fun stop() {
        running = false
        wake()
        worker?.join(500)
        worker = null
    }

    private fun feed(track: AudioTrack) {
        // One block. The engine fills it in place and the track reads it there: nothing
        // is copied on the way, and nothing is allocated per block.
        val block = ByteBuffer.allocateDirect(FRAMES * 4).order(ByteOrder.nativeOrder())
        var failures = 0
        while (running) {
            if (!audio.transport().playing) {
                idle(track)
                continue
            }
            audio.pull(block, FRAMES)
            block.position(0)
            block.limit(FRAMES * 4)
            var result = 0
            while (block.hasRemaining() && running) {
                val wrote = track.write(block, block.remaining(), AudioTrack.WRITE_BLOCKING)
                if (wrote <= 0) {
                    result = wrote
                    break
                }
            }
            if (result != 0) {
                // A routing change or the audio server going away: restart the stream instead
                // of running through the song with nothing to hear.
                failures++
                Log.w(TAG, "AudioTrack.write returned $result")
                runCatching {
                    track.pause()
                    track.flush()
                    track.play()
                }
                SystemClock.sleep(50)
                if (failures >= 20) {
                    failed = true
                    Log.e(TAG, "audio output is gone, playback waits")
                    return
                }
            } else {
                failures = 0
            }
        }
    }

    /** Nothing plays: the stream is paused so that it does not hold the speaker open for silence. */
    private fun idle(track: AudioTrack) {
        // what was written last is the end of the song: let it play out
        if (awaitPlaying(until = SystemClock.uptimeMillis() + DRAIN_MS)) return
        runCatching {
            track.pause()
            track.flush()
        }
        awaitPlaying()
        if (running) runCatching { track.play() }
    }

    /**
     * Waits for the engine to play again, for [running] to end, or, with [until], for that
     * moment to pass. Returns true when the engine plays and the feed still runs.
     */
    private fun awaitPlaying(until: Long? = null): Boolean {
        gate.withLock {
            while (running && !audio.transport().playing) {
                val left = until?.let { it - SystemClock.uptimeMillis() } ?: Long.MAX_VALUE
                if (left <= 0) return false
                try {
                    resumed.await(left, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    // asked whether the engine plays again, as after any wake-up
                }
            }
        }
        return running && audio.transport().playing
    }

    companion object {
        private const val TAG = "mbp-pcm"
        const val SAMPLE_RATE = 48_000
        const val FRAMES = 1024
        /** A little longer than the track buffer, which holds 200 ms. */
        const val DRAIN_MS = 250L
        const val CHANNELS = AudioFormat.CHANNEL_OUT_STEREO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }
}
