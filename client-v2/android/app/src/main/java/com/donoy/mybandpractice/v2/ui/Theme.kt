package com.donoy.mybandpractice.v2.ui

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object Mbp {
    val Bg = Color(0xFF0C0E12)
    val BgElevated = Color(0xFF141820)
    val BgHover = Color(0xFF1A2030)
    val Border = Color(0xFF252B38)
    val BorderStrong = Color(0xFF343C4E)
    val Text = Color(0xFFE8ECF4)
    val Muted = Color(0xFF8B95A8)
    val Faint = Color(0xFF5C6678)
    val Accent = Color(0xFF5EEAD4)
    val AccentDim = Color(0x1F5EEAD4)
    val AccentStrong = Color(0xFF2DD4BF)
    val Sc = Color(0xFFFF5500)
    val Loop = Color(0xFFFBBF24)
    val LoopSoft = Color(0x2EFBBF24)
    val Danger = Color(0xFFF87171)
    val Card = Color(0xFA0A0C10)
    val Ink = Color(0xFF06202A)
    val Bar = Color(0xFF3A414F)
    val BarLoop = Color(0xFF6B5A3A)
    val BarLoopPlayed = Color(0xFFFF7A33)
    val Mono = FontFamily.Monospace
    val Sidebar = 300.dp
    val DrawerBreakpoint = 820
    val CompactPlayer = 960
    val PhonePlayer = 600

    /**
     * Type ramp for this device. smallestScreenWidthDp already follows the
     * density override, and the sizes are sp so the system font scale stacks
     * on top. Phone keeps the ported sizes. Wider devices step the same roles up.
     */
    val type: MbpType
        @Composable
        @ReadOnlyComposable
        get() = MbpType.forSmallestWidth(LocalConfiguration.current.smallestScreenWidthDp)
}

/**
 * One step of the reading scale. Phone matches the previous literals.
 * Tablet is smallest width ≥ 600dp (this 8.4" panel). Large is ≥ 840dp.
 */
@Immutable
class MbpType internal constructor(
    val display: TextUnit,
    val song: TextUnit,
    val songLine: TextUnit,
    val headline: TextUnit,
    val title: TextUnit,
    val titleLg: TextUnit,
    val body: TextUnit,
    val bodySm: TextUnit,
    val callout: TextUnit,
    val caption: TextUnit,
    val label: TextUnit,
    val micro: TextUnit,
    val nano: TextUnit,
    val iconLg: TextUnit,
    val lyrics: TextUnit,
    val lyricsLine: TextUnit,
) {
    companion object {
        val Phone = MbpType(
            display = 24.sp,
            song = 28.sp,
            songLine = 32.sp,
            headline = 18.sp,
            title = 16.sp,
            titleLg = 20.sp,
            body = 14.sp,
            bodySm = 13.sp,
            callout = 15.sp,
            caption = 12.sp,
            label = 11.sp,
            micro = 10.sp,
            nano = 9.sp,
            iconLg = 28.sp,
            lyrics = 16.sp,
            lyricsLine = 26.sp,
        )
        val Tablet = MbpType(
            display = 28.sp,
            song = 32.sp,
            songLine = 40.sp,
            headline = 20.sp,
            title = 18.sp,
            titleLg = 22.sp,
            body = 16.sp,
            bodySm = 15.sp,
            callout = 17.sp,
            caption = 14.sp,
            label = 12.sp,
            micro = 11.sp,
            nano = 10.sp,
            iconLg = 32.sp,
            lyrics = 19.sp,
            lyricsLine = 30.sp,
        )
        val Large = MbpType(
            display = 32.sp,
            song = 36.sp,
            songLine = 44.sp,
            headline = 22.sp,
            title = 20.sp,
            titleLg = 24.sp,
            body = 17.sp,
            bodySm = 16.sp,
            callout = 18.sp,
            caption = 15.sp,
            label = 13.sp,
            micro = 12.sp,
            nano = 11.sp,
            iconLg = 36.sp,
            lyrics = 21.sp,
            lyricsLine = 34.sp,
        )

        fun forSmallestWidth(swDp: Int): MbpType = when {
            swDp >= 840 -> Large
            swDp >= 600 -> Tablet
            else -> Phone
        }
    }
}

/** Web drawer curve: cubic-bezier(0.16, 1, 0.3, 1). */
val MbpEaseOut = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
