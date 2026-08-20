import { useState, type CSSProperties } from "react";
import type { LoopRegion } from "../hooks/useAudioPlayer";
import {
  PLAYBACK_MODE_LABELS,
  nextPlaybackMode,
  type PlaybackMode,
} from "../hooks/useAudioPlayer";
import type { SongMarker } from "../hooks/useMarkers";
import type { SongSummary } from "../types";
import { clamp, formatTimePrecise } from "../utils/format";
import { toLeadSheetNotation } from "../utils/chordStore";
import { Modal } from "./Modal";
import { SpeedControl } from "./SpeedControl";
import { StemFader } from "./StemFader";
import { VolumeFader } from "./VolumeFader";
import { WaveformSeekBar } from "./WaveformSeekBar";

const PITCH_PRESETS = [-5, -2, -1, 0, 1, 2, 5];

type Props = {
  song: SongSummary | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  loop: LoopRegion | null;
  loopEnabled: boolean;
  buffered: number;
  playbackMode: PlaybackMode;
  stemLevels: Record<string, number>;
  onStemLevel: (name: string, level: number) => void;
  onStemReset: () => void;
  pitch: number;
  onPitch: (semitones: number) => void;
  markers: SongMarker[];
  currentChord?: string | null;
  hasChords?: boolean;
  chordSheetOpen?: boolean;
  onToggleChordSheet?: () => void;
  onMarkerAdd: (time: number, label: string) => void;
  onMarkerUpdate: (
    id: string,
    patch: Partial<Pick<SongMarker, "time" | "label">>,
  ) => void;
  onMarkerRemove: (id: string) => void;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onPlaybackMode: (mode: PlaybackMode) => void;
  onSeek: (t: number) => void;
  onSkip: (delta: number) => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onRate: (r: number) => void;
  onLoopChange: (region: LoopRegion | null) => void;
  onLoopEnable: (on: boolean) => void;
  onLoopIn: () => void;
  onLoopOut: () => void;
  onClearLoop: () => void;
};

