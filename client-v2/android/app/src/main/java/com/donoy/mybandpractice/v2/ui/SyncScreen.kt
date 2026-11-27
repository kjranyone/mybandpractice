package com.donoy.mybandpractice.v2.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.donoy.mybandpractice.v2.PracticeModel
import com.donoy.mybandpractice.v2.formatBytes
import com.donoy.mybandpractice.v2.formatDuration
import com.donoy.mybandpractice.v2.sync.SyncEvent
import com.donoy.mybandpractice.v2.sync.SyncManifest
import com.donoy.mybandpractice.v2.sync.SyncSession
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import android.graphics.Bitmap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun SyncDialog(model: PracticeModel, onClose: () -> Unit, onImport: () -> Unit) {
    val context = LocalContext.current
    var phase by remember { mutableStateOf("choose") }
    var payload by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var manifest by remember { mutableStateOf<SyncManifest?>(null) }
    var fresh by remember { mutableStateOf(emptySet<String>()) }
    var selected by remember { mutableStateOf(emptySet<String>()) }
    var selectedSets by remember { mutableStateOf(emptySet<String>()) }
    var progress by remember { mutableStateOf<Pair<String, Pair<Long, Long>>?>(null) }
    var session by remember { mutableStateOf<SyncSession?>(null) }
    DisposableEffect(Unit) {
        onDispose { session?.close() }
    }
    fun reset() {
        session?.close()
        session = null
        payload = null
        status = ""
        error = null
        manifest = null
        progress = null
        phase = "choose"
    }
    fun openSession(): SyncSession {
        session?.close()
        val next = SyncSession(context, context.filesDir) { event ->
            when (event) {
                is SyncEvent.Payload -> {
                    payload = event.text
                    status = "Show this code to the other device"
                    phase = if (event.role == "offer") "send-offer" else "receive-answer"
                }
                is SyncEvent.Status -> {
                    status = event.text
                    if (phase == "send-offer" || phase == "send-scan") phase = "send-wait"
                }
                is SyncEvent.LibraryReady -> {
                    manifest = event.manifest
                    fresh = event.fresh
                    selected = event.manifest.songs.map { it.slug }.toSet()
                    selectedSets = event.manifest.setlists.map { it.id }.toSet()
                    phase = "picking"
                }
                is SyncEvent.Transfer -> {
                    progress = event.name to (event.done to event.total)
                    if (phase != "receiving") phase = "sending"
                }
                SyncEvent.Complete -> {
                    phase = "done"
                    model.reloadLibrary()
                }
                is SyncEvent.Failed -> {
                    error = event.message
                    phase = "error"
                }
            }
        }
        session = next
        return next
    }
    val sub = when (phase) {
        "send-offer", "send-scan" -> "Send · connect"
        "send-wait", "sending" -> "Send · transfer"
        "receive-scan", "receive-answer" -> "Receive · connect"
        "picking", "receiving" -> "Receive · transfer"
        else -> "between devices"
    }
    AppDialog("Sync", sub, onClose) {
        when (phase) {
            "choose" -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                ChooseCard("⇧", "Send", "Share this library with another device", Modifier.weight(1f)) {
                    openSession().startSending()
                    phase = "send-offer"
                    status = "Gathering a connection code…"
                }
                ChooseCard("⇩", "Receive", "Copy songs from another device", Modifier.weight(1f)) {
                    phase = "receive-scan"
                }
            }
            "send-offer" -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(status.ifBlank { "Show this code to the other device" }, color = Mbp.Text, fontWeight = FontWeight.SemiBold)
                Text("Both devices need the same Wi-Fi.", color = Mbp.Muted, fontSize = Mbp.type.caption)
                payload?.let { QrImage(it) }
                Chip("Scan answer code", true) { phase = "send-scan" }
            }
            "send-scan" -> QrScan('A', onFound = {
                phase = "send-wait"
                status = "Connecting…"
                session?.submitAnswer(it)
            }, onCancel = { phase = "send-offer" })
            "send-wait" -> Text(status.ifBlank { "Connecting…" }, color = Mbp.Text)
            "sending", "receiving" -> {
                val name = progress?.first ?: "Waiting for data…"
                val done = progress?.second?.first ?: 0L
                val total = progress?.second?.second ?: 0L
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(name, color = Mbp.Text, maxLines = 2)
                    val fraction = if (total > 0) (done.toFloat() / total.toFloat()).coerceIn(0f, 1f) else 0f
                    androidx.compose.foundation.layout.Box(
                        Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(99.dp)).background(Mbp.Border),
                    ) {
                        androidx.compose.foundation.layout.Box(
                            Modifier.fillMaxWidth(fraction).height(6.dp).background(Mbp.Sc),
                        )
                    }
                    Text("${formatBytes(done)} / ${formatBytes(total)}", color = Mbp.Muted, fontFamily = Mbp.Mono, fontSize = Mbp.type.caption)
                }
            }
            "receive-scan" -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                QrScan('O', onFound = {
                    phase = "receive-answer"
                    openSession().acceptOffer(it)
                }, onCancel = { reset() })
                Chip("フォルダから取り込む", false) { onImport() }
            }
            "receive-answer" -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Show this code to the other device", color = Mbp.Text, fontWeight = FontWeight.SemiBold)
                payload?.let { code ->
                    QrImage(code)
                    Chip("Share answer code", false) {
                        val share = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TEXT, code)
                        }
                        context.startActivity(Intent.createChooser(share, "Share answer code"))
                    }
                } ?: Text("Building the answer code…", color = Mbp.Muted)
            }
            "picking" -> {
                val data = manifest
                if (data == null) {
                    Text("Waiting for the library…", color = Mbp.Muted)
                } else {
                    LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(data.songs, key = { it.slug }) { song ->
                            val on = song.slug in selected
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(if (on) Mbp.AccentDim else Mbp.BgElevated)
                                    .clickable {
                                        selected = if (on) selected - song.slug else selected + song.slug
                                    }
                                    .padding(10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(song.title, color = Mbp.Text, fontWeight = FontWeight.SemiBold, fontSize = Mbp.type.body, maxLines = 1)
                                    Text(
                                        song.artist + (if (song.hasStems) " · stems" else "") + (if (song.hasLyrics) " · lyrics" else "") +
                                            (if (song.slug in fresh) " · up to date" else ""),
                                        color = Mbp.Muted,
                                        fontSize = Mbp.type.caption,
                                        maxLines = 1,
                                    )
                                }
                                Text(formatBytes(song.totalBytes), color = Mbp.Faint, fontFamily = Mbp.Mono, fontSize = Mbp.type.label)
                                Text(formatDuration(song.durationSeconds), color = Mbp.Faint, fontSize = Mbp.type.label, modifier = Modifier.padding(start = 6.dp))
                            }
                        }
                        items(data.setlists, key = { it.id }) { setlist ->
                            val on = setlist.id in selectedSets
                            Text(
                                (if (on) "☑ " else "☐ ") + setlist.name + " · ${setlist.songs.size} songs",
                                color = if (on) Mbp.Accent else Mbp.Text,
                                modifier = Modifier.clickable {
                                    selectedSets = if (on) selectedSets - setlist.id else selectedSets + setlist.id
                                }.padding(vertical = 4.dp),
                            )
                        }
                    }
                    val count = selected.size + selectedSets.size
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("$count selected", color = Mbp.Muted, fontSize = Mbp.type.caption)
                        Chip("Receive", count > 0) {
                            if (count == 0) return@Chip
                            phase = "receiving"
                            session?.sendWant(selected.toList(), selectedSets.toList())
                        }
                    }
                }
            }
            "done" -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Sync complete", color = Mbp.Accent, fontWeight = FontWeight.Bold, fontSize = Mbp.type.title)
                Chip("Close", true, onClose)
            }
            "error" -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(error ?: "Sync failed", color = Mbp.Danger)
                Chip("Try again", true) { reset() }
            }
        }
    }
}

