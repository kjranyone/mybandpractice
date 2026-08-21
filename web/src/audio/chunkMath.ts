/**
 * Pure playback-engine math shared by the chunk sequencer.
 *
 * The invariant this module protects: chunk i of every stem starts at
 * exactly i * chunkSeconds in song time (guaranteed by
 * bin/make-stem-chunks.py cutting all stems from one shared PCM decode).
 * Every calculation here is derived from that contract — keep it pure and
 * unit-testable (no Web Audio, no React).
 */

export type ChunkLocator = {
  /** Index of the chunk containing the playhead. */
  idx: number;
  /** Offset inside that chunk (seconds, clamped to chunk length). */
  intra: number;
};

/** Locate the chunk containing `offsetSec` in a chunked song. */
export function locateChunk(
  offsetSec: number,
  chunkSeconds: number,
  chunkCount: number,
  songDuration = Infinity,
): ChunkLocator {
  const dur = songDuration > 0 ? songDuration : Infinity;
  const t = Math.min(Math.max(offsetSec, 0), Math.min(dur, chunkCount * chunkSeconds));
  const idx = Math.min(chunkCount - 1, Math.floor(t / chunkSeconds));
  const intra = Math.max(0, t - idx * chunkSeconds);
  return { idx, intra };
}

/**
 * Effective row duration: lossy codecs may decode with end padding (Opus
 * 20 ms frames); clamp to the nominal boundary so scheduled rows stay
 * sample-aligned and the clock never drifts ahead of the audio.
 */
export function effectiveRowDuration(
  decodedDuration: number,
  chunkSeconds: number,
): number {
  return Math.min(decodedDuration, chunkSeconds);
}

/** Wall-clock duration a row will play, given an intra-chunk start offset
 * and playback rate. Floors at 50ms so a boundary-adjacent seek still
 * schedules a real row. */
export function rowWallDuration(
  rowDur: number,
  intra: number,
  rate: number,
): number {
  const r = rate > 0 ? rate : 1;
  return Math.max(0.05, (rowDur - intra) / r);
}

/** Chunk URL for a stem chunk index under its urlBase, honoring the manifest
 * ext (defaults to flac for legacy manifests). Zero-padded to 5 digits. */
export function chunkUrl(
  urlBase: string,
  idx: number,
  ext = "flac",
): string {
  return `${urlBase}/${String(idx).padStart(5, "0")}.${ext}`;
}

/** Parse a chunks.json manifest body into typed chunk metadata.
 * Returns null when the manifest is malformed or out of sane bounds. */
export type ParsedChunkManifest = {
  chunkSeconds: number;
  ext: string;
  stems: Record<string, { count: number }>;
};

export function parseChunkManifest(raw: unknown): ParsedChunkManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as {
    chunkSeconds?: unknown;
    ext?: unknown;
    stems?: unknown;
  };
  if (
    typeof m.chunkSeconds !== "number" ||
    !(m.chunkSeconds >= 5 && m.chunkSeconds <= 120)
  ) {
    return null;
  }
  const ext =
    typeof m.ext === "string" && ["flac", "opus", "ogg"].includes(m.ext)
      ? m.ext
      : "flac";
  if (typeof m.stems !== "object" || m.stems === null) return null;
  const stems: Record<string, { count: number }> = {};
  for (const [name, info] of Object.entries(m.stems as Record<string, unknown>)) {
    const count = (info as { count?: unknown })?.count;
    if (typeof count === "number" && count > 0 && Number.isInteger(count)) {
      stems[name] = { count };
    }
  }
  if (Object.keys(stems).length === 0) return null;
  return { chunkSeconds: m.chunkSeconds, ext, stems };
}
