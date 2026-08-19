import {
  decodeSdp,
  encodeSdp,
  parseFrame,
  parseMessage,
  waitIce,
  type SyncManifest,
  type SyncMessage,
} from "./p2pProtocol";
import { Sha256, toHex } from "./sha256";
import type { SyncFs } from "./syncFs";

export type SyncProgress = {
  name: string | null;
  fileReceived: number;
  fileBytes: number;
  totalReceived: number;
  totalBytes: number;
  filesDone: number;
  filesTotal: number;
};

export type SyncClientEvents = {
  onManifest?: (manifest: SyncManifest) => void;
  onProgress?: (p: SyncProgress) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
};

type ActiveFile = {
  id: number;
  name: string;
  partPath: string;
  finalPath: string;
  bytes: number;
  sha256: string;
  received: number;
  hash: Sha256;
  /** storage preparation (mkdir, stale .part cleanup, skipWrite check) —
   *  chunks arriving before this settles are queued via `chain` */
  prep: Promise<void>;
  prepFailed: boolean;
  skipWrite: boolean;
};

/** Receiver: answers an offer and writes incoming files via `fs`. */
export class SyncClient {
  pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private events: SyncClientEvents;
  private fs: SyncFs;
  private active: ActiveFile | null = null;
  private chain: Promise<void> = Promise.resolve();
  private totalBytes = 0;
  private totalReceived = 0;
  private filesDone = 0;
  private filesTotal = 0;
  private closed = false;

  constructor(pc: RTCPeerConnection, fs: SyncFs, events: SyncClientEvents = {}) {
    this.pc = pc;
    this.fs = fs;
    this.events = events;
    pc.ondatachannel = (ev) => this.attach(ev.channel);
    pc.onconnectionstatechange = () => {
      if (
        !this.closed &&
        (pc.connectionState === "failed" || pc.connectionState === "disconnected")
      ) {
        this.events.onError?.("Connection lost");
      }
    };
  }

  close(): void {
    this.closed = true;
    this.dc?.close();
    this.pc.close();
  }

  private attach(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onmessage = (ev) => this.onMessage(ev.data);
  }

  private send(msg: SyncMessage): void {
    this.dc?.send(JSON.stringify(msg));
  }

  private onMessage(data: unknown): void {
    if (typeof data === "string") {
      const msg = parseMessage(data);
      if (!msg) return;
      switch (msg.type) {
        case "manifest":
          this.events.onManifest?.(msg.manifest);
          break;
        case "file":
          this.beginFile(msg);
          break;
        case "done":
          this.events.onDone?.();
          break;
        case "error":
          this.events.onError?.(msg.message);
          break;
        default:
          break;
      }
      return;
    }
    if (data instanceof ArrayBuffer) this.onChunk(data);
  }

