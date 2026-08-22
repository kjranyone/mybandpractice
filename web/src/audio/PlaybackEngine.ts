/**
 * PlaybackEngine — React-free Web Audio playback engine.
 *
 * Owns everything audio: the AudioContext graph (master/pitch/stem gains),
 * the position clock, the chunk JIT scheduler, full-file decode, LRU caches
 * and the start-ownership token that makes overlapping seeks race-free.
 * The React hook (useAudioPlayer) is a thin adapter that mirrors engine
 * state into UI and persists mixer settings; the engine emits changes
 * through callbacks and never touches the DOM.
 */

import {
  PITCH_GRAIN_SAMPLES,
  createPitchNode,
  registerPitchWorklet,
} from "./pitchWorklet";
import {
  chunkUrl,
  effectiveRowDuration,
  locateChunk,
  rowWallDuration,
} from "./chunkMath";
import { decodeAudioBuffer } from "./decodeAudio";
import { MAX_GAIN } from "./gain";
import type { SongSummary } from "../types";
import { clamp } from "../utils/format";

export type LoopRegion = { start: number; end: number };

export type FullSong = {
  kind: "full";
  slug: string;
  mix: AudioBuffer | null;
  stems: Map<string, AudioBuffer>;
  duration: number;
};

/** Sample-aligned pre-split chunks (bin/make-stem-chunks.py): chunk i of
 * every stem starts at exactly i * chunkSeconds in song time. */
export type ChunkedSong = {
  kind: "chunked";
  slug: string;
  chunkSeconds: number;
  ext: string;
  stems: string[];
  counts: Record<string, number>;
  urlBases: Record<string, string>;
  /** sparse per-stem chunk storage (null = evicted / not decoded) */
  chunks: Map<string, (AudioBuffer | null)[]>;
  inflight: Map<string, Promise<AudioBuffer | null>>;
  duration: number;
};

export type LoadedAudio = FullSong | ChunkedSong;

export type ChunkStartResult = "started" | "superseded" | "failed";

export type EngineEvents = {
  onPlayingChange(playing: boolean): void;
  onBufferingChange(buffering: boolean): void;
  onBufferedChange(fraction: number): void;
  onTimeChange(t: number): void;
  onDurationChange(d: number): void;
  onError(msg: string): void;
  /** Playback reached the end of the track (hook decides: next/repeat/stop). */
  onTrackEnd(): void;
};

// Full-song PCM is ~100MB per stem-minute-heavy track; keep the LRU tight.
const MAX_FULL_CACHE_SONGS = 2;
// Chunked songs only retain a small window of chunks; cache a couple of songs.
const MAX_CHUNK_CACHE_SONGS = 2;
/** Decode-ahead lead time (wall seconds) before scheduling the next chunk. */
const CHUNK_KICK_LEAD = 8.0;
/** Schedule the next chunk's sources this close to the boundary (wall secs). */
const CHUNK_SCHEDULE_LEAD = 2.0;
/** Samples adjusted on either side of a chunk junction (~2.67ms at 48kHz). */
const EDGE_SMOOTH_SAMPLES = 128;

/**
 * Make a newly decoded chunk meet cached neighbours at the same sample value.
 * Only mutate the new buffer: cached/playing buffers must not be adjusted
 * repeatedly when an evicted chunk is decoded again after a backward seek.
 */
function smoothChunkEdges(
  buf: AudioBuffer,
  previous: AudioBuffer | null,
  next: AudioBuffer | null,
) {
  const N = Math.min(EDGE_SMOOTH_SAMPLES, Math.floor(buf.length / 4));
  if (N <= 0) return;

  if (previous) {
    const numChannels = Math.min(buf.numberOfChannels, previous.numberOfChannels);
    for (let ch = 0; ch < numChannels; ch++) {
      const data = buf.getChannelData(ch);
      const start = data[0];
      const join = previous.getChannelData(ch)[previous.length - 1];
      for (let i = 0; i < N; i++) {
        const w = N === 1 ? 0 : (1 - Math.cos((Math.PI * i) / (N - 1))) / 2;
        data[i] += (join - start) * (1 - w);
      }
    }
  }

  if (next) {
    const numChannels = Math.min(buf.numberOfChannels, next.numberOfChannels);
    for (let ch = 0; ch < numChannels; ch++) {
      const data = buf.getChannelData(ch);
      const end = data[data.length - 1];
      const join = next.getChannelData(ch)[0];
      for (let i = 0; i < N; i++) {
        const w = N === 1 ? 1 : (1 - Math.cos((Math.PI * i) / (N - 1))) / 2;
        const idx = data.length - N + i;
        data[idx] += (join - end) * w;
      }
    }
  }
}

