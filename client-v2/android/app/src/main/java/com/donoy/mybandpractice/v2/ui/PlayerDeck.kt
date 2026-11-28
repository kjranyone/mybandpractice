package com.donoy.mybandpractice.v2.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.donoy.mybandpractice.v2.MIN_LOOP
import com.donoy.mybandpractice.v2.PlaybackMode
import com.donoy.mybandpractice.v2.PracticeModel
import com.donoy.mybandpractice.v2.formatGain
import com.donoy.mybandpractice.v2.formatTimePrecise
import com.donoy.mybandpractice.v2.suggestMarkerLabel
import com.donoy.mybandpractice.v2.syntheticPeaks
import com.donoy.mybandpractice.v2.toLeadSheetNotation
import com.donoy.mybandpractice.v2.transposeChord
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/** Mono characters the chord readout reserves, from the longest common lead-sheet symbol. */
private const val CHORD_SLOT = 8

/** Diameter of the play and repeat keys. */
private val TransportKey = 46.dp

/** Horizontal padding inside the mixer chip, and the gap between its cells. */
private val ChipPad = 10.dp
private val ChipGap = 4.dp

/** Room the compact transport needs beside the mixer chip: both keys, their padding, and a little air. */
private val CompactTransportMin = TransportKey * 2 + 18.dp

@Composable
fun PlayerDeck(
    model: PracticeModel,
    chordSheetOpen: Boolean,
    onToggleChordSheet: () -> Unit,
    onOpenMixer: () -> Unit,
    mixerOpen: Boolean,
    compact: Boolean,
) {
    val song = model.current
    val disabled = song?.chunksDir == null
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Mbp.Bg)
            .border(width = 1.dp, color = Mbp.Border)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Waveform(model, disabled)
        if (compact) {
            Info(model, chordSheetOpen, onToggleChordSheet, disabled, Modifier.fillMaxWidth())
            // The keys share a line with the chip while they fit. Larger fonts stack the chip
            // below it instead of letting it grow over a key.
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                if (maxWidth >= CompactTransportMin + chipCells().width) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Transport(model, disabled, showSkips = false, modifier = Modifier.weight(1f))
                        MixerChip(model, mixerOpen, onOpenMixer)
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Transport(model, disabled, showSkips = false, modifier = Modifier.fillMaxWidth())
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            MixerChip(model, mixerOpen, onOpenMixer)
                        }
                    }
                }
            }
            LoopStrip(model, disabled, Modifier.fillMaxWidth())
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Info(model, chordSheetOpen, onToggleChordSheet, disabled, Modifier.weight(1f))
                Transport(model, disabled, showSkips = true)
                LoopStrip(model, disabled, Modifier.weight(1.4f))
                MixerChip(model, mixerOpen, onOpenMixer)
            }
        }
    }
}

