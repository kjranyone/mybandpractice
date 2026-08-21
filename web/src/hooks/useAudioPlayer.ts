import { useCallback, useEffect, useRef, useState } from "react";
import {
  PITCH_GRAIN_SAMPLES,
  createPitchNode,
  registerPitchWorklet,
} from "../audio/pitchWorklet";
import type { SongSummary } from "../types";
import { clamp } from "../utils/format";



export type LoopRegion = {
  start: number;
  end: number;
};

export type PlaybackMode = "sequential" | "repeat-all" | "repeat-one";

export const PLAYBACK_MODES = [
  "sequential",
  "repeat-all",
  "repeat-one",
] as const satisfies readonly PlaybackMode[];

export function nextPlaybackMode(mode: PlaybackMode): PlaybackMode {
  return PLAYBACK_MODES[(PLAYBACK_MODES.indexOf(mode) + 1) % PLAYBACK_MODES.length];
}

export const PLAYBACK_MODE_LABELS: Record<PlaybackMode, string> = {
  sequential: "Sequential",
  "repeat-all": "Repeat all",
  "repeat-one": "Repeat one",
};

export type AudioPlayer = ReturnType<typeof useAudioPlayer>;

export type StemName = "mix" | "vocals" | "drums" | "bass" | "other";

const MIN_LOOP = 0.25; // seconds
const RATE_PRESETS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;

export { RATE_PRESETS };

const MIXER_STORAGE_KEY = "mybandpractice:mixer-settings";

type MixerSettings = {
  stemLevels: Record<string, number>;
  volume: number;
  muted: boolean;
  pitch: number;
  playbackRate: number;
};

const DEFAULT_MIXER_SETTINGS: MixerSettings = {
  stemLevels: { vocals: 1, drums: 1, bass: 1, other: 1 },
  volume: 0.85,
  muted: false,
  pitch: 0,
  playbackRate: 1,
};

function loadSavedMixerSettings(): MixerSettings {
  try {
    const raw = localStorage.getItem(MIXER_STORAGE_KEY);
    if (!raw) return DEFAULT_MIXER_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      stemLevels: parsed.stemLevels ?? DEFAULT_MIXER_SETTINGS.stemLevels,
      volume: typeof parsed.volume === "number" ? clamp(parsed.volume, 0, 1) : 0.85,
      muted: typeof parsed.muted === "boolean" ? parsed.muted : false,
      pitch: typeof parsed.pitch === "number" ? clamp(parsed.pitch, -12, 12) : 0,
      playbackRate:
        typeof parsed.playbackRate === "number" ? clamp(parsed.playbackRate, 0.25, 2) : 1,
    };
  } catch {
    return DEFAULT_MIXER_SETTINGS;
  }
}

