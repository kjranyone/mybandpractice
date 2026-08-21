import { clamp } from "./format";

// Peaks are decoded once per track at a fixed high resolution, then cheaply
// downsampled to any bar count (so resizing never re-decodes the audio).
const HI_RES_BARS = 2048;
const hiResPeakCache = new Map<string, number[]>();

/** Deterministic pseudo peaks when real decode is unavailable. */
export function syntheticPeaks(seed: string, bars = 180): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const peaks: number[] = [];
  for (let i = 0; i < bars; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const r = (h >>> 0) / 4294967295;
    // Envelope: quieter intro/outro, denser middle
    const t = i / bars;
    const env = 0.35 + 0.65 * Math.sin(Math.PI * t) ** 0.7;
    const detail = 0.45 + 0.55 * r;
    peaks.push(clamp(env * detail, 0.08, 1));
  }
  return peaks;
}

function downsamplePeaks(channel: Float32Array, bars: number): number[] {
  const block = Math.max(1, Math.floor(channel.length / bars));
  const peaks: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = i * block;
    const end = Math.min(channel.length, start + block);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  // Normalize
  const peak = Math.max(...peaks, 0.0001);
  return peaks.map((p) => clamp(p / peak, 0.04, 1));
}

/**
 * Load peaks for a track. Tries real decode; falls back to synthetic.
 * Cached by audioUrl at high resolution, downsampled per bar count.
 */
export async function loadWaveformPeaks(
  audioUrl: string,
  bars = 200,
): Promise<number[]> {
  const hi = await loadHiResPeaks(audioUrl);
  return downsamplePeaksFrom(hi, bars);
}

function downsamplePeaksFrom(hi: number[], bars: number): number[] {
  if (bars === hi.length) return hi;
  const ratio = hi.length / bars;
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let max = 0;
    for (let j = start; j < end && j < hi.length; j++) {
      if (hi[j] > max) max = hi[j];
    }
    out.push(max);
  }
  return out;
}

async function loadHiResPeaks(audioUrl: string): Promise<number[]> {
  const cached = hiResPeakCache.get(audioUrl);
  if (cached) return cached;

  let peaks: number[];
  try {
    // Defer slightly so the initial stem decode at song start keeps the CPU.
    await new Promise((r) => setTimeout(r, 400));
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error("fetch failed");
    const buf = await res.arrayBuffer();
    // Decode at the library's native rate via an offline context: no
    // resampling and no second hardware AudioContext on Android.
    const ctx = new OfflineAudioContext(1, 128, 44100);
    const decoded = await ctx.decodeAudioData(buf);
    const ch = decoded.getChannelData(0);
    peaks = downsamplePeaks(ch, HI_RES_BARS);
  } catch {
    peaks = syntheticPeaks(audioUrl, HI_RES_BARS);
  }
  hiResPeakCache.set(audioUrl, peaks);
  return peaks;
}
