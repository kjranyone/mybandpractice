import LZString from "lz-string";

const { compressToEncodedURIComponent, decompressFromEncodedURIComponent } =
  LZString;

export const CHUNK_SIZE = 16 * 1024;
export const LOW_BUFFERED = 1024 * 1024;

export type ManifestFile = {
  /** path relative to the library root, "/"-separated
   *  (e.g. "song-slug/stems/drums.mp3", "setlists/live.json") */
  name: string;
  bytes: number;
  sha256: string;
};

export type ManifestSong = {
  slug: string;
  title: string;
  artist: string;
  durationSeconds: number | null;
  hasLyrics: boolean;
  hasStems: boolean;
  totalBytes: number;
  files: ManifestFile[];
};

export type ManifestSetlist = {
  id: string;
  name: string;
  songs: string[];
  totalBytes: number;
  files: ManifestFile[];
};

export type SyncManifest = {
  songs: ManifestSong[];
  setlists: ManifestSetlist[];
};

export type SyncMessage =
  | { type: "manifest"; manifest: SyncManifest }
  | { type: "want"; slugs: string[]; setlists: string[] }
  | {
      type: "file";
      id: number;
      /** path relative to the library root, "/"-separated */
      name: string;
      bytes: number;
      sha256: string;
    }
  | { type: "ack"; id: number; ok: boolean; error?: string }
  | { type: "done" }
  | { type: "error"; message: string };

export function encodeSdp(type: "offer" | "answer", sdp: string): string {
  return (type === "offer" ? "O" : "A") + compressToEncodedURIComponent(sdp);
}

export function decodeSdp(
  payload: string,
): { type: "offer" | "answer"; sdp: string } | null {
  const t = payload.charAt(0);
  if (t !== "O" && t !== "A") return null;
  const sdp = decompressFromEncodedURIComponent(payload.slice(1));
  if (!sdp) return null;
  return { type: t === "O" ? "offer" : "answer", sdp };
}

export function parseMessage(raw: string): SyncMessage | null {
  try {
    const v = JSON.parse(raw) as SyncMessage;
    return typeof v?.type === "string" ? v : null;
  } catch {
    return null;
  }
}

export function frameChunk(
  id: number,
  seq: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, id, true);
  dv.setUint32(4, seq, true);
  out.set(payload, 8);
  return out;
}

export function parseFrame(data: ArrayBuffer): {
  id: number;
  seq: number;
  payload: Uint8Array;
} {
  const dv = new DataView(data);
  return {
    id: dv.getUint32(0, true),
    seq: dv.getUint32(4, true),
    payload: new Uint8Array(data, 8),
  };
}

export function waitIce(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onState);
      clearTimeout(timer);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