/** Title row. The chord readout sits at its end, so it never borders the transport. */
@Composable
private fun Info(
    model: PracticeModel,
    chordSheetOpen: Boolean,
    onToggleChordSheet: () -> Unit,
    disabled: Boolean,
    modifier: Modifier = Modifier,
) {
    val song = model.current
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                song?.title ?: "Nothing selected",
                color = if (song == null) Mbp.Faint else Mbp.Text,
                fontWeight = FontWeight.SemiBold,
                fontSize = Mbp.type.body,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (song != null) {
                Text(song.artist, color = Mbp.Muted, fontSize = Mbp.type.caption, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        ChordReadout(model, chordSheetOpen, onToggleChordSheet, disabled)
    }
}

@Composable
private fun Waveform(model: PracticeModel, disabled: Boolean) {
    val song = model.current
    val peaks = if (model.peaks.size >= 8) model.peaks else syntheticPeaks(song?.slug ?: "empty", 140)
    val duration = model.duration.coerceAtLeast(0.01f)
    val progress = (model.position / duration).coerceIn(0f, 1f)
    val loop = model.loop
    var widthPx by remember { mutableFloatStateOf(1f) }
    var lastTap by remember { mutableLongStateOf(0L) }
    var lastX by remember { mutableFloatStateOf(0f) }
    val handlePx = with(LocalDensity.current) { 16.dp.toPx() }

    fun timeAt(x: Float, width: Float): Float {
        val ratio = (x / width.coerceAtLeast(1f)).coerceIn(0f, 1f)
        return ratio * model.duration
    }

    val shortWave = with(LocalDensity.current) { widthPx < 700.dp.toPx() }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(if (shortWave) 56.dp else 72.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(ColorBgWave)
                .border(1.dp, Mbp.Border, RoundedCornerShape(6.dp))
                .onSizeChanged { widthPx = it.width.toFloat().coerceAtLeast(1f) }
                .pointerInput(disabled) {
                    if (disabled) return@pointerInput
                    awaitPointerEventScope {
                        while (true) {
                            val down = awaitPointerEvent().changes.firstOrNull { it.pressed } ?: continue
                            val width = size.width.toFloat()
                            val startX = down.position.x
                            val region = model.loop
                            val mode = when {
                                region == null -> "seek"
                                abs(startX - (region.first / model.duration * width).toFloat()) < handlePx -> "in"
                                abs(startX - (region.second / model.duration * width).toFloat()) < handlePx -> "out"
                                else -> "seek"
                            }
                            if (mode == "seek") {
                                model.beginDrag()
                                model.dragTo(timeAt(startX, width))
                            }
                            var x = startX
                            var moved = false
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                if (!change.pressed) {
                                    if (mode == "seek") {
                                        model.endDrag(timeAt(x, width))
                                        val now = change.uptimeMillis
                                        if (!moved && now - lastTap < 280 && abs(x - lastX) < 48.dp.toPx() && model.current != null) {
                                            model.addMarker(timeAt(x, width).toDouble(), suggestMarkerLabel(model.markers.size))
                                        }
                                        lastTap = now
                                        lastX = x
                                    }
                                    break
                                }
                                if (abs(change.position.x - startX) > 6.dp.toPx()) moved = true
                                x = change.position.x
                                when (mode) {
                                    "seek" -> model.dragTo(timeAt(x, width))
                                    "in" -> {
                                        val regionNow = model.loop ?: break
                                        val t = timeAt(x, width).toDouble().coerceAtMost(regionNow.second - MIN_LOOP)
                                        model.moveLoop(t, regionNow.second)
                                    }
                                    "out" -> {
                                        val regionNow = model.loop ?: break
                                        val t = timeAt(x, width).toDouble().coerceAtLeast(regionNow.first + MIN_LOOP)
                                        model.moveLoop(regionNow.first, t)
                                    }
                                }
                                change.consume()
                            }
                        }
                    }
                },
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val n = peaks.size
                val pad = 2.dp.toPx()
                val pitch = (size.width - pad * 2) / n
                val barW = (pitch - 1f).coerceAtLeast(1f)
                val mid = size.height / 2f
                val loopStartR = loop?.let { (it.first / duration).toFloat() }
                val loopEndR = loop?.let { (it.second / duration).toFloat() }
                for (i in 0 until n) {
                    val r = (i + 0.5f) / n
                    val played = r <= progress
                    val inLoop = loopStartR != null && loopEndR != null && r in loopStartR..loopEndR
                    val color = when {
                        played && inLoop -> Mbp.BarLoopPlayed
                        played -> Mbp.Sc
                        inLoop -> Mbp.BarLoop
                        else -> Mbp.Bar
                    }
                    val barH = (peaks[i] * size.height).coerceAtLeast(size.height * 0.08f)
                    drawRoundRect(
                        color = color,
                        topLeft = Offset(pad + i * pitch, mid - barH / 2f),
                        size = Size(barW, barH),
                        cornerRadius = CornerRadius(1f, 1f),
                    )
                }
                if (loop != null) {
                    val left = (loop.first / duration * size.width).toFloat()
                    val right = (loop.second / duration * size.width).toFloat()
                    drawRect(Mbp.LoopSoft, topLeft = Offset(left, 0f), size = Size(right - left, size.height))
                    drawLine(Mbp.Loop, Offset(left, 0f), Offset(left, size.height), strokeWidth = 2.dp.toPx())
                    drawLine(Mbp.Loop, Offset(right, 0f), Offset(right, size.height), strokeWidth = 2.dp.toPx())
                }
                val head = progress * size.width
                drawLine(androidx.compose.ui.graphics.Color.White, Offset(head, 0f), Offset(head, size.height), strokeWidth = 2.dp.toPx())
            }
            if (model.buffering && song != null) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(androidx.compose.ui.graphics.Color(0xA6080A0E)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("BUFFERING", color = Mbp.Accent, fontFamily = Mbp.Mono, fontSize = Mbp.type.label, fontWeight = FontWeight.Bold)
                }
            }
            model.markers.forEach { marker ->
                val x = ((marker.time / duration) * widthPx)
                Text(
                    marker.label,
                    color = Mbp.Text,
                    fontFamily = Mbp.Mono,
                    fontSize = Mbp.type.nano,
                    modifier = Modifier
                        .offset { IntOffset(x.roundToInt() - 18, if (marker.row == 1) 20 else 2) }
                        .background(androidx.compose.ui.graphics.Color(0xF00F172A), RoundedCornerShape(4.dp))
                        .border(1.dp, androidx.compose.ui.graphics.Color(0x8094A3B8), RoundedCornerShape(4.dp))
                        .clickable { model.seek(marker.time) }
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                )
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatTimePrecise(model.position.toDouble()), color = Mbp.Muted, fontFamily = Mbp.Mono, fontSize = Mbp.type.label)
            Text(formatTimePrecise(model.duration.toDouble()), color = Mbp.Muted, fontFamily = Mbp.Mono, fontSize = Mbp.type.label)
        }
    }
}