type GraphNodes = {
  masterGain: GainNode;
  limiter: DynamicsCompressorNode;
  mixGain: GainNode;
  pitchIn: GainNode;
  bypass: GainNode;
  bypassDelay: DelayNode;
  postPitchGain: GainNode;
  worklet: AudioWorkletNode | null;
  stemGains: Map<string, GainNode>;
};

/** Resolve stem audio URL (prioritizes explicit stemUrls, then fallback). */
export function stemUrl(song: SongSummary, stem: string): string | null {
  if (song.stemUrls?.[stem]) return song.stemUrls[stem];
  if (song.stemBaseUrl && song.stems?.includes(stem)) {
    return `${song.stemBaseUrl}${encodeURIComponent(stem)}.ogg`;
  }
  return null;
}

export class PlaybackEngine {
  private events: EngineEvents;

  private ctx: AudioContext | null = null;
  private graph: GraphNodes | null = null;
  private graphInit: Promise<AudioContext> | null = null;

  private loaded: LoadedAudio | null = null;
  private fullCache = new Map<string, FullSong>();
  private chunkCache = new Map<string, ChunkedSong>();
  private activeSources = new Map<string, AudioBufferSourceNode>();
  private inflightFull = new Map<string, Promise<FullSong | null>>();

  /** Monotonic token: invalidated starts abort silently. */
  private startSeq = 0;
  private sched: {
    nextIdx: number;
    nextWallTime: number;
    kick: Promise<boolean> | null;
    rowFails: number;
  } | null = null;

  // Clock anchors (ctx.currentTime domain)
  private startTime = 0;
  private startOffset = 0;
  private pausedTime = 0;

  // Engine configuration (mirrored by the hook for persistence)
  playing = false;
  duration = 0;
  playbackRate = 1;
  pitch = 0;
  stemLevels: Record<string, number> = { vocals: 1, drums: 1, bass: 1, other: 1 };
  volume = 1;
  muted = false;
  loop: LoopRegion | null = null;
  loopEnabled = false;
  /** Last emitted buffered fraction (0–1); engine-owned truth. */
  bufferedFraction = 0;

  constructor(events: EngineEvents) {
    this.events = events;
  }

  // ------------------------------------------------------------------ graph

  private getCtx(): AudioContext {
    if (!this.ctx) {
      const AC: typeof AudioContext =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext ??
        (window as unknown as { AudioContext: typeof AudioContext }).AudioContext;
      // Let the browser use the hardware's native sample rate (e.g. 44.1kHz / 48kHz).
      // Forcing 48kHz on 44.1kHz audio hardware causes real-time driver resampler
      // buffer underflows / clock drift, producing random clicks/pops during playback.
      this.ctx = new AC();
    }
    return this.ctx;
  }

  /** Fully-wired graph (worklet registered, stem gains at configured levels)
   * before any audio can start — prevents "unmixed original leaks first". */
  ensureGraph(): Promise<AudioContext> {
    if (!this.graphInit) {
      this.graphInit = (async () => {
        const ctx = this.getCtx();

        // Safety limiter in front of the hardware output: faders can boost
        // past unity (MAX_GAIN, stem sums), this catches would-be clipping.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -1;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.25;
        limiter.connect(ctx.destination);

        const masterGain = ctx.createGain();
        masterGain.gain.value = this.muted ? 0 : this.volume;
        masterGain.connect(limiter);

        const mixGain = ctx.createGain();
        const pitchIn = ctx.createGain();
        const bypass = ctx.createGain();
        const bypassDelay = ctx.createDelay(0.5);
        bypassDelay.delayTime.value =
          (1.5 * PITCH_GRAIN_SAMPLES + 128) / ctx.sampleRate;

        const postPitchGain = ctx.createGain();
        postPitchGain.connect(masterGain);
        bypass.connect(bypassDelay);
        bypassDelay.connect(masterGain);

        let worklet: AudioWorkletNode | null = null;
        try {
          await registerPitchWorklet(ctx);
          worklet = createPitchNode(ctx);
          mixGain.connect(pitchIn);
          pitchIn.connect(worklet);
          worklet.connect(postPitchGain);
        } catch (e) {
          console.warn("Pitch worklet init failed; fallback to bypass:", e);
          mixGain.connect(pitchIn);
          pitchIn.connect(postPitchGain);
        }

        // Stem gains are born at the configured mixer levels — never at 1.0
        const stemGains = new Map<string, GainNode>();
        for (const s of ["vocals", "drums", "bass", "other"]) {
          const sg = ctx.createGain();
          sg.gain.value = this.stemLevels[s] ?? 1;
          stemGains.set(s, sg);
        }

        this.graph = {
          masterGain,
          limiter,
          mixGain,
          pitchIn,
          bypass,
          bypassDelay,
          postPitchGain,
          worklet,
          stemGains,
        };
        this.routeStemGains();
        // Persisted pitch/rate (seeded before graph init) take effect here —
        // the worklet node is born at ratio 1.
        this.applyWorkletRatio();
        return ctx;
      })();
    }
    return this.graphInit;
  }

