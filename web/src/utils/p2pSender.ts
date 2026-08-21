import {
  CHUNK_SIZE,
  LOW_BUFFERED,
  decodeSdp,
  encodeSdp,
  frameChunk,
  waitIce,
  withRealHostCandidates,
  type ManifestFile,
  type SyncManifest,
} from "./p2pProtocol";
import type { SyncFs } from "./syncFs";

/** Sender: builds a manifest from the library, streams selected files. */
export class SyncSender {
  private dc: RTCDataChannel;
  private fs: SyncFs;
  private ackWaiters = new Map<number, (ok: boolean, error?: string) => void>();

  constructor(dc: RTCDataChannel, fs: SyncFs) {
    this.dc = dc;
    this.fs = fs;
    this.dc.binaryType = "arraybuffer";
  }

  /** Build the manifest purely from the storage layer (no server API). */
  async buildManifest(
    onProgress?: (message: string) => void,
  ): Promise<SyncManifest> {
    const allFiles = await this.fs.listFiles("songs");

    // group root-relative files by song slug; skip dotfiles/dirs (.gitkeep…)
    const bySlug = new Map<string, { name: string; bytes: number }[]>();
    for (const f of allFiles) {
      const slug = f.name.split("/")[0];
      if (!slug || slug.startsWith(".") || f.name.split("/").some((p) => p.startsWith("."))) {
        continue;
      }
      const arr = bySlug.get(slug) ?? [];
      arr.push({ name: f.name, bytes: f.bytes });
      bySlug.set(slug, arr);
    }

    const songs: SyncManifest["songs"] = [];
    for (const [slug, rawFiles] of bySlug) {
      if (slug === "setlists") continue; // sibling dir, not a song

      // Chunked songs stream from stems/chunks/ at playback; whole-file
      // stems are superseded (same policy as adb sync) — skip them to keep
      // transfers ~8x smaller. Unchunked songs keep their full stems.
      const hasChunks = rawFiles.some(
        (f) => f.name === `${slug}/stems/chunks/chunks.json`,
      );
      const isWholeStem = (name: string) =>
        name.startsWith(`${slug}/stems/`) &&
        !name.startsWith(`${slug}/stems/chunks/`) &&
        /\.(flac|ogg|opus|mp3|wav|m4a)$/i.test(name);
      const sendFiles = hasChunks
        ? rawFiles.filter((f) => !isWholeStem(f.name))
        : rawFiles;

      const files: ManifestFile[] = [];
      for (const f of sendFiles) {
        if (f.name.endsWith(".part")) continue;
        onProgress?.(f.name);
        // streaming hash — the file is never fully buffered
        const sha = await this.fs.hashFile(`songs/${f.name}`);
        if (!sha) continue;
        files.push({
          name: `songs/${f.name}`,
          bytes: f.bytes,
          sha256: sha,
        });
      }

      type Meta = {
        title?: string;
        artist?: string;
        yt_duration_seconds?: number;
        audio?: { output_duration_seconds?: number };
      };
      let meta: Meta = {};
      const metaBytes = await this.fs.readFile(`songs/${slug}/meta.json`);
      if (metaBytes) {
        try {
          meta = JSON.parse(new TextDecoder().decode(metaBytes)) as Meta;
        } catch {
          /* fall back to slug */
        }
      }

      const stems = [
        ...new Set(
          (hasChunks
            ? // chunked: derive stem names from chunk directories
              rawFiles
                .filter((f) => f.name.startsWith(`${slug}/stems/chunks/`))
                .map((f) => f.name.split(`${slug}/stems/chunks/`)[1]?.split("/")[0])
                .filter((s): s is string => !!s)
            : rawFiles
                .filter(
                  (f) =>
                    f.name.startsWith(`${slug}/stems/`) &&
                    (f.name.toLowerCase().endsWith(".flac") ||
                      f.name.toLowerCase().endsWith(".ogg") ||
                      f.name.toLowerCase().endsWith(".opus") ||
                      f.name.toLowerCase().endsWith(".mp3")),
                )
                .map((f) =>
                  f.name
                    .slice(`${slug}/stems/`.length)
                    .replace(/\.(flac|ogg|opus|mp3)$/i, ""),
                )
          ).filter((s) => s && !s.includes("/")),
        ),
      ].filter(
        (s) => !["mix", "mixdown", "original"].includes(s.toLowerCase()),
      );

      songs.push({
        slug,
        title: meta.title || slug,
        artist: meta.artist || "Unknown",
        durationSeconds:
          meta.audio?.output_duration_seconds ?? meta.yt_duration_seconds ?? null,
        hasLyrics: rawFiles.some((f) => f.name === `${slug}/lyrics.md`),
        hasStems: stems.length > 0,
        totalBytes: files.reduce((a, f) => a + f.bytes, 0),
        files,
      });
    }
    songs.sort((a, b) => a.slug.localeCompare(b.slug));

    const setlists: SyncManifest["setlists"] = [];
    for (const f of await this.fs.listFiles("setlists")) {
      if (!f.name.endsWith(".json")) continue;
      onProgress?.(f.name);
      // small json — buffered read is fine
      const bytes = await this.fs.readFile(`setlists/${f.name}`);
      if (!bytes) continue;
      let parsed: { name?: unknown; songs?: unknown } = {};
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
          name?: unknown;
          songs?: unknown;
        };
      } catch {
        continue;
      }
      const sha = await this.fs.hashFile(`setlists/${f.name}`);
      if (!sha) continue;
      setlists.push({
        id: f.name.slice(0, -".json".length),
        name: typeof parsed.name === "string" ? parsed.name : f.name,
        songs: Array.isArray(parsed.songs)
          ? parsed.songs.filter((s): s is string => typeof s === "string")
          : [],
        totalBytes: f.bytes,
        files: [
          {
            name: `setlists/${f.name}`,
            bytes: f.bytes,
            sha256: sha,
          },
        ],
      });
    }

    return { songs, setlists };
  }

  sendManifest(manifest: SyncManifest): void {
    this.dc.send(JSON.stringify({ type: "manifest", manifest }));
  }

  /** Respond to a want: send song files then setlist files, then done. */
  async sendWanted(
    manifest: SyncManifest,
    slugs: string[],
    setlistIds: string[],
    onProgress?: (sent: number, total: number, name: string) => void,
  ): Promise<void> {
    const plan: ManifestFile[] = [];
    for (const slug of slugs) {
      const song = manifest.songs.find((s) => s.slug === slug);
      if (song) plan.push(...song.files);
    }
    for (const id of setlistIds) {
      const sl = manifest.setlists.find((s) => s.id === id);
      if (sl) plan.push(...sl.files);
    }
    // receiver-side practice.json wins; skip those files
    const files = plan.filter((f) => !f.name.endsWith("/practice.json"));

    const total = files.reduce((a, f) => a + f.bytes, 0);
    let sent = 0;
    let id = 1;
    for (const file of files) {
      this.dc.send(
        JSON.stringify({
          type: "file",
          id,
          name: file.name,
          bytes: file.bytes,
          sha256: file.sha256,
        }),
      );
      // stream the file in storage-sized chunks, sliced to CHUNK_SIZE
      // frames — never buffers the whole file
      const tail = { buf: null as Uint8Array | null };
      let seq = 0;
      const streamRes = await this.fs.readFileStream(file.name, async (data) => {
        const buf = tail.buf ? concat(tail.buf, data) : data;
        tail.buf = null;
        let off = 0;
        while (off + CHUNK_SIZE <= buf.length) {
          await this.drain();
          const payload = buf.subarray(off, off + CHUNK_SIZE);
          this.dc.send(frameChunk(id, seq++, payload));
          off += CHUNK_SIZE;
          sent += CHUNK_SIZE;
          onProgress?.(sent, total, file.name);
        }
        tail.buf = buf.subarray(off);
      });
      if (streamRes === null) throw new Error(`cannot read ${file.name}`);
      if (tail.buf && tail.buf.length > 0) {
        await this.drain();
        this.dc.send(frameChunk(id, seq++, tail.buf));
        sent += tail.buf.length;
        onProgress?.(sent, total, file.name);
      }
      const ok = await this.waitAck(id);
      if (!ok) throw new Error(`receiver rejected ${file.name}`);
      id += 1;
    }
    this.dc.send(JSON.stringify({ type: "done" }));
  }

  /** Register a waiter for an ack from the receiver. */
  onAck(id: number, ok: boolean, error?: string): void {
    const waiter = this.ackWaiters.get(id);
    if (waiter) {
      this.ackWaiters.delete(id);
      waiter(ok, error);
    }
  }

  private waitAck(id: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.ackWaiters.set(id, (ok) => resolve(ok));
      // generous: the receiver acks only after every chunk is written,
      // hashed and renamed — slow devices need minutes for large files
      setTimeout(() => {
        if (this.ackWaiters.has(id)) {
          this.ackWaiters.delete(id);
          resolve(false);
        }
      }, 180000);
    });
  }

  private drain(): Promise<void> {
    if (this.dc.bufferedAmount <= LOW_BUFFERED) return Promise.resolve();
    return new Promise((resolve) => {
      const onLow = () => {
        this.dc.removeEventListener("bufferedamountlow", onLow);        resolve();
      };
      this.dc.bufferedAmountLowThreshold = LOW_BUFFERED;
      this.dc.addEventListener("bufferedamountlow", onLow);
    });
  }
}

/** Sender-side connection: create the offer QR payload + data channel. */
export async function createOfferConnection(
  fs: SyncFs,
): Promise<{
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  sender: SyncSender;
  offerPayload: string;
}> {
  return withRealHostCandidates(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel("mbp-sync", { ordered: true });
    const sender = new SyncSender(dc, fs);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc, 1500);
    if (!pc.localDescription) {
      throw new Error("Could not gather connection info");
    }
    return {
      pc,
      dc,
      sender,
      offerPayload: encodeSdp("offer", pc.localDescription.sdp),
    };
  });
}

/** Sender-side: accept the answer payload scanned from the receiver. */
export async function applyAnswer(
  pc: RTCPeerConnection,
  answerPayload: string,
): Promise<void> {
  const answer = decodeSdp(answerPayload);
  if (!answer || answer.type !== "answer") {
    throw new Error("That is not an answer code");
  }
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
