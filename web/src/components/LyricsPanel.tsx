import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  MARKER_PRESETS,
  type SongMarker,
  type StanzaTag,
} from "../hooks/useMarkers";
import type { SongSummary } from "../types";
import {
  formatTimePrecise,
  parseLyricsBlocks,
  parseLyricsMarkdown,
} from "../utils/format";

type Props = {
  song: SongSummary | null;
  markdown: string | null;
  loading: boolean;
  error: string | null;
  buffering?: boolean;
  markers: SongMarker[];
  stanzaTags: StanzaTag[];
  currentTime: number;
  onSeek: (t: number) => void;
  onMarkerUpdate: (
    id: string,
    patch: Partial<Pick<SongMarker, "time" | "label" | "stanzaIndex">>,
  ) => void;
  onStanzaTagAdd: (stanzaIndex: number, label: string) => void;
  onStanzaTagRemove: (id: string) => void;
};

function renderInline(text: string) {
  return text.split(/\*([^*]+)\*/g).map((part, i) =>
    i % 2 === 1 ? <em key={i}>{part}</em> : part,
  );
}

export function LyricsPanel({
  song,
  markdown,
  loading,
  error,
  buffering,
  markers,
  stanzaTags,
  currentTime,
  onSeek,
  onMarkerUpdate,
  onStanzaTagAdd,
  onStanzaTagRemove,
}: Props) {
  const [popover, setPopover] = useState<{
    stanzaIndex: number;
    custom: string;
    x: number;
    y: number;
  } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Center-stage buffering overlay: appears the instant decoding starts and
  // fades out only once playback is actually about to reach the speakers.
  const [bufferOverlay, setBufferOverlay] = useState<"hidden" | "shown" | "fading">(
    "hidden",
  );
  useEffect(() => {
    if (buffering) {
      setBufferOverlay("shown");
      return;
    }
    setBufferOverlay((prev) => (prev === "shown" ? "fading" : prev));
    const t = window.setTimeout(() => setBufferOverlay("hidden"), 220);
    return () => window.clearTimeout(t);
  }, [buffering]);

  useEffect(() => {
    if (!popover) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setPopover(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [popover]);

  const blocks = useMemo(() => {
    if (!markdown) return [];
    return parseLyricsBlocks(parseLyricsMarkdown(markdown).body);
  }, [markdown]);

  // stanza index -> linked markers
  const byStanza = useMemo(() => {
    const map = new Map<number, SongMarker[]>();
    for (const m of markers) {
      if (m.stanzaIndex == null) continue;
      const arr = map.get(m.stanzaIndex) ?? [];
      arr.push(m);
      map.set(m.stanzaIndex, arr);
    }
    return map;
  }, [markers]);

  // stanza index -> lyrics-only tags
  const tagsByStanza = useMemo(() => {
    const map = new Map<number, StanzaTag[]>();
    for (const t of stanzaTags) {
      const arr = map.get(t.stanzaIndex) ?? [];
      arr.push(t);
      map.set(t.stanzaIndex, arr);
    }
    return map;
  }, [stanzaTags]);

  // tag label -> timeline marker with the same label (first match)
  const markerByLabel = useMemo(() => {
    const map = new Map<string, SongMarker>();
    for (const m of markers) {
      if (!map.has(m.label)) map.set(m.label, m);
    }
    return map;
  }, [markers]);

  // Active section = the latest marker at or before the playhead
  const activeMarkerId = useMemo(() => {
    if (markers.length === 0) return null;
    let active: SongMarker | null = null;
    for (const m of markers) {
      if (m.time <= currentTime + 0.2) active = m;
      else break;
    }
    return active?.id ?? null;
  }, [markers, currentTime]);

  if (!song) {
    return (
      <main className="main">
        <div className="empty-state">
          <h1>Select a song</h1>
          <p>Pick a track from the list to play and view lyrics.</p>
          <p className="hint">
            Folder layout:{" "}
            <code>songs/&#123;slug&#125;/&#123;slug&#125;.mp3</code>,{" "}
            <code>meta.json</code>, <code>lyrics.md</code>
          </p>
        </div>
      </main>
    );
  }

  const confirmCustom = (stanzaIndex: number, label: string) => {
    onStanzaTagAdd(stanzaIndex, label.trim() || "Tag");
    setPopover(null);
  };

  let stanzaCounter = -1;

  return (
    <main className="main">
      {bufferOverlay !== "hidden" && (
        <div
          className={`main-buffering-overlay${bufferOverlay === "fading" ? " is-fading" : ""}`}
          role="status"
          aria-label="Buffering audio"
        >
          <span className="main-buffering-spinner" aria-hidden />
          <span className="main-buffering-text">Buffering</span>
        </div>
      )}
      <header className="track-header">
        <div>
          <h1>{song.title}</h1>
          <p className="track-artist">{song.artist}</p>
          <div className="track-chips">
            <span className="chip mono">{song.slug}</span>
            {song.lyricist && (
              <span className="chip">L: {song.lyricist}</span>
            )}
            {song.composer && (
              <span className="chip">C: {song.composer}</span>
            )}
            {song.sourceUrl && (
              <a
                className="chip chip-link"
                href={song.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Source ↗
              </a>
            )}
          </div>
        </div>
      </header>

      <section className="lyrics-card" aria-label="Lyrics">
        {loading && <p className="muted">Loading lyrics…</p>}
        {error && !loading && (
          <p className="muted">
            {song.hasLyrics ? error : "No lyrics.md for this track."}
          </p>
        )}
        {!loading && !error && blocks.length > 0 && (
          <div className="lyrics-body">
            {blocks.map((block, i) => {
              if (block.type === "heading") {
                return (
                  <h2 className="lyrics-title" key={i}>
                    {block.text}
                  </h2>
                );
              }
              if (block.type === "artist") {
                return (
                  <p className="lyrics-artist" key={i}>
                    {block.text}
                  </p>
                );
              }
              if (block.type === "section") {
                return (
                  <div className="lyrics-section" key={i}>
                    {block.text}
                  </div>
                );
              }

              const idx = ++stanzaCounter;
              const chips = byStanza.get(idx) ?? [];
              const tags = tagsByStanza.get(idx) ?? [];
              const open = popover?.stanzaIndex === idx;

              return (
                <div className="lyrics-stanza" key={i}>
                  <div
                    className={`stanza-markers${chips.length + tags.length > 0 ? " has-chips" : ""}`}
                  >
                    {chips.map((m) => (
                      <span
                        key={m.id}
                        className={`chip-wrap${m.id === activeMarkerId ? " is-active" : ""}`}
                      >
                        <button
                          type="button"
                          className="marker-chip mono"
                          onClick={() => onSeek(m.time)}
                          title={`Jump to ${formatTimePrecise(m.time)}`}
                        >
                          {m.label}
                        </button>
                        <button
                          type="button"
                          className="chip-x"
                          title="Remove tag from this line"
                          aria-label={`Remove tag ${m.label}`}
                          onClick={() =>
                            onMarkerUpdate(m.id, { stanzaIndex: undefined })
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {tags.map((t) => {
                      const linked = markerByLabel.get(t.label);
                      return (
                        <span key={t.id} className="chip-wrap">
                          {linked ? (
                            <button
                              type="button"
                              className="marker-chip mono is-jump"
                              onClick={() => onSeek(linked.time)}
                              title={`Jump to ${formatTimePrecise(linked.time)}`}
                            >
                              {t.label}
                            </button>
                          ) : (
                            <span
                              className="marker-chip mono is-plain"
                              title="Lyrics tag (no matching timeline marker)"
                            >
                              {t.label}
                            </span>
                          )}
                          <button
                            type="button"
                            className="chip-x"
                            title="Delete tag"
                            aria-label={`Delete tag ${t.label}`}
                            onClick={() => onStanzaTagRemove(t.id)}
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                    <button
                      type="button"
                      className={`stanza-add${open ? " is-open" : ""}`}
                      title="Tag this section"
                      aria-label={`Tag stanza ${idx + 1}`}
                      onClick={(e) => {
                        if (open) {
                          setPopover(null);
                          return;
                        }
                        const r = (
                          e.currentTarget as HTMLButtonElement
                        ).getBoundingClientRect();
                        setPopover({
                          stanzaIndex: idx,
                          custom: "",
                          x: r.left,
                          y: r.bottom + 4,
                        });
                      }}
                    >
                      + tag
                    </button>
                  </div>
                  <p className="lyrics-line">
                    {renderInline(block.lines[0])}
                    {block.lines.slice(1).map((ln, j) => (
                      <Fragment key={j}>
                        <br />
                        {renderInline(ln)}
                      </Fragment>
                    ))}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {popover && (
        <div
          ref={popoverRef}
          className="stanza-popover"
          style={{
            left: `min(${popover.x}px, calc(100vw - 23rem))`,
            top: `min(${popover.y}px, calc(100vh - 16rem))`,
          }}
        >
          <div className="wf-me-tags">
            {MARKER_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="wf-me-tag mono"
                onClick={() => {
                  onStanzaTagAdd(popover.stanzaIndex, preset);
                  setPopover(null);
                }}
              >
                {preset}
              </button>
            ))}
          </div>
          {markers.length > 0 && (
            <>
              <p className="popover-hint">Link timeline marker:</p>
              <div className="wf-me-tags">
                {markers.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="wf-me-tag mono"
                    onClick={() => {
                      onMarkerUpdate(m.id, { stanzaIndex: popover.stanzaIndex });
                      setPopover(null);
                    }}
                  >
                    {m.label} · {formatTimePrecise(m.time)}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="wf-me-row">
            <input
              autoFocus
              value={popover.custom}
              placeholder="Custom tag…"
              onChange={(e) =>
                setPopover({ ...popover, custom: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  confirmCustom(popover.stanzaIndex, popover.custom);
                else if (e.key === "Escape") setPopover(null);
              }}
            />
            <button
              type="button"
              className="wf-me-btn"
              title="Add tag (Enter)"
              onClick={() => confirmCustom(popover.stanzaIndex, popover.custom)}
            >
              ✓
            </button>
          </div>
          <p className="popover-hint">
            Tags annotate the lyric line only — they are not added to the
            timeline.
          </p>
        </div>
      )}
    </main>
  );
}