function saveMixerSettingsToStorage(settings: MixerSettings) {
  try {
    localStorage.setItem(MIXER_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore storage errors */
  }
}

/** Resolve stem audio URL (prioritizes explicit stemUrls, then fallback to base URL) */
function stemUrl(song: SongSummary, stem: string): string | null {
  if (song.stemUrls?.[stem]) {
    return song.stemUrls[stem];
  }
  if (song.stemBaseUrl && song.stems?.includes(stem)) {
    return `${song.stemBaseUrl}${encodeURIComponent(stem)}.ogg`;
  }
  return null;
}

type DecodedSongBuffers = {
  kind: "full";
  slug: string;
  mix: AudioBuffer | null;
  stems: Map<string, AudioBuffer>;
  duration: number;
};

/** Sample-aligned pre-split chunks (bin/make-stem-chunks.py): chunk i of every
 * stem starts at exactly i * chunkSeconds in song time. */
type ChunkedSong = {
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

type LoadedAudio = DecodedSongBuffers | ChunkedSong;

// Full-song PCM is ~100MB per stem-minute-heavy track; keep the LRU tight.
const MAX_CACHE_SONGS = 2;
// Chunked songs only retain a small window of chunks; cache a couple of songs.
const MAX_CHUNK_CACHE_SONGS = 2;
/** Decode-ahead lead time (wall seconds) before scheduling the next chunk. */
const CHUNK_KICK_LEAD = 1.0;
/** Schedule the next chunk's sources this close to the boundary (wall secs). */
const CHUNK_SCHEDULE_LEAD = 0.12;

export function useAudioPlayer(songs: SongSummary[]) {
  const songsRef = useRef(songs);
  songsRef.current = songs;

  const savedMixer = useRef(loadSavedMixerSettings());

  const [current, setCurrent] = useState<SongSummary | null>(null);
  const currentRef = useRef<SongSummary | null>(null);
  currentRef.current = current;

  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  playingRef.current = playing;

  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  currentTimeRef.current = currentTime;

  const [duration, setDuration] = useState(0);
  const durationRef = useRef(0);
  durationRef.current = duration;

  const [volume, setVolumeState] = useState(savedMixer.current.volume);
  const volumeRef = useRef(savedMixer.current.volume);
  volumeRef.current = volume;

  const [muted, setMutedState] = useState(savedMixer.current.muted);
  const mutedRef = useRef(savedMixer.current.muted);
  mutedRef.current = muted;

  const [playbackRate, setPlaybackRateState] = useState(savedMixer.current.playbackRate);
  const playbackRateRef = useRef(savedMixer.current.playbackRate);
  playbackRateRef.current = playbackRate;

  const [loop, setLoopState] = useState<LoopRegion | null>(null);
  const loopRef = useRef<LoopRegion | null>(null);
  loopRef.current = loop;

  const [loopEnabled, setLoopEnabledState] = useState(false);
  const loopEnabledRef = useRef(false);
  loopEnabledRef.current = loopEnabled;

  const [buffered, setBuffered] = useState(0); // 0–1 fraction
  const [buffering, setBuffering] = useState(false);
  const [playbackMode, setPlaybackModeState] = useState<PlaybackMode>("sequential");
  const playbackModeRef = useRef<PlaybackMode>("sequential");
  playbackModeRef.current = playbackMode;

  const [stemLevels, setStemLevelsState] = useState<Record<string, number>>(
    savedMixer.current.stemLevels,
  );
  const stemLevelsRef = useRef<Record<string, number>>(savedMixer.current.stemLevels);
  stemLevelsRef.current = stemLevels;

  const [pitch, setPitchState] = useState(savedMixer.current.pitch);
  const pitchRef = useRef(savedMixer.current.pitch);
  pitchRef.current = pitch;

  // --- Web Audio Graph & Buffers ---
  const audioCtxRef = useRef<AudioContext | null>(null);
  const loadedBuffersRef = useRef<LoadedAudio | null>(null);
  const bufferCacheRef = useRef<Map<string, DecodedSongBuffers>>(new Map());
  const chunkedCacheRef = useRef<Map<string, ChunkedSong>>(new Map());
  const activeSourcesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());
  const loadAbortRef = useRef<AbortController | null>(null);
  // Monotonic token: invalidated starts (seek/tap during async chunk start) abort silently
  const startSeqRef = useRef(0);
  // Chunk scheduler state while a chunked song is playing
  const chunkSchedRef = useRef<{
    nextIdx: number;
    nextWallTime: number;
    kick: Promise<boolean> | null;
  } | null>(null);

  // Playback tracking timestamps
  const startTimeRef = useRef(0); // ctx.currentTime when playback started
  const startOffsetRef = useRef(0); // song seconds offset when started
  const pausedTimeRef = useRef(0); // song seconds when paused/seeked

  // Graph Nodes
  const graphNodesRef = useRef<{
    masterGain: GainNode;
    mixGain: GainNode;
    pitchIn: GainNode;
    bypass: GainNode;
    bypassDelay: DelayNode;
    postPitchGain: GainNode;
    worklet: AudioWorkletNode | null;
    stemGains: Map<string, GainNode>;
  } | null>(null);

  // Shared init promise: guarantees every caller awaits the exact same
  // fully-wired graph (worklet registered, stem gains at saved levels) before
  // any audio can start. Prevents the "unmixed original audio leaks first" race.
  const graphInitPromiseRef = useRef<Promise<AudioContext> | null>(null);

  const ensureAudioGraph = useCallback((): Promise<AudioContext> => {
    if (!graphInitPromiseRef.current) {
      graphInitPromiseRef.current = (async () => {
        const AC: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!audioCtxRef.current) audioCtxRef.current = new AC({ sampleRate: 44100 });
        const ctx = audioCtxRef.current;

        // Master output chain
        const masterGain = ctx.createGain();
        masterGain.gain.value = mutedRef.current ? 0 : volumeRef.current;
        masterGain.connect(ctx.destination);

        const mixGain = ctx.createGain();
        const pitchIn = ctx.createGain();
        const bypass = ctx.createGain();
        const bypassDelay = ctx.createDelay(0.5);
        bypassDelay.delayTime.value = (1.5 * PITCH_GRAIN_SAMPLES + 128) / ctx.sampleRate;

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

        // Stem gains are born at the saved mixer levels — never at 1.0
        const stemGains = new Map<string, GainNode>();
        for (const s of ["vocals", "drums", "bass", "other"]) {
          const sg = ctx.createGain();
          sg.gain.value = stemLevelsRef.current[s] ?? 1;
          stemGains.set(s, sg);
        }

        graphNodesRef.current = {
          masterGain,
          mixGain,
          pitchIn,
          bypass,
          bypassDelay,
          postPitchGain,
          worklet,
          stemGains,
        };
        return ctx;
      })();
    }
    return graphInitPromiseRef.current;
  }, []);

  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new AC({ sampleRate: 44100 });
    }
    return audioCtxRef.current;
  }, []);

  const routeStemGains = useCallback(() => {
    const g = graphNodesRef.current;
    if (!g) return;
    const isPitched = pitchRef.current !== 0;
    for (const [name, gain] of g.stemGains) {
      gain.disconnect();
      if (name === "drums" && isPitched) {
        gain.connect(g.bypass);
      } else {
        gain.connect(g.pitchIn);
      }
    }
  }, []);

  const applyStemGains = useCallback((levels: Record<string, number>) => {
    const g = graphNodesRef.current;
    const ctx = audioCtxRef.current;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    for (const [name, gain] of g.stemGains) {
      const targetGain = levels[name] ?? 1;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(targetGain, t + 0.02);
    }
  }, []);

  const stopActiveSources = useCallback((fadeMs = 8) => {
    const ctx = audioCtxRef.current;
    const g = graphNodesRef.current;
    if (!ctx || !g) {
      for (const src of activeSourcesRef.current.values()) {
        try {
          src.stop();
          src.disconnect();
        } catch {
          /* ignore */
        }
      }
      activeSourcesRef.current.clear();
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

    const oldSources = Array.from(activeSourcesRef.current.values());
    activeSourcesRef.current.clear();

    for (const src of oldSources) {
      try {
        src.stop(t + fadeSec + 0.002);
        setTimeout(() => {
          try {
            src.disconnect();
          } catch {
            /* ignore */
          }
        }, fadeMs + 20);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const startSourcesAt = useCallback(
    (offsetSec: number, targetBuffers?: LoadedAudio, fadeMs = 8) => {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") void ctx.resume();

      const buffers = targetBuffers ?? loadedBuffersRef.current;
      if (!buffers || buffers.kind !== "full") return;

      stopActiveSources(fadeMs);
      routeStemGains();

      const song = currentRef.current;
      const g = graphNodesRef.current;
      if (!g) return;

      const dur = song?.durationSeconds || buffers.duration || durationRef.current || 1;
      const safeOffset = clamp(offsetSec, 0, dur);

      const fadeSec = fadeMs / 1000;
      const now = ctx.currentTime + fadeSec + 0.002; // Start after micro-fade out
      startTimeRef.current = now;
      startOffsetRef.current = safeOffset;
      pausedTimeRef.current = safeOffset;

      const hasStems = song?.stems && song.stems.length > 0 && buffers.stems.size > 0;

      if (hasStems) {
        // Start all stems with exact sample clock synchronization and micro-fade in
        for (const [stemName, buf] of buffers.stems) {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = playbackRateRef.current;

          const targetLevel = stemLevelsRef.current[stemName] ?? 1;
          let stemGain = g.stemGains.get(stemName);
          if (!stemGain) {
            stemGain = ctx.createGain();
            stemGain.gain.value = targetLevel;
            g.stemGains.set(stemName, stemGain);
            if (stemName === "drums" && pitchRef.current !== 0) {
              stemGain.connect(g.bypass);
            } else {
              stemGain.connect(g.pitchIn);
            }
          }

          // Cancel only events after `now` so the fade-out curve of stopped
          // sources completes, then anchor exactly at the target level: not a
          // single sample leaks at the default 1.0.
          stemGain.gain.cancelScheduledValues(now);
          stemGain.gain.setValueAtTime(targetLevel, now);

          src.connect(stemGain);
          src.start(now, safeOffset);
          activeSourcesRef.current.set(stemName, src);
        }
      } else if (buffers.mix) {
        // Fallback to stereo mix with micro-fade in
        const src = ctx.createBufferSource();
        src.buffer = buffers.mix;
        src.playbackRate.value = playbackRateRef.current;
        g.mixGain.gain.cancelScheduledValues(now);
        g.mixGain.gain.setValueAtTime(0, now);
        g.mixGain.gain.linearRampToValueAtTime(1, now + fadeSec);
        src.connect(g.mixGain);
        src.start(now, safeOffset);
        activeSourcesRef.current.set("mix", src);
      }
    },
    [getAudioContext, routeStemGains, stopActiveSources],
  );

  const getComputedCurrentTime = useCallback(() => {
    if (!playingRef.current) return pausedTimeRef.current;
    const ctx = audioCtxRef.current;
    if (!ctx) return pausedTimeRef.current;
    const elapsed = (ctx.currentTime - startTimeRef.current) * playbackRateRef.current;
    return Math.max(0, startOffsetRef.current + elapsed);
  }, []);

  // Set in cache with LRU eviction
  const setBufferInCache = useCallback((slug: string, buf: DecodedSongBuffers) => {
    const cache = bufferCacheRef.current;
    if (cache.has(slug)) {
      cache.delete(slug);
    } else if (cache.size >= MAX_CACHE_SONGS) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
    cache.set(slug, buf);
  }, []);

  // --- Chunked playback (instant start) -------------------------------------

  const getChunkedSong = useCallback((song: SongSummary): ChunkedSong | null => {
    if (!song.chunks || !song.stems || song.stems.length === 0) return null;
    const cache = chunkedCacheRef.current;
    const hit = cache.get(song.slug);
    if (hit) {
      cache.delete(song.slug);
      cache.set(song.slug, hit); // LRU refresh
      return hit;
    }
    const stems = song.stems.filter((s) => song.chunks!.stems[s]);
    if (stems.length === 0) return null;
    const minCount = Math.min(
      ...stems.map((s) => song.chunks!.stems[s].count),
    );
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
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
    cache.set(song.slug, cs);
    return cs;
  }, []);

  /** Fetch + decode one chunk (deduped). Returns null on failure. */
  const ensureChunk = useCallback(
    async (cs: ChunkedSong, stem: string, idx: number): Promise<AudioBuffer | null> => {
      const arr = cs.chunks.get(stem);
      if (arr && arr[idx]) return arr[idx];
      const key = `${stem}#${idx}`;
      const existing = cs.inflight.get(key);
      if (existing) return existing;

      const promise = (async (): Promise<AudioBuffer | null> => {
        const ctx = audioCtxRef.current ?? getAudioContext();
        const url = `${cs.urlBases[stem]}/${idx.toString().padStart(5, "0")}.${cs.ext}`;
        try {
          const t0 = performance.now();
          const res = await fetch(url);
          if (!res.ok) {
            console.error(`[AudioPlayer] Chunk fetch failed HTTP ${res.status}: ${stem}/${idx}`);
            return null;
          }
          const ab = await res.arrayBuffer();
          const buf = await ctx.decodeAudioData(ab);
          console.log(
            `[AudioPlayer] chunk ${cs.slug}/${stem}/${idx}: ${((performance.now() - t0) | 0)}ms ${buf.duration.toFixed(3)}s`,
          );
          const target = cs.chunks.get(stem);
          if (target) target[idx] = buf;
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
    },
    [getAudioContext],
  );

  const ensureChunkRow = useCallback(
    async (cs: ChunkedSong, idx: number): Promise<boolean> => {
      const bufs = await Promise.all(
        cs.stems.map((s) => ensureChunk(cs, s, idx)),
      );
      return bufs.every((b) => b != null);
    },
    [ensureChunk],
  );

  /**
   * Start chunked playback at `offsetSec`. Awaits only the chunk at the
   * playhead (~30s of audio), then plays instantly; later chunks decode on a
   * just-in-time schedule.
   *
   * Takes ownership synchronously: old sources are stopped, the JIT scheduler
   * is invalidated and the position clock is frozen at the target BEFORE the
   * await, so overlapping seeks/pauses cannot leave stale audio running.
   *
   * Returns "superseded" (a newer start/pause owns playback — touch nothing),
   * "failed" (target chunk undecodable) or "started".
   */
  const startChunkedAt = useCallback(
    async (offsetSec: number, cs: ChunkedSong): Promise<"started" | "superseded" | "failed"> => {
      const ctx = audioCtxRef.current;
      if (!ctx) return "failed";
      const seq = ++startSeqRef.current;
      const wantPlaying = playingRef.current;
      const wantSlug = cs.slug;

      const CD = cs.chunkSeconds;
      const dur = cs.duration || 1;
      const safeOffset = clamp(offsetSec, 0, dur);
      const i0 = Math.min(cs.counts[cs.stems[0]] - 1, Math.floor(safeOffset / CD));
      const intra = Math.max(0, safeOffset - i0 * CD);

      // --- Synchronous take-over: kill old audio NOW, freeze clock at target
      stopActiveSources(8);
      chunkSchedRef.current = null;
      startTimeRef.current = ctx.currentTime;
      startOffsetRef.current = safeOffset;
      pausedTimeRef.current = safeOffset;

      const firstBuf = cs.chunks.get(cs.stems[0])?.[i0] ?? null;
      if (!firstBuf) setBuffering(true);
      const ok = await ensureChunkRow(cs, i0);
      if (
        seq !== startSeqRef.current ||
        playingRef.current !== wantPlaying ||
        currentRef.current?.slug !== wantSlug
      ) {
        return "superseded"; // a newer start / pause / song switch owns state
      }
      setBuffering(false);
      if (!ok) return "failed";

      const g = graphNodesRef.current;
      if (!g) return "failed";

      routeStemGains();

      const rate = playbackRateRef.current;
      const now = ctx.currentTime + 0.01;
      startTimeRef.current = now;
      startOffsetRef.current = safeOffset;

      const leadBuf = cs.chunks.get(cs.stems[0])![i0]!;
      // Effective row duration: lossy codecs may decode with end padding
      // (e.g. Opus 20ms frames); clamp to the nominal boundary and hard-stop
      // sources there so scheduled rows stay sample-aligned.
      const rowDur = Math.min(leadBuf.duration, CD + 0.001);
      const rowWallDur = Math.max(0.05, (rowDur - intra) / rate);

      for (const stemName of cs.stems) {
        const buf = cs.chunks.get(stemName)![i0]!;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;

        let stemGain = g.stemGains.get(stemName);
        if (!stemGain) {
          const targetLevel = stemLevelsRef.current[stemName] ?? 1;
          stemGain = ctx.createGain();
          stemGain.gain.value = targetLevel;
          g.stemGains.set(stemName, stemGain);
          stemGain.connect(stemName === "drums" && pitchRef.current !== 0 ? g.bypass : g.pitchIn);
        }
        const targetLevel = stemLevelsRef.current[stemName] ?? 1;
        stemGain.gain.cancelScheduledValues(now);
        stemGain.gain.setValueAtTime(targetLevel, now);

        src.connect(stemGain);
        src.start(now, Math.min(intra, Math.max(0, buf.duration - 0.01)));
        src.stop(now + rowWallDur);
        activeSourcesRef.current.set(`${stemName}#${i0}`, src);
      }

      chunkSchedRef.current = {
        nextIdx: i0 + 1,
        nextWallTime: now + rowWallDur,
        kick: null,
      };
      return "started";
    },
    [ensureChunkRow, routeStemGains, stopActiveSources],
  );

  /** Schedule the next chunk row just-in-time. Called from the RAF loop. */
  const tickChunkScheduler = useCallback(() => {
    const sched = chunkSchedRef.current;
    const loaded = loadedBuffersRef.current;
    const ctx = audioCtxRef.current;
    if (!sched || !ctx || !loaded || loaded.kind !== "chunked") return;
    const cs = loaded;
    const rate = playbackRateRef.current;
    const lastIdx = cs.counts[cs.stems[0]] - 1;

    while (sched.nextIdx <= lastIdx) {
      const idx = sched.nextIdx;
      const remain = sched.nextWallTime - ctx.currentTime;

      if (remain > CHUNK_KICK_LEAD) return;

      if (!sched.kick) {
        sched.kick = ensureChunkRow(cs, idx).then((ok) => {
          sched.kick = null;
          return ok;
        });
      }
      if (remain > CHUNK_SCHEDULE_LEAD) return;

      const g = graphNodesRef.current;
      const leadBuf = cs.chunks.get(cs.stems[0])?.[idx];
      if (!g || !leadBuf) return; // not decoded yet — potential small gap

      // Clamp to the nominal chunk boundary (lossy padding defense) and
      // advance the schedule by the same effective duration.
      const rowDur = Math.min(leadBuf.duration, cs.chunkSeconds + 0.001);
      const when = Math.max(sched.nextWallTime, ctx.currentTime + 0.005);
      for (const stemName of cs.stems) {
        const buf = cs.chunks.get(stemName)![idx]!;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const stemGain = g.stemGains.get(stemName)!;
        src.connect(stemGain);
        src.start(when, 0);
        src.stop(when + rowDur / rate);
        activeSourcesRef.current.set(`${stemName}#${idx}`, src);
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
  }, [ensureChunkRow]);

  const prefetchAbortRef = useRef<AbortController | null>(null);

  // In-flight decode dedupe: a foreground play request joins an already running
  // background prefetch for the same song instead of decoding it twice.
  const inflightDecodesRef = useRef<Map<string, Promise<DecodedSongBuffers | null>>>(
    new Map(),
  );

  /**
   * Fetch + decode all tracks of a song in parallel.
   * Falls back to the main mix when every stem fails, so playback never
   * dead-ends in a silent fake-playing state.
   */
  const decodeSongBuffers = useCallback(
    async (
      song: SongSummary,
      signal?: AbortSignal,
      opts?: {
        background?: boolean;
        onTrackDone?: (done: number, total: number) => void;
      },
    ): Promise<DecodedSongBuffers | null> => {
      const cached = bufferCacheRef.current.get(song.slug);
      if (cached) return cached;

      const existing = inflightDecodesRef.current.get(song.slug);
      if (existing) return existing;

      const promise = (async (): Promise<DecodedSongBuffers> => {
        const ctx = getAudioContext();
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
            const buf = await ctx.decodeAudioData(ab);
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

        const result: DecodedSongBuffers = {
          kind: "full",
          slug: song.slug,
          mix: mixBuf,
          stems: stemsMap,
          duration: songDur,
        };

        if (stemsMap.size > 0 || mixBuf) {
          setBufferInCache(song.slug, result);
          if (currentRef.current?.slug === song.slug) {
            setDuration(result.duration);
            durationRef.current = result.duration;
          }
        }
        return result;
      })();

      inflightDecodesRef.current.set(song.slug, promise);
      try {
        return await promise;
      } finally {
        inflightDecodesRef.current.delete(song.slug);
      }
    },
    [getAudioContext, setBufferInCache],
  );

  // Proactive background prefetch of adjacent songs
  const prefetchAdjacentSongs = useCallback(
    (currentSong: SongSummary) => {
      prefetchAbortRef.current?.abort();
      const abortCtrl = new AbortController();
      prefetchAbortRef.current = abortCtrl;

      const allSongs = songsRef.current;
      if (allSongs.length === 0) return;
      const idx = allSongs.findIndex((s) => s.slug === currentSong.slug);
      if (idx === -1) return;

      const nextSong = allSongs[idx + 1] ?? allSongs[0];
      if (!nextSong || nextSong.slug === currentSong.slug) return;
      // Chunked: warming chunk 0 of every stem makes the next tap ~instant
      if (nextSong.chunks && nextSong.stems && nextSong.stems.length > 0) {
        const cs = getChunkedSong(nextSong);
        if (cs) {
          void ensureChunkRow(cs, 0).catch(() => undefined);
          return;
        }
      }
      void decodeSongBuffers(nextSong, abortCtrl.signal, { background: true });
    },
    [decodeSongBuffers, ensureChunkRow, getChunkedSong],
  );

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    const curT = getComputedCurrentTime();
    pausedTimeRef.current = curT;
    setCurrentTime(curT);
    stopActiveSources(8);
    setPlaying(false);
    playingRef.current = false;
  }, [getComputedCurrentTime, stopActiveSources]);

  /** Start playback at a song position, dispatching full vs chunked audio. */
  const startPlaybackAt = useCallback(
    (offsetSec: number): boolean => {
      const loaded = loadedBuffersRef.current;
      if (loaded?.kind === "chunked") {
        const cs = loaded;
        setPlaying(true); // optimistic; sources land once chunk is decoded
        playingRef.current = true;
        void startChunkedAt(offsetSec, cs).then((res) => {
          // "superseded": a newer start/pause owns playback — leave state alone
          if (res === "failed" && currentRef.current?.slug === cs.slug) {
            setPlaying(false);
            playingRef.current = false;
            setBuffering(false);
            setBuffered(0);
            chunkSchedRef.current = null;
          }
        });
        return true;
      }
      startSourcesAt(offsetSec);
      return true;
    },
    [startChunkedAt, startSourcesAt],
  );

  const play = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    startPlaybackAt(pausedTimeRef.current);
  }, [startPlaybackAt]);

  const toggle = useCallback(async () => {
    if (playingRef.current) {
      pause();
    } else {
      play();
    }
  }, [pause, play]);

  const playSong = useCallback(
    async (song: SongSummary) => {
      const cur = currentRef.current;
      if (cur?.slug === song.slug && loadedBuffersRef.current) {
        play();
        return;
      }

      stopActiveSources(8);
      playingRef.current = false;
      setPlaying(false);
      setCurrent(song);
      currentRef.current = song;
      loadedBuffersRef.current = null;
      setCurrentTime(0);
      currentTimeRef.current = 0;
      pausedTimeRef.current = 0;
      startOffsetRef.current = 0;
      startTimeRef.current = 0;
      setDuration(song.durationSeconds || 0);
      durationRef.current = song.durationSeconds || 0;
      setLoopState(null);
      setLoopEnabledState(false);
      loopRef.current = null;
      loopEnabledRef.current = false;

      // 1. Check memory cache (0ms instant start)
      const cached = bufferCacheRef.current.get(song.slug);
      if (cached) {
        loadedBuffersRef.current = cached;
        setDuration(cached.duration);
        durationRef.current = cached.duration;
        startSourcesAt(0, cached);
        setPlaying(true);
        playingRef.current = true;
        setBuffered(1);
        setBuffering(false);
        setTimeout(() => prefetchAdjacentSongs(song), 1000);
        return;
      }

      // 1.5 Chunked fast path: decode only the first ~30s row, start playing,
      // then stream the rest just-in-time from the RAF scheduler.
      const chunked = getChunkedSong(song);
      if (chunked) {
        loadedBuffersRef.current = chunked;
        setDuration(chunked.duration);
        durationRef.current = chunked.duration;
        setBuffering(true);
        setBuffered(0.05);

        await new Promise<void>((r) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              setTimeout(r, 30);
            }),
          );
        });

        const ctx = await ensureAudioGraph();
        if (ctx.state === "suspended") void ctx.resume();

        const res = await startChunkedAt(0, chunked);
        if (res === "superseded") return; // a seek/toggle during load owns it now
        if (res === "failed" || currentRef.current?.slug !== song.slug) {
          if (currentRef.current?.slug === song.slug) {
            setBuffering(false);
            setBuffered(0);
            setPlaying(false);
            playingRef.current = false;
          }
          return;
        }
        setPlaying(true);
        playingRef.current = true;
        setBuffered(1);
        setBuffering(false);
        setTimeout(() => prefetchAdjacentSongs(song), 800);
        return;
      }

      // 2. Decode path — global buffering UI shows instantly, mixer gains are
      //    guaranteed before the first sample.
      setBuffering(true);
      setBuffered(0.05);

      // Yield two frames + a beat so the spinner overlay is actually painted
      // before heavy parallel fetch/decode work starts competing for the main
      // thread on slow Android devices.
      await new Promise<void>((r) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setTimeout(r, 30);
          }),
        );
      });

      loadAbortRef.current?.abort();
      const abortCtrl = new AbortController();
      loadAbortRef.current = abortCtrl;
      const signal = abortCtrl.signal;

      // Fully-wired graph (stem gains at saved levels, worklet, master volume)
      // must exist before anything can play.
      const ctx = await ensureAudioGraph();
      if (ctx.state === "suspended") void ctx.resume();

      let buffers = await decodeSongBuffers(song, signal, {
        onTrackDone: (done, total) =>
          setBuffered(clamp(0.1 + (0.9 * done) / Math.max(1, total), 0, 0.99)),
      });
      if (signal.aborted || currentRef.current?.slug !== song.slug) return;

      // Joined an aborted background prefetch -> decode once more directly
      if (!buffers || (buffers.stems.size === 0 && !buffers.mix)) {
        buffers = await decodeSongBuffers(song, signal);
        if (signal.aborted || currentRef.current?.slug !== song.slug) return;
      }

      if (!buffers || (buffers.stems.size === 0 && !buffers.mix)) {
        // Nothing decodable — never enter a fake "playing" silence state
        setBuffering(false);
        setBuffered(0);
        setPlaying(false);
        playingRef.current = false;
        return;
      }

      loadedBuffersRef.current = buffers;
      setDuration(buffers.duration);
      durationRef.current = buffers.duration;
      setBuffered(1);
      setBuffering(false);

      startSourcesAt(0, buffers);
      setPlaying(true);
      playingRef.current = true;

      setTimeout(() => prefetchAdjacentSongs(song), 800);
    },
    [
      decodeSongBuffers,
      ensureAudioGraph,
      getChunkedSong,
      play,
      prefetchAdjacentSongs,
      startChunkedAt,
      startSourcesAt,
      stopActiveSources,
    ],
  );

  const playSongRef = useRef(playSong);
  playSongRef.current = playSong;

  const seek = useCallback(
    (time: number) => {
      const dur = durationRef.current || 0;
      const targetTime = clamp(time, 0, dur || time);
      pausedTimeRef.current = targetTime;
      setCurrentTime(targetTime);
      currentTimeRef.current = targetTime;

      if (playingRef.current) {
        startPlaybackAt(targetTime);
      }
    },
    [startPlaybackAt],
  );


  const skip = useCallback(
    (delta: number) => {
      const curT = getComputedCurrentTime();
      seek(curT + delta);
    },
    [getComputedCurrentTime, seek],
  );

  const persistMixer = useCallback(() => {
    saveMixerSettingsToStorage({
      stemLevels: stemLevelsRef.current,
      volume: volumeRef.current,
      muted: mutedRef.current,
      pitch: pitchRef.current,
      playbackRate: playbackRateRef.current,
    });
  }, []);

  const setStemLevel = useCallback(
    (name: string, level: number) => {
      const v = clamp(level, 0, 1);
      const next = { ...stemLevelsRef.current, [name]: v };
      setStemLevelsState(next);
      stemLevelsRef.current = next;
      applyStemGains(next);
      persistMixer();
    },
    [applyStemGains, persistMixer],
  );

  const resetStemLevels = useCallback(() => {
    const song = currentRef.current;
    if (!song?.stems) return;
    const next: Record<string, number> = {};
    for (const s of song.stems) next[s] = 1;
    setStemLevelsState(next);
    stemLevelsRef.current = next;
    applyStemGains(next);
    persistMixer();
  }, [applyStemGains, persistMixer]);

  const setPitch = useCallback(
    (semitones: number) => {
      const v = Math.round(clamp(semitones, -12, 12));
      setPitchState(v);
      pitchRef.current = v;
      const ctx = audioCtxRef.current;
      const node = graphNodesRef.current?.worklet;
      if (ctx && node) {
        node.parameters
          .get("ratio")
          ?.setTargetAtTime(2 ** (v / 12), ctx.currentTime, 0.03);
      }
      routeStemGains();
      persistMixer();
    },
    [persistMixer, routeStemGains],
  );

  const setVolume = useCallback(
    (v: number) => {
      const clamped = clamp(v, 0, 1);
      setVolumeState(clamped);
      volumeRef.current = clamped;
      const g = graphNodesRef.current;
      const ctx = audioCtxRef.current;
      if (g && ctx) {
        const target = mutedRef.current ? 0 : clamped;
        g.masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
      }
      persistMixer();
    },
    [persistMixer],
  );

  const setMuted = useCallback(
    (m: boolean) => {
      setMutedState(m);
      mutedRef.current = m;
      const g = graphNodesRef.current;
      const ctx = audioCtxRef.current;
      if (g && ctx) {
        const target = m ? 0 : volumeRef.current;
        g.masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
      }
      persistMixer();
    },
    [persistMixer],
  );

  const toggleMute = useCallback(() => {
    setMuted(!mutedRef.current);
  }, [setMuted]);

  const setPlaybackRate = useCallback(
    (rate: number) => {
      const r = clamp(rate, 0.25, 2);
      setPlaybackRateState(r);
      playbackRateRef.current = r;

      if (playingRef.current) {
        const curT = getComputedCurrentTime();
        pausedTimeRef.current = curT;
        startPlaybackAt(curT);
      }
      persistMixer();
    },
    [getComputedCurrentTime, persistMixer, startPlaybackAt],
  );

  const setLoop = useCallback((region: LoopRegion | null) => {
    if (!region) {
      setLoopState(null);
      loopRef.current = null;
      return;
    }
    const dur = durationRef.current || Infinity;
    let start = clamp(region.start, 0, dur);
    let end = clamp(region.end, 0, dur);
    if (end - start < MIN_LOOP) {
      end = clamp(start + MIN_LOOP, 0, dur);
      if (end - start < MIN_LOOP) {
        start = clamp(end - MIN_LOOP, 0, dur);
      }
    }
    if (end <= start) return;
    const next = { start, end };
    setLoopState(next);
    loopRef.current = next;
  }, []);

  const setLoopEnabled = useCallback(
    (on: boolean) => {
      setLoopEnabledState(on);
      loopEnabledRef.current = on;
      const lp = loopRef.current;
      if (on && lp) {
        const curT = getComputedCurrentTime();
        if (curT < lp.start || curT >= lp.end) {
          seek(lp.start);
        }
      }
    },
    [getComputedCurrentTime, seek],
  );

  const clearLoop = useCallback(() => {
    setLoopState(null);
    setLoopEnabledState(false);
    loopRef.current = null;
    loopEnabledRef.current = false;
  }, []);

  const setLoopIn = useCallback(() => {
    const t = getComputedCurrentTime();
    const end = loopRef.current?.end ?? Math.min(t + 8, durationRef.current || t + 8);
    setLoop({ start: t, end: Math.max(end, t + MIN_LOOP) });
    setLoopEnabled(true);
  }, [getComputedCurrentTime, setLoop, setLoopEnabled]);

  const setLoopOut = useCallback(() => {
    const t = getComputedCurrentTime();
    const start = loopRef.current?.start ?? Math.max(0, t - 8);
    setLoop({ start: Math.min(start, t - MIN_LOOP), end: t });
    setLoopEnabled(true);
  }, [getComputedCurrentTime, setLoop, setLoopEnabled]);

  const setPlaybackMode = useCallback((mode: PlaybackMode) => {
    playbackModeRef.current = mode;
    setPlaybackModeState(mode);
  }, []);

  const playNext = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    const idx = songsRef.current.findIndex((s) => s.slug === cur.slug);
    const next =
      songsRef.current[idx + 1] ??
      (playbackModeRef.current === "repeat-all" ? songsRef.current[0] : undefined);
    if (next) void playSongRef.current(next);
  }, []);

  const playPrev = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    const curT = getComputedCurrentTime();
    if (curT > 3) {
      seek(0);
      return;
    }
    const idx = songsRef.current.findIndex((s) => s.slug === cur.slug);
    const prev = songsRef.current[idx - 1];
    if (prev) void playSongRef.current(prev);
    else seek(0);
  }, [getComputedCurrentTime, seek]);

  // Main playback animation & loop / end trigger loop
  useEffect(() => {
    let animId = 0;
    const checkPlayback = () => {
      if (playingRef.current) {
        tickChunkScheduler();
        const t = getComputedCurrentTime();
        const dur = durationRef.current;
        const lp = loopRef.current;

        // Loop handling
        if (loopEnabledRef.current && lp && lp.end > lp.start) {
          if (t >= lp.end - 0.02) {
            seek(lp.start);
            animId = requestAnimationFrame(checkPlayback);
            return;
          }
        }

        // Track ended handling: strictly check that we are playing, valid song, valid duration, and reached end
        if (
          playingRef.current &&
          currentRef.current &&
          dur > 1 &&
          t >= dur - 0.05 &&
          t > 0.5
        ) {
          const cur = currentRef.current;
          const idx = cur ? songsRef.current.findIndex((s) => s.slug === cur.slug) : -1;
          if (loopEnabledRef.current && lp) {
            seek(lp.start);
          } else if (playbackModeRef.current === "repeat-one") {
            seek(0);
          } else if (idx !== -1) {
            const next =
              songsRef.current[idx + 1] ??
              (playbackModeRef.current === "repeat-all" ? songsRef.current[0] : undefined);
            if (next) {
              void playSongRef.current(next);
            } else {
              pause();
              seek(0);
            }
          } else {
            pause();
            seek(0);
          }
          animId = requestAnimationFrame(checkPlayback);
          return;
        }

        setCurrentTime(t);
        currentTimeRef.current = t;
      }
      animId = requestAnimationFrame(checkPlayback);
    };

    animId = requestAnimationFrame(checkPlayback);
    return () => {
      if (animId) cancelAnimationFrame(animId);
      stopActiveSources();
    };
  }, [getComputedCurrentTime, pause, playNext, seek, stopActiveSources, tickChunkScheduler]);

  return {
    current,
    playing,
    currentTime,
    duration: duration || current?.durationSeconds || 0,
    volume,
    muted,
    playbackRate,
    loop,
    loopEnabled,
    buffered,
    buffering,
    playbackMode,
    stemLevels,
    pitch,
    playSong,
    toggle,
    play,
    pause,
    setStemLevel,
    resetStemLevels,
    setPitch,
    seek,
    skip,
    setVolume,
    setMuted,
    toggleMute,
    setPlaybackRate,
    setPlaybackMode,
    setLoop,
    setLoopEnabled,
    clearLoop,
    setLoopIn,
    setLoopOut,
    playNext,
    playPrev,
  };
}
