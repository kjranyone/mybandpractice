package com.donoy.mybandpractice.v2.sync

import android.content.Context
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

sealed class SyncEvent {
    data class Payload(val role: String, val text: String) : SyncEvent()
    data class Status(val text: String) : SyncEvent()
    data class LibraryReady(val manifest: SyncManifest, val fresh: Set<String>) : SyncEvent()
    data class Transfer(val name: String, val done: Long, val total: Long) : SyncEvent()
    data object Complete : SyncEvent()
    data class Failed(val message: String) : SyncEvent()
}

class SyncSession(
    context: Context,
    private val root: File,
    private val onEvent: (SyncEvent) -> Unit,
) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val closed = AtomicBoolean(false)
    private val transferComplete = AtomicBoolean(false)
    private val gathered = ArrayList<String>()
    private val iceDone = CompletableDeferred<Unit>()
    private val channelOpen = CompletableDeferred<Unit>()
    private var pc: PeerConnection? = null
    private var dc: DataChannel? = null
    private var manifest: SyncManifest? = null
    private val acks = ConcurrentHashMap<Int, CompletableDeferred<Boolean>>()
    private var incoming: Incoming? = null
    private var filesDone = 0
    private var filesTotal = 0
    private var totalBytes = 0L
    private var totalReceived = 0L

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        scope.cancel()
        main.post {
            dc?.unregisterObserver()
            dc?.dispose()
            pc?.dispose()
            dc = null
            pc = null
        }
    }

    fun startSending() {
        // PeerConnection calls have to run on a thread with a Looper. The
        // WebRTC signaling thread deadlocks if they run on a pool thread.
        scope.launch(Dispatchers.Main) {
            try {
                val payload = openOffer()
                emit(SyncEvent.Payload("offer", payload))
            } catch (err: kotlinx.coroutines.CancellationException) {
                throw err
            } catch (err: Throwable) {
                fail(err.message ?: "Could not create connection")
            }
        }
    }

    fun submitAnswer(payload: String) {
        scope.launch(Dispatchers.Main) {
            try {
                val answer = decodeSdp(payload)
                if (answer == null || answer.type != "answer") {
                    fail("That is not an answer code")
                    return@launch
                }
                val peer = pc ?: return@launch
                peer.setRemoteAwait(SessionDescription(SessionDescription.Type.ANSWER, answer.sdp))
                emit(SyncEvent.Status("Connecting…"))
                if (withTimeoutOrNull(25_000) { channelOpen.await() } == null) {
                    fail("Could not connect. Both devices need the same Wi-Fi.")
                }
            } catch (err: kotlinx.coroutines.CancellationException) {
                throw err
            } catch (err: Throwable) {
                fail(err.message ?: "Bad answer code")
            }
        }
    }

    fun acceptOffer(payload: String) {
        scope.launch(Dispatchers.Main) {
            try {
                val offer = decodeSdp(payload)
                if (offer == null || offer.type != "offer") {
                    fail("Not a sync offer QR code")
                    return@launch
                }
                val payloadOut = openAnswer(offer.sdp)
                emit(SyncEvent.Payload("answer", payloadOut))
            } catch (err: Throwable) {
                fail(err.message ?: "Connection failed")
            }
        }
    }

    fun sendWant(slugs: List<String>, setlistIds: List<String>) {
        val manifest = manifest ?: return
        val songBy = manifest.songs.associateBy { it.slug }
        val setBy = manifest.setlists.associateBy { it.id }
        filesDone = 0
        filesTotal = 0
        totalBytes = 0
        totalReceived = 0
        for (slug in slugs) {
            for (file in songBy[slug]?.files.orEmpty()) {
                filesTotal++
                totalBytes += file.bytes
            }
        }
        for (id in setlistIds) {
            for (file in setBy[id]?.files.orEmpty()) {
                filesTotal++
                totalBytes += file.bytes
            }
        }
        sendJson(JSONObject().put("type", "want").put("slugs", JSONArray(slugs)).put("setlists", JSONArray(setlistIds)))
    }

    private suspend fun openOffer(): String {
        val peer = newPeer()
        val channel = peer.createDataChannel("mbp-sync", DataChannel.Init().apply { ordered = true })
        dc = channel
        channel.registerObserver(channelObserver(channel, isSender = true))
        val offer = peer.createOfferAwait()
        peer.setLocalAwait(offer)
        withTimeoutOrNull(1_500) { iceDone.await() }
        return encodeSdp("offer", localSdp(peer))
    }

    private suspend fun openAnswer(offerSdp: String): String {
        val peer = newPeer()
        peer.setRemoteAwait(SessionDescription(SessionDescription.Type.OFFER, offerSdp))
        val answer = peer.createAnswerAwait()
        peer.setLocalAwait(answer)
        withTimeoutOrNull(3_000) { iceDone.await() }
        return encodeSdp("answer", localSdp(peer))
    }

    private fun newPeer(): PeerConnection {
        val factory = factory(app)
        val config = PeerConnection.RTCConfiguration(emptyList<PeerConnection.IceServer>()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        val peer = factory.createPeerConnection(config, observer) ?: error("WebRTC peer was not created")
        pc = peer
        return peer
    }

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (state == PeerConnection.IceConnectionState.FAILED) fail("Connection failed")
        }
        override fun onStandardizedIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            if (state == PeerConnection.PeerConnectionState.FAILED) fail("Connection lost")
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE && !iceDone.isCompleted) {
                iceDone.complete(Unit)
            }
        }
        override fun onIceCandidate(candidate: IceCandidate) {
            val line = candidate.sdp
            if (!line.contains(" typ host")) return
            val short = shortHostLine(line) ?: return
            synchronized(gathered) { gathered += short }
        }
        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) {}
        override fun onSelectedCandidatePairChanged(event: org.webrtc.CandidatePairChangeEvent) {}
        override fun onAddStream(stream: org.webrtc.MediaStream) {}
        override fun onRemoveStream(stream: org.webrtc.MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {
            dc = channel
            channel.registerObserver(channelObserver(channel, isSender = false))
        }
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<org.webrtc.MediaStream>) {}
        override fun onTrack(transceiver: org.webrtc.RtpTransceiver) {}
    }

    private fun channelObserver(channel: DataChannel, isSender: Boolean) = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {}
        override fun onStateChange() {
            if (channel.state() == DataChannel.State.OPEN) {
                if (!channelOpen.isCompleted) channelOpen.complete(Unit)
                if (isSender) scope.launch { publishManifest() }
            }
            if (channel.state() == DataChannel.State.CLOSED && !closed.get()) {
                fail("Connection lost")
            }
        }
        override fun onMessage(buffer: DataChannel.Buffer) {
            val bytes = ByteArray(buffer.data.remaining())
            buffer.data.get(bytes)
            if (buffer.binary) onBinary(bytes) else onText(bytes.toString(Charsets.UTF_8))
        }
    }

    private fun publishManifest() {
        try {
            emit(SyncEvent.Status("Reading the library…"))
            val built = buildSyncManifest(root) { name -> emit(SyncEvent.Status("Hashing $name…")) }
            manifest = built
            sendJson(JSONObject().put("type", "manifest").put("manifest", built.toJson()))
            emit(SyncEvent.Status("Library ready — ${built.songs.size} songs, ${built.setlists.size} setlists."))
        } catch (err: Throwable) {
            fail(err.message ?: "Failed to read library")
        }
    }

    private fun onText(raw: String) {
        val msg = runCatching { JSONObject(raw) }.getOrNull() ?: return
        when (msg.optString("type")) {
            "manifest" -> {
                val parsed = parseSyncManifest(msg.optJSONObject("manifest") ?: return)
                manifest = parsed
                val fresh = upToDateSlugs(root, parsed)
                emit(SyncEvent.LibraryReady(parsed, fresh))
            }
            "want" -> {
                val slugs = jsonStrings(msg.optJSONArray("slugs"))
                val sets = jsonStrings(msg.optJSONArray("setlists"))
                scope.launch { sendWanted(slugs, sets) }
            }
            "file" -> beginFile(msg)
            "ack" -> {
                val id = msg.optInt("id")
                val ok = msg.optBoolean("ok")
                acks.remove(id)?.complete(ok)
            }
            "done" -> completeTransfer()
            "error" -> fail(msg.optString("message").ifBlank { "Sync failed" })
        }
    }

    private fun onBinary(bytes: ByteArray) {
        val file = incoming ?: return
        if (bytes.size < 8) return
        val id = ByteBuffer.wrap(bytes, 0, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int
        if (id != file.id) return
        val payload = bytes.copyOfRange(8, bytes.size)
        file.digest.update(payload)
        if (!file.skip) {
            try {
                file.out?.write(payload)
            } catch (err: Throwable) {
                fail(err.message ?: "write failed")
                return
            }
        }
        file.received += payload.size
        totalReceived += payload.size
        emit(SyncEvent.Transfer(file.name, totalReceived, totalBytes))
        if (file.received >= file.bytes) finishFile(file)
    }

    private fun beginFile(msg: JSONObject) {
        val name = msg.optString("name")
        val dest = safeFile(root, name)
        if (dest == null) {
            sendJson(JSONObject().put("type", "ack").put("id", msg.optInt("id")).put("ok", false).put("error", "bad path"))
            return
        }
        val part = File(dest.parentFile, dest.name + ".part")
        part.parentFile?.mkdirs()
        if (part.exists()) part.delete()
        val skip = name.endsWith("/practice.json") && dest.isFile
        if (skip) {
            totalBytes -= msg.optLong("bytes")
            filesTotal = (filesTotal - 1).coerceAtLeast(0)
        }
        val out = if (skip) {
            null
        } else {
            try {
                FileOutputStream(part)
            } catch (err: Throwable) {
                sendJson(JSONObject().put("type", "ack").put("id", msg.optInt("id")).put("ok", false).put("error", err.message ?: "write failed"))
                fail(err.message ?: "write failed")
                return
            }
        }
        val created = Incoming(
            id = msg.optInt("id"),
            name = name,
            bytes = msg.optLong("bytes"),
            sha256 = msg.optString("sha256"),
            part = part,
            dest = dest,
            skip = skip,
            digest = MessageDigest.getInstance("SHA-256"),
            out = out,
        )
        incoming = created
        if (created.bytes == 0L) finishFile(created)
    }

    private fun finishFile(file: Incoming) {
        runCatching {
            file.out?.flush()
            file.out?.close()
        }
        file.out = null
        if (file.skip) {
            filesDone++
            incoming = null
            sendJson(JSONObject().put("type", "ack").put("id", file.id).put("ok", true))
            return
        }
        val sha = file.digest.digest().joinToString("") { "%02x".format(it) }
        if (sha != file.sha256) {
            file.part.delete()
            incoming = null
            sendJson(JSONObject().put("type", "ack").put("id", file.id).put("ok", false).put("error", "checksum mismatch"))
            fail("Checksum mismatch: ${file.name}")
            return
        }
        if (file.dest.exists()) file.dest.delete()
        if (!file.part.renameTo(file.dest)) {
            file.part.copyTo(file.dest, overwrite = true)
            file.part.delete()
        }
        filesDone++
        incoming = null
        sendJson(JSONObject().put("type", "ack").put("id", file.id).put("ok", true))
    }

    private suspend fun sendWanted(slugs: List<String>, setlistIds: List<String>) {
        val manifest = manifest ?: return
        val plan = ArrayList<SyncFile>()
        for (slug in slugs) manifest.songs.find { it.slug == slug }?.let { plan += it.files }
        for (id in setlistIds) manifest.setlists.find { it.id == id }?.let { plan += it.files }
        val files = plan.filter { !it.name.endsWith("/practice.json") }
        val total = files.sumOf { it.bytes }
        var sent = 0L
        try {
            var id = 1
            for (file in files) {
                val disk = safeFile(root, file.name) ?: throw IllegalStateException("cannot read ${file.name}")
                val ack = CompletableDeferred<Boolean>()
                acks[id] = ack
                sendJson(
                    JSONObject()
                        .put("type", "file")
                        .put("id", id)
                        .put("name", file.name)
                        .put("bytes", file.bytes)
                        .put("sha256", file.sha256),
                )
                var seq = 0
                disk.inputStream().use { input ->
                    val buf = ByteArray(SYNC_CHUNK)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        drain()
                        sendBinary(frame(id, seq++, buf.copyOf(n)))
                        sent += n
                        emit(SyncEvent.Transfer(file.name, sent, total))
                    }
                }
                val ok = withTimeoutOrNull(180_000) { ack.await() } ?: false
                acks.remove(id)
                if (!ok) throw IllegalStateException("receiver rejected ${file.name}")
                id++
            }
            sendJson(JSONObject().put("type", "done"))
            completeTransfer()
        } catch (err: kotlinx.coroutines.CancellationException) {
            throw err
        } catch (err: Throwable) {
            fail(err.message ?: "Send failed")
        }
    }

    private fun frame(id: Int, seq: Int, payload: ByteArray): ByteArray {
        val out = ByteArray(8 + payload.size)
        ByteBuffer.wrap(out).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(id).putInt(seq)
        payload.copyInto(out, 8)
        return out
    }

    private suspend fun drain() {
        val channel = dc ?: return
        while (channel.bufferedAmount() > SYNC_LOW_BUFFER) {
            kotlinx.coroutines.delay(30)
        }
    }

    private fun sendJson(o: JSONObject) {
        val bytes = o.toString().toByteArray(Charsets.UTF_8)
        dc?.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
    }

    private fun sendBinary(bytes: ByteArray) {
        dc?.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), true))
    }

    private fun localSdp(peer: PeerConnection): String {
        val sdp = peer.localDescription?.description.orEmpty()
        val extra = synchronized(gathered) { gathered.toList() }
        return sdpWithHostCandidates(sdp, extra.map { it.removePrefix("a=") })
    }

    private fun emit(event: SyncEvent) {
        if (closed.get() && event !is SyncEvent.Failed) return
        main.post { onEvent(event) }
    }

    private fun fail(message: String) {
        if (transferComplete.get()) return
        if (!closed.compareAndSet(false, true)) return
        main.post { onEvent(SyncEvent.Failed(message)) }
        scope.cancel()
        main.post {
            runCatching { dc?.unregisterObserver() }
            runCatching { dc?.dispose() }
            runCatching { pc?.dispose() }
            dc = null
            pc = null
        }
    }

    private fun completeTransfer() {
        if (transferComplete.compareAndSet(false, true)) emit(SyncEvent.Complete)
    }

    private class Incoming(
        val id: Int,
        val name: String,
        val bytes: Long,
        val sha256: String,
        val part: File,
        val dest: File,
        val skip: Boolean,
        val digest: MessageDigest,
        var out: FileOutputStream?,
        var received: Long = 0,
    )
}

