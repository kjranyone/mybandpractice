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

/** stem files: `${stemBaseUrl}${stem}.mp3` */
function stemUrl(song: SongSummary, stem: string): string | null {
  if (song.stemBaseUrl && song.stems?.includes(stem)) {
    return `${song.stemBaseUrl}${encodeURIComponent(stem)}.mp3`;
  }
  return null;
}

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

  // --- Web Audio Graph & Persistent HTMLAudioElement Stream Pool ---
  const audioCtxRef = useRef<AudioContext | null>(null);

  // 5 Dedicated HTMLAudioElements permanently bound to Web Audio MediaElementSources
  const elementsRef = useRef<{
    mix: HTMLAudioElement;
    vocals: HTMLAudioElement;
    drums: HTMLAudioElement;
    bass: HTMLAudioElement;
    other: HTMLAudioElement;
  } | null>(null);

  const graphNodesRef = useRef<{
    masterGain: GainNode;
    declickGain: GainNode;
    mixGain: GainNode;
    pitchIn: GainNode;
    bypass: GainNode;
    bypassDelay: DelayNode;
    postPitchGain: GainNode;
    worklet: AudioWorkletNode | null;
    stemGains: Map<string, GainNode>;
  } | null>(null);

  // Initialize Web Audio Graph and Stream Pool
  const getAudioEngine = useCallback(() => {
    if (!audioCtxRef.current) {
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      audioCtxRef.current = ctx;

      // Master output & De-clicking chain
      const masterGain = ctx.createGain();
      masterGain.gain.value = mutedRef.current ? 0 : volumeRef.current;
      masterGain.connect(ctx.destination);

      const declickGain = ctx.createGain();
      declickGain.gain.value = 1;
      declickGain.connect(masterGain);

      const mixGain = ctx.createGain();
      const pitchIn = ctx.createGain();
      const bypass = ctx.createGain();
      const bypassDelay = ctx.createDelay(0.5);
      bypassDelay.delayTime.value = (1.5 * PITCH_GRAIN_SAMPLES + 128) / ctx.sampleRate;

      const postPitchGain = ctx.createGain();
      mixGain.connect(pitchIn);
      pitchIn.connect(postPitchGain);
      postPitchGain.connect(declickGain);
      bypass.connect(bypassDelay);
      bypassDelay.connect(declickGain);

      const stemGains = new Map<string, GainNode>();
      for (const s of ["vocals", "drums", "bass", "other"]) {
        const sg = ctx.createGain();
        sg.gain.value = 1;
        sg.connect(pitchIn);
        stemGains.set(s, sg);
      }

      graphNodesRef.current = {
        masterGain,
        declickGain,
        mixGain,
        pitchIn,
        bypass,
        bypassDelay,
        postPitchGain,
        worklet: null,
        stemGains,
      };

      // Create persistent HTMLAudioElements with Web Audio MediaElementSource bindings
      const createStreamEl = (targetGain: GainNode) => {
        const el = new Audio();
        el.crossOrigin = "anonymous";
        el.preload = "auto";
        el.addEventListener("progress", () => {
          if (el.duration > 0 && el.buffered.length > 0) {
            setBuffered(el.buffered.end(el.buffered.length - 1) / el.duration);
          }
        });
        const srcNode = ctx.createMediaElementSource(el);
        srcNode.connect(targetGain);
        return el;
      };

      elementsRef.current = {
        mix: createStreamEl(mixGain),
        vocals: createStreamEl(stemGains.get("vocals")!),
        drums: createStreamEl(stemGains.get("drums")!),
        bass: createStreamEl(stemGains.get("bass")!),
        other: createStreamEl(stemGains.get("other")!),
      };

      // Register Pitch Shift Worklet
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
    return { ctx: audioCtxRef.current, elements: elementsRef.current!, graph: graphNodesRef.current! };
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

  // Apply saved mixer levels on mount
  useEffect(() => {
    routeStemGains();
    applyStemGains(stemLevelsRef.current);
  }, [applyStemGains, routeStemGains]);

  // 8ms Micro-crossfade de-clicking
  const executeWithDeclick = useCallback((action: () => void, fadeMs = 8) => {
    const { ctx, graph } = getAudioEngine();
    if (ctx.state === "suspended") void ctx.resume();

    const t = ctx.currentTime;
    const fadeSec = fadeMs / 1000;

    // Fast micro-fade out
    graph.declickGain.gain.cancelScheduledValues(t);
    graph.declickGain.gain.setValueAtTime(graph.declickGain.gain.value, t);
    graph.declickGain.gain.linearRampToValueAtTime(0, t + fadeSec);

    setTimeout(() => {
      action();
      // Fast micro-fade in
      const tAfter = ctx.currentTime;
      graph.declickGain.gain.cancelScheduledValues(tAfter);
      graph.declickGain.gain.setValueAtTime(0, tAfter);
      graph.declickGain.gain.linearRampToValueAtTime(1, tAfter + fadeSec);
    }, fadeMs + 2);
  }, [getAudioEngine]);

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    executeWithDeclick(() => {
      const { elements } = getAudioEngine();
      elements.mix.pause();
      elements.vocals.pause();
      elements.drums.pause();
      elements.bass.pause();
      elements.other.pause();
      setPlaying(false);
      playingRef.current = false;
    });
  }, [executeWithDeclick, getAudioEngine]);

  const play = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    const { ctx, elements } = getAudioEngine();
    if (ctx.state === "suspended") void ctx.resume();

    executeWithDeclick(() => {
      const hasStems = cur.stems && cur.stems.length > 0 && cur.stemBaseUrl;
      const rate = playbackRateRef.current;

      if (hasStems) {
        elements.mix.pause();
        for (const s of cur.stems!) {
          const el = elements[s as keyof typeof elements];
          if (el && el.src) {
            el.playbackRate = rate;
            void el.play().catch(() => {});
          }
        }
      } else if (cur.audioUrl) {
        elements.mix.playbackRate = rate;
        void elements.mix.play().catch(() => {});
      }
      setPlaying(true);
      playingRef.current = true;
    });
  }, [executeWithDeclick, getAudioEngine]);

  const toggle = useCallback(async () => {
    if (playingRef.current) {
      pause();
    } else {
      play();
    }
  }, [pause, play]);

  const playSong = useCallback(
    (song: SongSummary) => {
      const cur = currentRef.current;
      const { ctx, elements } = getAudioEngine();
      if (ctx.state === "suspended") void ctx.resume();

      if (cur?.slug === song.slug) {
        play();
        return;
      }

      executeWithDeclick(() => {
        // Stop current
        elements.mix.pause();
        elements.vocals.pause();
        elements.drums.pause();
        elements.bass.pause();
        elements.other.pause();

        setLoopState(null);
        setLoopEnabledState(false);
        loopRef.current = null;
        loopEnabledRef.current = false;

        setCurrent(song);
        setCurrentTime(0);
        currentTimeRef.current = 0;
        setDuration(song.durationSeconds || 0);
        durationRef.current = song.durationSeconds || 0;

        routeStemGains();
        applyStemGains(stemLevelsRef.current);

        const hasStems = song.stems && song.stems.length > 0 && song.stemBaseUrl;
        const rate = playbackRateRef.current;

        if (hasStems) {
          elements.mix.src = "";
          for (const s of ["vocals", "drums", "bass", "other"]) {
            const el = elements[s as keyof typeof elements];
            if (song.stems!.includes(s)) {
              el.src = stemUrl(song, s)!;
              el.currentTime = 0;
              el.playbackRate = rate;
              void el.play().catch(() => {});
            } else {
              el.src = "";
            }
          }
        } else if (song.audioUrl) {
          elements.vocals.src = "";
          elements.drums.src = "";
          elements.bass.src = "";
          elements.other.src = "";
          elements.mix.src = song.audioUrl;
          elements.mix.currentTime = 0;
          elements.mix.playbackRate = rate;
          void elements.mix.play().catch(() => {});
        }

        setPlaying(true);
        playingRef.current = true;
      });
    },
    [applyStemGains, executeWithDeclick, getAudioEngine, play, routeStemGains],
  );

  const playSongRef = useRef(playSong);
  playSongRef.current = playSong;

  const seek = useCallback(
    (time: number) => {
      const dur = durationRef.current || 0;
      const targetTime = clamp(time, 0, dur || time);
      setCurrentTime(targetTime);
      currentTimeRef.current = targetTime;

      executeWithDeclick(() => {
        const { elements } = getAudioEngine();
        const cur = currentRef.current;
        const hasStems = cur?.stems && cur.stems.length > 0 && cur.stemBaseUrl;

        if (hasStems) {
          for (const s of cur.stems!) {
            const el = elements[s as keyof typeof elements];
            if (el && el.src) {
              el.currentTime = targetTime;
            }
          }
        } else if (elements.mix.src) {
          elements.mix.currentTime = targetTime;
        }
      });
    },
    [executeWithDeclick, getAudioEngine],
  );

  const skip = useCallback(
    (delta: number) => {
      seek(currentTimeRef.current + delta);
    },
    [seek],
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
      const { ctx, graph } = getAudioEngine();
      if (graph.worklet) {
        graph.worklet.parameters
          .get("ratio")
          ?.setTargetAtTime(2 ** (v / 12), ctx.currentTime, 0.03);
      }
      routeStemGains();
      persistMixer();
    },
    [getAudioEngine, persistMixer, routeStemGains],
  );

  const setVolume = useCallback(
    (v: number) => {
      const clamped = clamp(v, 0, 1);
      setVolumeState(clamped);
      volumeRef.current = clamped;
      const { ctx, graph } = getAudioEngine();
      const target = mutedRef.current ? 0 : clamped;
      graph.masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
      persistMixer();
    },
    [getAudioEngine, persistMixer],
  );

  const setMuted = useCallback(
    (m: boolean) => {
      setMutedState(m);
      mutedRef.current = m;
      const { ctx, graph } = getAudioEngine();
      const target = m ? 0 : volumeRef.current;
      graph.masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
      persistMixer();
    },
    [getAudioEngine, persistMixer],
  );

  const toggleMute = useCallback(() => {
    setMuted(!mutedRef.current);
  }, [setMuted]);

  const setPlaybackRate = useCallback(
    (rate: number) => {
      const r = clamp(rate, 0.25, 2);
      setPlaybackRateState(r);
      playbackRateRef.current = r;
      const { elements } = getAudioEngine();
      for (const el of Object.values(elements)) {
        el.playbackRate = r;
      }
      persistMixer();
    },
    [getAudioEngine, persistMixer],
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
        const curT = currentTimeRef.current;
        if (curT < lp.start || curT >= lp.end) {
          seek(lp.start);
        }
      }
    },
    [seek],
  );

  const clearLoop = useCallback(() => {
    setLoopState(null);
    setLoopEnabledState(false);
    loopRef.current = null;
    loopEnabledRef.current = false;
  }, []);

  const setLoopIn = useCallback(() => {
    const t = currentTimeRef.current;
    const end = loopRef.current?.end ?? Math.min(t + 8, durationRef.current || t + 8);
    setLoop({ start: t, end: Math.max(end, t + MIN_LOOP) });
    setLoopEnabled(true);
  }, [setLoop, setLoopEnabled]);

  const setLoopOut = useCallback(() => {
    const t = currentTimeRef.current;
    const start = loopRef.current?.start ?? Math.max(0, t - 8);
    setLoop({ start: Math.min(start, t - MIN_LOOP), end: t });
    setLoopEnabled(true);
  }, [setLoop, setLoopEnabled]);

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
    const curT = currentTimeRef.current;
    if (curT > 3) {
      seek(0);
      return;
    }
    const idx = songsRef.current.findIndex((s) => s.slug === cur.slug);
    const prev = songsRef.current[idx - 1];
    if (prev) void playSongRef.current(prev);
    else seek(0);
  }, [seek]);

  // Master PLL Phase Sync, Position Tracking & Loop / End Detection Loop
  useEffect(() => {
    let animId = 0;
    const { elements } = getAudioEngine();

    const checkPlayback = () => {
      if (playingRef.current) {
        const cur = currentRef.current;
        const hasStems = cur?.stems && cur.stems.length > 0 && cur.stemBaseUrl;

        // Choose master clock element (drums -> vocals -> mix)
        const masterEl = hasStems
          ? elements.drums.src
            ? elements.drums
            : elements.vocals
          : elements.mix;

        const masterT = masterEl.currentTime || 0;
        const dur = masterEl.duration || durationRef.current || cur?.durationSeconds || 0;
        const lp = loopRef.current;

        // PLL Phase Synchronization: Keep all stems synchronized to master clock within ±5ms
        if (hasStems && masterT > 0.05) {
          const baseRate = playbackRateRef.current;
          for (const s of cur.stems!) {
            const follower = elements[s as keyof typeof elements];
            if (follower && follower !== masterEl && follower.src && !follower.paused) {
              const delta = masterT - follower.currentTime;
              if (Math.abs(delta) > 0.035) {
                // Hard jump for large drift (>35ms)
                follower.currentTime = masterT;
              } else if (Math.abs(delta) > 0.005) {
                // Micro PLL speed compensation for minor drift (5-35ms)
                follower.playbackRate = baseRate * (1 + delta * 0.5);
              } else {
                follower.playbackRate = baseRate;
              }
            }
          }
        }

        // Loop handling
        if (loopEnabledRef.current && lp && lp.end > lp.start) {
          if (masterT >= lp.end - 0.02) {
            seek(lp.start);
            animId = requestAnimationFrame(checkPlayback);
            return;
          }
        }

        // Track ended handling
        if (dur > 0 && masterT >= dur - 0.05) {
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

        setCurrentTime(masterT);
        currentTimeRef.current = masterT;
        if (dur > 0 && durationRef.current !== dur) {
          setDuration(dur);
          durationRef.current = dur;
        }
      }
      animId = requestAnimationFrame(checkPlayback);
    };

    animId = requestAnimationFrame(checkPlayback);
    return () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }, [getAudioEngine, pause, playNext, seek]);

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
