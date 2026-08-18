import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";

type Props = {
  value: number; // 0..1
  label: string;
  disabled?: boolean;
  onChange: (v: number) => void;
};

/** Compact vertical fader for per-stem levels (physical-mixer style). */
export function StemFader({ value, label, disabled, onChange }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = Math.round(value * 100);

  const setFromClientY = useCallback(
    (clientY: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Top = 1, bottom = 0
      const ratio = 1 - (clientY - rect.top) / rect.height;
      onChange(Math.min(1, Math.max(0, ratio)));
    },
    [onChange],
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

  const onToggleMute = () => {
    if (disabled) return;
    onChange(value > 0.005 ? 0 : 1);
  };

  return (
    <div className={`mx-fader${disabled ? " is-disabled" : ""}`}>
      <button
        type="button"
        className={`mx-fader-mute mono${value <= 0.005 ? " is-muted" : ""}`}
        onClick={onToggleMute}
        disabled={disabled}
        aria-label={`${value <= 0.005 ? "Unmute" : "Mute"} ${label}`}
        title={value <= 0.005 ? `Unmute ${label}` : `Mute ${label}`}
      >
        M
      </button>
      <div
        ref={trackRef}
        className="mx-fader-track"
        role="slider"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
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
            onChange(Math.min(1, value + 0.02));
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onChange(Math.max(0, value - 0.02));
          }
        }}
      >
        <div className="mx-fader-fill" style={{ height: `${pct}%` }} />
        <div className="mx-fader-thumb" style={{ bottom: `${pct}%` }} />
        <div className="mx-fader-ticks" aria-hidden>
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
      <span className="mx-fader-label mono">{label}</span>
      <span className="mx-fader-val mono">{pct}%</span>
    </div>
  );
}
