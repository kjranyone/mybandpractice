import { useCallback, useEffect, useRef, useState } from "react";
import { PlaybackEngine, type LoopRegion } from "../audio/PlaybackEngine";
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

      // UI-owned song state resets immediately (engine reset happens inside
      // engine.playSong synchronously before any await).
      setCurrent(song);
      currentRef.current = song;
      setLoopState(null);
      setLoopEnabledState(false);
      loopRef.current = null;
      loopEnabledRef.current = false;

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

  const persistMixer = useCallback(() => {
    saveMixerSettingsToStorage({
      stemLevels: engine.stemLevels,
      volume: engine.volume,
      muted: engine.muted,
      pitch: engine.pitch,
      playbackRate: engine.playbackRate,
    });
  }, [engine]);

  const setStemLevel = useCallback(
    (name: string, level: number) => {
      const next = { ...engine.stemLevels, [name]: clamp(level, 0, 1) };
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

  const setLoop = useCallback(
    (region: LoopRegion | null) => {
      if (!region) {
        engine.loop = null;
        setLoopState(null);
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
    },
    [engine],
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
    },
    [engine, seek],
  );

  const clearLoop = useCallback(() => {
    engine.loop = null;
    engine.loopEnabled = false;
    setLoopState(null);
    setLoopEnabledState(false);
  }, [engine]);

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

  // Foreground-only smooth UI clock (engine logic lives in the worker ticker)
  useEffect(() => {
    let animId = 0;
    const uiFrame = () => {
      if (engine.playing) setCurrentTime(engine.currentTime);
      animId = requestAnimationFrame(uiFrame);
    };
    animId = requestAnimationFrame(uiFrame);
    return () => {
      if (animId) cancelAnimationFrame(animId);
      engine.stopSources();
    };
  }, [engine]);

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
