package com.donoy.mybandpractice.v2

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import com.donoy.mybandpractice.v2.core.Player
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

/** Pulls stereo PCM from the Rust core into an [AudioTrack]. */
class PcmFeeder(private val player: Player) {
    @Volatile private var running = false
    private var worker: Thread? = null

    fun start() {
        if (running) return
        val minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE, CHANNELS, ENCODING)
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
            .setBufferSizeInBytes(maxOf(minBuf, SAMPLE_RATE / 5 * 2 * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track.play()
        running = true
        worker = thread(name = "mbp-pcm", isDaemon = true) {
            val shorts = ShortArray(FRAMES * 2)
            while (running) {
                val bytes = player.renderPcm(FRAMES.toUInt())
                ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
                var offset = 0
                while (offset < shorts.size && running) {
                    val wrote = track.write(shorts, offset, shorts.size - offset)
                    if (wrote <= 0) break
                    offset += wrote
                }
            }
            track.pause()
            track.flush()
            track.release()
        }
    }

    fun stop() {
        running = false
        worker?.join(500)
        worker = null
    }

    companion object {
        const val SAMPLE_RATE = 48_000
        const val FRAMES = 1024
        const val CHANNELS = AudioFormat.CHANNEL_OUT_STEREO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }
}

fun requestPlaybackFocus(manager: AudioManager) {
    val request = android.media.AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build(),
        )
        .build()
    manager.requestAudioFocus(request)
}
