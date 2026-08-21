import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { LoopRegion } from "../hooks/useAudioPlayer";
import type { SongMarker } from "../hooks/useMarkers";
import { MARKER_PRESETS, suggestMarkerLabel } from "../hooks/useMarkers";
import { clamp, formatTimePrecise } from "../utils/format";
import { loadWaveformPeaks, syntheticPeaks } from "../utils/waveform";

type DragMode =
  | null
  | { kind: "seek" }
  | { kind: "loop-start" }
  | { kind: "loop-end" }
  | { kind: "loop-body"; offset: number; length: number };

type Props = {
  audioUrl: string | null;
  slug: string | null;
  currentTime: number;
  duration: number;
  buffered: number;
  buffering?: boolean;
  loop: LoopRegion | null;
  loopEnabled: boolean;
  markers: SongMarker[];
  disabled?: boolean;
  onSeek: (t: number) => void;
  onLoopChange: (region: LoopRegion | null) => void;
  onLoopEnable: (on: boolean) => void;
  onMarkerAdd: (time: number, label: string) => void;
  onMarkerUpdate: (id: string, patch: Partial<Pick<SongMarker, "time" | "label">>) => void;
  onMarkerRemove: (id: string) => void;
  rightSlot?: React.ReactNode;
};

type MarkerEditor = {
  markerId: string | null;
  time: number;
  label: string;
};

const MIN_BARS = 48;
const MAX_BARS = 600;
const BAR_PITCH_PX = 5; // ~4px bar + 1px gap
const DRAG_THRESHOLD_PX = 4;
const LONG_PRESS_MS = 2000;
const FLAG_DRAG_THRESHOLD_PX = 3;