export function PlayerBar({
  song,
  playing,
  currentTime,
  duration,
  volume,
  muted,
  playbackRate,
  loop,
  loopEnabled,
  buffered,
  playbackMode,
  stemLevels,
  onStemLevel,
  onStemReset,
  pitch,
  onPitch,
  markers,
  currentChord,
  hasChords,
  chordSheetOpen,
  onToggleChordSheet,
  onMarkerAdd,
  onMarkerUpdate,
  onMarkerRemove,
  onToggle,
  onPrev,
  onNext,
  onPlaybackMode,
  onSeek,
  onSkip,
  onVolume,
  onToggleMute,
  onRate,
  onLoopChange,
  onLoopEnable,
  onLoopIn,
  onLoopOut,
  onClearLoop,
}: Props) {
  const disabled = !song?.audioUrl;
  const loopLen = loop ? loop.end - loop.start : 0;
  const modeLabel = PLAYBACK_MODE_LABELS[playbackMode];
  const [mixerOpen, setMixerOpen] = useState(false);
  const stems = song?.stems ?? [];
  const levels = stemLevels ?? {};
  const touched = stems.filter((s) => (levels[s] ?? 1) < 0.995);
  const allStemsOn = touched.length === 0;
  const stemChipLabel = allStemsOn
    ? "mix"
    : touched.length === 1 && (levels[touched[0]] ?? 1) <= 0.005
      ? `-${touched[0]}`
      : `${stems.length - touched.length}/${stems.length}`;

  return (
    <footer className="player practice-player">
      {/* Row 1: waveform */}
      <WaveformSeekBar
        audioUrl={song?.audioUrl ?? null}
        slug={song?.slug ?? null}
        currentTime={currentTime}
        duration={duration}
        buffered={buffered}
        loop={loop}
        loopEnabled={loopEnabled}
        markers={markers}
        disabled={disabled}
        onSeek={onSeek}
        onLoopChange={onLoopChange}
        onLoopEnable={onLoopEnable}
        onMarkerAdd={onMarkerAdd}
        onMarkerUpdate={onMarkerUpdate}
        onMarkerRemove={onMarkerRemove}
      />

      {/* Row 2: transport + loop + mixer entry */}
      <div className="player-deck">
        <div className="player-info">
          {song ? (
            <>
              <div className="player-title" title={song.title}>
                {song.title}
              </div>
              <div className="player-artist">{song.artist}</div>
            </>
          ) : (
            <div className="player-title muted">Nothing selected</div>
          )}
        </div>

        <div className="transport">
            <button
              type="button"
              className="icon-btn track-btn"
              onClick={onPrev}
            disabled={!song}
            aria-label="Previous track"
            title="Previous"
          >
            <TransportIcon kind="prev" />
          </button>
          <button
            type="button"
            className="icon-btn skip-btn"
            onClick={() => onSkip(-5)}
            disabled={disabled}
            aria-label="Back 5 seconds"
            title="-5s"
          >
            −5
          </button>
          <button
            type="button"
            className="icon-btn skip-btn"
            onClick={() => onSkip(-1)}
            disabled={disabled}
            aria-label="Back 1 second"
            title="-1s"
          >
            −1
          </button>
          <button
            type="button"
            className="play-btn"
            onClick={onToggle}
            disabled={disabled}
            aria-label={playing ? "Pause" : "Play"}
          >
            <TransportIcon kind={playing ? "pause" : "play"} />
          </button>
          <button
            type="button"
            className="icon-btn skip-btn"
            onClick={() => onSkip(1)}
            disabled={disabled}
            aria-label="Forward 1 second"
            title="+1s"
          >
            +1
          </button>
          <button
            type="button"
            className="icon-btn skip-btn"
            onClick={() => onSkip(5)}
            disabled={disabled}
            aria-label="Forward 5 seconds"
            title="+5s"
          >
            +5
          </button>
            <button
              type="button"
              className="icon-btn track-btn"
              onClick={onNext}
            disabled={!song}
            aria-label="Next track"
            title="Next"
          >
            <TransportIcon kind="next" />
          </button>
          <button
            type="button"
            className={`icon-btn mode-btn${playbackMode !== "sequential" ? " is-active" : ""}`}
            onClick={() => onPlaybackMode(nextPlaybackMode(playbackMode))}
            disabled={!song}
            aria-label={`Playback mode: ${modeLabel}. Click to change.`}
            title={`Playback: ${modeLabel} (R)`}
          >
            <RepeatIcon one={playbackMode === "repeat-one"} />
          </button>
        </div>

        {/* DAW-style loop strip */}
        <div className="loop-strip" role="group" aria-label="Loop controls">
          <button
            type="button"
            className={`loop-btn${loopEnabled ? " is-active" : ""}`}
            disabled={disabled || !loop}
            onClick={() => onLoopEnable(!loopEnabled)}
            title="Toggle loop (L)"
          >
            <LoopIcon />
            <span>Loop</span>
            {loopEnabled && <span className="loop-led" aria-hidden />}
          </button>
          <button
            type="button"
            className="loop-btn"
            disabled={disabled}
            onClick={onLoopIn}
            title="Set loop in at playhead (I)"
          >
            In
          </button>
          <button
            type="button"
            className="loop-btn"
            disabled={disabled}
            onClick={onLoopOut}
            title="Set loop out at playhead (O)"
          >
            Out
          </button>
          <button
            type="button"
            className="loop-btn loop-btn-clear"
            disabled={!loop}
            onClick={onClearLoop}
            title="Clear loop"
          >
            Clear
          </button>
          <div className="loop-readout mono">
            {loop ? (
              <>
                <span className={loopEnabled ? "accent" : ""}>
                  {formatTimePrecise(loop.start)}
                </span>
                <span className="muted">→</span>
                <span className={loopEnabled ? "accent" : ""}>
                  {formatTimePrecise(loop.end)}
                </span>
                <span className="muted">({formatTimePrecise(loopLen)})</span>
              </>
            ) : (
              <span className="muted">No region</span>
            )}
          </div>
        </div>

        <div className="deck-side">
          <button
            type="button"
            className={`chord-toggle mono${chordSheetOpen ? " is-active" : ""}${currentChord ? " has-chord" : ""}`}
            onClick={onToggleChordSheet}
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={chordSheetOpen}
            aria-label="Toggle chord sheet"
            title={
              currentChord
                ? `Current Chord: ${toLeadSheetNotation(currentChord)} (Click to open Chord Sheet)`
                : hasChords
                  ? "Open Chord Sheet"
                  : "No chords data"
            }
          >
            <span className="chord-name">
              {currentChord ? toLeadSheetNotation(currentChord) : (hasChords ? "Chord" : "--")}
            </span>
          </button>
          <button
            type="button"
            className={`mixer-toggle mono${mixerOpen ? " is-active" : ""}`}
            onClick={() => setMixerOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={mixerOpen}
            aria-label="Open mixer"
            title={`Mixer — speed ${playbackRate.toFixed(2)}×, ${
              allStemsOn ? "original mix" : `stems: ${touched.join(", ")} attenuated`
            }, volume ${Math.round((muted ? 0 : volume) * 100)}%`}
          >
            <span
              className={`mx-stat${Math.abs(playbackRate - 1) >= 0.005 ? " is-on" : ""}`}
            >
              {playbackRate.toFixed(2).replace(/\.?0+$/, "")}×
            </span>
            {pitch !== 0 && (
              <>
                <span className="mx-sep" aria-hidden>
                  ·
                </span>
                <span
                  className="mx-stat is-on is-pitch"
                  title={`Pitch ${pitch > 0 ? "+" : ""}${pitch} semitones`}
                >
                  {pitch > 0 ? `+${pitch}` : pitch}st
                </span>
              </>
            )}
            <span className="mx-sep" aria-hidden>
              ·
            </span>
            <span
              className={`mx-stat${!allStemsOn ? " is-on is-stem" : ""}`}
              title={
                allStemsOn
                  ? "Original mix"
                  : `Stem mix: ${touched.join(", ")} attenuated`
              }
            >
              {stemChipLabel}
            </span>
            <span className="mx-sep" aria-hidden>
              ·
            </span>
            <span
              className="mx-vol"
              role="img"
              aria-label={
                muted || volume === 0
                  ? "muted"
                  : `volume ${Math.round(volume * 100)}%`
              }
            >
              <span
                className="mx-vol-fill"
                style={{ width: `${Math.round((muted ? 0 : volume) * 100)}%` }}
              />
              <span className="mx-vol-text">
                {muted || volume === 0 ? "M" : `${Math.round(volume * 100)}`}
              </span>
            </span>
          </button>
        </div>
      </div>

      {mixerOpen && (
        <Modal title="Mixer" onClose={() => setMixerOpen(false)} className="mixer-card">
          {/* Fader Console: Stems (left) + Master Volume (right) */}
          <section className="mixer-section">
            <div className="mixer-section-header">
              <p className="mixer-section-title">
                {stems.length > 0 ? "Fader Console" : "Master Volume"}
                <span className="mixer-section-hint">
                  {stems.length > 0
                    ? " — drag faders to blend stems & overall volume"
                    : " — drag fader to adjust overall volume"}
                </span>
              </p>
              {stems.length > 0 && (
                <button
                  type="button"
                  className={`stem-all-btn${allStemsOn ? " is-hidden" : ""}`}
                  onClick={onStemReset}
                  disabled={allStemsOn}
                >
                  Reset Stems
                </button>
              )}
            </div>

            <div className="mx-fader-console">
              {stems.length > 0 && (
                <div className="mx-fader-bank">
                  {stems.map((s) => (
                    <StemFader
                      key={s}
                      label={s}
                      value={levels[s] ?? 1}
                      disabled={disabled}
                      onChange={(v) => onStemLevel(s, v)}
                    />
                  ))}
                </div>
              )}

              {stems.length > 0 && <div className="mx-console-divider" aria-hidden />}

              <VolumeFader
                volume={volume}
                muted={muted}
                disabled={!song}
                onVolume={onVolume}
                onToggleMute={onToggleMute}
              />
            </div>
          </section>

          {/* Playback Tuning Section: Pitch & Speed */}
          <div className="mixer-controls mixer-tuning-controls">
            <section className="mixer-section mixer-pitch">
              <p className="mixer-section-title">
                Pitch
                <span className="mixer-section-hint">
                  {" "}
                  — semitones, speed unchanged (adds slight latency)
                </span>
                {pitch !== 0 && (
                  <button
                    type="button"
                    className="stem-all-btn"
                    onClick={() => onPitch(0)}
                  >
                    Reset
                  </button>
                )}
              </p>
              <div className="pitch-control">
                <div className="speed-label">
                  <span className="speed-presets" role="group" aria-label="Pitch presets">
                    {PITCH_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`speed-chip${pitch === p ? " is-active" : ""}`}
                        disabled={disabled}
                        onClick={() => onPitch(p)}
                      >
                        {p === 0 ? "0" : `${p > 0 ? "+" : ""}${p}`}
                      </button>
                    ))}
                  </span>
                  <span
                    className={`speed-value mono pitch-val${pitch !== 0 ? " is-on" : ""}`}
                  >
                    {pitch > 0 ? `+${pitch}` : pitch} st
                  </span>
                </div>
                <div className="pitch-row">
                  <span className="mono pitch-bound">−12</span>
                  <input
                    type="range"
                    className="speed-slider pitch-slider"
                    min={-12}
                    max={12}
                    step={1}
                    value={pitch}
                    disabled={disabled}
                    onChange={(e) => onPitch(Number(e.target.value))}
                    aria-label="Pitch shift (semitones)"
                    style={
                      {
                        "--progress": `${((clamp(pitch, -12, 12) + 12) / 24) * 100}%`,
                      } as CSSProperties
                    }
                  />
                  <span className="mono pitch-bound">+12</span>
                </div>
              </div>
            </section>

            <section className="mixer-section mixer-speed">
              <p className="mixer-section-title">
                Speed
                <span className="mixer-section-hint">
                  {" "}
                  — audio rate, pitch follows
                </span>
              </p>
              <SpeedControl
                rate={playbackRate}
                disabled={disabled}
                onChange={onRate}
              />
            </section>
          </div>
        </Modal>
      )}

      <span className="sr-only" aria-live="polite">
        {modeLabel}
      </span>
    </footer>
  );
}

function TransportIcon({ kind }: { kind: "play" | "pause" | "prev" | "next" }) {
  if (kind === "play") {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
      >
        <path d="M8 5v14l11-7L8 5z" />
      </svg>
    );
  }
  if (kind === "pause") {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
      >
        <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
      </svg>
    );
  }
  if (kind === "prev") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
      >
        <path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z" />
      </svg>
    );
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z" />
    </svg>
  );
}

function RepeatIcon({ one }: { one: boolean }) {
  return (
    <span className="repeat-icon">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11v-1a4 4 0 014-4h14" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v1a4 4 0 01-4 4H3" />
      </svg>
      {one && (
        <span className="repeat-one-badge" aria-hidden>
          1
        </span>
      )}
    </span>
  );
}

function LoopIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 014-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 01-4 4H3" />
    </svg>
  );
}
