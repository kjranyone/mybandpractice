package com.donoy.mybandpractice.v2

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TransportTest {
    private fun written(position: Double, duration: Double, flags: Int): ByteBuffer {
        val bytes = ByteBuffer.allocateDirect(Transport.BYTES).order(ByteOrder.nativeOrder())
        bytes.putDouble(position).putDouble(duration).put(flags.toByte())
        return bytes
    }

    @Test
    fun readsWhatTheEngineWrites() {
        val transport = Transport.read(written(12.5, 200.25, 1 or 4))
        assertEquals(12.5, transport.position, 0.0)
        assertEquals(200.25, transport.duration, 0.0)
        assertTrue(transport.playing)
        assertTrue(transport.ended)
        assertFalse(transport.buffering)
        assertFalse(transport.failed)
    }

    @Test
    fun readsEachFlagOnItsOwn() {
        assertFalse(Transport.read(written(0.0, 1.0, 0)).playing)
        assertTrue(Transport.read(written(0.0, 1.0, 2)).buffering)
        assertTrue(Transport.read(written(0.0, 1.0, 8)).failed)
        val all = Transport.read(written(1.0, 2.0, 15))
        assertTrue(all.playing && all.buffering && all.ended && all.failed)
    }
}
