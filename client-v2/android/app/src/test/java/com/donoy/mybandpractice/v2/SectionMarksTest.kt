package com.donoy.mybandpractice.v2

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SectionMarksTest {
    private fun mark(id: String, time: Double) = Marker(id, time, id)

    private val marks = listOf(mark("Int", 0.0), mark("1A", 12.5), mark("1B", 40.0), mark("Solo", 95.0))

    @Test
    fun aNewMarkTakesTheFirstNameThatIsFree() {
        assertEquals("1サビ", nextMarkLabel(marks))
        assertEquals("Int", nextMarkLabel(emptyList()))
        assertEquals("M10", nextMarkLabel((0 until 9).map { mark(MARKER_PRESETS[it], it.toDouble()) }))
        // names are not handed out twice, whatever the order of the marks
        assertEquals("Int", nextMarkLabel(listOf(mark("1A", 0.0), mark("1B", 1.0))))
    }

    @Test
    fun theMarkNearThePlayheadIsTheNearestOne() {
        assertEquals("1A", markerNear(marks, 13.0)?.label)
        assertEquals("1B", markerNear(marks, 39.2)?.label)
        assertNull(markerNear(marks, 20.0))
    }

    @Test
    fun nothingIsNearWhenThePlayheadIsFarFromEveryMark() {
        assertNull(markerNear(marks, -3.0))
        assertNull(markerNear(marks, 300.0))
        assertNull(markerNear(emptyList(), 12.5))
    }

    @Test
    fun aSectionEndsAtTheNextMark() {
        assertEquals(40.0, sectionEnd(marks, 12.5, 180.0), 0.0)
        assertEquals(95.0, sectionEnd(marks, 40.0, 180.0), 0.0)
    }

    @Test
    fun theLastSectionEndsWithTheSong() {
        assertEquals(180.0, sectionEnd(marks, 95.0, 180.0), 0.0)
        assertEquals(180.0, sectionEnd(emptyList(), 0.0, 180.0), 0.0)
    }

    @Test
    fun aSectionIsLongEnoughToLoop() {
        // a mark so close to the start that the stretch between could not be a loop is passed over
        val tight = marks + mark("close", 12.6)
        assertEquals(40.0, sectionEnd(tight, 12.5, 180.0), 0.0)
        // and a mark at the very place of the one at hand does not end it
        val twin = marks + mark("twin", 40.0)
        assertEquals(95.0, sectionEnd(twin, 40.0, 180.0), 0.0)
    }
}
