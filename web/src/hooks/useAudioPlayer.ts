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
  slug: string;
  mix: AudioBuffer | null;
  stems: Map<string, AudioBuffer>;
  duration: number;
};

// Maximum number of full song buffers to keep in memory (LRU sliding window)
const MAX_CACHE_SONGS = 8;

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
  const loadedBuffersRef = useRef<DecodedSongBuffers | null>(null);
  const bufferCacheRef = useRef<Map<string, DecodedSongBuffers>>(new Map());
  const activeSourcesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());
  const loadAbortRef = useRef<AbortController | null>(null);

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

  const ensureAudioGraph = useCallback(async () => {
    if (!audioCtxRef.current) {
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      audioCtxRef.current = ctx;

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
    }
    return audioCtxRef.current;
  }, []);

  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      audioCtxRef.current = ctx;
      void ensureAudioGraph();
    }
    return audioCtxRef.current;
  }, [ensureAudioGraph]);

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
    (offsetSec: number, targetBuffers?: DecodedSongBuffers, fadeMs = 8) => {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") void ctx.resume();

      const buffers = targetBuffers ?? loadedBuffersRef.current;
      if (!buffers) return;

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

          let stemGain = g.stemGains.get(stemName);
          if (!stemGain) {
            stemGain = ctx.createGain();
            g.stemGains.set(stemName, stemGain);
            if (stemName === "drums" && pitchRef.current !== 0) {
              stemGain.connect(g.bypass);
            } else {
              stemGain.connect(g.pitchIn);
            }
          }

          const targetLevel = stemLevelsRef.current[stemName] ?? 1;
          stemGain.gain.cancelScheduledValues(0);
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

  const prefetchAbortRef = useRef<AbortController | null>(null);

  // Decode all stems for a song directly in parallel (instant for FLAC)
  const loadSongAudioBuffers = useCallback(
    async (
      song: SongSummary,
      signal?: AbortSignal,
      isBackground = false,
    ): Promise<DecodedSongBuffers | null> => {
      const cached = bufferCacheRef.current.get(song.slug);
      if (cached) {
        if (!isBackground) {
          setBuffered(1);
          setBuffering(false);
        }
        return cached;
      }

      if (!isBackground) setBuffering(true);
      const ctx = getAudioContext();
      const stemsMap = new Map<string, AudioBuffer>();
      let mixBuf: AudioBuffer | null = null;
      let songDur = song.durationSeconds || 0;

      const decodeTrack = async (url: string): Promise<AudioBuffer | null> => {
        try {
          const res = await fetch(url, { signal });
          if (!res.ok) return null;
          const ab = await res.arrayBuffer();
          return await ctx.decodeAudioData(ab);
        } catch {
          return null;
        }
      };

      if (song.stems && song.stems.length > 0 && (song.stemUrls || song.stemBaseUrl)) {
        await Promise.all(
          song.stems.map(async (s) => {
            const url = stemUrl(song, s);
            if (!url) return;
            const buf = await decodeTrack(url);
            if (buf) {
              stemsMap.set(s, buf);
              if (buf.duration > songDur) songDur = buf.duration;
            }
          }),
        );
      } else if (song.audioUrl) {
        mixBuf = await decodeTrack(song.audioUrl);
        if (mixBuf && mixBuf.duration > songDur) songDur = mixBuf.duration;
      }

      const result: DecodedSongBuffers = {
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

      if (!isBackground && currentRef.current?.slug === song.slug) {
        setBuffered(1);
        setBuffering(false);
      }
      return result;
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
      if (nextSong && nextSong.slug !== currentSong.slug) {
        void loadSongAudioBuffers(nextSong, abortCtrl.signal, true);
      }
    },
    [loadSongAudioBuffers],
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

  const play = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    const curT = pausedTimeRef.current;
    startSourcesAt(curT);
    setPlaying(true);
    playingRef.current = true;
  }, [startSourcesAt]);

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

      // 2. Direct Parallel Stem Decode (Clean & Reliable)
      setBuffering(true);
      setBuffered(0.2);

      // Yield 20ms so browser paints the loading spinners immediately before CPU decode starts
      await new Promise((r) => setTimeout(r, 20));

      loadAbortRef.current?.abort();
      const abortCtrl = new AbortController();
      loadAbortRef.current = abortCtrl;
      const signal = abortCtrl.signal;

      const ctx = await ensureAudioGraph();
      if (ctx.state === "suspended") void ctx.resume();

      const decodeTrack = async (url: string): Promise<AudioBuffer | null> => {
        try {
          console.log(`[AudioPlayer] Fetching: ${url}`);
          const res = await fetch(url, { signal });
          if (!res.ok) {
            console.error(`[AudioPlayer] Fetch failed HTTP ${res.status}: ${url}`);
            return null;
          }
          const ab = await res.arrayBuffer();
          const buf = await ctx.decodeAudioData(ab);
          console.log(`[AudioPlayer] Decoded OK (${buf.duration.toFixed(1)}s): ${url}`);
          return buf;
        } catch (err) {
          console.error(`[AudioPlayer] Decode error for ${url}:`, err);
          return null;
        }
      };

      const stemsMap = new Map<string, AudioBuffer>();
      let mixBuf: AudioBuffer | null = null;
      let songDur = song.durationSeconds || 0;

      if (song.stems && song.stems.length > 0 && (song.stemUrls || song.stemBaseUrl)) {
        await Promise.all(
          song.stems.map(async (s) => {
            const url = stemUrl(song, s);
            if (!url) return;
            const buf = await decodeTrack(url);
            if (buf) stemsMap.set(s, buf);
          }),
        );
      } else if (song.audioUrl) {
        mixBuf = await decodeTrack(song.audioUrl);
      }

      if (signal.aborted || currentRef.current?.slug !== song.slug) return;

      let maxDur = songDur;
      for (const b of stemsMap.values()) {
        if (b.duration > maxDur) maxDur = b.duration;
      }
      if (mixBuf && mixBuf.duration > maxDur) maxDur = mixBuf.duration;

      const fullBuffers: DecodedSongBuffers = {
        slug: song.slug,
        mix: mixBuf,
        stems: stemsMap,
        duration: maxDur,
      };

      setBufferInCache(song.slug, fullBuffers);
      loadedBuffersRef.current = fullBuffers;
      setDuration(maxDur);
      durationRef.current = maxDur;
      setBuffered(1);
      setBuffering(false);

      startSourcesAt(0, fullBuffers);
      setPlaying(true);
      playingRef.current = true;

      setTimeout(() => prefetchAdjacentSongs(song), 800);
    },
    [
      getAudioContext,
      getComputedCurrentTime,
      play,
      prefetchAdjacentSongs,
      setBufferInCache,
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
        startSourcesAt(targetTime);
      }
    },
    [startSourcesAt],
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
        startSourcesAt(curT);
      }
      persistMixer();
    },
    [getComputedCurrentTime, persistMixer, startSourcesAt],
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
  }, [getComputedCurrentTime, pause, playNext, seek, stopActiveSources]);

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
