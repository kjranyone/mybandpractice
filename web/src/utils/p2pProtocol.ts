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

// ---- SDP minification for QR transport ----
// Full SDP compresses to ~600-700 chars -> QR v17+ (85+ modules), which
// phone cameras struggle to resolve. Instead we transmit only the fields
// that vary (candidates + a handful of session attributes) and rebuild a
// valid SDP on the receiving side. Gets typical codes to ~QR v11-13.

type MiniSdp = {
  t: "O" | "A";
  /** ice-pwd */
  p: string;
  /** ice-ufrag */
  u: string;
  /** dtls fingerprint (hex, colon-separated) */
  f: string;
  /** setup role */
  s: "actpass" | "active" | "passive";
  /** host candidates: "foundation/priority/ip/port" */
  c: string[];
};

function attr(sdp: string, name: string): string | null {
  const m = sdp.match(new RegExp(`^a=${name}:(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

export function encodeSdp(type: "offer" | "answer", sdp: string): string {
  const mini: MiniSdp = {
    t: type === "offer" ? "O" : "A",
    p: attr(sdp, "ice-pwd") ?? "",
    u: attr(sdp, "ice-ufrag") ?? "",
    f: attr(sdp, "fingerprint") ?? "",
    s: (attr(sdp, "setup") as MiniSdp["s"]) ?? "actpass",
    c: [],
  };
  for (const m of sdp.matchAll(/^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ host$/gm)) {
    const [, foundation, , , priority, ip, port] = m;
    // drop IPv6 link-locals (fe80::) and loopback — unusable for pairing.
    // .local (mDNS) candidates are kept: Chromium can resolve them, and
    // withRealHostCandidates() usually makes real IPs available anyway.
    if (/^(fe80::|127\.)/i.test(ip)) continue;
    mini.c.push(`${foundation}/${priority}/${ip}/${port}`);
  }
  const json = JSON.stringify(mini);
  return (type === "offer" ? "O" : "A") + compressToEncodedURIComponent(json);
}

export function decodeSdp(
  payload: string,
): { type: "offer" | "answer"; sdp: string } | null {
  const t = payload.charAt(0);
  if (t !== "O" && t !== "A") return null;
  // backward compatibility: legacy payloads compressed the raw SDP
  // (detect by the leading "v=0" after decompression)
  const raw = decompressFromEncodedURIComponent(payload.slice(1));
  if (!raw) return null;
  if (raw.startsWith("v=0")) {
    return { type: t === "O" ? "offer" : "answer", sdp: raw };
  }
  let mini: MiniSdp;
  try {
    mini = JSON.parse(raw) as MiniSdp;
  } catch {
    return null;
  }
  if (!Array.isArray(mini.c) || typeof mini.p !== "string") return null;
  const setup = mini.s ?? "actpass";
  const lines = [
    "v=0",
    "o=- 0 0 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${mini.u}`,
    `a=ice-pwd:${mini.p}`,
    `a=fingerprint:${mini.f}`,
    `a=setup:${setup}`,
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ];
  for (const c of mini.c) {
    const [foundation, priority, ip, port] = c.split("/");
    if (!foundation || !priority || !ip || !port) continue;
    lines.push(
      `a=candidate:${foundation} 1 udp ${priority} ${ip} ${port} typ host generation 0`,
    );
  }
  return { type: t === "O" ? "offer" : "answer", sdp: lines.join("\r\n") + "\r\n" };
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

/**
 * Chromium hides host candidate IPs behind mDNS names (e.g. abc.local)
 * unless media capture is permitted for the origin. QR-carried SDP with
 * only .local candidates fails when the peer cannot resolve them, and
 * neither side can start ICE checks — so briefly hold a getUserMedia
 * stream while gathering candidates. Real IPs end up baked into the SDP;
 * the stream is released right after.
 */
export async function withRealHostCandidates<T>(
  fn: () => Promise<T>,
): Promise<T> {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
  } catch {
    /* permission denied / unavailable — proceed; prflx may still connect
       when the peer exposes real IPs */
  }
  try {
    return await fn();
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
