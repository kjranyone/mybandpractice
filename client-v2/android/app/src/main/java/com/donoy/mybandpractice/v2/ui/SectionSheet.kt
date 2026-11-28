package com.donoy.mybandpractice.v2.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.donoy.mybandpractice.v2.MARKER_PRESETS
import com.donoy.mybandpractice.v2.Marker
import com.donoy.mybandpractice.v2.PracticeModel
import com.donoy.mybandpractice.v2.StanzaTag
import com.donoy.mybandpractice.v2.formatTimePrecise
import com.donoy.mybandpractice.v2.markerNear

/**
 * The panel of a stanza that has no mark yet. Nothing happens before one of its keys is
 * tapped: a mark where the song is now, a mark near the playhead or elsewhere in the song
 * tied to the stanza instead, and for a tag of the old kind on it a time of its own or its
 * end. Opens from the key in the gutter of the stanza.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StanzaSheet(model: PracticeModel, stanzaIndex: Int, onClose: () -> Unit) {
    // What was near the playhead when the panel opened is what is offered.
    val near = remember { markerNear(model.markers, model.position.toDouble())?.takeIf { it.stanzaIndex != stanzaIndex } }
    val others = remember { model.markers.filter { it.stanzaIndex != stanzaIndex && it.id != near?.id } }
    val tags = remember { model.stanzaTags.filter { it.stanzaIndex == stanzaIndex } }
    Sheet(onClose) {
        SectionTitle("このスタンザのマーク")
        Key("今の位置にマークを追加", strong = true, modifier = Modifier.fillMaxWidth(), trailing = { Playhead(model, Mbp.Ink) }) {
            model.markStanza(stanzaIndex)
            onClose()
        }
        if (near != null) {
            Key("近くのマーク「${near.label} ${formatTimePrecise(near.time)}」を紐付ける", modifier = Modifier.fillMaxWidth()) {
                model.linkMarkToStanza(near.id, stanzaIndex)
                onClose()
            }
        }
        if (others.isNotEmpty()) {
            SectionTitle("ほかのマークを紐付ける")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                others.forEach { mark ->
                    Chip("${mark.label} ${formatTimePrecise(mark.time)}", active = false) {
                        model.linkMarkToStanza(mark.id, stanzaIndex)
                        onClose()
                    }
                }
            }
        }
        if (tags.isNotEmpty()) {
            SectionTitle("このスタンザのタグ")
            tags.forEach { tag ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TagLabel(tag.label)
                    Key("時刻を付ける", modifier = Modifier.weight(1f)) {
                        model.anchorStanzaTag(tag.id)
                        onClose()
                    }
                    Key("削除", danger = true) {
                        model.removeStanzaTag(tag.id)
                        onClose()
                    }
                }
            }
        }
    }
}

/**
 * One mark, or one tag of the old kind, over the rest of the screen: its name, its place in
 * the song, the loop of its section, and its end. Opens from the key in the gutter of a
 * stanza that has a mark, and from a chip that is held down, in the lyrics or on the
 * waveform.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SectionSheet(model: PracticeModel, markerId: String?, tagId: String?, onClose: () -> Unit) {
    // It may be gone by the time this is drawn, or while it is open.
    val mark = model.markers.firstOrNull { it.id == markerId }
    val tag = model.stanzaTags.firstOrNull { it.id == tagId }
    if (mark == null && tag == null) {
        LaunchedEffect(Unit) { onClose() }
        return
    }
    Sheet(onClose) {
        when {
            mark != null -> MarkEditor(model, mark, onClose)
            tag != null -> TagEditor(model, tag, onClose)
        }
    }
}

/** The bottom sheet they all come in: opened in full at once, as half of it would cut off the keys. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Sheet(onClose: () -> Unit, content: @Composable () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Mbp.BgElevated,
        scrimColor = Color(0xC4000000),
    ) {
        // The sheet grows with what it holds, and scrolls what does not fit.
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            content()
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MarkEditor(model: PracticeModel, mark: Marker, onClose: () -> Unit) {
    // Read again each time, so that a new name or a new place shows at once.
    val live = model.markers.firstOrNull { it.id == mark.id } ?: return
    var name by remember(live.id) { mutableStateOf("") }
    val end = model.duration.toDouble()

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(live.label, color = Mbp.Text, fontWeight = FontWeight.Bold, fontSize = Mbp.type.titleLg, modifier = Modifier.weight(1f))
        Text(formatTimePrecise(live.time), color = Mbp.Accent, fontFamily = Mbp.Mono, fontSize = Mbp.type.callout)
    }
    SectionTitle("名前")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        MARKER_PRESETS.forEach { preset ->
            Chip(preset, active = preset == live.label) { model.updateMarker(live.id, label = preset) }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            placeholder = { Text("ほかの名前", color = Mbp.Faint) },
            singleLine = true,
            textStyle = TextStyle(color = Mbp.Text, fontSize = Mbp.type.body),
            colors = fieldColors(),
            modifier = Modifier.weight(1f),
        )
        Key("決定", enabled = name.isNotBlank()) {
            model.updateMarker(live.id, label = name.trim())
            name = ""
        }
    }
    SectionTitle("位置")
    Key("今の再生位置をこのマークに指定", modifier = Modifier.fillMaxWidth(), trailing = { Playhead(model, Mbp.Accent) }) {
        model.updateMarker(live.id, time = model.position.toDouble())
    }
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Key("−1 s") { model.updateMarker(live.id, time = (live.time - 1.0).coerceIn(0.0, end)) }
        Key("−0.1") { model.updateMarker(live.id, time = (live.time - 0.1).coerceIn(0.0, end)) }
        Text(
            formatTimePrecise(live.time),
            color = Mbp.Accent,
            fontFamily = Mbp.Mono,
            fontSize = Mbp.type.body,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 12.dp),
        )
        Key("+0.1") { model.updateMarker(live.id, time = (live.time + 0.1).coerceIn(0.0, end)) }
        Key("+1 s") { model.updateMarker(live.id, time = (live.time + 1.0).coerceIn(0.0, end)) }
    }
    SectionTitle("区間")
    Key("この区間をループ", strong = true, modifier = Modifier.fillMaxWidth()) {
        model.loopFromMarker(live.id)
        onClose()
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Key("ここへ移動", modifier = Modifier.weight(1f)) { model.seek(live.time) }
        if (live.stanzaIndex != null) {
            Key("スタンザから外す", modifier = Modifier.weight(1f)) { model.updateMarker(live.id, clearStanza = true) }
        }
    }
    Key("このマークを削除", danger = true, modifier = Modifier.fillMaxWidth()) {
        model.removeMarker(live.id)
        onClose()
    }
}

@Composable
private fun TagEditor(model: PracticeModel, tag: StanzaTag, onClose: () -> Unit) {
    val live = model.stanzaTags.firstOrNull { it.id == tag.id } ?: return
    val tied = model.markers.firstOrNull { it.label == live.label }
    Text(live.label, color = Mbp.Text, fontWeight = FontWeight.Bold, fontSize = Mbp.type.titleLg)
    Text(
        if (tied != null) {
            "スタンザのタグ。同じ名前のマーク（${formatTimePrecise(tied.time)}）へ移動します。"
        } else {
            "スタンザのタグ。時刻を持たないので、どこへも移動できません。"
        },
        color = Mbp.Muted,
        fontSize = Mbp.type.caption,
    )
    Key("このタグに時刻を付ける", strong = true, modifier = Modifier.fillMaxWidth()) {
        model.anchorStanzaTag(live.id)
        onClose()
    }
    Text(
        "今の位置の近くのマーク、なければ同じ名前のマークを、このスタンザに紐付けます。どちらもなければ今の位置にマークを作ります。",
        color = Mbp.Faint,
        fontSize = Mbp.type.caption,
    )
    Key("このタグを削除", danger = true, modifier = Modifier.fillMaxWidth()) {
        model.removeStanzaTag(live.id)
        onClose()
    }
}

/** Where the song is now, as the sheet is open. Only this text follows the playhead. */
@Composable
private fun Playhead(model: PracticeModel, color: Color) {
    Text(formatTimePrecise(model.position.toDouble()), color = color, fontFamily = Mbp.Mono, fontSize = Mbp.type.body, fontWeight = FontWeight.SemiBold)
}

/** A key of the sheet: the colour says what it does, orange for the one that is the point. */
@Composable
private fun Key(
    label: String,
    modifier: Modifier = Modifier,
    strong: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier
            .clip(shape)
            .background(if (strong) Mbp.Sc else Mbp.Bg)
            .then(
                if (strong) {
                    Modifier
                } else {
                    Modifier.border(1.dp, if (danger) Mbp.Danger.copy(alpha = 0.55f) else Mbp.BorderStrong, shape)
                },
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            color = when {
                !enabled -> Mbp.Faint
                danger -> Mbp.Danger
                strong -> Mbp.Ink
                else -> Mbp.Text
            },
            fontSize = Mbp.type.body,
            fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal,
            textAlign = TextAlign.Center,
        )
        trailing?.invoke()
    }
}

/** The name of a tag of the old kind, as it stands on its stanza. */
@Composable
private fun TagLabel(label: String) {
    Text(
        label,
        color = Mbp.Muted,
        fontFamily = Mbp.Mono,
        fontSize = Mbp.type.caption,
        modifier = Modifier
            .heightIn(min = 32.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(Mbp.Bg)
            .border(1.dp, Mbp.BorderStrong, RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp)
            .wrapContentHeight(Alignment.CenterVertically),
    )
}