  /** Cheap up-to-date check: sizes match for all song files. */
  async checkUpToDate(manifest: SyncManifest): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    for (const song of manifest.songs) {
      let upToDate = true;
      for (const f of song.files) {
        if (f.name === "practice.json") continue;
        const size = await this.fs.size(f.name);
        if (size !== f.bytes) {
          upToDate = false;
          break;
        }
      }
      out.set(song.slug, upToDate);
    }
    return out;
  }

  sendWant(
    manifest: SyncManifest,
    slugs: string[],
    setlistIds: string[],
  ): void {
    const songBySlug = new Map(manifest.songs.map((s) => [s.slug, s]));
    const setlistById = new Map(manifest.setlists.map((s) => [s.id, s]));
    this.totalBytes = 0;
    this.totalReceived = 0;
    this.filesDone = 0;
    this.filesTotal = 0;
    for (const slug of slugs) {
      for (const f of songBySlug.get(slug)?.files ?? []) {
        this.filesTotal += 1;
        this.totalBytes += f.bytes;
      }
    }
    for (const id of setlistIds) {
      for (const f of setlistById.get(id)?.files ?? []) {
        this.filesTotal += 1;
        this.totalBytes += f.bytes;
      }
    }
    this.send({ type: "want", slugs, setlists: setlistIds });
  }

  private beginFile(msg: Extract<SyncMessage, { type: "file" }>): void {
    const partPath = `${msg.name}.part`;
    const f: ActiveFile = {
      id: msg.id,
      name: msg.name,
      partPath,
      finalPath: msg.name,
      bytes: msg.bytes,
      sha256: msg.sha256,
      received: 0,
      hash: new Sha256(),
      prepFailed: false,
      skipWrite: false,
      prep: Promise.resolve(),
    };
    f.prep = (async () => {
      const parent = msg.name.slice(0, msg.name.lastIndexOf("/"));
      if (parent) await this.fs.mkdir(parent);
      await this.fs.deleteFile(partPath);

      // local practice.json wins on the receiving side
      if (msg.name.endsWith("/practice.json")) {
        f.skipWrite = (await this.fs.size(msg.name)) != null;
        if (f.skipWrite) {
          this.totalBytes -= msg.bytes;
          this.filesTotal -= 1;
        }
      }
    })();
    f.prep.catch(() => {
      f.prepFailed = true;
    });
    // set synchronously: the sender starts streaming chunks immediately
    // after the `file` message, before mkdir can resolve
    this.active = f;
    void f.prep.then(() => {
      if (f.prepFailed) {
        this.send({
          type: "ack",
          id: msg.id,
          ok: false,
          error: "storage preparation failed",
        });
        this.active = null;
      }
    });
  }

  private onChunk(data: ArrayBuffer): void {
    const f = this.active;
    if (!f || data.byteLength < 8) return;
    const { id, payload } = parseFrame(data);
    if (id !== f.id) return;
    f.hash.update(payload);
    const n = payload.length;
    this.chain = this.chain
      .then(async () => {
        if (f.received >= f.bytes) return;
        await f.prep;
        if (f.prepFailed) return;
        if (!f.skipWrite) {
          await this.fs.appendFile(f.partPath, payload);
        }
        f.received += n;
        this.totalReceived += n;
        this.emitProgress(f);
        if (f.received >= f.bytes) await this.finishFile(f);
      })
      .catch((e: unknown) => {
        this.events.onError?.(e instanceof Error ? e.message : "write failed");
      });
  }

  private async finishFile(f: ActiveFile): Promise<void> {
    if (f.skipWrite) {
      this.filesDone += 1;
      this.send({ type: "ack", id: f.id, ok: true });
      this.active = null;
      return;
    }
    const sha = toHex(f.hash.digest());
    if (sha !== f.sha256) {
      await this.fs.deleteFile(f.partPath);
      this.send({
        type: "ack",
        id: f.id,
        ok: false,
        error: "checksum mismatch",
      });
      this.events.onError?.(`Checksum mismatch: ${f.name}`);
      return;
    }
    await this.fs.rename(f.partPath, f.finalPath);
    this.filesDone += 1;
    this.emitProgress(f);
    this.send({ type: "ack", id: f.id, ok: true });
    this.active = null;
  }

  private emitProgress(f: ActiveFile): void {
    this.events.onProgress?.({
      name: f.name,
      fileReceived: f.received,
      fileBytes: f.bytes,
      totalReceived: this.totalReceived,
      totalBytes: this.totalBytes,
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
    });
  }
}

export async function createAnswerFromOffer(
  offerPayload: string,
  fs: SyncFs,
  events: SyncClientEvents = {},
): Promise<{ answerPayload: string; client: SyncClient }> {
  const offer = decodeSdp(offerPayload);
  if (!offer || offer.type !== "offer") {
    throw new Error("Not a sync offer QR code");
  }
  const pc = new RTCPeerConnection({ iceServers: [] });
  const client = new SyncClient(pc, fs, events);
  await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIce(pc, 3000);
  if (!pc.localDescription) throw new Error("Failed to create answer");
  return { answerPayload: encodeSdp("answer", pc.localDescription.sdp), client };
}
