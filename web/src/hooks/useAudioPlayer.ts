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

/** stem files: `${stemBaseUrl}${stem}.mp3` */
function stemUrl(song: SongSummary, stem: string): string | null {
  if (song.stemBaseUrl && song.stems?.includes(stem)) {
    return `${song.stemBaseUrl}${encodeURIComponent(stem)}.mp3`;
  }
  return null;
}

type DecodedSongBuffers = {
  slug: string;
  mix: AudioBuffer | null;
  stems: Map<string, AudioBuffer>;
  duration: number;
};

export function useAudioPlayer(songs: SongSummary[]) {
  const songsRef = useRef(songs);
  songsRef.current = songs;

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

  const [volume, setVolumeState] = useState(0.85);
  const volumeRef = useRef(0.85);
  volumeRef.current = volume;

  const [muted, setMutedState] = useState(false);
  const mutedRef = useRef(false);
  mutedRef.current = muted;

  const [playbackRate, setPlaybackRateState] = useState(1);
  const playbackRateRef = useRef(1);
  playbackRateRef.current = playbackRate;

  const [loop, setLoopState] = useState<LoopRegion | null>(null);
  const loopRef = useRef<LoopRegion | null>(null);
  loopRef.current = loop;

  const [loopEnabled, setLoopEnabledState] = useState(false);
  const loopEnabledRef = useRef(false);
  loopEnabledRef.current = loopEnabled;

  const [buffered, setBuffered] = useState(0); // 0–1 fraction
  const [playbackMode, setPlaybackModeState] = useState<PlaybackMode>("sequential");
  const playbackModeRef = useRef<PlaybackMode>("sequential");
  playbackModeRef.current = playbackMode;

  const [stemLevels, setStemLevelsState] = useState<Record<string, number>>({});
  const stemLevelsRef = useRef<Record<string, number>>({});
  stemLevelsRef.current = stemLevels;

  const [pitch, setPitchState] = useState(0);
  const pitchRef = useRef(0);
  pitchRef.current = pitch;

  // --- Web Audio Graph & Buffers ---
  const audioCtxRef = useRef<AudioContext | null>(null);
  const loadedBuffersRef = useRef<DecodedSongBuffers | null>(null);
  const bufferCacheRef = useRef<Map<string, DecodedSongBuffers>>(new Map());
  const activeSourcesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadReqIdRef = useRef(0);

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

  const getAudioContext = useCallback(() => {
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
      mixGain.connect(pitchIn);
      pitchIn.connect(postPitchGain);
      postPitchGain.connect(masterGain);
      bypass.connect(bypassDelay);
      bypassDelay.connect(masterGain);

      const stemGains = new Map<string, GainNode>();
      for (const s of ["vocals", "drums", "bass", "other"]) {
        const sg = ctx.createGain();
        sg.gain.value = 1;
        stemGains.set(s, sg);
      }

      graphNodesRef.current = {
        masterGain,
        mixGain,
        pitchIn,
        bypass,
        bypassDelay,
        postPitchGain,
        worklet: null,
        stemGains,
      };

      // Lazy load pitch worklet
      void registerPitchWorklet(ctx)
        .then(() => {
          if (!audioCtxRef.current || !graphNodesRef.current) return;
          const node = createPitchNode(ctx);
          const g = graphNodesRef.current;
          g.pitchIn.disconnect();
          g.pitchIn.connect(node);
          node.connect(g.postPitchGain);
          g.worklet = node;
          if (pitchRef.current !== 0) {
            node.parameters
              .get("ratio")
              ?.setTargetAtTime(2 ** (pitchRef.current / 12), ctx.currentTime, 0.03);
          }
        })
        .catch((e) => {
          console.warn("Pitch worklet registration failed; falling back to direct pass:", e);
        });
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

  const stopActiveSources = useCallback(() => {
    for (const src of activeSourcesRef.current.values()) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    activeSourcesRef.current.clear();
  }, []);

  const startSourcesAt = useCallback(
    (offsetSec: number) => {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") void ctx.resume();

      const buffers = loadedBuffersRef.current;
      if (!buffers) return;

      stopActiveSources();
      routeStemGains();
      applyStemGains(stemLevelsRef.current);

      const song = currentRef.current;
      const g = graphNodesRef.current;
      if (!g) return;

      const dur = buffers.duration || durationRef.current || 1;
      const safeOffset = clamp(offsetSec, 0, dur);

      const now = ctx.currentTime + 0.02; // 20ms lead time for sub-sample hardware sync
      startTimeRef.current = now;
      startOffsetRef.current = safeOffset;
      pausedTimeRef.current = safeOffset;

      const hasStems = song?.stems && song.stems.length > 0 && buffers.stems.size > 0;

      if (hasStems) {
        // Start all stems with exact sample clock synchronization
        for (const [stemName, buf] of buffers.stems) {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = playbackRateRef.current;

          let stemGain = g.stemGains.get(stemName);
          if (!stemGain) {
            stemGain = ctx.createGain();
            stemGain.gain.value = stemLevelsRef.current[stemName] ?? 1;
            g.stemGains.set(stemName, stemGain);
            if (stemName === "drums" && pitchRef.current !== 0) {
              stemGain.connect(g.bypass);
            } else {
              stemGain.connect(g.pitchIn);
            }
          }

          src.connect(stemGain);
          src.start(now, safeOffset);
          activeSourcesRef.current.set(stemName, src);
        }
      } else if (buffers.mix) {
        // Fallback to stereo mix
        const src = ctx.createBufferSource();
        src.buffer = buffers.mix;
        src.playbackRate.value = playbackRateRef.current;
        src.connect(g.mixGain);
        src.start(now, safeOffset);
        activeSourcesRef.current.set("mix", src);
      }
    },
    [applyStemGains, getAudioContext, routeStemGains, stopActiveSources],
  );

  const getComputedCurrentTime = useCallback(() => {
    if (!playingRef.current) return pausedTimeRef.current;
    const ctx = audioCtxRef.current;
    if (!ctx) return pausedTimeRef.current;
    const elapsed = (ctx.currentTime - startTimeRef.current) * playbackRateRef.current;
    return Math.max(0, startOffsetRef.current + elapsed);
  }, []);

  // Fetch and decode song audio (mix + stems) into memory
  const loadSongAudioBuffers = useCallback(
    async (song: SongSummary): Promise<DecodedSongBuffers | null> => {
      const cached = bufferCacheRef.current.get(song.slug);
      if (cached) return cached;

      loadAbortRef.current?.abort();
      const abortCtrl = new AbortController();
      loadAbortRef.current = abortCtrl;
      const reqId = ++loadReqIdRef.current;

      const ctx = getAudioContext();
      const stemsMap = new Map<string, AudioBuffer>();
      let mixBuf: AudioBuffer | null = null;
      let songDur = song.durationSeconds || 0;

      const decodeUrl = async (url: string): Promise<AudioBuffer | null> => {
        try {
          const res = await fetch(url, { signal: abortCtrl.signal });
          if (!res.ok) return null;
          const ab = await res.arrayBuffer();
          return await ctx.decodeAudioData(ab);
        } catch {
          return null;
        }
      };

      setBuffered(0.1);

      // Load stems in parallel if available
      if (song.stems && song.stems.length > 0 && song.stemBaseUrl) {
        const stemPromises = song.stems.map(async (s) => {
          const url = stemUrl(song, s);
          if (!url) return;
          const buf = await decodeUrl(url);
          if (buf) {
            stemsMap.set(s, buf);
            if (buf.duration > songDur) songDur = buf.duration;
          }
        });
        await Promise.all(stemPromises);
      }

      // If no stems loaded or mix is needed as fallback
      if (stemsMap.size === 0 && song.audioUrl) {
        mixBuf = await decodeUrl(song.audioUrl);
        if (mixBuf && mixBuf.duration > songDur) songDur = mixBuf.duration;
      }

      if (reqId !== loadReqIdRef.current) return null;

      const result: DecodedSongBuffers = {
        slug: song.slug,
        mix: mixBuf,
        stems: stemsMap,
        duration: songDur,
      };

      bufferCacheRef.current.set(song.slug, result);
      setBuffered(1);
      return result;
    },
    [getAudioContext],
  );

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    const curTime = getComputedCurrentTime();
    pausedTimeRef.current = curTime;
    setCurrentTime(curTime);
    setPlaying(false);
    playingRef.current = false;
    stopActiveSources();
  }, [getComputedCurrentTime, stopActiveSources]);

  const play = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    const ctx = getAudioContext();
    if (ctx.state === "suspended") void ctx.resume();

    const t = pausedTimeRef.current;
    startSourcesAt(t);
    setPlaying(true);
    playingRef.current = true;
  }, [getAudioContext, startSourcesAt]);

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

      // Stop previous
      pause();
      stopActiveSources();
      setLoopState(null);
      setLoopEnabledState(false);
      loopRef.current = null;
      loopEnabledRef.current = false;

      setCurrent(song);
      setCurrentTime(0);
      pausedTimeRef.current = 0;
      setDuration(song.durationSeconds || 0);

      const buffers = await loadSongAudioBuffers(song);
      if (!buffers) return;

      loadedBuffersRef.current = buffers;
      setDuration(buffers.duration);
      durationRef.current = buffers.duration;

      // Start playing
      startSourcesAt(0);
      setPlaying(true);
      playingRef.current = true;
    },
    [loadSongAudioBuffers, pause, play, startSourcesAt, stopActiveSources],
  );

  const playSongRef = useRef(playSong);
  playSongRef.current = playSong;

  const seek = useCallback(
    (time: number) => {
      const dur = durationRef.current || 0;
      const targetTime = clamp(time, 0, dur || time);
      pausedTimeRef.current = targetTime;
      setCurrentTime(targetTime);

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

  const setStemLevel = useCallback(
    (name: string, level: number) => {
      const v = clamp(level, 0, 1);
      const next = { ...stemLevelsRef.current, [name]: v };
      setStemLevelsState(next);
      stemLevelsRef.current = next;
      applyStemGains(next);
    },
    [applyStemGains],
  );

  const resetStemLevels = useCallback(() => {
    const song = currentRef.current;
    if (!song?.stems) return;
    const next: Record<string, number> = {};
    for (const s of song.stems) next[s] = 1;
    setStemLevelsState(next);
    stemLevelsRef.current = next;
    applyStemGains(next);
  }, [applyStemGains]);

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
    },
    [routeStemGains],
  );

  const setVolume = useCallback((v: number) => {
    const clamped = clamp(v, 0, 1);
    setVolumeState(clamped);
    volumeRef.current = clamped;
    const g = graphNodesRef.current;
    const ctx = audioCtxRef.current;
    if (g && ctx) {
      const target = mutedRef.current ? 0 : clamped;
      g.masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
    }
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    mutedRef.current = m;
    const g = graphNodesRef.current;
    const ctx = audioCtxRef.current;
    if (g && ctx) {
      const target = m ? 0 : volumeRef.current;
      g.masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
    }
  }, []);

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
    },
    [getComputedCurrentTime, startSourcesAt],
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

        // Track ended handling
        if (dur > 0 && t >= dur) {
          if (loopEnabledRef.current && lp) {
            seek(lp.start);
          } else if (playbackModeRef.current === "repeat-one") {
            seek(0);
          } else {
            pause();
            playNext();
          }
          animId = requestAnimationFrame(checkPlayback);
          return;
        }

        setCurrentTime(t);
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