  /** Varispeed active: AudioBufferSourceNode shifts pitch by playbackRate,
   * so the worklet must compensate (ratio 1/rate) to keep tempo changes
   * pitch-neutral. */
  private isVarispeed(): boolean {
    return Math.abs(this.playbackRate - 1) > 1e-4;
  }

  private needsPitchWorklet(): boolean {
    return this.pitch !== 0 || this.isVarispeed();
  }

  /** Route a stem gain: through the worklet whenever it is engaged — zero
   * shift bypasses it entirely (no JS worklet underrun pops). Drums only
   * bypass it for pure pitch shifts: a tempo change must compensate every
   * stem or the kit drifts out of tune with the rest of the band. */
  private connectStem(stemGain: GainNode, stemName: string) {
    const g = this.graph;
    if (!g) return;
    if (!this.needsPitchWorklet()) {
      stemGain.connect(g.masterGain);
    } else if (stemName === "drums" && this.pitch !== 0 && !this.isVarispeed()) {
      stemGain.connect(g.bypass);
    } else {
      stemGain.connect(g.pitchIn);
    }
  }

  /** Push the combined worklet ratio: user pitch × varispeed compensation
   * (net pitch = 2^(semitones/12) even while playbackRate != 1). */
  private applyWorkletRatio() {
    const ctx = this.ctx;
    const node = this.graph?.worklet;
    if (!ctx || !node) return;
    node.parameters
      .get("ratio")
      ?.setTargetAtTime(
        2 ** (this.pitch / 12) / this.playbackRate,
        ctx.currentTime,
        0.03,
      );
  }

  private routeStemGains() {
    const g = this.graph;
    if (!g) return;
    const engaged = this.needsPitchWorklet();

    for (const [name, gain] of g.stemGains) {
      gain.disconnect();
      this.connectStem(gain, name);
    }
    g.mixGain.disconnect();
    g.mixGain.connect(engaged ? g.pitchIn : g.masterGain);

    g.postPitchGain.disconnect();
    g.bypassDelay.disconnect();
    if (engaged) {
      g.postPitchGain.connect(g.masterGain);
      g.bypassDelay.connect(g.masterGain);
    }
  }

  applyStemGains(levels: Record<string, number>) {
    const g = this.graph;
    const ctx = this.ctx;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    for (const [name, gain] of g.stemGains) {
      const target = levels[name] ?? 1;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(target, t + 0.02);
    }
  }

  stopSources(fadeMs = 8) {
    const oldSources = Array.from(this.activeSources.values());
    this.activeSources.clear();

    // 1. Immediately detach onended handlers so dying sources cannot trigger
    // background ticks or premature chunk scheduler invocations.
    for (const src of oldSources) {
      src.onended = null;
    }

    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g || fadeMs <= 0) {
      for (const src of oldSources) {
        try {
          src.stop(0);
        } catch {
          try {
            src.stop();
          } catch {
            /* ignore */
          }
        }
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const t = ctx.currentTime;
    const fadeSec = fadeMs / 1000;

    // Fast micro-fade out on all active gains to eliminate clicks/pops
    for (const gain of g.stemGains.values()) {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + fadeSec);
    }
    g.mixGain.gain.cancelScheduledValues(t);
    g.mixGain.gain.setValueAtTime(g.mixGain.gain.value, t);
    g.mixGain.gain.linearRampToValueAtTime(0, t + fadeSec);

    for (const src of oldSources) {
      try {
        src.stop(t + fadeSec + 0.002);
      } catch {
        try {
          src.stop();
        } catch {
          /* ignore */
        }
      }
      setTimeout(() => {
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
      }, fadeMs + 10);
    }
  }

  // ------------------------------------------------------------------ clock

  get currentTime(): number {
    if (!this.playing) return this.pausedTime;
    const ctx = this.ctx;
    if (!ctx) return this.pausedTime;
    const elapsed = (ctx.currentTime - this.startTime) * this.playbackRate;
    return Math.max(0, this.startOffset + elapsed);
  }

  // ------------------------------------------------------------------ caches

  getFullCached(slug: string): FullSong | null {
    return this.fullCache.get(slug) ?? null;
  }

  private setFullCached(slug: string, buf: FullSong) {
    const cache = this.fullCache;
    if (cache.has(slug)) {
      cache.delete(slug);
    } else if (cache.size >= MAX_FULL_CACHE_SONGS) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(slug, buf);
  }

