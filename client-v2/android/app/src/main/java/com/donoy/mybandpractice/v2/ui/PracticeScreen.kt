package com.donoy.mybandpractice.v2.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.PressInteraction
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
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableFloatState
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import android.os.SystemClock
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.ViewModelProvider
import com.donoy.mybandpractice.v2.LyricsBlock
import com.donoy.mybandpractice.v2.Marker
import com.donoy.mybandpractice.v2.PracticeModel
import com.donoy.mybandpractice.v2.R
import com.donoy.mybandpractice.v2.StanzaTag
import com.donoy.mybandpractice.v2.formatDuration
import com.donoy.mybandpractice.v2.formatTimePrecise

@Composable
fun PracticeScreen(model: PracticeModel = viewModel(factory = ViewModelProvider.AndroidViewModelFactory.getInstance(
    androidx.compose.ui.platform.LocalContext.current.applicationContext as android.app.Application,
))) {
    val widthDp = LocalConfiguration.current.screenWidthDp
    val drawer = widthDp <= Mbp.DrawerBreakpoint
    val compactPlayer = widthDp <= Mbp.CompactPlayer
    val listOpenState = remember { mutableStateOf(widthDp <= 900) }
    var listOpen by listOpenState
    var menuOpen by remember { mutableStateOf(false) }
    val mixerOpenState = remember { mutableStateOf(false) }
    var mixerOpen by mixerOpenState
    var chordsOpen by remember { mutableStateOf(false) }
    var manageOpen by remember { mutableStateOf(false) }
    var syncOpen by remember { mutableStateOf(false) }
    // The mark, or the tag of the old kind, that is open in the sheet.
    var editingMark by remember { mutableStateOf<String?>(null) }
    var editingTag by remember { mutableStateOf<String?>(null) }
    val density = LocalDensity.current
    val drawerProgress = remember { mutableFloatStateOf(if (listOpenState.value) 1f else 0f) }
    val drawerAnim = remember { mutableStateOf<Job?>(null) }
    val drawerGen = remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val gestureBlocked = rememberUpdatedState(chordsOpen || manageOpen || syncOpen || editingMark != null || editingTag != null)
    val rootOriginState = remember { mutableStateOf(Offset.Zero) }
    var rootOrigin by rootOriginState
    val toggleRectState = remember { mutableStateOf(Rect.Zero) }
    var toggleRect by toggleRectState
    val searchRectState = remember { mutableStateOf(Rect.Zero) }
    var searchRect by searchRectState
    val deckTopState = remember { mutableFloatStateOf(Float.POSITIVE_INFINITY) }
    var deckTop by deckTopState
    val drawerWidthState = remember { mutableFloatStateOf(with(density) { 340.dp.toPx() }) }
    var drawerWidthPx by drawerWidthState
    // The song list is on screen all the time, or in the drawer while the drawer is out.
    val listShown by remember(drawer) { derivedStateOf { !drawer || drawerProgress.floatValue > 0.01f } }
    val mixerPanelDp = (widthDp - 72).coerceIn(300, 520).dp
    val mixerProgress = remember { mutableFloatStateOf(0f) }
    val mixerAnim = remember { mutableStateOf<Job?>(null) }
    val mixerGen = remember { mutableIntStateOf(0) }
    val mixerWidthState = remember { mutableFloatStateOf(with(density) { mixerPanelDp.toPx() }) }
    val mixerRectState = remember { mutableStateOf(Rect.Zero) }
    LaunchedEffect(mixerOpen) {
        animateDrawer(mixerProgress, scope, mixerAnim, mixerGen, if (mixerOpen) 1f else 0f)
    }
    LaunchedEffect(listOpen) {
        if (!listOpen) menuOpen = false
        animateDrawer(drawerProgress, scope, drawerAnim, drawerGen, if (listOpen) 1f else 0f)
    }
    val context = androidx.compose.ui.platform.LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        runCatching {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        model.importTree(uri)
    }

    CompositionLocalProvider(LocalTextStyle provides TextStyle(fontSize = Mbp.type.body)) {
    Box(
        Modifier
            .fillMaxSize()
            .onGloballyPositioned { rootOrigin = it.positionInRoot() }
            .drawBehind {
                drawRect(Mbp.Bg)
                drawCircle(Color(0x145EEAD4), radius = size.minDimension * 0.55f, center = Offset(size.width * 0.1f, 0f))
                drawCircle(Color(0x126366F1), radius = size.minDimension * 0.4f, center = Offset(size.width * 0.9f, 0f))
            }
            .pointerInput(drawer) {
                watchDrawer(
                    listOpenState,
                    drawerProgress,
                    scope,
                    drawerAnim,
                    drawerGen,
                    gestureBlocked,
                    drawerWidthState,
                    rootOriginState,
                    toggleRectState,
                    searchRectState,
                    deckTopState,
                    mixerOpenState,
                    mixerProgress,
                    mixerAnim,
                    mixerGen,
                    mixerWidthState,
                    mixerRectState,
                    listSwipe = drawer,
                )
            },
    ) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (!drawer) {
                    Row(Modifier.fillMaxSize()) {
                        SongList(
                            model,
                            menuOpen,
                            onMenu = { menuOpen = it },
                            onManage = { manageOpen = true },
                            onSearchBounds = { searchRect = it },
                            modifier = Modifier.width(Mbp.Sidebar).fillMaxHeight(),
                        )
                        Lyrics(
                            model,
                            onEditMark = { editingMark = it },
                            onEditTag = { editingTag = it },
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                            topPad = 32.dp,
                        )
                    }
                } else {
                    Lyrics(
                        model,
                        onEditMark = { editingMark = it },
                        onEditTag = { editingTag = it },
                        modifier = Modifier.fillMaxSize(),
                        topPad = 72.dp,
                    )
                }
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer { alpha = mixerProgress.floatValue }
                        .background(Color(0xD1000000))
                        .then(
                            if (mixerOpen) {
                                Modifier.pointerInput(Unit) { detectTapGestures(onTap = { mixerOpen = false }) }
                            } else {
                                Modifier
                            },
                        ),
                )
                Box(
                    Modifier
                        .align(Alignment.CenterEnd)
                        .offset {
                            IntOffset((mixerWidthState.floatValue * (1f - mixerProgress.floatValue)).roundToInt(), 0)
                        }
                        .onGloballyPositioned { coords ->
                            val w = coords.size.width.toFloat()
                            if (w > 0f && w != mixerWidthState.floatValue) mixerWidthState.floatValue = w
                            val p = coords.positionInRoot()
                            mixerRectState.value = Rect(p.x, p.y, p.x + coords.size.width, p.y + coords.size.height)
                        }
                        .width(mixerPanelDp)
                        .fillMaxHeight()
                        .graphicsLayer {
                            shadowElevation = 24.dp.toPx() * mixerProgress.floatValue
                            shape = RectangleShape
                            clip = false
                            ambientShadowColor = Color.Black.copy(alpha = 0.55f)
                            spotShadowColor = Color.Black.copy(alpha = 0.7f)
                        }
                        .background(Color(0xF70C0F14))
                        .border(1.dp, Mbp.Border)
                        .pointerInput(Unit) { holdWithoutConsuming() },
                ) {
                    MixerPanel(
                        model,
                        onClose = { mixerOpen = false },
                        modifier = Modifier.fillMaxSize().padding(top = 8.dp),
                    )
                }
            }
            Box(Modifier.fillMaxWidth().onGloballyPositioned { deckTop = it.positionInRoot().y }) {
                PlayerDeck(
                    model = model,
                    chordSheetOpen = chordsOpen,
                    onToggleChordSheet = { chordsOpen = !chordsOpen },
                    onOpenMixer = {
                        val opening = !mixerOpen
                        mixerOpen = opening
                        if (opening) listOpen = false
                    },
                    mixerOpen = mixerOpen,
                    compact = compactPlayer,
                    onEditMarker = { editingMark = it },
                )
            }
        }
        if (drawer) {
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer { alpha = drawerProgress.floatValue }
                    .background(Color(0xD1000000))
                    .then(
                        if (listOpen) {
                            Modifier.pointerInput(Unit) { detectTapGestures(onTap = { listOpen = false }) }
                        } else {
                            Modifier
                        },
                    ),
            )
            Box(
                Modifier
                    .offset {
                        IntOffset((-drawerWidthPx * (1f - drawerProgress.floatValue)).roundToInt(), 0)
                    }
                    .onGloballyPositioned { coords ->
                        val w = coords.size.width.toFloat()
                        if (w > 0f && w != drawerWidthState.floatValue) drawerWidthState.floatValue = w
                    }
                    .width(340.dp)
                    .fillMaxHeight()
                    .graphicsLayer {
                        shadowElevation = 24.dp.toPx() * drawerProgress.floatValue
                        shape = RectangleShape
                        clip = false
                        ambientShadowColor = Color.Black.copy(alpha = 0.55f)
                        spotShadowColor = Color.Black.copy(alpha = 0.7f)
                    }
                    .background(Color(0xF70C0F14))
                    .border(1.dp, Mbp.Border)
                    .pointerInput(Unit) { holdWithoutConsuming() },
            ) {
                SongList(
                    model,
                    menuOpen,
                    onMenu = { menuOpen = it },
                    onManage = {
                        manageOpen = true
                        listOpen = false
                    },
                    onPicked = { listOpen = false },
                    onSearchBounds = { searchRect = it },
                    panel = false,
                    live = listShown,
                    modifier = Modifier
                        .fillMaxSize()
                        .safeDrawingPadding()
                        .padding(top = 64.dp),
                )
            }
            Box(
                modifier = Modifier
                    .safeDrawingPadding()
                    .padding(12.dp)
                    .size(44.dp)
                    .onGloballyPositioned { coords ->
                        val p = coords.positionInRoot()
                        toggleRect = Rect(p.x, p.y, p.x + coords.size.width, p.y + coords.size.height)
                    }
                    .graphicsLayer {
                        shadowElevation = 8.dp.toPx()
                        shape = RoundedCornerShape(12.dp)
                        clip = false
                    }
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0xEB0A0C10))
                    .drawBehind {
                        val stroke = 1.dp.toPx()
                        val amount = drawerProgress.floatValue.coerceIn(0f, 1f)
                        drawRoundRect(
                            color = lerp(Mbp.BorderStrong, Mbp.Accent.copy(alpha = 0.4f), amount),
                            topLeft = Offset(stroke / 2f, stroke / 2f),
                            size = Size(size.width - stroke, size.height - stroke),
                            cornerRadius = CornerRadius(12.dp.toPx()),
                            style = Stroke(stroke),
                        )
                    }
                    .clickable {
                        val opening = !listOpen
                        listOpen = opening
                        if (opening) mixerOpen = false
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "☰",
                    color = Mbp.Text,
                    fontSize = Mbp.type.headline,
                    modifier = Modifier.graphicsLayer { alpha = 1f - drawerProgress.floatValue },
                )
                Text(
                    "✕",
                    color = Mbp.Sc,
                    fontSize = Mbp.type.headline,
                    modifier = Modifier.graphicsLayer { alpha = drawerProgress.floatValue },
                )
            }
        }
        val status = model.status
        var toastText by remember { mutableStateOf<String?>(null) }
        if (status != null) toastText = status
        AnimatedVisibility(
            visible = status != null,
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 12.dp),
            enter = fadeIn(tween(150, easing = MbpEaseOut)) +
                slideInVertically(tween(180, easing = MbpEaseOut)) { -it / 2 },
            exit = fadeOut(tween(150)) +
                slideOutVertically(tween(140)) { -it / 3 },
        ) {
            Text(
                toastText.orEmpty(),
                color = Color(0xFFFECACA),
                fontFamily = Mbp.Mono,
                fontSize = Mbp.type.caption,
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color(0xEB7F1D1D))
                    .border(1.dp, Color(0x80F87171), RoundedCornerShape(10.dp))
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }

    if (chordsOpen) ChordSheetDialog(model) { chordsOpen = false }
    if (manageOpen) {
        ManageDialog(
            model,
            onClose = { manageOpen = false },
            onSync = {
                manageOpen = false
                syncOpen = true
            },
            onImport = { picker.launch(null) },
        )
    }
    if (syncOpen) {
        SyncDialog(
            model = model,
            onClose = { syncOpen = false },
            onImport = { picker.launch(null) },
        )
    }
    if (editingMark != null || editingTag != null) {
        SectionSheet(model, editingMark, editingTag) {
            editingMark = null
            editingTag = null
        }
    }
    }
}

