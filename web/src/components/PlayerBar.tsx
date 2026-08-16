import type { LoopRegion } from "../hooks/useAudioPlayer";
import {
  PLAYBACK_MODE_LABELS,
  nextPlaybackMode,
  type PlaybackMode,
} from "../hooks/useAudioPlayer";
import type { SongMarker } from "../hooks/useMarkers";
import type { SongSummary } from "../types";
import { formatTimePrecise } from "../utils/format";
import { SpeedControl } from "./SpeedControl";
import { VolumeFader } from "./VolumeFader";
import { WaveformSeekBar } from "./WaveformSeekBar";

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
  markers: SongMarker[];
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
  markers,
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

      {/* Row 2: transport + practice tools */}
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

        <div className="player-transport-block">
          <div className="transport">
            <button
              type="button"
              className="icon-btn"
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
              className="icon-btn"
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
        </div>

        <SpeedControl
          rate={playbackRate}
          disabled={disabled}
          onChange={onRate}
        />

        <VolumeFader
          volume={volume}
          muted={muted}
          disabled={!song}
          onVolume={onVolume}
          onToggleMute={onToggleMute}
        />
      </div>
      <span className="sr-only" aria-live="polite">
        {modeLabel}
      </span>
    </footer>
  );
}

function TransportIcon({ kind }: { kind: "play" | "pause" | "prev" | "next" }) {
  if (kind === "play") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M8 5v14l11-7L8 5z" />
      </svg>
    );
  }
  if (kind === "pause") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
      </svg>
    );
  }
  if (kind === "prev") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 014-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 01-4 4H3" />
    </svg>
  );
}