  getOrCreateChunked(song: SongSummary): ChunkedSong | null {
    if (!song.chunks || !song.stems || song.stems.length === 0) return null;
    const cache = this.chunkCache;
    const hit = cache.get(song.slug);
    if (hit) {
      cache.delete(song.slug);
      cache.set(song.slug, hit); // LRU refresh
      return hit;
    }
    const stems = song.stems.filter((s) => song.chunks!.stems[s]);
    if (stems.length === 0) return null;
    const minCount = Math.min(...stems.map((s) => song.chunks!.stems[s].count));
    const cs: ChunkedSong = {
      kind: "chunked",
      slug: song.slug,
      chunkSeconds: song.chunks.chunkSeconds,
      ext: song.chunks.ext ?? "flac",
      stems,
      counts: Object.fromEntries(
        stems.map((s) => [s, song.chunks!.stems[s].count]),
      ),
      urlBases: Object.fromEntries(
        stems.map((s) => [s, song.chunks!.stems[s].urlBase]),
      ),
      chunks: new Map(stems.map((s) => [s, new Array(minCount).fill(null)])),
      inflight: new Map(),
      duration:
        song.durationSeconds ?? (minCount - 1) * song.chunks.chunkSeconds,
    };
    while (cache.size >= MAX_CHUNK_CACHE_SONGS) {
      const oldest = cache.keys().next().value;
      if (!oldest) break;
      cache.delete(oldest);
    }
    cache.set(song.slug, cs);
    return cs;
  }

  /** Warm chunk row 0 of every stem so the next tap starts ~instantly. */
  prefetchChunkRow0(song: SongSummary): boolean {
    const cs = this.getOrCreateChunked(song);
    if (!cs) return false;
    void this.ensureChunkRow(cs, 0).catch(() => undefined);
    return true;
  }

  // ------------------------------------------------------------------ decode

  private async ensureChunk(
    cs: ChunkedSong,
    stem: string,
    idx: number,
  ): Promise<AudioBuffer | null> {
    const arr = cs.chunks.get(stem);
    if (arr && arr[idx]) return arr[idx];
    const key = `${stem}#${idx}`;
    const existing = cs.inflight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<AudioBuffer | null> => {
      const ctx = this.getCtx();
      const url = chunkUrl(cs.urlBases[stem], idx, cs.ext);
      try {
        const t0 = performance.now();
        const res = await fetch(url);
        if (!res.ok) {
          console.error(
            `[AudioPlayer] Chunk fetch failed HTTP ${res.status}: ${stem}/${idx}`,
          );
          return null;
        }
        const ab = await res.arrayBuffer();
        const buf = await decodeAudioBuffer(ctx, ab);
        console.log(
          `[AudioPlayer] chunk ${cs.slug}/${stem}/${idx}: ${((performance.now() - t0) | 0)}ms ${buf.duration.toFixed(3)}s`,
        );
        const target = cs.chunks.get(stem);
        if (target) {
          target[idx] = buf;
          smoothChunkEdges(buf, target[idx - 1] ?? null, target[idx + 1] ?? null);
        }
        return buf;
      } catch (err) {
        console.error(`[AudioPlayer] Chunk decode error ${stem}/${idx}:`, err);
        return null;
      } finally {
        cs.inflight.delete(key);
      }
    })();