private val ColorBgWave = androidx.compose.ui.graphics.Color(0xFF0A0C10)

@Composable
private fun Transport(model: PracticeModel, disabled: Boolean, showSkips: Boolean, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
        if (showSkips) {
            IconButton("⏮", !disabled, 34) { model.playPrev() }
            SkipButton("-5") { model.skip(-5.0) }
            SkipButton("-1") { model.skip(-1.0) }
        }
        Box(
            modifier = Modifier
                .padding(horizontal = 4.dp)
                .size(TransportKey)
                .clip(CircleShape)
                .background(Mbp.Text)
                // A layer that stays: taking Modifier.alpha(1f) out of the chain while a
                // restored song appears left the key without its circle until the next redraw.
                .graphicsLayer { alpha = if (disabled) 0.35f else 1f }
                .clickable(enabled = !disabled) { model.toggle() },
            contentAlignment = Alignment.Center,
        ) {
            if (model.buffering && model.current != null) {
                // Only there while a chunk is really loading. Kept alive all the time, this
                // animation made the whole app redraw at 60 fps for as long as it was open.
                val spin by rememberInfiniteTransition(label = "spin").animateFloat(
                    initialValue = 0f,
                    targetValue = 360f,
                    animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing)),
                    label = "deg",
                )
                Canvas(Modifier.size(18.dp)) {
                    rotate(spin) {
                        drawArc(Mbp.Bg, startAngle = 0f, sweepAngle = 270f, useCenter = false, style = Stroke(2.5.dp.toPx()))
                    }
                }
            } else if (model.playing) {
                Canvas(Modifier.size(16.dp)) {
                    drawRect(Mbp.Bg, size = Size(4.dp.toPx(), size.height))
                    drawRect(Mbp.Bg, topLeft = Offset(size.width - 4.dp.toPx(), 0f), size = Size(4.dp.toPx(), size.height))
                }
            } else {
                Canvas(Modifier.size(16.dp)) {
                    val path = Path().apply {
                        moveTo(2.dp.toPx(), 0f)
                        lineTo(size.width, size.height / 2f)
                        lineTo(2.dp.toPx(), size.height)
                        close()
                    }
                    drawPath(path, Mbp.Bg)
                }
            }
        }
        if (showSkips) {
            SkipButton("+1") { model.skip(1.0) }
            SkipButton("+5") { model.skip(5.0) }
            IconButton("⏭", !disabled, 34) { model.playNext() }
        }
        RepeatKey(model.playbackMode, model.current != null, Modifier.padding(start = 6.dp)) { model.cycleMode() }
    }
}