private fun shortHostLine(candidate: String): String? {
    val match = Regex("""candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ host""").find(candidate) ?: return null
    val ip = match.groupValues[5]
    if (ip.startsWith("fe80:", ignoreCase = true) || ip.startsWith("127.")) return null
    val g = match.groupValues
    return "a=candidate:${g[1]} ${g[2]} ${g[3]} ${g[4]} $ip ${g[6]} typ host"
}

private fun jsonStrings(array: JSONArray?): List<String> {
    if (array == null) return emptyList()
    return (0 until array.length()).mapNotNull { array.optString(it).takeIf { s -> s.isNotEmpty() } }
}

private fun factory(context: Context): PeerConnectionFactory {
    val existing = FACTORY
    if (existing != null) return existing
    synchronized(SyncSession::class.java) {
        FACTORY?.let { return it }
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
        )
        val created = PeerConnectionFactory.builder().createPeerConnectionFactory()
        FACTORY = created
        return created
    }
}

@Volatile
private var FACTORY: PeerConnectionFactory? = null

private fun resumeOffSignaling(block: () -> Unit) {
    // WebRTC invokes SdpObserver on its signaling thread. Continuing inline
    // calls back into the peer connection and deadlocks that thread.
    android.os.Handler(android.os.Looper.getMainLooper()).post(block)
}

