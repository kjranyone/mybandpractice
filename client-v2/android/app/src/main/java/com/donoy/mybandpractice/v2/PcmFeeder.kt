package com.donoy.mybandpractice.v2

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.donoy.mybandpractice.v2.core.Player
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

/** Pulls stereo PCM from the Rust core into an [AudioTrack]. */
class PcmFeeder(private val player: Player) {
    @Volatile private var running = false
    /** The output failed for good. The engine is no longer pulled forward, so the song waits. */
    @Volatile var failed = false
        private set
    private var worker: Thread? = null

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
        worker?.join(500)
        worker = null
    }

    private fun feed(track: AudioTrack) {
        val shorts = ShortArray(FRAMES * 2)
        var failures = 0
        while (running) {
            if (!player.playing()) {
                idle(track)
                continue
            }
            val bytes = player.renderPcm(FRAMES.toUInt())
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
            var offset = 0
            var result = 0
            while (offset < shorts.size && running) {
                val wrote = track.write(shorts, offset, shorts.size - offset)
                if (wrote <= 0) {
                    result = wrote
                    break
                }
                offset += wrote
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
        SystemClock.sleep(DRAIN_MS)
        if (!running || player.playing()) return
        runCatching {
            track.pause()
            track.flush()
        }
        while (running && !player.playing()) SystemClock.sleep(20)
        if (running) runCatching { track.play() }
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