/**
 * Playback-mode key. It is built like the play key, a filled circle with a drawn glyph, so
 * it never depends on a font carrying "↻". Sequential keeps the play key's fill; Repeat All
 * and Repeat One turn it orange, and Repeat One adds a "1".
 */
@Composable
private fun RepeatKey(mode: PlaybackMode, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .size(TransportKey)
            .clip(CircleShape)
            .background(if (mode == PlaybackMode.Sequential) Mbp.Text else Mbp.Sc)
            .graphicsLayer { alpha = if (enabled) 1f else 0.35f }
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(22.dp)) {
            val ink = Mbp.Bg
            val c = center
            val r = size.minDimension / 2f - 3.dp.toPx()
            fun ring(degrees: Double) = Offset(
                c.x + (r * cos(Math.toRadians(degrees))).toFloat(),
                c.y + (r * sin(Math.toRadians(degrees))).toFloat(),
            )
            fun inner(x: Dp, y: Dp) = Offset(c.x + x.toPx(), c.y + y.toPx())

            // Nearly a full turn, open at the top right where the arrowhead takes over.
            drawArc(
                color = ink,
                startAngle = 305f,
                sweepAngle = 290f,
                useCenter = false,
                topLeft = Offset(c.x - r, c.y - r),
                size = Size(r * 2f, r * 2f),
                style = Stroke(2.dp.toPx(), cap = StrokeCap.Round),
            )
            val base = ring(300.0)
            val along = Offset(0.866f, 0.5f)
            val across = Offset(-0.5f, 0.866f)
            val reach = 5.5.dp.toPx()
            val spread = 3.6.dp.toPx()
            drawPath(
                Path().apply {
                    moveTo(base.x - across.x * spread, base.y - across.y * spread)
                    lineTo(base.x + along.x * reach, base.y + along.y * reach)
                    lineTo(base.x + across.x * spread, base.y + across.y * spread)
                    close()
                },
                ink,
            )
            if (mode == PlaybackMode.RepeatOne) {
                val flag = inner((-2.4).dp, (-3.4).dp)
                val top = inner((-0.3).dp, (-5.4).dp)
                val foot = inner((-0.3).dp, 5.4.dp)
                drawPath(
                    Path().apply {
                        moveTo(flag.x, flag.y)
                        lineTo(top.x, top.y)
                        lineTo(foot.x, foot.y)
                    },
                    ink,
                    style = Stroke(1.9.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
            }
        }
    }
}

@Composable
private fun SkipButton(label: String, onClick: () -> Unit) {
    Text(
        label,
        color = Mbp.Faint,
        fontFamily = Mbp.Mono,
        fontSize = Mbp.type.label,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 8.dp),
    )
}

@Composable
private fun IconButton(
    label: String,
    enabled: Boolean,
    size: Int,
    color: androidx.compose.ui.graphics.Color = Mbp.Muted,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = if (enabled) color else Mbp.Faint, fontSize = Mbp.type.body)
    }
}

