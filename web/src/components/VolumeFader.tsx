import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { clamp, volumeToDbLabel } from "../utils/format";

type Props = {
  volume: number;
  muted: boolean;
  disabled?: boolean;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
};

export function VolumeFader({
  volume,
  muted,
  disabled,
  onVolume,
  onToggleMute,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const display = muted ? 0 : volume;
  const pct = display * 100;

  const setFromClientY = useCallback(
    (clientY: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Top = 1, bottom = 0
      const ratio = 1 - (clientY - rect.top) / rect.height;
      onVolume(clamp(ratio, 0, 1));
    },
    [onVolume],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromClientY(e.clientY);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setFromClientY(e.clientY);
  };

  return (
    <div className={`vol-fader${disabled ? " is-disabled" : ""}`}>
      <button
        type="button"
        className={`vol-mute${muted || volume === 0 ? " is-muted" : ""}`}
        onClick={onToggleMute}
        disabled={disabled}
        aria-label={muted ? "Unmute" : "Mute"}
        title={muted ? "Unmute" : "Mute"}
      >
        {muted || volume === 0 ? "M" : "VOL"}
      </button>

      <div className="vol-fader-meter">
        <div
          ref={trackRef}
          className="vol-fader-track"
          role="slider"
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(display * 100)}
          aria-valuetext={`${volumeToDbLabel(display)} dB`}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          }}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onVolume(clamp(volume + 0.02, 0, 1));
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onVolume(clamp(volume - 0.02, 0, 1));
            }
          }}
        >
          <div className="vol-fader-fill" style={{ height: `${pct}%` }} />
          <div className="vol-fader-thumb" style={{ bottom: `${pct}%` }} />
          <div className="vol-fader-ticks" aria-hidden>
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>

      <div className="vol-db mono" title="Level (dBFS approx.)">
        {muted ? "-∞" : volumeToDbLabel(volume)}
        <span className="vol-db-unit">dB</span>
      </div>
    </div>
  );
}
