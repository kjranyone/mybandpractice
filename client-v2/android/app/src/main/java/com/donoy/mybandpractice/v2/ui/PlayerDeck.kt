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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.donoy.mybandpractice.v2.MIN_LOOP
import com.donoy.mybandpractice.v2.PracticeModel
import com.donoy.mybandpractice.v2.formatGain
import com.donoy.mybandpractice.v2.formatTimePrecise
import com.donoy.mybandpractice.v2.suggestMarkerLabel
import com.donoy.mybandpractice.v2.syntheticPeaks
import com.donoy.mybandpractice.v2.toLeadSheetNotation
import com.donoy.mybandpractice.v2.transposeChord
import kotlin.math.abs
import kotlin.math.roundToInt

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
            Info(model)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Transport(model, disabled, showSkips = false, modifier = Modifier.weight(1f))
                DeckSide(model, chordSheetOpen, onToggleChordSheet, onOpenMixer, mixerOpen, disabled)
            }
            LoopStrip(model, disabled, Modifier.fillMaxWidth())
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Info(model, Modifier.weight(1f))
                Transport(model, disabled, showSkips = true)
                LoopStrip(model, disabled, Modifier.weight(1.4f))
                DeckSide(model, chordSheetOpen, onToggleChordSheet, onOpenMixer, mixerOpen, disabled)
            }
        }
    }
}

@Composable
private fun Info(model: PracticeModel, modifier: Modifier = Modifier) {
    val song = model.current
    Column(modifier) {
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
    val spin by rememberInfiniteTransition(label = "spin").animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing)),
        label = "deg",
    )
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
        if (showSkips) {
            IconButton("⏮", !disabled, 34) { model.playPrev() }
            SkipButton("-5") { model.skip(-5.0) }
            SkipButton("-1") { model.skip(-1.0) }
        }
        Box(
            modifier = Modifier
                .padding(horizontal = 4.dp)
                .size(46.dp)
                .clip(CircleShape)
                .background(Mbp.Text)
                .alpha(if (disabled) 0.35f else 1f)
                .clickable(enabled = !disabled) { model.toggle() },
            contentAlignment = Alignment.Center,
        ) {
            if (model.buffering && model.current != null) {
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
        val active = model.playbackMode != com.donoy.mybandpractice.v2.PlaybackMode.Sequential
        IconButton(if (model.playbackMode == com.donoy.mybandpractice.v2.PlaybackMode.RepeatOne) "1↻" else "↻", model.current != null, 34, if (active) Mbp.Sc else Mbp.Muted) {
            model.cycleMode()
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
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (show == LoopKind.Active) {
                Box(Modifier.size(6.dp).background(androidx.compose.ui.graphics.Color(0xFF1A1200), CircleShape))
            }
            Text(
                label.uppercase(),
                color = labelColor,
                fontSize = Mbp.type.caption,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.04.em,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
        }
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

@Composable
private fun DeckSide(
    model: PracticeModel,
    chordSheetOpen: Boolean,
    onToggleChordSheet: () -> Unit,
    onOpenMixer: () -> Unit,
    mixerOpen: Boolean,
    disabled: Boolean,
) {
    val hit = model.chords?.chords?.firstOrNull { model.position >= it.start && model.position < it.end }
    val shown = hit?.let { toLeadSheetNotation(transposeChord(it.chord, model.pitch)) }
    val has = model.chords?.chords?.isNotEmpty() == true
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            shown ?: if (has) "Chord" else "--",
            color = if (chordSheetOpen || shown != null) Mbp.Accent else Mbp.Muted,
            fontFamily = Mbp.Mono,
            fontWeight = FontWeight.Bold,
            fontSize = Mbp.type.bodySm,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(if (chordSheetOpen) Mbp.AccentDim else Mbp.BgElevated)
                .border(1.dp, if (shown != null) Mbp.Accent else Mbp.BorderStrong, RoundedCornerShape(8.dp))
                .clickable(enabled = !disabled, onClick = onToggleChordSheet)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        )
        MixerChip(model, mixerOpen, onOpenMixer)
    }
}

@Composable
private fun MixerChip(model: PracticeModel, open: Boolean, onOpen: () -> Unit) {
    val stems = model.current?.stems?.ifEmpty { null } ?: com.donoy.mybandpractice.v2.STEM_ORDER
    val touched = stems.filter { (model.stemGains[it] ?: 1f) < 0.995f }
    val label = when {
        touched.isEmpty() -> "mix"
        touched.size == 1 && (model.stemGains[touched[0]] ?: 1f) <= 0.005f -> "-${touched[0]}"
        else -> "${stems.size - touched.size}/${stems.size}"
    }
    val rateOn = abs(model.rate - 1f) >= 0.005f
    Row(
        modifier = Modifier
            .height(38.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (open) Mbp.AccentDim else Mbp.BgElevated)
            .border(1.dp, if (open) Mbp.Accent else Mbp.BorderStrong, RoundedCornerShape(8.dp))
            .clickable(onClick = onOpen)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            "${"%.2f".format(model.rate)}×",
            color = if (rateOn) Mbp.Sc else Mbp.Muted,
            fontFamily = Mbp.Mono,
            fontSize = Mbp.type.caption,
        )
        if (model.pitch != 0) {
            Text("·", color = Mbp.Faint, fontSize = Mbp.type.caption)
            Text(
                "${if (model.pitch > 0) "+" else ""}${model.pitch}st",
                color = Mbp.Accent,
                fontFamily = Mbp.Mono,
                fontSize = Mbp.type.caption,
            )
        }
        Text("·", color = Mbp.Faint, fontSize = Mbp.type.caption)
        Text(label, color = if (touched.isEmpty()) Mbp.Muted else Mbp.Sc, fontFamily = Mbp.Mono, fontSize = Mbp.type.caption)
        Text("·", color = Mbp.Faint, fontSize = Mbp.type.caption)
        Text(
            if (model.muted || model.volume <= 0.001f) "M" else "${(model.volume * 100).roundToInt()}",
            color = Mbp.Text,
            fontFamily = Mbp.Mono,
            fontSize = Mbp.type.caption,
        )
    }
}