export function WaveformSeekBar({
  audioUrl,
  slug,
  currentTime,
  duration,
  buffered,
  buffering,
  loop,
  loopEnabled,
  markers,
  disabled,
  onSeek,
  onLoopChange,
  onLoopEnable,
  onMarkerAdd,
  onMarkerUpdate,
  onMarkerRemove,
  rightSlot,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = useState(220);
  const [peaks, setPeaks] = useState<number[]>(() =>
    syntheticPeaks(slug ?? "idle", 220),
  );
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const dragRef = useRef<DragMode>(null);
  const [dragging, setDragging] = useState(false);
  const loopDragRef = useRef<{ anchor: number; x: number; moved: boolean } | null>(
    null,
  );
  const [markerEditor, setMarkerEditor] = useState<MarkerEditor | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef<{ timer: number; x: number } | null>(null);
  const flagDragRef = useRef<{ id: string; x: number; moved: boolean } | null>(
    null,
  );
  const flagLongPressRef = useRef<number | null>(null);

  useEffect(() => {
    if (!markerEditor) return;
    const handleOutsideClick = (e: PointerEvent) => {
      if (editorRef.current && !editorRef.current.contains(e.target as Node)) {
        setMarkerEditor(null);
      }
    };
    // Use setTimeout so the current pointerdown event doesn't trigger immediate close
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", handleOutsideClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", handleOutsideClick);
    };
  }, [markerEditor]);

  const clearLongPress = useCallback(() => {
    if (longPressRef.current) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
    if (flagLongPressRef.current != null) {
      window.clearTimeout(flagLongPressRef.current);
      flagLongPressRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  // Keep the bar count in sync with the track width so the waveform
  // stretches to fill the whole seek bar on wide windows.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => {
      const n = Math.round(
        clamp(el.clientWidth / BAR_PITCH_PX, MIN_BARS, MAX_BARS),
      );
      setBarCount((prev) => (prev === n ? prev : n));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!audioUrl) {
      setPeaks(syntheticPeaks(slug ?? "idle", barCount));
      return;
    }
    let cancelled = false;
    setPeaks(syntheticPeaks(slug ?? audioUrl, barCount));
    void loadWaveformPeaks(audioUrl, barCount).then((p) => {
      if (!cancelled) setPeaks(p);
    });
    return () => {
      cancelled = true;
    };
  }, [audioUrl, slug, barCount]);

  const ratioToTime = useCallback(
    (ratio: number) => clamp(ratio, 0, 1) * (duration || 0),
    [duration],
  );

  const clientXToRatio = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  }, []);

  const progress = duration > 0 ? currentTime / duration : 0;
  const loopStartR = loop && duration > 0 ? loop.start / duration : 0;
  const loopEndR = loop && duration > 0 ? loop.end / duration : 0;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (markerEditor) setMarkerEditor(null);
    if (disabled || !duration) return;
    const target = e.target as HTMLElement;
    const handle = target.dataset.handle as
      | "start"
      | "end"
      | "body"
      | undefined;

    e.currentTarget.setPointerCapture(e.pointerId);
    const ratio = clientXToRatio(e.clientX);
    const t = ratioToTime(ratio);

    if (handle === "start" && loop) {
      dragRef.current = { kind: "loop-start" };
      setDragging(true);
      return;
    }
    if (handle === "end" && loop) {
      dragRef.current = { kind: "loop-end" };
      setDragging(true);
      return;
    }
    if (handle === "body" && loop) {
      dragRef.current = {
        kind: "loop-body",
        offset: t - loop.start,
        length: loop.end - loop.start,
      };
      setDragging(true);
      return;
    }

    // Pending: click = seek, drag = select loop, hold = add marker
    dragRef.current = { kind: "seek" };
    setDragging(true);
    onSeek(t);

    clearLongPress();
    const x = e.clientX;
    const timer = window.setTimeout(() => {
      longPressRef.current = null;
      // Held still: cancel the pending seek and open the marker editor
      dragRef.current = null;
      setDragging(false);
      setMarkerEditor({
        markerId: null,
        time: t,
        label: suggestMarkerLabel(markers.length),
      });
    }, LONG_PRESS_MS);
    longPressRef.current = { timer, x };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ratio = clientXToRatio(e.clientX);
    setHoverRatio(ratio);
    if (!dragRef.current || !duration) return;

    const t = ratioToTime(ratio);
    const mode = dragRef.current;

    // Waveform drag = scrub seek only (loop selection lives on the time bar)
    if (mode.kind === "seek") {
      // Scrubbing cancels the pending long-press marker popup
      const lp = longPressRef.current;
      if (lp && Math.abs(e.clientX - lp.x) > DRAG_THRESHOLD_PX) {
        window.clearTimeout(lp.timer);
        longPressRef.current = null;
      }
      onSeek(t);
      return;
    }

    if (mode.kind === "loop-start" && loop) {
      onLoopChange({ start: Math.min(t, loop.end - 0.25), end: loop.end });
      return;
    }

    if (mode.kind === "loop-end" && loop) {
      onLoopChange({ start: loop.start, end: Math.max(t, loop.start + 0.25) });
      return;
    }

    if (mode.kind === "loop-body") {
      let start = t - mode.offset;
      start = clamp(start, 0, Math.max(0, duration - mode.length));
      onLoopChange({ start, end: start + mode.length });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPress();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  // --- Time bar (above the waveform): drag = select loop, tap = seek ---
  const onTimeBarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (markerEditor) setMarkerEditor(null);
    if (disabled || !duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = ratioToTime(clientXToRatio(e.clientX));
    loopDragRef.current = { anchor: t, x: e.clientX, moved: false };
  };

  const onTimeBarPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ld = loopDragRef.current;
    if (!ld || !duration) return;
    if (
      !ld.moved &&
      Math.abs(e.clientX - ld.x) <= DRAG_THRESHOLD_PX
    )
      return;
    ld.moved = true;
    const t = ratioToTime(clientXToRatio(e.clientX));
    onLoopChange({
      start: Math.min(ld.anchor, t),
      end: Math.max(ld.anchor, t),
    });
    onLoopEnable(true);
  };

  const onTimeBarPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ld = loopDragRef.current;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    loopDragRef.current = null;
    if (ld && !ld.moved) {
      // Tap without drag = seek
      onSeek(ratioToTime(clientXToRatio(e.clientX)));
    }
  };

  // --- Marker flags: drag to move, click to edit ---
  const onFlagPointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    marker: SongMarker,
  ) => {
    if (disabled || !duration) return;
    e.stopPropagation(); // don't trigger waveform seek/loop gestures
    e.currentTarget.setPointerCapture(e.pointerId);
    flagDragRef.current = { id: marker.id, x: e.clientX, moved: false };
    // Hold still = open editor; moving cancels into a drag
    flagLongPressRef.current = window.setTimeout(() => {
      flagLongPressRef.current = null;
      flagDragRef.current = null;
      setMarkerEditor({
        markerId: marker.id,
        time: marker.time,
        label: marker.label,
      });
    }, LONG_PRESS_MS);
  };

  const onFlagPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const fd = flagDragRef.current;
    if (!fd || !duration) return;
    if (!fd.moved && Math.abs(e.clientX - fd.x) <= FLAG_DRAG_THRESHOLD_PX)
      return;
    fd.moved = true;
    if (flagLongPressRef.current != null) {
      window.clearTimeout(flagLongPressRef.current);
      flagLongPressRef.current = null;
    }
    const t = ratioToTime(clientXToRatio(e.clientX));
    onMarkerUpdate(fd.id, { time: t });
  };

  const onFlagPointerUp = (
    e: ReactPointerEvent<HTMLDivElement>,
    marker: SongMarker,
  ) => {
    const fd = flagDragRef.current;
    if (flagLongPressRef.current != null) {
      window.clearTimeout(flagLongPressRef.current);
      flagLongPressRef.current = null;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    flagDragRef.current = null;
    if (fd && !fd.moved) {
      // Click (no drag) = jump to the marker position
      onSeek(marker.time);
    }
  };

  const confirmMarkerEditor = () => {
    if (!markerEditor) return;
    const label =
      markerEditor.label.trim() || suggestMarkerLabel(markers.length);
    if (markerEditor.markerId) {
      onMarkerUpdate(markerEditor.markerId, { label });
    } else {
      onMarkerAdd(markerEditor.time, label);
    }
    setMarkerEditor(null);
  };

  const onPointerLeave = () => {
    if (!dragging) setHoverRatio(null);
  };

  const hoverTime =
    hoverRatio != null && duration > 0 ? ratioToTime(hoverRatio) : null;

  return (
    <div className="waveform-wrap">
      <div
        className={`waveform-times${disabled ? " is-disabled" : ""}`}
        title="Drag to select loop · Tap to seek"
        onPointerDown={onTimeBarPointerDown}
        onPointerMove={onTimeBarPointerMove}
        onPointerUp={onTimeBarPointerUp}
        onPointerCancel={onTimeBarPointerUp}
        onContextMenu={(e) => {
          e.preventDefault();
          if (disabled || !duration) return;
          const ratio = clientXToRatio(e.clientX);
          const t = ratioToTime(ratio);
          setMarkerEditor({
            markerId: null,
            time: t,
            label: suggestMarkerLabel(markers.length),
          });
        }}
      >
        {/* Loop selection track */}
        <div className="loop-strip-line" aria-hidden />
        {loop && duration > 0 && (
          <div
            className={`loop-strip-range${loopEnabled ? " is-active" : ""}`}
            style={{
              left: `${loopStartR * 100}%`,
              width: `${Math.max(0, (loopEndR - loopStartR) * 100)}%`,
            }}
            aria-hidden
          />
        )}
        <span className="mono">{formatTimePrecise(currentTime)}</span>
        {hoverTime != null && !disabled && (
          <span className="waveform-hover mono">
            {formatTimePrecise(hoverTime)}
          </span>
        )}
        <div className="waveform-times-right">
          <span className="mono muted">{formatTimePrecise(duration)}</span>
          {rightSlot}
        </div>
      </div>

      <div
        ref={trackRef}
        className={`waveform${disabled ? " is-disabled" : ""}${dragging ? " is-dragging" : ""}`}
        role="slider"
        aria-label="Seek bar. Drag to scrub; select loops on the time bar above."
        aria-valuemin={0}
        aria-valuemax={duration || 0}
        aria-valuenow={currentTime}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => {
          e.preventDefault();
          if (disabled || !duration) return;
          const ratio = clientXToRatio(e.clientX);
          const t = ratioToTime(ratio);
          setMarkerEditor({
            markerId: null,
            time: t,
            label: suggestMarkerLabel(markers.length),
          });
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onSeek(currentTime - (e.shiftKey ? 5 : 1));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onSeek(currentTime + (e.shiftKey ? 5 : 1));
          }
        }}
      >
        {/* Buffered */}
        <div
          className="waveform-buffered"
          style={{ width: `${buffered * 100}%` }}
        />

        {/* Bars */}
        <div className="waveform-bars" aria-hidden>
          {peaks.map((p, i) => {
            const r = (i + 0.5) / peaks.length;
            const played = r <= progress;
            const inLoop =
              loop && r >= loopStartR && r <= loopEndR;
            return (
              <span
                key={i}
                className={[
                  "wf-bar",
                  played ? "is-played" : "",
                  inLoop ? "in-loop" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ height: `${Math.max(8, p * 100)}%` }}
              />
            );
          })}
        </div>

        {/* Loop region */}
        {loop && duration > 0 && (
          <div
            className={`waveform-loop${loopEnabled ? " is-active" : ""}`}
            style={{
              left: `${loopStartR * 100}%`,
              width: `${Math.max(0, (loopEndR - loopStartR) * 100)}%`,
            }}
          >
            <div
              className="loop-handle loop-handle-start"
              data-handle="start"
              title="Loop in"
            />
            <div className="loop-body" data-handle="body" title="Move loop" />
            <div
              className="loop-handle loop-handle-end"
              data-handle="end"
              title="Loop out"
            />
            <div className="loop-label mono">
              {formatTimePrecise(loop.start)} – {formatTimePrecise(loop.end)}
              <span className="loop-len">
                {" "}
                ({formatTimePrecise(loop.end - loop.start)})
              </span>
            </div>
          </div>
        )}

        {/* Section markers */}
        {duration > 0 &&
          markers.map((m) => (
            <div
              key={m.id}
              className="wf-marker"
              style={{ left: `${(m.time / duration) * 100}%` }}
            >
              <div
                className={`wf-marker-flag mono${m.row === 1 ? " is-row2" : ""}`}
                title={`${m.label} @ ${formatTimePrecise(m.time)} · click to jump, hold/double-click to edit, drag to move`}
                onPointerDown={(e) => onFlagPointerDown(e, m)}
                onPointerMove={onFlagPointerMove}
                onPointerUp={(e) => onFlagPointerUp(e, m)}
                onPointerCancel={(e) => onFlagPointerUp(e, m)}
                onDoubleClick={() => {
                  if (disabled) return;
                  setMarkerEditor({
                    markerId: m.id,
                    time: m.time,
                    label: m.label,
                  });
                }}
              >
                {m.label}
              </div>
            </div>
          ))}

        {/* Playhead */}
        <div
          className="waveform-playhead"
          style={{ left: `${progress * 100}%` }}
        />

        {/* Hover line */}
        {hoverRatio != null && !disabled && (
          <div
            className="waveform-hover-line"
            style={{ left: `${hoverRatio * 100}%` }}
          />
        )}

        {/* Buffering Spinner Overlay */}
        {buffering && (
          <div className="waveform-buffering-overlay" aria-label="Buffering audio...">
            <div className="waveform-spinner" />
            <span className="waveform-buffering-text">Buffering</span>
          </div>
        )}
      </div>

      {markerEditor && (
        <div
          ref={editorRef}
          className="wf-marker-editor"
          style={{
            left: `${clamp(markerEditor.time / (duration || 1), 0.06, 0.94) * 100}%`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="wf-me-tags">
            {MARKER_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`wf-me-tag mono${
                  markerEditor.label === preset ? " is-active" : ""
                }`}
                onClick={() =>
                  setMarkerEditor({ ...markerEditor, label: preset })
                }
              >
                {preset}
              </button>
            ))}
          </div>
          <div className="wf-me-row">
            <input
              autoFocus
              value={markerEditor.label}
              placeholder="Custom label…"
              onChange={(e) =>
                setMarkerEditor({ ...markerEditor, label: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmMarkerEditor();
                else if (e.key === "Escape") setMarkerEditor(null);
              }}
            />
            <button
              type="button"
              className="wf-me-btn"
              onClick={confirmMarkerEditor}
              title="Save marker (Enter)"
            >
              ✓
            </button>
            {markerEditor.markerId && (
              <button
                type="button"
                className="wf-me-btn danger"
                onClick={() => {
                  onMarkerRemove(markerEditor.markerId!);
                  setMarkerEditor(null);
                }}
                title="Delete marker"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