    cs.inflight.set(key, promise);
    return promise;
  }

  private async ensureChunkRow(
    cs: ChunkedSong,
    idx: number,
  ): Promise<boolean> {
    const bufs = await Promise.all(
      cs.stems.map((s) => this.ensureChunk(cs, s, idx)),
    );
    return bufs.every((b) => b != null);
  }

  /** Fetch + decode all tracks of a song in parallel (full-file fallback).
   * Falls back to the main mix when every stem fails. */
  async decodeFull(
    song: SongSummary,
    signal?: AbortSignal,
    opts?: {
      onTrackDone?: (done: number, total: number) => void;
    },
  ): Promise<FullSong | null> {
    const cached = this.fullCache.get(song.slug);
    if (cached) return cached;

    const existing = this.inflightFull.get(song.slug);
    if (existing) return existing;

    const promise = (async (): Promise<FullSong> => {
      const ctx = this.getCtx();
      const stemsMap = new Map<string, AudioBuffer>();
      let mixBuf: AudioBuffer | null = null;
      let songDur = song.durationSeconds || 0;

      const decodeTrack = async (url: string): Promise<AudioBuffer | null> => {
        try {
          const t0 = performance.now();
          const res = await fetch(url, { signal });
          if (!res.ok) {
            console.error(`[AudioPlayer] Fetch failed HTTP ${res.status}: ${url}`);
            return null;
          }
          const ab = await res.arrayBuffer();
          const t1 = performance.now();
          const buf = await decodeAudioBuffer(ctx, ab);
          const t2 = performance.now();
          console.log(
            `[AudioPlayer] ${url.split("/").pop()}: fetch=${(t1 - t0).toFixed(0)}ms decode=${(t2 - t1).toFixed(0)}ms bytes=${(ab.byteLength / 1048576).toFixed(1)}MB dur=${buf.duration.toFixed(0)}s`,
          );
          return buf;
        } catch (err) {
          console.error(`[AudioPlayer] Decode error for ${url}:`, err);
          return null;
        }
      };

      const trackUrls: { key: string; url: string }[] = [];
      if (song.stems && song.stems.length > 0 && (song.stemUrls || song.stemBaseUrl)) {
        for (const s of song.stems) {
          const url = stemUrl(song, s);
          if (url) trackUrls.push({ key: s, url });
        }
      }
      if (trackUrls.length === 0 && song.audioUrl) {
        trackUrls.push({ key: "mix", url: song.audioUrl });
      }

      let done = 0;
      await Promise.all(
        trackUrls.map(async ({ key, url }) => {
          const buf = await decodeTrack(url);
          done += 1;
          opts?.onTrackDone?.(done, trackUrls.length);
          if (!buf) return;
          if (key === "mix") {
            mixBuf = buf;
            if (buf.duration > songDur) songDur = buf.duration;
          } else {
            stemsMap.set(key, buf);
            if (buf.duration > songDur) songDur = buf.duration;
          }
        }),
      );

      // Every stem failed -> try the main mix once so we still have audio
      if (
        stemsMap.size === 0 &&
        !mixBuf &&
        song.audioUrl &&
        !trackUrls.some((t) => t.key === "mix")
      ) {
        mixBuf = await decodeTrack(song.audioUrl);
        if (mixBuf && mixBuf.duration > songDur) songDur = mixBuf.duration;
        opts?.onTrackDone?.(trackUrls.length + 1, trackUrls.length + 1);
      }

      const result: FullSong = {
        kind: "full",
        slug: song.slug,
        mix: mixBuf,
        stems: stemsMap,
        duration: songDur,
      };

      if (stemsMap.size > 0 || mixBuf) {
        this.setFullCached(song.slug, result);
      }
      return result;
    })();

    this.inflightFull.set(song.slug, promise);
    try {
      const res = await promise;
      if (res && this.loaded?.slug === song.slug && res.duration !== this.duration) {
        this.duration = res.duration;
        this.events.onDurationChange(res.duration);
      }
      return res;
    } finally {
      this.inflightFull.delete(song.slug);
    }
  }

  // ------------------------------------------------------------------ start

  /** Adopt decoded audio as the current song and expose its duration. */
  load(audio: LoadedAudio) {
    this.loaded = audio;
    this.duration = audio.duration;
    this.events.onDurationChange(audio.duration);
  }

  /** True when some audio is loaded for the current song. */
  get hasAudio(): boolean {
    return this.loaded != null;
  }

  resetClock(zero = 0) {
    this.startTime = 0;
    this.startOffset = zero;
    this.pausedTime = zero;
    this.events.onTimeChange(zero);
  }

  /** Start chunked playback at `offsetSec`: awaits only the playhead chunk,
   * then plays instantly; later chunks decode just-in-time.
   *
   * Takes ownership synchronously (sources stopped, scheduler invalidated,
   * clock frozen at target) BEFORE the await, so overlapping seeks/pauses
   * cannot leave stale audio running. */
  async startChunkedAt(
    offsetSec: number,
    cs: ChunkedSong,
  ): Promise<ChunkStartResult> {
    const ctx = this.ctx;
    if (!ctx) return "failed";
    const seq = ++this.startSeq;
    const wantPlaying = this.playing;
    const wantLoaded = cs;

    const CD = cs.chunkSeconds;
    const leadCount = cs.counts[cs.stems[0]];
    const { idx: i0, intra } = locateChunk(offsetSec, CD, leadCount, cs.duration);
    const safeOffset = i0 * CD + intra;

    // --- Synchronous take-over: kill old audio NOW, freeze clock at target
    this.stopSources(8);
    this.sched = null;
    this.startTime = ctx.currentTime;
    this.startOffset = safeOffset;
    this.pausedTime = safeOffset;

    const firstBuf = cs.chunks.get(cs.stems[0])?.[i0] ?? null;
    if (!firstBuf) this.setBuffering(true);
    const ok = await this.ensureChunkRow(cs, i0);
    if (seq !== this.startSeq || this.playing !== wantPlaying || this.loaded !== wantLoaded) {
      return "superseded"; // a newer start / pause / song switch owns state
    }
    this.setBuffering(false);
    if (!ok) return "failed";

    const g = this.graph;
    if (!g) return "failed";

    this.routeStemGains();

    const rate = this.playbackRate;
    const now = ctx.currentTime + 0.01;
    this.startTime = now;
    this.startOffset = safeOffset;

    const leadBuf = cs.chunks.get(cs.stems[0])![i0]!;
    // Effective row duration: lossy codecs decode with end padding (Opus
    // 20ms frames); clamp to the nominal boundary so rows stay aligned.
    const rowDur = effectiveRowDuration(leadBuf.duration, CD);
    const rowWallDur = rowWallDuration(rowDur, intra, rate);

    for (const stemName of cs.stems) {
      const buf = cs.chunks.get(stemName)![i0]!;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;

      let stemGain = g.stemGains.get(stemName);
      if (!stemGain) {
        const targetLevel = this.stemLevels[stemName] ?? 1;
          stemGain = ctx.createGain();
          stemGain.gain.value = targetLevel;
          g.stemGains.set(stemName, stemGain);
          this.connectStem(stemGain, stemName);
        }
        const targetLevel = this.stemLevels[stemName] ?? 1;
      stemGain.gain.cancelScheduledValues(now);
      stemGain.gain.setValueAtTime(targetLevel, now);

      src.connect(stemGain);
      src.start(now, Math.min(intra, Math.max(0, buf.duration - 0.01)));
      src.stop(now + rowWallDur);
      const curSeq = seq;
      src.onended = () => {
        if (this.startSeq !== curSeq) return;
        this.activeSources.delete(`${stemName}#${i0}`);
        if (stemName === cs.stems[0] && this.playing) {
          // Boundary safety net: an immediate tick when the lead source ends
          // recovers scheduling even if timer ticks jittered.
          this.tick();
        }
      };
      this.activeSources.set(`${stemName}#${i0}`, src);
    }

    this.sched = {
      nextIdx: i0 + 1,
      nextWallTime: now + rowWallDur,
      kick: null,
      rowFails: 0,
    };
    return "started";
  }

  /** Start the full-buffer path (whole stems / mix in memory). */
  startFullAt(offsetSec: number, buffers?: FullSong) {
    const ctx = this.getCtx();
    if (ctx.state === "suspended") void ctx.resume();

    const buf = buffers ?? (this.loaded?.kind === "full" ? this.loaded : null);
    if (!buf) return;

    this.stopSources(8);
    this.routeStemGains();

    const seq = ++this.startSeq;
    const g = this.graph;
    if (!g) return;

    const dur = buf.duration || this.duration || 1;
    const safeOffset = clamp(offsetSec, 0, dur);

    const fadeSec = 0.008;
    const now = ctx.currentTime + fadeSec + 0.002; // start after micro-fade-out
    this.startTime = now;
    this.startOffset = safeOffset;
    this.pausedTime = safeOffset;

    if (buf.stems.size > 0) {
      for (const [stemName, stemBuf] of buf.stems) {
        const src = ctx.createBufferSource();
        src.buffer = stemBuf;
        src.playbackRate.value = this.playbackRate;

        const targetLevel = this.stemLevels[stemName] ?? 1;
        let stemGain = g.stemGains.get(stemName);
        if (!stemGain) {
          stemGain = ctx.createGain();
          stemGain.gain.value = targetLevel;
          g.stemGains.set(stemName, stemGain);
          this.connectStem(stemGain, stemName);
        }
        // Anchor exactly at the target level: not a single sample leaks at 1.0.
        stemGain.gain.cancelScheduledValues(now);
        stemGain.gain.setValueAtTime(targetLevel, now);

        src.connect(stemGain);
        src.start(now, safeOffset);
        const curSeq = seq;
        src.onended = () => {
          if (this.startSeq !== curSeq) return;
          this.activeSources.delete(stemName);
          if (stemName === "vocals" && this.playing) {
            this.tick();
          }
        };
        this.activeSources.set(stemName, src);
      }
    } else if (buf.mix) {
      const src = ctx.createBufferSource();
      src.buffer = buf.mix;
      src.playbackRate.value = this.playbackRate;
      g.mixGain.gain.cancelScheduledValues(now);
      g.mixGain.gain.setValueAtTime(0, now);
      g.mixGain.gain.linearRampToValueAtTime(1, now + fadeSec);
      src.connect(g.mixGain);
      src.start(now, safeOffset);
      const curSeq = seq;
      src.onended = () => {
        if (this.startSeq !== curSeq) return;
        this.activeSources.delete("mix");
        if (this.playing) {
          this.tick();
        }
      };
      this.activeSources.set("mix", src);
    }
  }

  /** Start playback at a song position, dispatching chunked vs full audio.
   * Optimistically marks playing; a failed chunked start reports an error. */
  startPlaybackAt(offsetSec: number) {
    const loaded = this.loaded;
    if (loaded?.kind === "chunked") {
      this.setPlaying(true); // optimistic; sources land once chunk decodes
      void this.startChunkedAt(offsetSec, loaded).then((res) => {
        if (res === "failed") {
          this.setPlaying(false);
          this.setBuffering(false);
          this.setBuffered(0);
          this.sched = null;
          this.events.onError("Could not decode audio at that position");
        }
      });
      return;
    }
    this.setPlaying(true);
    this.startFullAt(offsetSec);
  }

  private setPlaying(v: boolean) {
    if (this.playing === v) return;
    this.playing = v;
    this.events.onPlayingChange(v);
  }

  private setBuffered(fraction: number) {
    this.bufferedFraction = fraction;
    this.events.onBufferedChange(fraction);
  }

  private setBuffering(v: boolean) {
    this.events.onBufferingChange(v);
  }

  /** Paint yield so buffering spinners render before heavy decode starts. */
  private static yieldToPaint(): Promise<void> {
    return new Promise<void>((r) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setTimeout(r, 30);
        }),
      );
    });
  }

  /**
   * Full song-switch orchestration: reset clock, resolve audio in
   * cache -> chunked -> full-decode order and start playback. Emits
   * buffering/buffered/playing/error events as it goes.
   *
   * Returns "ok", "cancelled" (another song/seek took over mid-load) or
   * "failed" (nothing decodable). The hook only decides playlist policy.
   */
  async playSong(
    song: SongSummary,
    hooks?: {
      onSongReset?(song: SongSummary): void;
      onPrefetch?(song: SongSummary): void;
      isStale?(): boolean;
    },
  ): Promise<"ok" | "cancelled" | "failed"> {
    this.stopSources(8);
    this.setPlaying(false);
    this.resetClock(0);
    this.duration = song.durationSeconds || 0;
    this.events.onDurationChange(this.duration);
    hooks?.onSongReset?.(song);

    // 1. Full-buffer memory cache (0ms instant start)
    const cached = this.fullCache.get(song.slug);
    if (cached) {
      this.load(cached);
      this.startFullAt(0, cached);
      this.setPlaying(true);
      this.setBuffered(1);
      this.setBuffering(false);
      setTimeout(() => hooks?.onPrefetch?.(song), 1000);
      return "ok";
    }

    // 1.5 Chunked fast path: decode only the first ~30s row, start playing,
    // then stream the rest just-in-time.
    const chunked = this.getOrCreateChunked(song);
    if (chunked) {
      this.load(chunked);
      this.setBuffering(true);
      this.setBuffered(0.05);
      await PlaybackEngine.yieldToPaint();

      const ctx = await this.ensureGraph();
      if (ctx.state === "suspended") void ctx.resume();

      const res = await this.startChunkedAt(0, chunked);
      if (res === "superseded") return "cancelled";
      if (res === "failed") {
        if (hooks?.isStale?.()) return "cancelled";
        console.warn(
          `[AudioPlayer] Chunked start failed for ${song.slug}, falling back to full decode`,
        );
      } else {
        this.setPlaying(true);
        this.setBuffered(1);
        this.setBuffering(false);
        setTimeout(() => hooks?.onPrefetch?.(song), 800);
        return "ok";
      }
    }

    // 2. Full decode path — global buffering UI shows instantly, mixer gains
    //    are guaranteed before the first sample.
    this.setBuffering(true);
    this.setBuffered(0.05);
    await PlaybackEngine.yieldToPaint();

    const ctx = await this.ensureGraph();
    if (ctx.state === "suspended") void ctx.resume();

    let buffers = await this.decodeFull(song, undefined, {
      onTrackDone: (done, total) =>
        this.setBuffered(clamp(0.1 + (0.9 * done) / Math.max(1, total), 0, 0.99)),
    });
    if (hooks?.isStale?.()) return "cancelled";

    // Joined an aborted background prefetch -> decode once more directly
    if (!buffers || (buffers.stems.size === 0 && !buffers.mix)) {
      buffers = await this.decodeFull(song);
      if (hooks?.isStale?.()) return "cancelled";
    }

    if (!buffers || (buffers.stems.size === 0 && !buffers.mix)) {
      // Nothing decodable — never enter a fake "playing" silence state
      this.setBuffering(false);
      this.setBuffered(0);
      this.setPlaying(false);
      this.events.onError("Audio files for this song could not be decoded");
      return "failed";
    }

    this.load(buffers);
    this.setBuffered(1);
    this.setBuffering(false);
    this.startFullAt(0, buffers);
    this.setPlaying(true);

    setTimeout(() => hooks?.onPrefetch?.(song), 800);
    return "ok";
  }

  pause() {
    if (!this.playing) return;
    const curT = this.currentTime;
    this.pausedTime = curT;
    this.events.onTimeChange(curT);
    this.stopSources(8);
    this.setPlaying(false);
  }

  seek(t: number) {
    const target = clamp(t, 0, this.duration || t);
    this.pausedTime = target;
    this.events.onTimeChange(target);
    if (this.playing) this.startPlaybackAt(target);
  }

  // ------------------------------------------------------------------ tick

  /** Engine tick: chunk JIT scheduling + loop jump + end detection.
   * Driven by the worker ticker (works with the screen off) and by lead
   * sources' onended (boundary recovery). No React, no DOM. */
  tick() {
    if (!this.playing) return;

    this.tickChunkScheduler();

    const t = this.currentTime;
    const lp = this.loop;

    if (this.loopEnabled && lp && lp.end > lp.start) {
      if (t >= lp.end - 0.02) {
        this.seek(lp.start);
        return;
      }
    }

    if (this.duration > 1 && t >= this.duration - 0.05 && t > 0.5) {
      this.events.onTrackEnd();
      return;
    }

    this.events.onTimeChange(t);
  }

  private tickChunkScheduler() {
    const sched = this.sched;
    const loaded = this.loaded;
    const ctx = this.ctx;
    if (!sched || !ctx || !loaded || loaded.kind !== "chunked") return;
    const cs = loaded;
    const rate = this.playbackRate;
    const lastIdx = cs.counts[cs.stems[0]] - 1;

    while (sched.nextIdx <= lastIdx) {
      const idx = sched.nextIdx;
      const remain = sched.nextWallTime - ctx.currentTime;
      const kickLead = Math.min(CHUNK_KICK_LEAD, cs.chunkSeconds * 0.5);
      const schedLead = Math.min(CHUNK_SCHEDULE_LEAD, cs.chunkSeconds * 0.25);

      if (remain > kickLead) return;

      if (!sched.kick) {
        sched.kick = this.ensureChunkRow(cs, idx).then((ok) => {
          sched.kick = null;
          sched.rowFails = ok ? 0 : sched.rowFails + 1;
          return ok;
        });
      }
      if (remain > schedLead) return;
      if (sched.rowFails >= 3) {
        this.events.onError("Chunk streaming failed — audio file missing or corrupt");
        return;
      }

      const g = this.graph;
      const leadBuf = cs.chunks.get(cs.stems[0])?.[idx];
      if (!g || !leadBuf) return; // not decoded yet — potential small gap

      const rowDur = effectiveRowDuration(leadBuf.duration, cs.chunkSeconds);
      const when = Math.max(sched.nextWallTime, ctx.currentTime + 0.005);
      if (when - sched.nextWallTime > 0.02) {
        // Late decode: audio resumes from this chunk's start while the
        // wall-derived position ran ahead. Re-anchor the clock to the audio
        // truth so the playhead never desyncs (brief silence remains).
        this.startOffset = idx * cs.chunkSeconds;
        this.startTime = when;
      }
      for (const stemName of cs.stems) {
        const buf = cs.chunks.get(stemName)![idx]!;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const stemGain = g.stemGains.get(stemName)!;
        src.connect(stemGain);
        src.start(when, 0);
        src.stop(when + rowDur / rate);
        const curSeq = this.startSeq;
        src.onended = () => {
          if (this.startSeq !== curSeq) return;
          this.activeSources.delete(`${stemName}#${idx}`);
          if (stemName === cs.stems[0] && this.playing) {
            this.tick();
          }
        };
        this.activeSources.set(`${stemName}#${idx}`, src);
      }
      sched.nextWallTime = when + rowDur / rate;
      sched.nextIdx = idx + 1;

      // Evict far-behind chunks to bound memory (~current + next row kept)
      for (const stemName of cs.stems) {
        const arr = cs.chunks.get(stemName);
        if (!arr) continue;
        for (let i = 0; i < idx - 1 && i < arr.length; i++) arr[i] = null;
      }
    }
  }

  // ------------------------------------------------------------------ setters

  setPlaybackRate(r: number) {
    this.playbackRate = clamp(r, 0.25, 2);
    this.applyWorkletRatio();
    this.routeStemGains();
    if (this.playing) {
      const curT = this.currentTime;
      this.pausedTime = curT;
      this.startPlaybackAt(curT);
    }
  }

  setPitch(semitones: number) {
    this.pitch = Math.round(clamp(semitones, -12, 12));
    this.applyWorkletRatio();
    this.routeStemGains();
  }

  setVolume(v: number) {
    this.volume = clamp(v, 0, MAX_GAIN);
    const g = this.graph;
    const ctx = this.ctx;
    if (g && ctx) {
      g.masterGain.gain.setTargetAtTime(
        this.muted ? 0 : this.volume,
        ctx.currentTime,
        0.015,
      );
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    const g = this.graph;
    const ctx = this.ctx;
    if (g && ctx) {
      g.masterGain.gain.setTargetAtTime(
        m ? 0 : this.volume,
        ctx.currentTime,
        0.015,
      );
    }
  }
}