@Composable
private fun LoopStrip(model: PracticeModel, disabled: Boolean, modifier: Modifier = Modifier) {
    val region = model.loop
    val on = model.loopEnabled && region != null
    Row(
        modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LoopKey(
            label = "Loop",
            hint = if (on) "on" else "off",
            kind = if (on) LoopKind.Active else if (region != null) LoopKind.Armed else LoopKind.Idle,
            enabled = !disabled && region != null,
            modifier = Modifier.weight(1.15f),
        ) { model.enableLoop(!model.loopEnabled) }
        LoopKey(
            label = "In",
            hint = region?.let { formatTimePrecise(it.first) } ?: "set",
            kind = if (region != null) LoopKind.Armed else LoopKind.Idle,
            enabled = !disabled,
            modifier = Modifier.weight(1f),
        ) { model.loopIn() }
        LoopKey(
            label = "Out",
            hint = region?.let { formatTimePrecise(it.second) } ?: "set",
            kind = if (region != null) LoopKind.Armed else LoopKind.Idle,
            enabled = !disabled,
            modifier = Modifier.weight(1f),
        ) { model.loopOut() }
        LoopKey(
            label = "Clear",
            hint = if (region != null) "reset" else "—",
            kind = if (region != null) LoopKind.Danger else LoopKind.Idle,
            enabled = region != null,
            modifier = Modifier.weight(1f),
        ) { model.clearLoop() }
    }
}

private enum class LoopKind { Idle, Armed, Active, Danger }