@Composable
private fun ChooseCard(icon: String, title: String, sub: String, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(Mbp.BgElevated)
            .border(1.dp, Mbp.BorderStrong, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(icon, color = Mbp.Sc, fontSize = Mbp.type.iconLg)
        Text(title, color = Mbp.Text, fontWeight = FontWeight.Bold, fontSize = Mbp.type.title)
        Text(sub, color = Mbp.Muted, fontSize = Mbp.type.caption)
    }
}

@Composable
private fun QrImage(payload: String) {
    val bitmap = remember(payload) { runCatching { qrBitmap(payload) }.getOrNull() }
    if (bitmap == null) {
        Text("This connection code is too large to draw as a QR code.", color = Mbp.Danger)
        return
    }
    Image(
        bitmap = bitmap,
        contentDescription = "Sync code",
        modifier = Modifier.size(240.dp).clip(RoundedCornerShape(8.dp)).background(Color.White).padding(8.dp),
        contentScale = ContentScale.Fit,
    )
}

private fun qrBitmap(payload: String): androidx.compose.ui.graphics.ImageBitmap {
    val hints = mapOf(
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L,
        EncodeHintType.MARGIN to 1,
    )
    val size = 640
    val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size, hints)
    val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    for (y in 0 until size) {
        for (x in 0 until size) {
            bmp.setPixel(x, y, if (matrix.get(x, y)) 0xFF0B0D11.toInt() else 0xFFFFFFFF.toInt())
        }
    }
    return bmp.asImageBitmap()
}

