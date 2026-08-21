import { useCallback, useEffect, useRef, useState } from "react";
import { PlaybackEngine, type LoopRegion } from "../audio/PlaybackEngine";
import { MAX_GAIN } from "../audio/gain";
import type { SongSummary } from "../types";
import { clamp } from "../utils/format";

export type { LoopRegion };

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
  volume: 1,
  muted: false,
  pitch: 0,
  playbackRate: 1,
};

function loadSavedMixerSettings(): MixerSettings {
  try {
    const raw = localStorage.getItem(MIXER_STORAGE_KEY);
    if (!raw) return DEFAULT_MIXER_SETTINGS;
    const parsed = JSON.parse(raw);
    const stems = DEFAULT_MIXER_SETTINGS.stemLevels;
    const stemLevels: Record<string, number> = { ...stems };
    if (parsed.stemLevels && typeof parsed.stemLevels === "object") {
      for (const [k, v] of Object.entries(parsed.stemLevels)) {
        if (typeof v === "number") stemLevels[k] = clamp(v, 0, MAX_GAIN);
      }
    }
    return {
      stemLevels,
      volume: typeof parsed.volume === "number" ? clamp(parsed.volume, 0, MAX_GAIN) : 1,
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

/**
 * Trailing debounce for mixer persistence: fader drags fire dozens of
 * updates per second; coalescing keeps the synchronous localStorage write
 * (which can spike on the Android WebView main thread) to one per gesture.
 */
const MIXER_SAVE_DEBOUNCE_MS = 300;

function createDebouncedSaver<A extends unknown[]>(fn: (...args: A) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const flush = () => {
    timer = null;
    if (pending) {
      const args = pending;
      pending = null;
      fn(...args);
    }
  };
  const debounced = (...args: A) => {
    pending = args;
    if (timer === null) timer = setTimeout(flush, MIXER_SAVE_DEBOUNCE_MS);
  };
  return Object.assign(debounced, {
    /** Write out any pending update immediately (app going away). */
    flushNow: flush,
  });
}

// Loop regions are device-local practice markers: per-song {start, end}
// plus whether looping was active, restored when the song is reopened.
const LOOP_STORAGE_KEY = "mybandpractice:loop-settings";

type StoredLoop = { start: number; end: number; enabled: boolean };

function loadSavedLoops(): Record<string, StoredLoop> {
  try {
    const raw = localStorage.getItem(LOOP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, StoredLoop> = {};
    for (const [slug, v] of Object.entries(parsed)) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as StoredLoop).start === "number" &&
        typeof (v as StoredLoop).end === "number" &&
        (v as StoredLoop).end > (v as StoredLoop).start
      ) {
        out[slug] = {
          start: (v as StoredLoop).start,
          end: (v as StoredLoop).end,
          enabled: (v as StoredLoop).enabled === true,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveLoopsToStorage(loops: Record<string, StoredLoop>) {
  try {
    localStorage.setItem(LOOP_STORAGE_KEY, JSON.stringify(loops));
  } catch {
    /* ignore storage errors */
  }
}

/**
 * Dedicated-worker ticker that drives the playback engine at a fixed cadence.
 * requestAnimationFrame stops when the Android screen turns off, which froze
 * chunk streaming at the first 30s boundary and killed background playback;
 * worker timers keep firing while the media-session foreground service
 * holds the process alive.
 */
const ENGINE_TICK_MS = 100;
const ENGINE_TICK_WORKER_SRC = `let id=null;onmessage=e=>{if(e.data==="start"&&id===null){id=setInterval(()=>postMessage(0),${ENGINE_TICK_MS});}else if(e.data==="stop"&&id!==null){clearInterval(id);id=null;}};`;

export function useAudioPlayer(songs: SongSummary[]) {
  const songsRef = useRef(songs);
  songsRef.current = songs;

  const savedMixer = useRef(loadSavedMixerSettings());
  const savedLoops = useRef(loadSavedLoops());

  const [current, setCurrent] = useState<SongSummary | null>(null);
  const currentRef = useRef<SongSummary | null>(null);
  currentRef.current = current;

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0); // 0–1 fraction
  const [buffering, setBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackMode, setPlaybackModeState] = useState<PlaybackMode>("sequential");
  const playbackModeRef = useRef<PlaybackMode>("sequential");
  playbackModeRef.current = playbackMode;
  const [volume, setVolumeState] = useState(savedMixer.current.volume);
  const [muted, setMutedState] = useState(savedMixer.current.muted);
  const [playbackRate, setPlaybackRateState] = useState(savedMixer.current.playbackRate);
  const [stemLevels, setStemLevelsState] = useState<Record<string, number>>(
    savedMixer.current.stemLevels,
  );
  const [pitch, setPitchState] = useState(savedMixer.current.pitch);
  const [loop, setLoopState] = useState<LoopRegion | null>(null);
  const [loopEnabled, setLoopEnabledState] = useState(false);
  const loopRef = useRef<LoopRegion | null>(null);
  loopRef.current = loop;
  const loopEnabledRef = useRef(false);
  loopEnabledRef.current = loopEnabled;

  // --- engine (single instance; events mirror into React state) -----------
  const engineRef = useRef<PlaybackEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new PlaybackEngine({
      onPlayingChange: setPlaying,
      onBufferingChange: setBuffering,
      onBufferedChange: setBuffered,
      onTimeChange: setCurrentTime,
      onDurationChange: setDuration,
      onError: (msg) => {
        setPlaybackError(msg);
        window.setTimeout(() => {
          setPlaybackError((cur) => (cur === msg ? null : cur));
        }, 4500);
      },
      onTrackEnd: () => {
        const cur = currentRef.current;
        const lp = loopRef.current;
        const engine = engineRef.current!;
        if (loopEnabledRef.current && lp) {
          engine.seek(lp.start);
        } else if (playbackModeRef.current === "repeat-one") {
          engine.seek(0);
        } else if (cur) {
          const idx = songsRef.current.findIndex((s) => s.slug === cur.slug);
          const next =
            songsRef.current[idx + 1] ??
            (playbackModeRef.current === "repeat-all"
              ? songsRef.current[0]
              : undefined);
          if (next) void playSongRef.current(next);
          else {
            engine.pause();
            engine.seek(0);
          }
        } else {
          engine.pause();
          engine.seek(0);
        }
      },
    });
    // seed persisted mixer into the engine before anything plays
    const e = engineRef.current;
    e.stemLevels = savedMixer.current.stemLevels;
    e.volume = savedMixer.current.volume;
    e.muted = savedMixer.current.muted;
    e.pitch = savedMixer.current.pitch;
    e.playbackRate = savedMixer.current.playbackRate;
  }
  const engine = engineRef.current;

  const prefetchAbortRef = useRef<AbortController | null>(null);

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
      // Chunked: warming chunk row 0 makes the next tap ~instant
      if (engine.prefetchChunkRow0(nextSong)) return;
      void engine.decodeFull(nextSong, abortCtrl.signal);
    },
    [engine],
  );

  const play = useCallback(() => {
    if (!currentRef.current) return;
    void engine.ensureGraph().then(() => {
      engine.startPlaybackAt(engine.currentTime);
    });
  }, [engine]);

  const pause = useCallback(() => engine.pause(), [engine]);

  const toggle = useCallback(() => {
    if (engine.playing) pause();
    else play();
  }, [engine, pause, play]);

  const playSong = useCallback(
    async (song: SongSummary) => {
      if (currentRef.current?.slug === song.slug && engine.hasAudio) {
        play();
        return;
      }

      // UI-owned song state swaps immediately (engine reset happens inside
      // engine.playSong synchronously before any await). Loop settings are
      // per-song and device-local: restore the saved practice loop, if any.
      const saved = savedLoops.current[song.slug] ?? null;
      const region: LoopRegion | null = saved
        ? { start: saved.start, end: saved.end }
        : null;
      setCurrent(song);
      currentRef.current = song;
      engine.loop = region;
      engine.loopEnabled = saved?.enabled ?? false;
      setLoopState(region);
      setLoopEnabledState(saved?.enabled ?? false);
      loopRef.current = region;
      loopEnabledRef.current = saved?.enabled ?? false;

      await engine.playSong(song, {
        isStale: () => currentRef.current?.slug !== song.slug,
        onPrefetch: (s) => prefetchAdjacentSongs(s),
      });
    },
    [engine, play, prefetchAdjacentSongs],
  );

  const playSongRef = useRef(playSong);
  playSongRef.current = playSong;

  const seek = useCallback(
    (time: number) => {
      const dur = engine.duration || 0;
      engine.seek(clamp(time, 0, dur || time));
    },
    [engine],
  );

  const skip = useCallback(
    (delta: number) => {
      seek(engine.currentTime + delta);
    },
    [engine, seek],
  );

  const mixerSaverRef = useRef(createDebouncedSaver(saveMixerSettingsToStorage));
  const persistMixer = useCallback(() => {
    mixerSaverRef.current({
      stemLevels: engine.stemLevels,
      volume: engine.volume,
      muted: engine.muted,
      pitch: engine.pitch,
      playbackRate: engine.playbackRate,
    });
  }, [engine]);

  const setStemLevel = useCallback(
    (name: string, level: number) => {
      const next = { ...engine.stemLevels, [name]: clamp(level, 0, MAX_GAIN) };
      engine.stemLevels = next;
      setStemLevelsState(next);
      engine.applyStemGains(next);
      persistMixer();
    },
    [engine, persistMixer],
  );

  const resetStemLevels = useCallback(() => {
    const song = currentRef.current;
    if (!song?.stems) return;
    const next: Record<string, number> = {};
    for (const s of song.stems) next[s] = 1;
    engine.stemLevels = next;
    setStemLevelsState(next);
    engine.applyStemGains(next);
    persistMixer();
  }, [engine, persistMixer]);

  const setPitch = useCallback(
    (semitones: number) => {
      engine.setPitch(semitones);
      setPitchState(engine.pitch);
      persistMixer();
    },
    [engine, persistMixer],
  );

  const setVolume = useCallback(
    (v: number) => {
      engine.setVolume(v);
      setVolumeState(engine.volume);
      persistMixer();
    },
    [engine, persistMixer],
  );

  const setMuted = useCallback(
    (m: boolean) => {
      engine.setMuted(m);
      setMutedState(m);
      persistMixer();
    },
    [engine, persistMixer],
  );

  const toggleMute = useCallback(() => setMuted(!engine.muted), [engine, setMuted]);

  const setPlaybackRate = useCallback(
    (rate: number) => {
      engine.setPlaybackRate(rate);
      setPlaybackRateState(engine.playbackRate);
      persistMixer();
    },
    [engine, persistMixer],
  );

  const persistLoop = useCallback(
    (slug: string, entry: StoredLoop | null) => {
      const next = { ...savedLoops.current };
      if (entry) next[slug] = entry;
      else delete next[slug];
      savedLoops.current = next;
      saveLoopsToStorage(next);
    },
    [],
  );

  const setLoop = useCallback(
    (region: LoopRegion | null) => {
      const slug = currentRef.current?.slug;
      if (!region) {
        engine.loop = null;
        setLoopState(null);
        if (slug) persistLoop(slug, null);
        return;
      }
      const dur = engine.duration || Infinity;
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
      engine.loop = next;
      setLoopState(next);
      if (slug) persistLoop(slug, { ...next, enabled: engine.loopEnabled });
    },
    [engine, persistLoop],
  );

  const setLoopEnabled = useCallback(
    (on: boolean) => {
      engine.loopEnabled = on;
      setLoopEnabledState(on);
      const lp = engine.loop;
      if (on && lp) {
        const curT = engine.currentTime;
        if (curT < lp.start || curT >= lp.end) seek(lp.start);
      }
      const slug = currentRef.current?.slug;
      if (slug && lp) persistLoop(slug, { start: lp.start, end: lp.end, enabled: on });
    },
    [engine, seek, persistLoop],
  );

  const clearLoop = useCallback(() => {
    const slug = currentRef.current?.slug;
    engine.loop = null;
    engine.loopEnabled = false;
    setLoopState(null);
    setLoopEnabledState(false);
    if (slug) persistLoop(slug, null);
  }, [engine, persistLoop]);

  const setLoopIn = useCallback(() => {
    const t = engine.currentTime;
    const end = engine.loop?.end ?? Math.min(t + 8, engine.duration || t + 8);
    setLoop({ start: t, end: Math.max(end, t + MIN_LOOP) });
    setLoopEnabled(true);
  }, [engine, setLoop, setLoopEnabled]);

  const setLoopOut = useCallback(() => {
    const t = engine.currentTime;
    const start = engine.loop?.start ?? Math.max(0, t - 8);
    setLoop({ start: Math.min(start, t - MIN_LOOP), end: t });
    setLoopEnabled(true);
  }, [engine, setLoop, setLoopEnabled]);

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
    if (engine.currentTime > 3) {
      seek(0);
      return;
    }
    const idx = songsRef.current.findIndex((s) => s.slug === cur.slug);
    const prev = songsRef.current[idx - 1];
    if (prev) void playSongRef.current(prev);
    else seek(0);
  }, [engine, seek]);

  // --- engine ticker: dedicated worker (immune to screen-off RAF death),
  //     window timer fallback for exotic WebView builds.
  useEffect(() => {
    try {
      const url = URL.createObjectURL(
        new Blob([ENGINE_TICK_WORKER_SRC], { type: "application/javascript" }),
      );
      const w = new Worker(url);
      w.onmessage = () => engine.tick();
      w.postMessage("start");
      return () => {
        w.terminate();
      };
    } catch {
      const tid = window.setInterval(() => engine.tick(), ENGINE_TICK_MS);
      return () => window.clearInterval(tid);
    }
  }, [engine]);

  // Foreground-only smooth UI clock (engine logic lives in the worker ticker).
  // 10 Hz matches the tenths-precision time readout; re-rendering the whole
  // tree at animation-frame rate kept the Android WebView repainting at 30fps
  // and stressed hwui's RenderThread until it crashed (SIGSEGV in Skia).
  useEffect(() => {
    let animId = 0;
    let lastTime = 0;
    const uiFrame = () => {
      if (engine.playing) {
        const cur = engine.currentTime;
        if (Math.abs(cur - lastTime) >= 0.1) {
          lastTime = cur;
          setCurrentTime(cur);
        }
      }
      animId = requestAnimationFrame(uiFrame);
    };
    animId = requestAnimationFrame(uiFrame);
    return () => {
      if (animId) cancelAnimationFrame(animId);
      engine.stopSources();
    };
  }, [engine]);

  // Flush any debounced mixer write when the app is backgrounded/killed —
  // Android WebView may never fire the trailing timer after a page freeze.
  useEffect(() => {
    const flush = () => mixerSaverRef.current.flushNow();
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

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
    playbackError,
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
