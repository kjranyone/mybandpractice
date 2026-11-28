package com.donoy.mybandpractice.v2.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import kotlinx.coroutines.launch
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.donoy.mybandpractice.v2.BarCadence
import com.donoy.mybandpractice.v2.ChordAnalysis
import com.donoy.mybandpractice.v2.MAX_GAIN
import com.donoy.mybandpractice.v2.PITCH_PRESETS
import com.donoy.mybandpractice.v2.UNITY_POS
import com.donoy.mybandpractice.v2.PracticeModel
import com.donoy.mybandpractice.v2.RATE_PRESETS
import com.donoy.mybandpractice.v2.ROLE_DIATONIC
import com.donoy.mybandpractice.v2.ROLE_DOMINANT
import com.donoy.mybandpractice.v2.ROLE_NON
import com.donoy.mybandpractice.v2.ROLE_SEC
import com.donoy.mybandpractice.v2.ROLE_SUBV
import com.donoy.mybandpractice.v2.ROLE_TWO
import com.donoy.mybandpractice.v2.STEM_ORDER
import com.donoy.mybandpractice.v2.SongRecord
import com.donoy.mybandpractice.v2.analyzeBarChords
import com.donoy.mybandpractice.v2.chordAnalysisKey
import com.donoy.mybandpractice.v2.formatBytes
import com.donoy.mybandpractice.v2.formatDuration
import com.donoy.mybandpractice.v2.formatGain
import com.donoy.mybandpractice.v2.gainToPos
import com.donoy.mybandpractice.v2.posToGain
import com.donoy.mybandpractice.v2.toLeadSheetNotation
import com.donoy.mybandpractice.v2.transposeChord
import kotlin.math.roundToInt

