import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { formatGain, gainToPos, posToGain } from "../audio/gain";
import { clamp } from "../utils/format";

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
  const pos = gainToPos(display);
  const posPct = Math.round(pos * 100);

  const setFromClientY = useCallback(
    (clientY: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Top = max boost, bottom = 0
      const ratio = 1 - (clientY - rect.top) / rect.height;
      onVolume(posToGain(clamp(ratio, 0, 1)));
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
    <div className={`mx-fader mx-fader-master${disabled ? " is-disabled" : ""}`}>
      <button
        type="button"
        className={`mx-fader-mute mono${muted || volume === 0 ? " is-muted" : ""}`}
        onClick={onToggleMute}
        disabled={disabled}
        aria-label={muted || volume === 0 ? "Unmute Master" : "Mute Master"}
        title={muted || volume === 0 ? "Unmute Master" : "Mute Master"}
      >
        M
      </button>

      <div
        ref={trackRef}
        className="mx-fader-track mx-master-track"
        role="slider"
        aria-label="Master volume"
        aria-valuemin={0}
        aria-valuemax={200}
        aria-valuenow={Math.round(display * 100)}
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
            onVolume(posToGain(clamp(pos + 0.02, 0, 1)));
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onVolume(posToGain(clamp(pos - 0.02, 0, 1)));
          }
        }}
      >
        <div className="mx-fader-boost-zone" aria-hidden />
        <div className="mx-fader-unity" aria-hidden />
        <div
          className={`mx-fader-fill mx-master-fill${display > 1 ? " is-boost" : ""}`}
          style={{ height: `${posPct}%` }}
        />
        <div className="mx-fader-thumb" style={{ bottom: `${posPct}%` }} />
        <div className="mx-fader-ticks" aria-hidden>
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>

      <span className="mx-fader-label mx-master-label mono">Master</span>
      <span className="mx-fader-val mx-master-val mono">{formatGain(display)}</span>
    </div>
  );
}
