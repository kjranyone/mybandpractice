import { useCallback, useEffect, useRef, useState } from "react";
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

const MIN_LOOP = 0.25; // seconds
const RATE_PRESETS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;

export { RATE_PRESETS };

export function useAudioPlayer(songs: SongSummary[]) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const songsRef = useRef(songs);
  songsRef.current = songs;

  const [current, setCurrent] = useState<SongSummary | null>(null);
  const currentRef = useRef<SongSummary | null>(null);
  currentRef.current = current;

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.85);
  const [muted, setMutedState] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [loop, setLoopState] = useState<LoopRegion | null>(null);
  const [loopEnabled, setLoopEnabledState] = useState(false);
  const [buffered, setBuffered] = useState(0); // 0–1 fraction
  const [playbackMode, setPlaybackModeState] =
    useState<PlaybackMode>("sequential");

  const loopRef = useRef<LoopRegion | null>(null);
  const loopEnabledRef = useRef(false);
  const playbackModeRef = useRef<PlaybackMode>("sequential");
  loopRef.current = loop;
  loopEnabledRef.current = loopEnabled;
  playbackModeRef.current = playbackMode;

  const playSong = useCallback(async (song: SongSummary) => {
    const audio = audioRef.current;
    if (!audio || !song.audioUrl) return;

    if (currentRef.current?.slug === song.slug && audio.src) {
      try {
        await audio.play();
      } catch {
        setPlaying(false);
      }
      return;
    }

    // New track: clear loop selection
    setLoopState(null);
    setLoopEnabledState(false);
    loopRef.current = null;
    loopEnabledRef.current = false;

    setCurrent(song);
    setCurrentTime(0);
    setBuffered(0);
    audio.src = song.audioUrl;
    audio.load();
    try {
      await audio.play();
    } catch {
      setPlaying(false);
    }
  }, []);

  const playSongRef = useRef(playSong);
  playSongRef.current = playSong;

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.volume = 0.85;
    audio.preservesPitch = true;
    Object.assign(audio, { mozPreservesPitch: true, webkitPreservesPitch: true });
    audioRef.current = audio;

    const onTime = () => {
      const t = audio.currentTime;
      const lp = loopRef.current;
      if (loopEnabledRef.current && lp && lp.end > lp.start) {
        // Small epsilon so we don't thrash at the boundary
        if (t >= lp.end - 0.02) {
          audio.currentTime = lp.start;
          setCurrentTime(lp.start);
          return;
        }
        if (t < lp.start - 0.05) {
          // dragged playhead before region while looping — snap in
          // only if we overshoot past end naturally; allow scrubbing into region
        }
      }
      setCurrentTime(t);
    };

    const onMeta = () => setDuration(audio.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onProgress = () => {
      try {
        if (audio.buffered.length > 0 && audio.duration > 0) {
          const end = audio.buffered.end(audio.buffered.length - 1);
          setBuffered(clamp(end / audio.duration, 0, 1));
        }
      } catch {
        /* ignore */
      }
    };
    const onEnded = () => {
      // If loop enabled, ended shouldn't fire mid-loop; whole-track loop via region
      if (loopEnabledRef.current && loopRef.current) {
        audio.currentTime = loopRef.current.start;
        void audio.play();
        return;
      }
      setPlaying(false);
      const cur = currentRef.current;
      if (!cur) return;
      if (playbackModeRef.current === "repeat-one") {
        audio.currentTime = 0;
        void audio.play();
        return;
      }
      const list = songsRef.current;
      const idx = list.findIndex((s) => s.slug === cur.slug);
      const next =
        list[idx + 1] ??
        (playbackModeRef.current === "repeat-all" ? list[0] : undefined);
      if (next?.audioUrl) {
        void playSongRef.current(next);
      }
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("progress", onProgress);
    audio.addEventListener("canplay", onProgress);

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("progress", onProgress);
      audio.removeEventListener("canplay", onProgress);
      audio.src = "";
      audioRef.current = null;
    };
  }, []);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !currentRef.current) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        /* ignore */
      }
    } else {
      audio.pause();
    }
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const dur = audio.duration || duration || 0;
    const t = clamp(time, 0, dur || time);
    audio.currentTime = t;
    setCurrentTime(t);
  }, [duration]);

  const skip = useCallback(
    (delta: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      seek(audio.currentTime + delta);
    },
    [seek],
  );

  const setVolume = useCallback((v: number) => {
    const clamped = clamp(v, 0, 1);
    setVolumeState(clamped);
    if (audioRef.current) {
      audioRef.current.volume = clamped;
      if (clamped > 0 && audioRef.current.muted) {
        audioRef.current.muted = false;
        setMutedState(false);
      }
    }
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    if (audioRef.current) audioRef.current.muted = m;
  }, []);

  const toggleMute = useCallback(() => {
    setMuted(!muted);
  }, [muted, setMuted]);

  const setPlaybackRate = useCallback((rate: number) => {
    const r = clamp(rate, 0.25, 2);
    setPlaybackRateState(r);
    if (audioRef.current) {
      audioRef.current.playbackRate = r;
      audioRef.current.preservesPitch = true;
    }
  }, []);

  const setLoop = useCallback((region: LoopRegion | null) => {
    if (!region) {
      setLoopState(null);
      loopRef.current = null;
      return;
    }
    const dur = audioRef.current?.duration || duration || Infinity;
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
  }, [duration]);

  const setLoopEnabled = useCallback((on: boolean) => {
    setLoopEnabledState(on);
    loopEnabledRef.current = on;
    // When enabling, jump into region if outside
    const audio = audioRef.current;
    const lp = loopRef.current;
    if (on && audio && lp) {
      if (audio.currentTime < lp.start || audio.currentTime >= lp.end) {
        audio.currentTime = lp.start;
        setCurrentTime(lp.start);
      }
    }
  }, []);

  const clearLoop = useCallback(() => {
    setLoopState(null);
    setLoopEnabledState(false);
    loopRef.current = null;
    loopEnabledRef.current = false;
  }, []);

  const setLoopIn = useCallback(() => {
    const t = audioRef.current?.currentTime ?? currentTime;
    const end = loop?.end ?? Math.min(t + 8, duration || t + 8);
    setLoop({ start: t, end: Math.max(end, t + MIN_LOOP) });
    setLoopEnabled(true);
  }, [currentTime, duration, loop?.end, setLoop, setLoopEnabled]);

  const setLoopOut = useCallback(() => {
    const t = audioRef.current?.currentTime ?? currentTime;
    const start = loop?.start ?? Math.max(0, t - 8);
    setLoop({ start: Math.min(start, t - MIN_LOOP), end: t });
    setLoopEnabled(true);
  }, [currentTime, loop?.start, setLoop, setLoopEnabled]);

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
      (playbackModeRef.current === "repeat-all"
        ? songsRef.current[0]
        : undefined);
    if (next) void playSong(next);
  }, [playSong]);

  const playPrev = useCallback(() => {
    const audio = audioRef.current;
    const cur = currentRef.current;
    if (!cur) return;
    if (audio && audio.currentTime > 3) {
      seek(0);
      return;
    }
    const idx = songsRef.current.findIndex((s) => s.slug === cur.slug);
    const prev = songsRef.current[idx - 1];
    if (prev) void playSong(prev);
    else seek(0);
  }, [playSong, seek]);

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
    playSong,
    toggle,
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
