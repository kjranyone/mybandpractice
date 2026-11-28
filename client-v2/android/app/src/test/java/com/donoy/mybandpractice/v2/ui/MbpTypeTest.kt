package com.donoy.mybandpractice.v2.ui

import androidx.compose.ui.unit.TextUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MbpTypeTest {
    private val ramps = listOf("phone" to MbpType.Phone, "tablet" to MbpType.Tablet, "large" to MbpType.Large)

    // every step that sizes text; iconLg is left out, it sizes a picture
    private fun MbpType.textSteps(): List<Pair<String, TextUnit>> = listOf(
        "display" to display,
        "song" to song,
        "headline" to headline,
        "title" to title,
        "titleLg" to titleLg,
        "body" to body,
        "bodySm" to bodySm,
        "callout" to callout,
        "caption" to caption,
        "label" to label,
        "micro" to micro,
        "nano" to nano,
        "lyrics" to lyrics,
    )

    @Test
    fun noTextUnderTheMinimum() {
        for ((device, ramp) in ramps) {
            for ((step, size) in ramp.textSteps()) {
                assertTrue("$device $step is $size", size >= MbpType.MinText)
            }
        }
    }

    @Test
    fun aWiderDeviceNeverHasSmallerText() {
        val steps = MbpType.Phone.textSteps().zip(MbpType.Tablet.textSteps()).zip(MbpType.Large.textSteps())
        for ((phoneAndTablet, large) in steps) {
            val (phone, tablet) = phoneAndTablet
            assertEquals(phone.first, tablet.first)
            assertEquals(phone.first, large.first)
            assertTrue("${phone.first}: $phone is larger than $tablet", phone.second <= tablet.second)
            assertTrue("${tablet.first}: $tablet is larger than $large", tablet.second <= large.second)
        }
    }

    @Test
    fun picksTheStepFromTheSmallestWidth() {
        assertSame(MbpType.Phone, MbpType.forSmallestWidth(599))
        assertSame(MbpType.Tablet, MbpType.forSmallestWidth(600))
        assertSame(MbpType.Tablet, MbpType.forSmallestWidth(839))
        assertSame(MbpType.Large, MbpType.forSmallestWidth(840))
    }
}