private suspend fun PeerConnection.createOfferAwait(): SessionDescription = suspendCancellableCoroutine { cont ->
    createOffer(object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {
            resumeOffSignaling { if (cont.isActive) cont.resume(sdp) }
        }
        override fun onCreateFailure(error: String) {
            resumeOffSignaling { if (cont.isActive) cont.resumeWithException(IllegalStateException(error)) }
        }
        override fun onSetSuccess() {}
        override fun onSetFailure(error: String) {}
    }, MediaConstraints())
}

private suspend fun PeerConnection.createAnswerAwait(): SessionDescription = suspendCancellableCoroutine { cont ->
    createAnswer(object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {
            resumeOffSignaling { if (cont.isActive) cont.resume(sdp) }
        }
        override fun onCreateFailure(error: String) {
            resumeOffSignaling { if (cont.isActive) cont.resumeWithException(IllegalStateException(error)) }
        }
        override fun onSetSuccess() {}
        override fun onSetFailure(error: String) {}
    }, MediaConstraints())
}

private suspend fun PeerConnection.setLocalAwait(sdp: SessionDescription) = suspendCancellableCoroutine { cont ->
    setLocalDescription(object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {}
        override fun onCreateFailure(error: String) {}
        override fun onSetSuccess() {
            resumeOffSignaling { if (cont.isActive) cont.resume(Unit) }
        }
        override fun onSetFailure(error: String) {
            resumeOffSignaling { if (cont.isActive) cont.resumeWithException(IllegalStateException(error)) }
        }
    }, sdp)
}

private suspend fun PeerConnection.setRemoteAwait(sdp: SessionDescription) = suspendCancellableCoroutine { cont ->
    setRemoteDescription(object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {}
        override fun onCreateFailure(error: String) {}
        override fun onSetSuccess() {
            resumeOffSignaling { if (cont.isActive) cont.resume(Unit) }
        }
        override fun onSetFailure(error: String) {
            resumeOffSignaling { if (cont.isActive) cont.resumeWithException(IllegalStateException(error)) }
        }
    }, sdp)
}
