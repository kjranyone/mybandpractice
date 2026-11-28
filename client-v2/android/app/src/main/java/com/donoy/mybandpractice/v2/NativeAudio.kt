package com.donoy.mybandpractice.v2

import com.donoy.mybandpractice.v2.core.Player
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The two calls the player makes dozens of times a second, straight through JNI:
 * pulling PCM and reading the transport. Everything else goes through UniFFI, whose
 * JNA marshalling costs a good part of a millisecond per call.
 *
 * The native side is `native.rs` in libmbp_ffi.so. It is addressed through
 * [Player.nativeHandle], and holding [player] is what keeps that address valid.
 * JNI finds the two functions by their names, so they and this class keep them even
 * if code shrinking is ever turned on.
 */
class NativeAudio(private val player: Player) {
    private val handle = player.nativeHandle().toLong()
    private val transportBytes = ByteBuffer.allocateDirect(Transport.BYTES).order(ByteOrder.nativeOrder())

    init {
        System.loadLibrary("mbp_ffi")
    }

    /** Mixes [frames] frames of stereo 16-bit PCM into [dst], from its first byte. */
    fun pull(dst: ByteBuffer, frames: Int) {
        check(renderPcm(handle, dst, frames) >= 0) { "the engine cannot render into this buffer" }
    }

    fun transport(): Transport {
        check(readTransport(handle, transportBytes) == Transport.BYTES) { "the engine cannot write the transport" }
        return Transport.read(transportBytes)
    }

    fun lastError(): String = player.lastError()

    private external fun renderPcm(handle: Long, dst: ByteBuffer, frames: Int): Int

    private external fun readTransport(handle: Long, out: ByteBuffer): Int
}
