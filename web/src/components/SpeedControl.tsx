import type { CSSProperties } from "react";
import { RATE_PRESETS } from "../hooks/useAudioPlayer";
import { clamp } from "../utils/format";

type Props = {
  rate: number;
  disabled?: boolean;
  onChange: (rate: number) => void;
};

export function SpeedControl({ rate, disabled, onChange }: Props) {
  return (
    <div className={`speed-control${disabled ? " is-disabled" : ""}`}>
      <div className="speed-label">
        <span className="speed-kicker">Speed</span>
        <span className="speed-value mono">{rate.toFixed(2)}×</span>
      </div>

      <div className="speed-presets" role="group" aria-label="Playback speed presets">
        {RATE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`speed-chip${Math.abs(rate - p) < 0.001 ? " is-active" : ""}`}
            disabled={disabled}
            onClick={() => onChange(p)}
          >
            {p === 1 ? "1×" : `${p}×`}
          </button>
        ))}
      </div>

      <input
        type="range"
        className="speed-slider"
        min={0.5}
        max={1.5}
        step={0.01}
        value={clamp(rate, 0.5, 1.5)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Playback rate"
        style={
          {
            "--progress": `${((clamp(rate, 0.5, 1.5) - 0.5) / 1) * 100}%`,
          } as CSSProperties
        }
      />
    </div>
  );
}