@Composable
private fun LoopKey(
    label: String,
    hint: String,
    kind: LoopKind,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    val show = if (enabled || kind == LoopKind.Active) kind else LoopKind.Idle
    val labelColor = when (show) {
        LoopKind.Active -> androidx.compose.ui.graphics.Color(0xFF1A1200)
        LoopKind.Danger -> Mbp.Danger
        LoopKind.Armed -> Mbp.Text
        LoopKind.Idle -> if (enabled) Mbp.Text else Mbp.Muted
    }
    val hintColor = when (show) {
        LoopKind.Active -> androidx.compose.ui.graphics.Color(0xFF1A1200)
        LoopKind.Danger -> Mbp.Danger
        LoopKind.Armed -> Mbp.Loop
        LoopKind.Idle -> Mbp.Faint
    }
    val border = when (show) {
        LoopKind.Active -> Mbp.Loop
        LoopKind.Danger -> Mbp.Danger.copy(alpha = 0.55f)
        LoopKind.Armed -> Mbp.Loop.copy(alpha = 0.7f)
        LoopKind.Idle -> Mbp.BorderStrong
    }
    val fill = if (show == LoopKind.Active) Mbp.Loop else Mbp.BgElevated
    Column(
        modifier
            .heightIn(min = 52.dp)
            .clip(shape)
            .background(fill)
            .border(1.dp, border, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            label.uppercase(),
            color = labelColor,
            fontSize = Mbp.type.caption,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.04.em,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
            // Drawn beside the label rather than laid out with it, so toggling never nudges it.
            modifier = Modifier.drawBehind {
                if (show == LoopKind.Active) {
                    drawCircle(
                        color = androidx.compose.ui.graphics.Color(0xFF1A1200),
                        radius = 3.dp.toPx(),
                        center = Offset(-9.dp.toPx(), size.height / 2f),
                    )
                }
            },
        )
        Text(
            hint,
            color = hintColor,
            fontFamily = Mbp.Mono,
            fontSize = Mbp.type.label,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Fixed slot, so a changing chord never resizes the deck. */
@Composable
private fun ChordReadout(
    model: PracticeModel,
    chordSheetOpen: Boolean,
    onToggleChordSheet: () -> Unit,
    disabled: Boolean,
) {
    val hit = model.chords?.chords?.firstOrNull { model.position >= it.start && model.position < it.end }
    val shown = hit?.let { toLeadSheetNotation(transposeChord(it.chord, model.pitch)) }
    val has = model.chords?.chords?.isNotEmpty() == true
    Text(
        shown ?: if (has) "Chord" else "--",
        color = if (chordSheetOpen || shown != null) Mbp.Accent else Mbp.Muted,
        fontFamily = Mbp.Mono,
        fontWeight = FontWeight.Bold,
        fontSize = Mbp.type.bodySm,
        textAlign = TextAlign.Center,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .width(readoutWidth(listOf("0".repeat(CHORD_SLOT)), Mbp.type.bodySm, FontWeight.Bold) + 20.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (chordSheetOpen) Mbp.AccentDim else Mbp.BgElevated)
            .border(1.dp, if (shown != null) Mbp.Accent else Mbp.BorderStrong, RoundedCornerShape(8.dp))
            .clickable(enabled = !disabled, onClick = onToggleChordSheet)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

/** Every value is a centered fixed-width cell, so the chip never changes size. */
@Composable
private fun MixerChip(model: PracticeModel, open: Boolean, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val stems = model.current?.stems?.ifEmpty { null } ?: com.donoy.mybandpractice.v2.STEM_ORDER
    val touched = stems.filter { (model.stemGains[it] ?: 1f) < 0.995f }
    val label = when {
        touched.isEmpty() -> "mix"
        touched.size == 1 && (model.stemGains[touched[0]] ?: 1f) <= 0.005f -> "-${touched[0]}"
        else -> "${stems.size - touched.size}/${stems.size}"
    }
    val rateOn = abs(model.rate - 1f) >= 0.005f
    val pitch = model.pitch
    val cells = chipCells()
    Row(
        modifier = modifier
            .height(38.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (open) Mbp.AccentDim else Mbp.BgElevated)
            .border(1.dp, if (open) Mbp.Accent else Mbp.BorderStrong, RoundedCornerShape(8.dp))
            .clickable(onClick = onOpen)
            .padding(horizontal = ChipPad),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ChipGap),
    ) {
        ChipCell("%.2f×".format(model.rate), cells.rate, if (rateOn) Mbp.Sc else Mbp.Muted)
        ChipCell("·", cells.dot, Mbp.Faint)
        ChipCell("${if (pitch > 0) "+" else ""}${pitch}st", cells.pitch, if (pitch != 0) Mbp.Accent else Mbp.Muted)
        ChipCell("·", cells.dot, Mbp.Faint)
        ChipCell(label, cells.mix, if (touched.isEmpty()) Mbp.Muted else Mbp.Sc)
        ChipCell("·", cells.dot, Mbp.Faint)
        ChipCell(
            if (model.muted || model.volume <= 0.001f) "M" else "${(model.volume * 100).roundToInt()}",
            cells.volume,
            Mbp.Text,
        )
    }
}

/** Fixed widths of the chip's cells. [width] lets the deck check the chip fits before placing it. */
private class ChipCells(val rate: Dp, val pitch: Dp, val mix: Dp, val volume: Dp, val dot: Dp) {
    val width: Dp get() = rate + pitch + mix + volume + dot * 3 + ChipPad * 2 + ChipGap * 6
}

@Composable
private fun chipCells(): ChipCells {
    val caption = Mbp.type.caption
    return ChipCells(
        rate = readoutWidth(listOf("1.00×"), caption, null),
        pitch = readoutWidth(listOf("+12st", "-12st"), caption, null),
        mix = readoutWidth(listOf("-vocals", "3/4"), caption, null),
        volume = readoutWidth(listOf("100"), caption, null),
        dot = readoutWidth(listOf("·"), caption, null),
    )
}

@Composable
private fun ChipCell(text: String, width: Dp, color: androidx.compose.ui.graphics.Color) {
    Text(
        text,
        color = color,
        fontFamily = Mbp.Mono,
        fontSize = Mbp.type.caption,
        textAlign = TextAlign.Center,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(width),
    )
}

/**
 * Width of the widest of [samples] in the readout style. Each cell is sized from the values
 * it really shows, so it stays fixed across font scales and OEM fonts. Guessing by glyph is
 * not safe: on a Japanese font chain a symbol like ♯ can fall back to a full-width one.
 */
@Composable
private fun readoutWidth(samples: List<String>, fontSize: TextUnit, fontWeight: FontWeight?): Dp {
    val measurer = rememberTextMeasurer()
    val base = LocalTextStyle.current
    val density = LocalDensity.current
    return remember(samples, fontSize, fontWeight, base, density) {
        val style = base.merge(TextStyle(fontFamily = Mbp.Mono, fontWeight = fontWeight, fontSize = fontSize))
        val widest = samples.maxOf { measurer.measure(it, style, maxLines = 1).size.width }
        with(density) { widest.toDp() }
    }
}

