package com.donoy.mybandpractice.v2.sync

import org.junit.Assert.assertEquals
import org.junit.Test

class LzStringTest {
    @Test
    fun matchesTheWebLibrary() {
        assertEquals("BYUwNmD2Q", compressToEncodedUriComponent("hello"))
        assertEquals("hello", decompressFromEncodedUriComponent("BYUwNmD2Q"))
        val json =
            "{\"t\":\"O\",\"p\":\"pwd\",\"u\":\"ufrag\",\"f\":\"sha-256 AA:BB\",\"s\":\"actpass\",\"c\":[\"1/2/192.168.1.5/5000\"]}"
        val encoded =
            "N4IgLiBcIPIgNCADlZB3AJgkBXVOAzAJwEMBzbA1AZwAsSBaAJgFYA2AAgEEvIAhPtmqoSAYzBIS1YYlFQA2iACMAeiYqlATiYA6JWwAcenSxUsADJZABdAL5A"
        assertEquals(encoded, compressToEncodedUriComponent(json))
        assertEquals(json, decompressFromEncodedUriComponent(encoded))
    }
}