@Composable
fun MixerPanel(model: PracticeModel, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val stems = model.current?.stems?.ifEmpty { null } ?: STEM_ORDER
    val allOn = stems.all { (model.stemGains[it] ?: 1f) >= 0.995f }
    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Mixer",
                color = Mbp.Text,
                fontWeight = FontWeight.SemiBold,
                fontSize = Mbp.type.title,
                modifier = Modifier.weight(1f),
            )
            Box(
                Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .clickable(role = Role.Button, onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Text("✕", color = Mbp.Muted, fontSize = Mbp.type.title)
            }
        }
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp),
        ) {
        // The hint keeps its slot while hidden, so the faders below never jump.
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            SectionTitle("Fader Console")
            Text(
                "Reset Stems",
                color = if (allOn) Color.Transparent else Mbp.Accent,
                fontSize = Mbp.type.bodySm,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .then(if (allOn) Modifier.clearAndSetSemantics { } else Modifier)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(enabled = !allOn) { model.resetStems() }
                    .padding(top = 8.dp, bottom = 8.dp, start = 12.dp),
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 4.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            stems.forEach { name ->
                Fader(name, (model.stemGains[name] ?: 1f).toDouble(), model.current == null) {
                    model.setStem(name, it)
                }
            }
            Fader(
                "master",
                if (model.muted) 0.0 else model.volume.toDouble(),
                false,
                emphasize = true,
                onMute = { model.toggleMute() },
            ) {
                model.setVolume(it)
            }
        }
        TuneHeader(
            title = "Pitch",
            value = "${if (model.pitch > 0) "+" else ""}${model.pitch} st",
            hot = model.pitch != 0,
            hotColor = Mbp.Accent,
        )
        TuneRow(PITCH_PRESETS.size) { index ->
            val p = PITCH_PRESETS[index]
            TuneKey(
                label = if (p > 0) "+$p" else "$p",
                selected = model.pitch == p,
                hot = model.pitch == p && p != 0,
                hotColor = Mbp.Accent,
            ) { model.updatePitch(p) }
        }
        SliderRow(-12f, 12f, model.pitch.toFloat()) { model.updatePitch(it.roundToInt()) }
        TuneHeader(
            title = "Speed",
            value = "%.2f×".format(model.rate),
            hot = kotlin.math.abs(model.rate - 1f) >= 0.005f,
            hotColor = Mbp.Sc,
        )
        TuneRow(RATE_PRESETS.size) { index ->
            val p = RATE_PRESETS[index]
            val on = kotlin.math.abs(model.rate - p.toFloat()) < 0.001f
            TuneKey(
                label = if (p == 1.0) "1×" else "${p}×",
                selected = on,
                hot = on && p != 1.0,
                hotColor = Mbp.Sc,
            ) { model.updateRate(p.toFloat()) }
        }
        SliderRow(0.5f, 1.5f, model.rate) { model.updateRate(it) }
        Box(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun Fader(
    label: String,
    gain: Double,
    disabled: Boolean,
    emphasize: Boolean = false,
    onMute: (() -> Unit)? = null,
    onChange: (Double) -> Unit,
) {
    val pos = gainToPos(gain).toFloat().coerceIn(0f, 1f)
    val muted = gain <= 0.005
    val valueColor = when {
        muted -> Mbp.Danger
        gain > 1.0 -> Mbp.Sc
        emphasize -> Mbp.Accent
        else -> Mbp.Text
    }
    Row(
        Modifier.fillMaxWidth().graphicsLayer { alpha = if (disabled) 0.4f else 1f },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val muteShape = RoundedCornerShape(12.dp)
        Box(
            Modifier
                .size(48.dp)
                .clip(muteShape)
                .background(if (muted) Mbp.Sc else Mbp.BgElevated)
                .border(1.dp, if (muted) Mbp.Sc else Mbp.BorderStrong, muteShape)
                .clickable(enabled = !disabled, role = Role.Button) {
                    if (onMute != null) onMute() else onChange(if (gain > 0.005) 0.0 else 1.0)
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "M",
                color = if (muted) Mbp.Ink else Mbp.Muted,
                fontFamily = Mbp.Mono,
                fontWeight = FontWeight.Bold,
                fontSize = Mbp.type.bodySm,
            )
        }
        Text(
            label,
            color = if (emphasize) Mbp.Accent else Mbp.Text,
            fontFamily = Mbp.Mono,
            fontWeight = FontWeight.SemiBold,
            fontSize = Mbp.type.bodySm,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier.padding(start = 10.dp).width(76.dp),
        )
        val shape = RoundedCornerShape(12.dp)
        val thumb = 36.dp
        BoxWithConstraints(
            Modifier
                .padding(horizontal = 8.dp)
                .weight(1f)
                .height(48.dp)
                .pointerInput(disabled) {
                    if (disabled) return@pointerInput
                    val slop = viewConfiguration.touchSlop
                    val thumbPx = thumb.toPx()
                    fun apply(x: Float) {
                        val travel = (size.width - thumbPx).coerceAtLeast(1f)
                        val ratio = ((x - thumbPx / 2f) / travel).coerceIn(0f, 1f)
                        onChange(posToGain(ratio.toDouble()).coerceAtMost(MAX_GAIN))
                    }
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var horizontal = false
                        while (true) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) {
                                if (!horizontal) apply(down.position.x)
                                break
                            }
                            val dx = change.position.x - down.position.x
                            val dy = change.position.y - down.position.y
                            if (!horizontal) {
                                if (kotlin.math.abs(dx) < slop && kotlin.math.abs(dy) < slop) continue
                                if (kotlin.math.abs(dx) < kotlin.math.abs(dy)) break
                                horizontal = true
                            }
                            apply(change.position.x)
                            change.consume()
                        }
                    }
                },
        ) {
            Box(
                Modifier
                    .matchParentSize()
                    .clip(shape)
                    .background(Mbp.Bg)
                    .border(1.dp, Mbp.BorderStrong, shape),
            ) {
                Box(
                    Modifier
                        .align(Alignment.CenterEnd)
                        .fillMaxHeight()
                        .fillMaxWidth((1.0 - UNITY_POS).toFloat())
                        .background(Mbp.Sc.copy(alpha = 0.14f)),
                )
                if (pos > 0.001f) {
                    Box(
                        Modifier
                            .align(Alignment.CenterStart)
                            .fillMaxHeight()
                            .fillMaxWidth(pos)
                            .background(if (gain > 1.0) Mbp.Sc else Mbp.Accent),
                    )
                }
            }
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .offset(x = maxWidth * UNITY_POS.toFloat())
                    .width(1.dp)
                    .fillMaxHeight()
                    .background(Color.White.copy(alpha = 0.35f)),
            )
            val thumbX = (maxWidth * pos - thumb / 2).coerceIn(0.dp, (maxWidth - thumb).coerceAtLeast(0.dp))
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .offset(x = thumbX)
                    .size(thumb)
                    .background(Mbp.Text, CircleShape),
            )
        }
        Text(
            formatGain(gain),
            color = valueColor,
            fontFamily = Mbp.Mono,
            fontWeight = FontWeight.Bold,
            fontSize = Mbp.type.bodySm,
            maxLines = 1,
            softWrap = false,
            textAlign = TextAlign.End,
            modifier = Modifier.width(72.dp),
        )
    }
}

