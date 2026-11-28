package com.donoy.mybandpractice.v2

import java.nio.ByteBuffer

/**
 * The transport as the engine reports it, read in one call by [NativeAudio.transport].
 */
class Transport private constructor() {
    var position = 0.0
        private set
    var duration = 0.0
        private set
    var playing = false
        private set
    var buffering = false
        private set
    var ended = false
        private set
    /** The engine holds an error; [NativeAudio.lastError] has its text. */
    var failed = false
        private set

    companion object {
        /** What the engine writes: the position and the duration as f64, then a byte of flags. */
        const val BYTES = 17

        private const val PLAYING = 1
        private const val BUFFERING = 2
        private const val ENDED = 4
        private const val FAILED = 8

        /** Reads the first [BYTES] bytes of a buffer the engine has just written. */
        internal fun read(bytes: ByteBuffer): Transport {
            val flags = bytes.get(16).toInt()
            val transport = Transport()
            transport.position = bytes.getDouble(0)
            transport.duration = bytes.getDouble(8)
            transport.playing = flags and PLAYING != 0
            transport.buffering = flags and BUFFERING != 0
            transport.ended = flags and ENDED != 0
            transport.failed = flags and FAILED != 0
            return transport
        }
    }
}
