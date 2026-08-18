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

/** stem files: `${stemBaseUrl}${stem}.mp3` */
function stemUrl(song: SongSummary, stem: string): string | null {
  if (song.stemBaseUrl && song.stems?.includes(stem)) {
    return `${song.stemBaseUrl}${encodeURIComponent(stem)}.mp3`;
  }
  return null;
}

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
  /** Per-stem fader levels 0–1 (missing = full). All full => the original
   * mix file plays; any fader below full => stems are summed live via Web
   * Audio with these gains (physical-mixer style). */
  const [stemLevels, setStemLevelsState] = useState<Record<string, number>>(
    {},
  );
  const stemLevelsRef = useRef<Record<string, number>>({});
  stemLevelsRef.current = stemLevels;

  /** Pitch shift in semitones (-12..12). 0 = bypassed (no worklet cost). */
  const [pitch, setPitchState] = useState(0);
  const pitchRef = useRef(0);
  pitchRef.current = pitch;

  const loopRef = useRef<LoopRegion | null>(null);
  const loopEnabledRef = useRef(false);
  const playbackModeRef = useRef<PlaybackMode>("sequential");
  loopRef.current = loop;
  loopEnabledRef.current = loopEnabled;
  playbackModeRef.current = playbackMode;

  // --- Web Audio graph (lazily created for stems and/or pitch) ---
  const audioCtxRef = useRef<AudioContext | null>(null);
  const stemGraphRef = useRef<{
    mix: GainNode; // master mix element route (kept forever once created)
    pitchIn: GainNode; // pitched sources sum here, feed the pitch worklet
    bypass: GainNode; // unpitched sources (drums while shifting)
    out: GainNode; // post-pitch master
    worklet: AudioWorkletNode | null;
    stems: Map<string, { el: HTMLAudioElement; gain: GainNode }>;
  } | null>(null);
  const stemGraphSlugRef = useRef<string | null>(null);
  const graphReadyRef = useRef<Promise<void> | null>(null);

  const stemsAllFull = (
    song: SongSummary | null,
    levels: Record<string, number>,
  ) => !song?.stems || song.stems.every((s) => (levels[s] ?? 1) >= 0.995);

  const teardownStems = useCallback(() => {
    const g = stemGraphRef.current;
    if (!g) return;
    for (const { el, gain } of g.stems.values()) {
      el.pause();
      el.removeAttribute("src");
      gain.disconnect();
    }
    g.stems.clear();
    stemGraphSlugRef.current = null;
  }, []);

  /** Create the AudioContext + shared chain (mix/stems -> pitch -> out).
   * Safe to call repeatedly; resolves when the worklet is registered. */
  const ensureGraph = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return null;
    if (stemGraphRef.current) {
      await graphReadyRef.current;
      return stemGraphRef.current;
    }
    let ctx = audioCtxRef.current;
    if (!ctx) {
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ctx = new AC();
      audioCtxRef.current = ctx;
    }
    // Route the master mix element through the context once. Note:
    // MediaElementSource permanently reroutes the element, so this
    // chain stays alive for the rest of the session.
    const mixGain = ctx.createGain();
    const pitchIn = ctx.createGain();
    const bypass = ctx.createGain();
    // Time-align the unpitched path with the worklet's grain latency
    // (~1.5 x grain samples) so bypassed drums stay in sync.
    const bypassDelay = ctx.createDelay(0.5);
    bypassDelay.delayTime.value =
      (1.5 * PITCH_GRAIN_SAMPLES + 128) / ctx.sampleRate;
    const out = ctx.createGain();
    ctx.createMediaElementSource(audio).connect(mixGain);
    mixGain.connect(pitchIn);
    pitchIn.connect(out); // direct until the worklet takes over
    bypass.connect(bypassDelay);
    bypassDelay.connect(out);
    out.connect(ctx.destination);
    const g = {
      mix: mixGain,
      pitchIn,
      bypass,
      out,
      worklet: null as AudioWorkletNode | null,
      stems: new Map<string, { el: HTMLAudioElement; gain: GainNode }>(),
    };
    stemGraphRef.current = g;
    const ready = registerPitchWorklet(ctx)
      .then(() => {
        const node = createPitchNode(ctx);
        g.pitchIn.disconnect();
        g.pitchIn.connect(node);
        node.connect(g.out);
        g.worklet = node;
        node.parameters
          .get("ratio")
          ?.setTargetAtTime(
            2 ** (pitchRef.current / 12),
            ctx.currentTime,
            0.03,
          );
      })
      .catch((e: unknown) => {
        console.warn("pitch worklet unavailable — passthrough", e);
      });
    graphReadyRef.current = ready;
    await ready;
    void ctx.resume();
    return g;
  }, []);

  /** (Re)connect every stem gain to its bus based on current pitch. */
  const routeStems = useCallback(() => {
    const g = stemGraphRef.current;
    if (!g) return;
    const unpitched = pitchRef.current !== 0;
    for (const [name, { gain }] of g.stems) {
      gain.disconnect();
      gain.connect(
        unpitched && name === "drums" ? g.bypass : g.pitchIn,
      );
    }
  }, []);

  const ensureStemGraph = useCallback(
    async (song: SongSummary) => {
      if (!song.stems || !song.stemBaseUrl) return;
      const audio = audioRef.current;
      if (!audio) return;
      const g = await ensureGraph();
      if (!g) return;
      if (stemGraphSlugRef.current !== song.slug) {
        for (const { el, gain } of g.stems.values()) {
          el.pause();
          el.removeAttribute("src");
          gain.disconnect();
        }
        g.stems.clear();
        stemGraphSlugRef.current = song.slug;
      }
      for (const s of song.stems) {
        if (g.stems.has(s)) continue;
        const el = new Audio();
        el.preload = "auto";
        el.preservesPitch = true;
        el.volume = audio.volume;
        const url = stemUrl(song, s);
        if (!url) continue;
        el.src = url;
        const ctx = audioCtxRef.current!;
        const gain = ctx.createGain();
        gain.gain.value = 0; // starts silent
        ctx.createMediaElementSource(el).connect(gain);
        gain.connect(
          pitchRef.current !== 0 && s === "drums" ? g.bypass : g.pitchIn,
        );
        g.stems.set(s, { el, gain });
      }
    },
    [ensureGraph],
  );

  const applyStemGains = useCallback(
    (song: SongSummary | null, levels: Record<string, number>) => {
      const g = stemGraphRef.current;
      const ctx = audioCtxRef.current;
      if (!g || !ctx) return;
      // While pitch shifting a song that has a drums stem, play the
      // separated stems (all full) so drums can bypass the worklet —
      // otherwise fall back to the pristine mix file when untouched.
      const drumsBypassed =
        pitchRef.current !== 0 && !!song?.stems?.includes("drums");
      const useMix = stemsAllFull(song, levels) && !drumsBypassed;
      const t = ctx.currentTime;
      const ramp = (node: GainNode, v: number) => {
        node.gain.cancelScheduledValues(t);
        node.gain.setValueAtTime(node.gain.value, t);
        node.gain.linearRampToValueAtTime(v, t + 0.03);
      };
      ramp(g.mix, useMix ? 1 : 0);
      for (const [name, { gain }] of g.stems) {
        ramp(gain, useMix ? 0 : levels[name] ?? 1);
      }
    },
    [],
  );

  /** Keep stem elements in sync with the master mix element. */
  const syncStemPlayback = useCallback(() => {
    const g = stemGraphRef.current;
    const audio = audioRef.current;
    if (!g || !audio) return;
    const t = audio.currentTime;
    const wantPlay = !audio.paused && !audio.ended;
    for (const { el } of g.stems.values()) {
      if (el.readyState > 0 && Math.abs(el.currentTime - t) > 0.15) {
        el.currentTime = t;
      }
      if (wantPlay && el.paused) void el.play().catch(() => {});
      if (!wantPlay && !el.paused) el.pause();
    }
  }, []);

  const syncStemPlaybackRef = useRef(syncStemPlayback);
  syncStemPlaybackRef.current = syncStemPlayback;

  const playSong = useCallback(
    async (song: SongSummary) => {
      const audio = audioRef.current;
      if (!audio || !song.audioUrl) return;

      const cur = currentRef.current;
      if (cur?.slug === song.slug && audio.src) {
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
      audio.src = song.audioUrl; // always the mix; stems layer on top
      audio.load();

      // Rebuild the stem layer for the new song (keeps minus-one state);
      // also build the graph when a pitch shift is engaged.
      if (song.stems?.length) {
        try {
          await ensureStemGraph(song);
        } catch {
          /* ignore stem graph error */
        }
      } else {
        teardownStems();
        if (pitchRef.current !== 0) await ensureGraph();
      }
      applyStemGains(song, stemLevelsRef.current);

      try {
        await audio.play();
      } catch {
        setPlaying(false);
      }
      syncStemPlaybackRef.current();
    },
    [applyStemGains, ensureStemGraph, teardownStems],
  );

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
          syncStemPlaybackRef.current();
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
    const onPlay = () => {
      setPlaying(true);
      syncStemPlaybackRef.current();
    };
    const onPause = () => {
      setPlaying(false);
      syncStemPlaybackRef.current();
    };
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
      syncStemPlaybackRef.current();
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

    // timeupdate fires ~4Hz which is too coarse for the precise m:ss.d
    // readout — poll via rAF while playing (loop snapping included).
    let raf = 0;
    const tick = () => {
      onTime();
      raf = requestAnimationFrame(tick);
    };
    const startRaf = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const stopRaf = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    audio.addEventListener("play", startRaf);
    audio.addEventListener("pause", stopRaf);
    audio.addEventListener("ended", stopRaf);

    return () => {
      audio.pause();
      stopRaf();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("progress", onProgress);
      audio.removeEventListener("canplay", onProgress);
      audio.removeEventListener("play", startRaf);
      audio.removeEventListener("pause", stopRaf);
      audio.removeEventListener("ended", stopRaf);
      for (const { el } of stemGraphRef.current?.stems.values() ?? []) {
        el.pause();
      }
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
      stemGraphRef.current = null;
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

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !currentRef.current) return;
    void audioCtxRef.current?.resume();
    void audio.play().catch(() => {
      /* ignore */
    });
    syncStemPlayback();
  }, [syncStemPlayback]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    syncStemPlayback();
  }, [syncStemPlayback]);

  /** Set one stem fader level (0–1). All full plays the original mix;
   * any fader below full switches to live-summed stems with these gains. */
  const setStemLevel = useCallback(
    (name: string, level: number) => {
      const song = currentRef.current;
      const audio = audioRef.current;
      if (!song?.stems?.includes(name) || !audio) return;
      const v = clamp(level, 0, 1);
      const next = { ...stemLevelsRef.current, [name]: v };
      setStemLevelsState(next);
      stemLevelsRef.current = next;
      void ensureStemGraph(song).then(() => {
        if (!stemsAllFull(song, next)) syncStemPlayback();
        applyStemGains(song, next);
      });
    },
    [applyStemGains, ensureStemGraph, syncStemPlayback],
  );

  /** Pitch shift in semitones (-12..12). 0 bypasses the worklet. While
   * shifting, the drums stem routes around the worklet (no key needed)
   * with grain-latency compensation to stay in sync. */
  const setPitch = useCallback(
    (semitones: number) => {
      const v = Math.round(clamp(semitones, -12, 12));
      setPitchState(v);
      pitchRef.current = v;
      const ctx = audioCtxRef.current;
      const node = stemGraphRef.current?.worklet;
      if (ctx && node) {
        node.parameters
          .get("ratio")
          ?.setTargetAtTime(2 ** (v / 12), ctx.currentTime, 0.03);
      }
      const song = currentRef.current;
      if (v !== 0) {
        if (song?.stems?.includes("drums")) {
          // engage the stem layer so drums can bypass the shifter
          void ensureStemGraph(song).then(() => {
            routeStems();
            applyStemGains(song, stemLevelsRef.current);
            syncStemPlayback();
          });
        } else if (!stemGraphRef.current) {
          void ensureGraph();
        }
      } else if (stemGraphRef.current) {
        routeStems();
        applyStemGains(song, stemLevelsRef.current);
      }
    },
    [applyStemGains, ensureGraph, ensureStemGraph, routeStems, syncStemPlayback],
  );

  /** Reset every stem fader to full (back to the original mix). */
  const resetStemLevels = useCallback(() => {
    const song = currentRef.current;
    if (!song?.stems) return;
    const next: Record<string, number> = {};
    for (const s of song.stems) next[s] = 1;
    setStemLevelsState(next);
    stemLevelsRef.current = next;
    applyStemGains(song, next);
  }, [applyStemGains]);

  const seek = useCallback(
    (time: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const dur = audio.duration || duration || 0;
      const t = clamp(time, 0, dur || time);
      audio.currentTime = t;
      setCurrentTime(t);
      syncStemPlayback();
    },
    [duration, syncStemPlayback],
  );

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
    const audio = audioRef.current;
    if (audio) {
      audio.volume = clamped;
      if (clamped > 0 && audio.muted) {
        audio.muted = false;
        setMutedState(false);
      }
    }
    for (const { el } of stemGraphRef.current?.stems.values() ?? []) {
      el.volume = clamped;
    }
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    if (audioRef.current) audioRef.current.muted = m;
    for (const { el } of stemGraphRef.current?.stems.values() ?? []) {
      el.muted = m;
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted(!muted);
  }, [muted, setMuted]);

  const setPlaybackRate = useCallback((rate: number) => {
    const r = clamp(rate, 0.25, 2);
    setPlaybackRateState(r);
    const audio = audioRef.current;
    if (audio) {
      audio.playbackRate = r;
      audio.preservesPitch = true;
    }
    for (const { el } of stemGraphRef.current?.stems.values() ?? []) {
      el.playbackRate = r;
      el.preservesPitch = true;
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