@Composable
private fun QrScan(expect: Char, onFound: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        if (!granted) launcher.launch(Manifest.permission.CAMERA)
    }
    if (!granted) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Camera permission is required to scan a code.", color = Mbp.Muted)
            Chip("Allow camera", true) { launcher.launch(Manifest.permission.CAMERA) }
            Text("Back", color = Mbp.Accent, modifier = Modifier.clickable(onClick = onCancel).padding(top = 8.dp))
        }
        return
    }
    val lifecycle = LocalLifecycleOwner.current
    val consumed = remember { AtomicBoolean(false) }
    val executor = remember { Executors.newSingleThreadExecutor() }
    var cameraError by remember { mutableStateOf<String?>(null) }
    DisposableEffect(lifecycle) {
        onDispose {
            executor.shutdown()
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
        }
    }
    Text(if (expect == 'O') "Scan the offer code shown on the other device" else "Scan the answer code shown on the other device", color = Mbp.Text)
    AndroidView(
        factory = { ctx ->
            val previewView = PreviewView(ctx)
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                val main = Handler(Looper.getMainLooper())
                analysis.setAnalyzer(executor) { image ->
                    try {
                        if (consumed.get()) return@setAnalyzer
                        val text = decodeQr(image)
                        if (text != null && text.startsWith(expect) && consumed.compareAndSet(false, true)) {
                            main.post { onFound(text) }
                        }
                    } catch (_: Throwable) {
                    } finally {
                        image.close()
                    }
                }
                val selector = when {
                    provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
                    else -> CameraSelector.DEFAULT_FRONT_CAMERA
                }
                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycle, selector, preview, analysis)
                }.onFailure { cameraError = it.message ?: "Camera failed" }
            }, ContextCompat.getMainExecutor(ctx))
            previewView
        },
        modifier = Modifier.fillMaxWidth().height(280.dp).padding(vertical = 8.dp),
    )
    cameraError?.let { Text(it, color = Mbp.Danger, fontSize = Mbp.type.caption) }
    Text("Back", color = Mbp.Accent, modifier = Modifier.clickable(onClick = onCancel))
}

private fun decodeQr(image: ImageProxy): String? {
    val plane = image.planes.firstOrNull() ?: return null
    val width = image.width
    val height = image.height
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride
    val buf = plane.buffer.duplicate()
    buf.rewind()
    if (buf.remaining() < rowStride * (height - 1) + width * pixelStride) return null
    val raw = ByteArray(buf.remaining())
    buf.get(raw)
    val tight = ByteArray(width * height)
    var i = 0
    for (row in 0 until height) {
        val rowStart = row * rowStride
        var col = 0
        while (col < width) {
            tight[i++] = raw[rowStart + col * pixelStride]
            col++
        }
    }
    val turned = rotateLuma(tight, width, height, image.imageInfo.rotationDegrees)
    val source = PlanarYUVLuminanceSource(turned.bytes, turned.width, turned.height, 0, 0, turned.width, turned.height, false)
    val reader = MultiFormatReader()
    return try {
        reader.decode(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: NotFoundException) {
        null
    } finally {
        reader.reset()
    }
}

private class Luma(val bytes: ByteArray, val width: Int, val height: Int)

private fun rotateLuma(src: ByteArray, width: Int, height: Int, degrees: Int): Luma {
    if (degrees == 90) {
        val out = ByteArray(src.size)
        var i = 0
        for (x in 0 until width) {
            for (y in height - 1 downTo 0) out[i++] = src[y * width + x]
        }
        return Luma(out, height, width)
    }
    if (degrees == 270) {
        val out = ByteArray(src.size)
        var i = 0
        for (x in width - 1 downTo 0) {
            for (y in 0 until height) out[i++] = src[y * width + x]
        }
        return Luma(out, height, width)
    }
    if (degrees == 180) {
        val out = ByteArray(src.size)
        var i = 0
        for (y in height - 1 downTo 0) {
            for (x in width - 1 downTo 0) out[i++] = src[y * width + x]
        }
        return Luma(out, width, height)
    }
    return Luma(src, width, height)
}