@Composable
private fun SongList(
    model: PracticeModel,
    menuOpen: Boolean,
    onMenu: (Boolean) -> Unit,
    onManage: () -> Unit,
    onPicked: () -> Unit = {},
    onSearchBounds: (Rect) -> Unit = {},
    panel: Boolean = true,
    // Whether the list can be seen. Hidden in the closed drawer, the "now playing" marks
    // would still follow the playhead.
    live: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val songs = model.filtered
    val listState = rememberLazyListState()
    val active = model.pendingSlug ?: model.current?.slug
    val playhead = remember { derivedStateOf { model.position } }
    LaunchedEffect(active, songs.size) {
        val index = songs.indexOfFirst { it.slug == active }
        if (index >= 0) listState.animateScrollToItem(index)
    }
    Column(
        if (panel) modifier.background(Color(0xF70C0F14)).border(width = 1.dp, color = Mbp.Border) else modifier,
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Box {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .clickable { onMenu(!menuOpen) }
                        .padding(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Image(
                        painterResource(R.drawable.brand_icon),
                        contentDescription = null,
                        modifier = Modifier.size(36.dp),
                        contentScale = ContentScale.Fit,
                    )
                    Column(Modifier.weight(1f).padding(start = 10.dp)) {
                        Text(
                            model.activeSetlist?.name ?: "All Songs",
                            color = Mbp.Text,
                            fontWeight = FontWeight.Bold,
                            fontSize = Mbp.type.callout,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text("${songs.size} tracks", color = Mbp.Muted, fontFamily = Mbp.Mono, fontSize = Mbp.type.caption)
                    }
                    ModeChevron(menuOpen)
                }
                SetlistMenu(model, menuOpen, onMenu, onManage)
            }
            BasicTextField(
                value = model.query,
                onValueChange = { model.query = it },
                singleLine = true,
                textStyle = androidx.compose.ui.text.TextStyle(color = Mbp.Text, fontSize = Mbp.type.body),
                cursorBrush = SolidColor(Mbp.Accent),
                modifier = Modifier
                    .onGloballyPositioned { coords ->
                        val o = coords.positionInRoot()
                        onSearchBounds(Rect(o.x, o.y, o.x + coords.size.width, o.y + coords.size.height))
                    }
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Mbp.BgElevated)
                    .border(1.dp, Mbp.Border, RoundedCornerShape(8.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                decorationBox = { inner ->
                    if (model.query.isEmpty()) Text("Search title or artist…", color = Mbp.Faint, fontSize = Mbp.type.body)
                    inner()
                },
            )
        }
        LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(horizontal = 8.dp)) {
            itemsIndexed(songs, key = { _, song -> song.slug }) { index, song ->
                val isActive = song.slug == active
                val rowBuffering = isActive && model.buffering
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 2.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (isActive) Mbp.AccentDim else Color.Transparent)
                        .clickable {
                            model.playSong(song)
                            onPicked()
                        }
                        .padding(horizontal = 8.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(28.dp), contentAlignment = Alignment.Center) {
                        when {
                            rowBuffering -> Text("·", color = Mbp.Accent, fontFamily = Mbp.Mono, fontSize = Mbp.type.label)
                            isActive && live && model.playing -> EqMarks(playhead)
                            else -> Text("%02d".format(index + 1), color = Mbp.Faint, fontFamily = Mbp.Mono, fontSize = Mbp.type.label)
                        }
                    }
                    Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                        Text(
                            song.title,
                            color = if (isActive) Mbp.Accent else Mbp.Text,
                            fontSize = Mbp.type.body,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(song.artist, color = Mbp.Muted, fontSize = Mbp.type.caption, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(formatDuration(song.durationSeconds), color = Mbp.Faint, fontFamily = Mbp.Mono, fontSize = Mbp.type.label)
                }
            }
            if (songs.isEmpty()) {
                item {
                    Text(
                        when {
                            model.query.isNotBlank() -> "No matching songs"
                            model.activeSetlist != null -> "Empty setlist — manage via ⚙ Manage Songs"
                            else -> "No songs"
                        },
                        color = Mbp.Muted,
                        fontSize = Mbp.type.body,
                        modifier = Modifier.padding(20.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ModeChevron(open: Boolean) {
    val rotation = remember { Animatable(if (open) 180f else 0f) }
    LaunchedEffect(open) {
        rotation.animateTo(if (open) 180f else 0f, tween(180, easing = MbpEaseOut))
    }
    Text(
        "▾",
        color = Mbp.Faint,
        fontSize = Mbp.type.caption,
        modifier = Modifier.graphicsLayer { rotationZ = rotation.value },
    )
}

@Composable
private fun ModeRow(label: String, active: Boolean, count: String? = null, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(7.dp))
            .background(if (active) Mbp.AccentDim else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = if (active) Mbp.Sc else Mbp.Muted, fontSize = Mbp.type.bodySm, modifier = Modifier.weight(1f))
        if (count != null) Text(count, color = Mbp.Faint, fontFamily = Mbp.Mono, fontSize = Mbp.type.micro)
    }
}

private val EqOffsets = listOf(0f, 2.1f, 4.2f)

/** The "now playing" marks. They follow the playhead, which the model updates ten times a
 *  second: an animation of their own kept the whole app redrawing at 60 fps while playing.
 *  The playhead is read while the layers are placed, so no update recomposes anything. */
@Composable
private fun EqMarks(position: State<Float>) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.Bottom, modifier = Modifier.height(12.dp)) {
        EqOffsets.forEach { offset ->
            // The bars scale their layer only: a height would lay the row out on every update.
            Box(
                Modifier
                    .width(2.dp)
                    .height(12.dp)
                    .graphicsLayer {
                        val wave = 0.5f + 0.5f * sin(position.value * EQ_SPEED + offset)
                        scaleY = 0.4f + 0.6f * wave
                        transformOrigin = TransformOrigin(0.5f, 1f)
                    }
                    .background(Mbp.Accent, RoundedCornerShape(1.dp)),
            )
        }
    }
}

private const val EQ_SPEED = 12.0f

/** The item of the lyric list that holds the card; the one before it is the head. */
private const val CARD_ITEM = 1

/** The gutter of the mark key beside a stanza, and the key in it. */
private val StanzaGutter = 40.dp
private val StanzaKey = 28.dp

/** The top padding of the lyric card. The place of a stanza is measured without it. */
private val CardPadTop = 16.dp

@Composable
private fun Lyrics(
    model: PracticeModel,
    onEditMark: (String) -> Unit,
    onEditTag: (String) -> Unit,
    modifier: Modifier,
    topPad: androidx.compose.ui.unit.Dp,
) {
    val song = model.current
    val uriHandler = LocalUriHandler.current
    if (song == null) {
        Column(
            modifier.padding(top = topPad, start = 28.dp, end = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Select a song", color = Mbp.Text, fontSize = Mbp.type.display, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 72.dp))
            Text("Pick a track from the list to play and view lyrics.", color = Mbp.Muted, fontSize = Mbp.type.caption, modifier = Modifier.padding(top = 8.dp))
            Text(
                "Folder layout: songs/{slug}/{slug}.mp3, meta.json, lyrics.md",
                color = Mbp.Faint,
                fontSize = Mbp.type.bodySm,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        return
    }
    // Follows the playhead without recomposing for each tick of it: only when the playhead
    // reaches another mark. The stanza tied to that mark is the one the song is in.
    val activeMarker by remember {
        derivedStateOf { model.markers.lastOrNull { it.time <= model.position + 0.2 } }
    }
    val activeStanza by remember { derivedStateOf { activeMarker?.stanzaIndex } }
    // Where each stanza sits in the card. The card is one item of the list, so following a
    // stanza means scrolling into that item.
    val stanzaTops = remember { HashMap<Int, Float>() }
    val listState = rememberLazyListState()
    val density = LocalDensity.current
    // A touch on the list is somebody reading: the card does not pull away from under the
    // finger.
    var touchedAt by remember { mutableLongStateOf(0L) }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect {
            if (it is PressInteraction.Press || it is DragInteraction.Start) touchedAt = SystemClock.uptimeMillis()
        }
    }
    LaunchedEffect(activeStanza) {
        val stanza = activeStanza ?: return@LaunchedEffect
        if (listState.isScrollInProgress || SystemClock.uptimeMillis() - touchedAt < 3500) return@LaunchedEffect
        val top = stanzaTops[stanza] ?: return@LaunchedEffect
        val offset = with(density) { (top + CardPadTop.toPx() - 12.dp.toPx()).roundToInt() }
        listState.animateScrollToItem(CARD_ITEM, offset.coerceAtLeast(0))
    }
    // In a layer of its own, so that a change elsewhere does not record the whole lyric again.
    LazyColumn(
        modifier = modifier
            .padding(top = topPad, start = 22.dp, end = 22.dp, bottom = 24.dp)
            .graphicsLayer(),
        state = listState,
    ) {
        item {
            Text(song.title, color = Mbp.Text, fontSize = Mbp.type.song, fontWeight = FontWeight.Bold, lineHeight = Mbp.type.songLine)
            Text(song.artist, color = Mbp.Muted, fontSize = Mbp.type.title, modifier = Modifier.padding(top = 6.dp))
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                MetaChip(song.slug, mono = true)
                song.lyricist?.let { MetaChip("L: $it") }
                song.composer?.let { MetaChip("C: $it") }
                song.sourceUrl?.let { url ->
                    Text(
                        "Source ↗",
                        color = Mbp.Accent,
                        fontSize = Mbp.type.caption,
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .border(1.dp, Color(0x4D5EEAD4), RoundedCornerShape(999.dp))
                            .clickable { runCatching { uriHandler.openUri(url) } }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
            Text(
                "＋で今の位置にマーク。チップはタップで移動、長押しで編集。",
                color = Mbp.Faint,
                fontSize = Mbp.type.caption,
                modifier = Modifier.padding(top = 10.dp, bottom = 18.dp),
            )
        }
        item {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(Mbp.BgElevated)
                    .border(1.dp, Mbp.Border, RoundedCornerShape(12.dp))
                    .padding(start = 12.dp, top = CardPadTop, end = 18.dp, bottom = 12.dp),
            ) {
                when {
                    model.lyricsLoading -> Text("Loading lyrics…", color = Mbp.Muted, modifier = Modifier.padding(bottom = 12.dp))
                    model.lyricsNote != null -> Text(model.lyricsNote ?: "", color = Mbp.Muted, modifier = Modifier.padding(bottom = 12.dp))
                    model.lyrics.isEmpty() -> Text("No lyrics.md for this track.", color = Mbp.Muted, modifier = Modifier.padding(bottom = 12.dp))
                    else -> {
                        // Counted here, not next to the list: a variable captured from around the
                        // item gives it a new content each time the lyric recomposes.
                        var stanzaCounter = -1
                        val activeId = activeMarker?.id
                        model.lyrics.forEach { block ->
                            when (block) {
                                is LyricsBlock.Heading -> Text(block.text, color = Mbp.Text, fontWeight = FontWeight.SemiBold, fontSize = Mbp.type.headline)
                                is LyricsBlock.Artist -> Text(block.text, color = Mbp.Muted, fontStyle = FontStyle.Italic, modifier = Modifier.padding(bottom = 12.dp))
                                is LyricsBlock.Section -> Text(
                                    block.text,
                                    color = Mbp.Accent,
                                    fontFamily = Mbp.Mono,
                                    fontSize = Mbp.type.label,
                                    letterSpacing = 0.08.em,
                                    modifier = Modifier.padding(top = 16.dp, bottom = 6.dp),
                                )
                                is LyricsBlock.Stanza -> {
                                    val idx = ++stanzaCounter
                                    val marks = model.markers.filter { it.stanzaIndex == idx }
                                    // a tag of the old kind gives way to a mark of the same name
                                    val tags = model.stanzaTags.filter { tag -> tag.stanzaIndex == idx && marks.none { it.label == tag.label } }
                                    StanzaBlock(
                                        model,
                                        block.lines,
                                        marks,
                                        tags,
                                        activeMarkId = activeId,
                                        current = idx == activeStanza,
                                        onMark = { model.markStanza(idx) },
                                        onEditMark = onEditMark,
                                        onEditTag = onEditTag,
                                        modifier = Modifier.onGloballyPositioned { stanzaTops[idx] = it.positionInParent().y },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * One stanza of the lyrics with its marks. The key in the gutter puts the start of the
 * stanza where the song is now; it stands only where there is no mark yet, for a stanza that
 * has one shows the mark instead. The chips go to their mark with a tap and open it for
 * editing when they are held down. The stanza the song is in is lit.
 */
@Composable
private fun StanzaBlock(
    model: PracticeModel,
    lines: List<String>,
    marks: List<Marker>,
    tags: List<StanzaTag>,
    activeMarkId: String?,
    current: Boolean,
    onMark: () -> Unit,
    onEditMark: (String) -> Unit,
    onEditTag: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(modifier.fillMaxWidth()) {
        Box(Modifier.width(StanzaGutter), contentAlignment = Alignment.TopCenter) {
            if (marks.isEmpty()) {
                Box(
                    Modifier
                        .padding(top = 3.dp)
                        .size(StanzaKey)
                        .clip(CircleShape)
                        .background(if (current) Mbp.Accent else Mbp.Bg)
                        .border(1.dp, Mbp.BorderStrong, CircleShape)
                        .clickable(onClick = onMark),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("＋", color = if (current) Mbp.Ink else Mbp.Muted, fontSize = Mbp.type.body, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Column(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(8.dp))
                .background(if (current) Mbp.AccentDim else Color.Transparent)
                .padding(horizontal = 6.dp),
        ) {
            if (marks.isNotEmpty() || tags.isNotEmpty()) {
                Row(Modifier.padding(top = 2.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    marks.forEach { mark ->
                        MarkChip(
                            mark.label,
                            mark.time,
                            on = mark.id == activeMarkId,
                            onClick = { model.seek(mark.time) },
                            onLongClick = { onEditMark(mark.id) },
                        )
                    }
                    tags.forEach { tag ->
                        val tied = model.markers.firstOrNull { it.label == tag.label }
                        TagChip(
                            tag.label,
                            tied = tied != null,
                            onClick = { tied?.let { model.seek(it.time) } },
                            onLongClick = { onEditTag(tag.id) },
                        )
                    }
                }
            }
            Text(
                emphasize(lines.joinToString("\n")),
                color = Mbp.Text,
                fontSize = Mbp.type.lyrics,
                lineHeight = Mbp.type.lyricsLine,
                modifier = Modifier.padding(bottom = 12.dp),
            )
        }
    }
}

/** The mark of a stanza: its name and where it is. A tap goes there, a hold edits it. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MarkChip(label: String, time: Double, on: Boolean, onClick: () -> Unit, onLongClick: () -> Unit) {
    Text(
        "$label ${formatTimePrecise(time)}",
        color = if (on) Mbp.Ink else Mbp.Accent,
        fontFamily = Mbp.Mono,
        fontSize = Mbp.type.caption,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .heightIn(min = 32.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(if (on) Mbp.Sc else Mbp.AccentDim)
            .border(1.dp, if (on) Mbp.Sc else Mbp.Accent.copy(alpha = 0.55f), RoundedCornerShape(999.dp))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 10.dp, vertical = 6.dp)
            .wrapContentHeight(Alignment.CenterVertically),
    )
}

/** A tag of the old kind: a name on a stanza. It goes to the mark of that name, if there is one. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TagChip(label: String, tied: Boolean, onClick: () -> Unit, onLongClick: () -> Unit) {
    Text(
        label,
        color = if (tied) Mbp.Muted else Mbp.Faint,
        fontFamily = Mbp.Mono,
        fontSize = Mbp.type.caption,
        modifier = Modifier
            .heightIn(min = 32.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(Mbp.Bg)
            .border(1.dp, Mbp.BorderStrong, RoundedCornerShape(999.dp))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 10.dp, vertical = 6.dp)
            .wrapContentHeight(Alignment.CenterVertically),
    )
}

@Composable
private fun MetaChip(text: String, mono: Boolean = false) {
    Text(
        text,
        color = Mbp.Muted,
        fontSize = if (mono) Mbp.type.label else Mbp.type.caption,
        fontFamily = if (mono) Mbp.Mono else null,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(Mbp.BgElevated)
            .border(1.dp, Mbp.Border, RoundedCornerShape(999.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

private fun animateDrawer(
    shown: MutableFloatState,
    scope: CoroutineScope,
    job: MutableState<Job?>,
    generation: MutableIntState,
    target: Float,
) {
    val ticket = generation.intValue + 1
    generation.intValue = ticket
    job.value?.cancel()
    val start = shown.floatValue
    val remaining = abs(target - start)
    if (remaining < 0.001f) {
        shown.floatValue = target
        job.value = null
        return
    }
    val ms = (280f * remaining).toInt().coerceIn(100, 280)
    job.value = scope.launch {
        val anim = Animatable(start)
        anim.animateTo(target, tween(durationMillis = ms, easing = MbpEaseOut)) {
            if (generation.intValue == ticket) shown.floatValue = value
        }
    }
}

@Composable
private fun SetlistMenu(
    model: PracticeModel,
    menuOpen: Boolean,
    onMenu: (Boolean) -> Unit,
    onManage: () -> Unit,
) {
    AnimatedVisibility(
        visible = menuOpen,
        enter = fadeIn(tween(160, easing = MbpEaseOut)) +
            expandVertically(tween(200, easing = MbpEaseOut), expandFrom = Alignment.Top),
        exit = fadeOut(tween(120, easing = MbpEaseOut)) +
            shrinkVertically(tween(160, easing = MbpEaseOut), shrinkTowards = Alignment.Top),
    ) {
        Column(
            Modifier
                .padding(top = 52.dp)
                .fillMaxWidth()
                .graphicsLayer {
                    shadowElevation = 16.dp.toPx()
                    shape = RoundedCornerShape(10.dp)
                    clip = false
                }
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xFA0A0C10))
                .border(1.dp, Mbp.BorderStrong, RoundedCornerShape(10.dp))
                .padding(6.dp),
        ) {
            ModeRow("All Songs", model.modeId == null) {
                model.selectMode(null)
                onMenu(false)
            }
            model.setlists.forEach { setlist ->
                ModeRow(setlist.name, model.modeId == setlist.id, "${setlist.songs.size}") {
                    model.selectMode(setlist.id)
                    onMenu(false)
                }
            }
            Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(Mbp.Border))
            ModeRow("⚙ Manage Songs…", false) {
                onMenu(false)
                onManage()
            }
        }
    }
}

/** Hit target for empty drawer padding. Does not consume, so rows and scrolling still win. */
private suspend fun PointerInputScope.holdWithoutConsuming() {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        while (true) {
            val event = awaitPointerEvent()
            val change = event.changes.firstOrNull { it.id == down.id } ?: break
            if (!change.pressed) break
        }
    }
}

private fun settleDrawer(
    listOpenState: MutableState<Boolean>,
    shown: MutableFloatState,
    scope: CoroutineScope,
    job: MutableState<Job?>,
    generation: MutableIntState,
    open: Boolean,
) {
    if (open != listOpenState.value) {
        listOpenState.value = open
    } else {
        animateDrawer(shown, scope, job, generation, if (open) 1f else 0f)
    }
}

/**
 * Finger-following side panels. Thresholds match web `useSwipeDrawer`, in dp
 * rather than raw pixels: 10dp slop, then 50dp or 0.25 dp/ms.
 * The list opens from the left half. The mixer opens from the right half.
 * A drag that starts on the mixer panel is left to the faders.
 */
private suspend fun PointerInputScope.watchDrawer(
    listOpenState: MutableState<Boolean>,
    shown: MutableFloatState,
    scope: CoroutineScope,
    job: MutableState<Job?>,
    generation: MutableIntState,
    blocked: State<Boolean>,
    drawerWidthPx: MutableFloatState,
    rootOrigin: MutableState<Offset>,
    toggleRect: MutableState<Rect>,
    searchRect: MutableState<Rect>,
    deckTop: MutableFloatState,
    mixerOpenState: MutableState<Boolean>,
    mixerShown: MutableFloatState,
    mixerJob: MutableState<Job?>,
    mixerGeneration: MutableIntState,
    mixerWidthPx: MutableFloatState,
    mixerRect: MutableState<Rect>,
    listSwipe: Boolean,
) {
    val slopPx = 10.dp.toPx()
    val openPx = 50.dp.toPx()
    val flickPxPerMs = 0.25.dp.toPx()
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        val origin = rootOrigin.value
        val rootDown = Offset(origin.x + down.position.x, origin.y + down.position.y)
        val search = searchRect.value
        val onMixer = mixerRect.value.width > 0f && mixerRect.value.contains(rootDown)
        var skip = blocked.value ||
            onMixer ||
            rootDown.y >= deckTop.floatValue ||
            toggleRect.value.contains(rootDown) ||
            (search.width > 0f && search.contains(rootDown))
        val startX = down.position.x
        val startY = down.position.y
        val startTime = down.uptimeMillis
        var driving = false
        var driveMixer = false
        var dragOrigin = 0f
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            val change = event.changes.firstOrNull { it.id == down.id }
            if (change == null) {
                if (driving) {
                    if (driveMixer) {
                        settleDrawer(mixerOpenState, mixerShown, scope, mixerJob, mixerGeneration, mixerOpenState.value)
                    } else {
                        settleDrawer(listOpenState, shown, scope, job, generation, listOpenState.value)
                    }
                }
                break
            }
            if (!change.pressed) {
                if (driving) {
                    val deltaX = change.position.x - startX
                    val elapsed = (change.uptimeMillis - startTime).coerceAtLeast(1L)
                    val velocity = deltaX / elapsed.toFloat()
                    val flick = abs(velocity) > flickPxPerMs
                    if (driveMixer) {
                        val open = if (!mixerOpenState.value) {
                            startX > size.width * 0.5f && (deltaX < -openPx || (flick && velocity < 0f))
                        } else {
                            !(deltaX > openPx || (flick && velocity > 0f))
                        }
                        if (open) listOpenState.value = false
                        settleDrawer(mixerOpenState, mixerShown, scope, mixerJob, mixerGeneration, open)
                    } else {
                        val open = if (!listOpenState.value) {
                            listSwipe && startX < size.width * 0.5f && (deltaX > openPx || (flick && velocity > 0f))
                        } else {
                            !(deltaX < -openPx || (flick && velocity < 0f))
                        }
                        if (open) mixerOpenState.value = false
                        settleDrawer(listOpenState, shown, scope, job, generation, open)
                    }
                }
                break
            }
            if (skip) continue
            val deltaX = change.position.x - startX
            val deltaY = change.position.y - startY
            if (!driving) {
                if (abs(deltaX) < slopPx && abs(deltaY) < slopPx) continue
                val horizontal = abs(deltaX) > abs(deltaY) * 1.2f
                val listOpen = listOpenState.value
                val mixerOpen = mixerOpenState.value
                val driveList = horizontal && listSwipe && (listOpen || (!mixerOpen && startX < size.width * 0.5f && deltaX > 0f))
                val openingMixer = !mixerOpen && !listOpen && startX > size.width * 0.5f && deltaX < 0f
                val closingMixer = mixerOpen && deltaX > 0f
                driveMixer = horizontal && !driveList && (openingMixer || closingMixer)
                if (!horizontal || (!driveList && !driveMixer)) {
                    skip = true
                    continue
                }
                if (driveMixer) {
                    if (listOpen) listOpenState.value = false
                    mixerGeneration.intValue += 1
                    mixerJob.value?.cancel()
                    val widthPx = mixerWidthPx.floatValue.coerceAtLeast(1f)
                    dragOrigin = mixerShown.floatValue + deltaX / widthPx
                } else {
                    if (mixerOpen) mixerOpenState.value = false
                    generation.intValue += 1
                    job.value?.cancel()
                    val widthPx = drawerWidthPx.floatValue.coerceAtLeast(1f)
                    dragOrigin = shown.floatValue - deltaX / widthPx
                }
                driving = true
            }
            change.consume()
            if (driveMixer) {
                val widthPx = mixerWidthPx.floatValue.coerceAtLeast(1f)
                mixerShown.floatValue = (dragOrigin - deltaX / widthPx).coerceIn(0f, 1f)
            } else {
                val widthPx = drawerWidthPx.floatValue.coerceAtLeast(1f)
                shown.floatValue = (dragOrigin + deltaX / widthPx).coerceIn(0f, 1f)
            }
        }
    }
}

private fun emphasize(text: String) = buildAnnotatedString {
    var i = 0
    while (i < text.length) {
        val start = text.indexOf('*', i)
        if (start < 0) {
            append(text.substring(i))
            break
        }
        val end = text.indexOf('*', start + 1)
        if (end < 0) {
            append(text.substring(i))
            break
        }
        append(text.substring(i, start))
        withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
            append(text.substring(start + 1, end))
        }
        i = end + 1
    }
}