@Composable
private fun TuneHeader(title: String, value: String, hot: Boolean, hotColor: Color) {
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(title, color = Mbp.Text, fontWeight = FontWeight.SemiBold, fontSize = Mbp.type.bodySm)
        Text(
            value,
            color = if (hot) hotColor else Mbp.Muted,
            fontFamily = Mbp.Mono,
            fontWeight = FontWeight.Bold,
            fontSize = Mbp.type.title,
        )
    }
}

@Composable
private fun TuneRow(count: Int, key: @Composable (Int) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 2.dp)) {
        val gap = 8.dp
        val minKey = 56.dp
        if (maxWidth >= minKey * count + gap * (count - 1)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                repeat(count) { index ->
                    Box(Modifier.weight(1f)) { key(index) }
                }
            }
        } else {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(gap),
            ) {
                repeat(count) { index ->
                    Box(Modifier.width(64.dp)) { key(index) }
                }
            }
        }
    }
}

@Composable
private fun TuneKey(
    label: String,
    selected: Boolean,
    hot: Boolean,
    hotColor: Color,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    val fill = when {
        hot -> hotColor
        selected -> Mbp.BgHover
        else -> Mbp.BgElevated
    }
    val border = when {
        hot || selected -> hotColor
        else -> Mbp.BorderStrong
    }
    val ink = if (hot) Mbp.Ink else if (selected) Mbp.Text else Mbp.Muted
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(shape)
            .background(fill)
            .border(1.dp, border, shape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = ink,
            fontFamily = Mbp.Mono,
            fontWeight = FontWeight.Bold,
            fontSize = Mbp.type.caption,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun SliderRow(min: Float, max: Float, value: Float, onChange: (Float) -> Unit) {
    val colors = androidx.compose.material3.SliderDefaults.colors(
        thumbColor = Mbp.Sc,
        activeTrackColor = Mbp.Sc,
        inactiveTrackColor = Mbp.BorderStrong,
    )
    androidx.compose.material3.Slider(
        value = value.coerceIn(min, max),
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        valueRange = min..max,
        colors = colors,
        thumb = {
            Box(Modifier.size(32.dp).background(Mbp.Sc, CircleShape))
        },
    )
}

@Composable
fun ChordSheetDialog(model: PracticeModel, onClose: () -> Unit) {
    val data = model.chords
    val song = model.current
    AppDialog(song?.title ?: "Chord Sheet", song?.artist, onClose) {
        if (data == null || data.bars.isEmpty()) {
            Text("No chords data", color = Mbp.Muted, fontSize = Mbp.type.caption)
            return@AppDialog
        }
        val displayKey = data.key?.let { transposeChord(it, model.pitch) }
        val analysis = androidx.compose.runtime.remember(data, model.pitch, displayKey) {
            analyzeBarChords(data.bars, displayKey, model.pitch)
        }
        // Both follow the playhead without recomposing for each tick of it: only when the
        // highlighted bar, or the chord in it, changes.
        val active by followAsState {
            data.bars.firstOrNull { model.position >= it.start && model.position < it.end }
        }
        val currentStart by followAsState {
            active?.chords?.firstOrNull { model.position >= it.start && model.position < it.end }?.start
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 8.dp)) {
            if (displayKey != null) Chip("Key $displayKey", true) {}
            if (data.bpm != null) Chip("BPM ${data.bpm.roundToInt()}", false) {}
            Chip("4/4 (${data.bars.size}小節)", false) {}
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
            val systems = data.bars.chunked(4)
            items(systems.size) { index ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    systems[index].forEach { bar ->
                        val on = bar.number == active?.number
                        val cadence = analysis.cadences[bar.number]
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (on) Mbp.AccentDim else Mbp.BgElevated)
                                .border(1.dp, cadenceBorder(cadence, on), RoundedCornerShape(8.dp))
                                .padding(6.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("${bar.number}", color = Mbp.Faint, fontFamily = Mbp.Mono, fontSize = Mbp.type.micro)
                                if (cadence != null) {
                                    Text(
                                        cadence.badgeText,
                                        color = cadenceColor(cadence.className),
                                        fontSize = Mbp.type.nano,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.padding(start = 4.dp),
                                    )
                                }
                            }
                            bar.chords.forEach { chord ->
                                val symbol = transposeChord(chord.chord, model.pitch)
                                val info = analysis.chords[chordAnalysisKey(bar.number, chord.start)]
                                val nc = symbol == "N.C." || symbol == "--" || symbol == "X"
                                val paint = chordPaint(info, nc, chord.isDominant)
                                val current = chord.start == currentStart
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(top = 4.dp)
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (current) paint.fill.copy(alpha = 0.45f) else paint.fill)
                                        .border(1.dp, paint.border, RoundedCornerShape(6.dp))
                                        .clickable { model.seek(chord.start) }
                                        .padding(horizontal = 4.dp, vertical = 3.dp),
                                ) {
                                    Text(
                                        toLeadSheetNotation(symbol),
                                        color = if (nc) Mbp.Faint else paint.root,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = Mbp.type.callout,
                                        maxLines = 1,
                                    )
                                    if (!nc && info != null && info.roman != "N.C.") {
                                        Text(info.roman, color = paint.roman, fontFamily = Mbp.Mono, fontSize = Mbp.type.nano)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private data class ChordPaint(val root: Color, val fill: Color, val border: Color, val roman: Color)

private fun chordPaint(info: ChordAnalysis?, nc: Boolean, flaggedDominant: Boolean): ChordPaint {
    if (nc || info == null) {
        return ChordPaint(Mbp.Faint, Color.Transparent, Color.Transparent, Mbp.Faint)
    }
    val role = when {
        info.harmonicRole == ROLE_SEC -> ROLE_SEC
        info.harmonicRole == ROLE_SUBV -> ROLE_SUBV
        info.harmonicRole == ROLE_TWO -> ROLE_TWO
        info.harmonicRole == ROLE_DOMINANT || info.isDominant || flaggedDominant -> ROLE_DOMINANT
        info.harmonicRole == ROLE_NON || !info.isDiatonic -> ROLE_NON
        else -> ROLE_DIATONIC
    }
    return when (role) {
        ROLE_SEC -> ChordPaint(Color(0xFFF0ABFC), Color(0x14D946EF), Color(0x73D946EF), Color(0xFFE879F9))
        ROLE_SUBV -> ChordPaint(Color(0xFF5EEAD4), Color(0x142DD4BF), Color(0x732DD4BF), Color(0xFF2DD4BF))
        ROLE_TWO -> ChordPaint(Color(0xFFC084FC), Color(0x10C084FC), Color(0x59C084FC), Color(0xFFC084FC))
        ROLE_DOMINANT -> ChordPaint(Color(0xFFFDE047), Color(0x14F59E0B), Color(0x73F59E0B), Color(0xFFFDE047))
        ROLE_NON -> ChordPaint(Color(0xFFFB7185), Color(0x12FB7185), Color(0x66FB7185), Color(0xFFFB7185))
        else -> ChordPaint(Color(0xFF93C5FD), Color(0x0D93C5FD), Color(0x3893C5FD), Color(0xFF93C5FD))
    }
}

private fun cadenceBorder(cadence: BarCadence?, current: Boolean): Color = when {
    current -> Mbp.Sc
    cadence == null -> Mbp.Border
    cadence.className == "cadence-251" || cadence.className == "cadence-51" || cadence.className == "cadence-cycle" ->
        Color(0x66F59E0B)
    cadence.className.startsWith("cadence-sec") -> Color(0x59D946EF)
    cadence.className == "cadence-sub-v" -> Color(0x592DD4BF)
    else -> Mbp.Border
}

private fun cadenceColor(className: String): Color = when (className) {
    "cadence-sec-51" -> Color(0xFFE879F9)
    "cadence-sec-251" -> Color(0xFFF472B6)
    "cadence-sub-v" -> Color(0xFF2DD4BF)
    "cadence-cycle" -> Color(0xFFFDBA74)
    else -> Color(0xFFFBBF24)
}

@Composable
fun ManageDialog(
    model: PracticeModel,
    onClose: () -> Unit,
    onSync: () -> Unit,
    onImport: () -> Unit,
) {
    var tab by remember { mutableStateOf("songs") }
    var pendingDelete by remember { mutableStateOf<SongRecord?>(null) }
    var newName by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf<String?>(null) }
    AppDialog("Manage Songs", "library & setlists", onClose) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip("Songs", tab == "songs") { tab = "songs" }
                Chip("Setlists", tab == "setlists") { tab = "setlists" }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip("↻", false) { model.reloadLibrary() }
                Chip("＋", false) { onImport() }
                Chip("⇅ Sync", false) { onSync() }
            }
        }
        if (tab == "songs") {
            val total = model.sizes.values.sum()
            Text(
                "${model.songs.size} songs · ${formatBytes(total)} used",
                color = Mbp.Muted,
                fontSize = Mbp.type.caption,
                modifier = Modifier.padding(vertical = 8.dp),
            )
            LazyColumn(modifier = Modifier.weight(1f)) {
                items(model.songs, key = { it.slug }) { song ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(song.title, color = Mbp.Text, fontSize = Mbp.type.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOfNotNull(
                                    song.artist.ifBlank { null },
                                    song.stems.size.takeIf { it > 0 }?.let { "$it stems" },
                                    if (song.hasLyrics) "lyrics" else null,
                                    formatDuration(song.durationSeconds),
                                ).joinToString(" · "),
                                color = Mbp.Muted,
                                fontSize = Mbp.type.caption,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(formatBytes(model.sizes[song.slug] ?: 0L), color = Mbp.Faint, fontFamily = Mbp.Mono, fontSize = Mbp.type.label)
                        Text(
                            "✕",
                            color = Mbp.Danger,
                            modifier = Modifier
                                .clickable { pendingDelete = song }
                                .padding(start = 10.dp),
                        )
                    }
                }
                if (model.songs.isEmpty()) {
                    item { Text("No songs", color = Mbp.Muted, fontSize = Mbp.type.caption, modifier = Modifier.padding(16.dp)) }
                }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
                TextField(
                    value = newName,
                    onValueChange = { newName = it },
                    placeholder = { Text("New setlist name…", color = Mbp.Faint, fontSize = Mbp.type.body) },
                    singleLine = true,
                    textStyle = TextStyle(color = Mbp.Text, fontSize = Mbp.type.body),
                    modifier = Modifier.weight(1f),
                    colors = fieldColors(),
                )
                Text(
                    "＋",
                    color = Mbp.Accent,
                    fontSize = Mbp.type.titleLg,
                    modifier = Modifier
                        .clickable(enabled = newName.isNotBlank()) {
                            model.createSetlist(newName)
                            newName = ""
                        }
                        .padding(10.dp),
                )
            }
            LazyColumn(modifier = Modifier.weight(1f)) {
                items(model.setlists, key = { it.id }) { setlist ->
                    val open = expanded == setlist.id
                    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                setlist.name,
                                color = if (model.modeId == setlist.id) Mbp.Sc else Mbp.Text,
                                fontSize = Mbp.type.body,
                                modifier = Modifier
                                    .weight(1f)
                                    .clickable { expanded = if (open) null else setlist.id },
                            )
                            Text("${setlist.songs.size}", color = Mbp.Faint, fontFamily = Mbp.Mono, fontSize = Mbp.type.label)
                            Text("✕", color = Mbp.Faint, modifier = Modifier.clickable { model.removeSetlist(setlist.id) }.padding(start = 8.dp))
                        }
                        if (open) {
                            setlist.songs.forEachIndexed { index, slug ->
                                val song = model.songs.find { it.slug == slug }
                                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 8.dp, top = 4.dp)) {
                                    Text(song?.title ?: slug, color = Mbp.Muted, fontSize = Mbp.type.caption, modifier = Modifier.weight(1f), maxLines = 1)
                                    Text("↑", color = Mbp.Faint, modifier = Modifier.clickable {
                                        if (index > 0) {
                                            val next = setlist.songs.toMutableList()
                                            val tmp = next[index - 1]
                                            next[index - 1] = next[index]
                                            next[index] = tmp
                                            model.updateSetlist(setlist.copy(songs = next))
                                        }
                                    }.padding(4.dp))
                                    Text("↓", color = Mbp.Faint, modifier = Modifier.clickable {
                                        if (index < setlist.songs.lastIndex) {
                                            val next = setlist.songs.toMutableList()
                                            val tmp = next[index + 1]
                                            next[index + 1] = next[index]
                                            next[index] = tmp
                                            model.updateSetlist(setlist.copy(songs = next))
                                        }
                                    }.padding(4.dp))
                                    Text("✕", color = Mbp.Faint, modifier = Modifier.clickable {
                                        model.updateSetlist(setlist.copy(songs = setlist.songs.filter { it != slug }))
                                    }.padding(4.dp))
                                }
                            }
                            val addable = model.songs.filter { it.slug !in setlist.songs }
                            addable.take(8).forEach { song ->
                                Text(
                                    "＋ ${song.title}",
                                    color = Mbp.Accent,
                                    fontSize = Mbp.type.caption,
                                    modifier = Modifier
                                        .clickable { model.updateSetlist(setlist.copy(songs = setlist.songs + song.slug)) }
                                        .padding(start = 8.dp, top = 2.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    pendingDelete?.let { song ->
        AppDialog("Delete \"${song.title}\"?", onClose = { pendingDelete = null }) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Chip("Cancel", false) { pendingDelete = null }
                Chip("Delete", true) {
                    model.deleteSong(song)
                    pendingDelete = null
                }
            }
        }
    }
}

@Composable
internal fun AppDialog(
    title: String,
    sub: String? = null,
    onClose: () -> Unit,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    val progress = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var closing by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        progress.animateTo(1f, tween(220, easing = MbpEaseOut))
    }
    val dismiss = {
        if (!closing) {
            closing = true
            scope.launch {
                progress.animateTo(0f, tween(180, easing = MbpEaseOut))
                onClose()
            }
        }
    }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            modifier = Modifier
                .padding(16.dp)
                .graphicsLayer {
                    val amount = progress.value
                    alpha = amount
                    val scale = 0.96f + 0.04f * amount
                    scaleX = scale
                    scaleY = scale
                    translationY = (1f - amount) * 16.dp.toPx()
                    shadowElevation = 24.dp.toPx() * amount
                    shape = RoundedCornerShape(10.dp)
                    clip = false
                }
                .fillMaxWidth(0.96f)
                .fillMaxHeight(0.9f)
                .clip(RoundedCornerShape(10.dp))
                .background(Mbp.Card)
                .border(1.dp, Mbp.BorderStrong, RoundedCornerShape(10.dp))
                .padding(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, color = Mbp.Text, fontWeight = FontWeight.SemiBold, fontSize = Mbp.type.title, modifier = Modifier.weight(1f))
                if (sub != null) Text(sub, color = Mbp.Muted, fontSize = Mbp.type.caption, modifier = Modifier.padding(end = 8.dp))
                Text("✕", color = Mbp.Muted, fontSize = Mbp.type.title, modifier = Modifier.clickable(onClick = dismiss).padding(6.dp))
            }
            Column(Modifier.weight(1f).fillMaxWidth().padding(top = 8.dp)) { content() }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, color = Mbp.Text, fontWeight = FontWeight.SemiBold, fontSize = Mbp.type.bodySm, modifier = Modifier.padding(top = 4.dp))
}

@Composable
internal fun Chip(label: String, active: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) Mbp.Ink else Mbp.Muted,
        fontSize = Mbp.type.caption,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (active) Mbp.Sc else Mbp.BgElevated)
            .border(1.dp, if (active) Mbp.Sc else Mbp.Border, RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

@Composable
private fun fieldColors() = TextFieldDefaults.colors(
    focusedContainerColor = Mbp.BgElevated,
    unfocusedContainerColor = Mbp.BgElevated,
    focusedIndicatorColor = Mbp.AccentStrong,
    unfocusedIndicatorColor = Mbp.Border,
    cursorColor = Mbp.Accent,
    focusedTextColor = Mbp.Text,
    unfocusedTextColor = Mbp.Text,
)

