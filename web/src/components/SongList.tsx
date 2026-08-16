import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Setlist } from "../hooks/useSetlists";
import type { SongSummary } from "../types";
import { formatDuration } from "../utils/format";

type Props = {
  songs: SongSummary[];
  displaySongs: SongSummary[];
  currentSlug: string | null;
  playing: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  onSelect: (song: SongSummary) => void;
  mode: string | null; // null = all songs, else setlist id
  onModeChange: (id: string | null) => void;
  setlists: Setlist[];
  activeSetlist: Setlist | null;
  editable: boolean;
  onSaveSetlist: (setlist: Setlist) => void;
  onRemoveSetlist: (id: string) => void;
  onCreate: (name: string) => Setlist;
};

export function SongList({
  songs,
  displaySongs,
  currentSlug,
  playing,
  query,
  onQueryChange,
  onSelect,
  mode,
  onModeChange,
  setlists,
  activeSetlist,
  editable,
  onSaveSetlist,
  onRemoveSetlist,
  onCreate,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDocDown);
    return () => document.removeEventListener("pointerdown", onDocDown);
  }, [menuOpen]);

  const inSet = new Set(activeSetlist?.songs ?? []);
  const addable = songs.filter((s) => !inSet.has(s.slug));

  const addableFiltered = (() => {
    const q = addQuery.trim().toLowerCase();
    if (!q) return addable;
    return addable.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.artist.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q),
    );
  })();

  const mutate = (songsNext: string[]) => {
    if (activeSetlist) onSaveSetlist({ ...activeSetlist, songs: songsNext });
  };

  const move = (slug: string, dir: -1 | 1) => {
    if (!activeSetlist) return;
    const list = [...activeSetlist.songs];
    const i = list.indexOf(slug);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    mutate(list);
  };

  const createSetlist = () => {
    const name = newName.trim();
    if (!name) return;
    const sl = onCreate(name);
    onSaveSetlist(sl);
    setNewName("");
    setCreating(false);
    setMenuOpen(false);
    onModeChange(sl.id);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="mode-selector" ref={menuRef}>
          <button
            type="button"
            className="mode-button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="brand-mark" aria-hidden />
            <span className="mode-text">
              <span className="mode-title">
                {activeSetlist?.name ?? "All Songs"}
              </span>
              <span className="brand-sub">
                {displaySongs.length} tracks
              </span>
            </span>
            <span className="mode-chevron" aria-hidden>
              ▾
            </span>
          </button>

          {menuOpen && (
            <div className="mode-menu" role="menu">
              <button
                type="button"
                className={`mode-item${mode == null ? " is-active" : ""}`}
                role="menuitem"
                onClick={() => {
                  onModeChange(null);
                  setMenuOpen(false);
                }}
              >
                All Songs
              </button>
              {setlists.map((sl) => (
                <div key={sl.id} className="mode-item-row">
                  <button
                    type="button"
                    className={`mode-item${mode === sl.id ? " is-active" : ""}`}
                    role="menuitem"
                    onClick={() => {
                      onModeChange(sl.id);
                      setMenuOpen(false);
                    }}
                  >
                    {sl.name}
                    <span className="mode-item-count">
                      {sl.songs.length}
                    </span>
                  </button>
                  {editable && (
                    <button
                      type="button"
                      className="mode-item-del"
                      title="Delete setlist"
                      aria-label={`Delete setlist ${sl.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          window.confirm(`Delete setlist "${sl.name}"?`)
                        ) {
                          onRemoveSetlist(sl.id);
                          if (mode === sl.id) onModeChange(null);
                        }
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {editable && (
                <div className="mode-menu-footer">
                  {creating ? (
                    <div className="wf-me-row">
                      <input
                        autoFocus
                        value={newName}
                        placeholder="Setlist name…"
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") createSetlist();
                          else if (e.key === "Escape") setCreating(false);
                        }}
                      />
                      <button
                        type="button"
                        className="wf-me-btn"
                        title="Create (Enter)"
                        onClick={createSetlist}
                      >
                        ✓
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="mode-item mode-item-new"
                      role="menuitem"
                      onClick={() => setCreating(true)}
                    >
                      ＋ New setlist
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <label className="search">
          <span className="sr-only">Search</span>
          <input
            type="search"
            placeholder="Search title or artist…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </label>
      </div>

      <ul className="song-list">
        {displaySongs.map((song, i) => {
          const active = song.slug === currentSlug;
          return (
            <li key={song.slug} className="song-row-li">
              <button
                type="button"
                className={`song-row${active ? " is-active" : ""}`}
                onClick={() => onSelect(song)}
              >
                <span className="song-index">
                  {active && playing ? (
                    <span className="eq" aria-label="Playing">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    String(i + 1).padStart(2, "0")
                  )}
                </span>
                <span className="song-meta">
                  <span className="song-title">{song.title}</span>
                  <span className="song-artist">{song.artist}</span>
                </span>
                <span className="song-duration">
                  {formatDuration(song.durationSeconds)}
                </span>
              </button>
              {editable && activeSetlist && (
                <span className="song-row-tools">
                  <button
                    type="button"
                    title="Move up"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(song.slug, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    aria-label="Move down"
                    disabled={i === displaySongs.length - 1}
                    onClick={() => move(song.slug, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title="Remove from setlist"
                    aria-label="Remove from setlist"
                    onClick={() =>
                      mutate(
                        activeSetlist.songs.filter((s) => s !== song.slug),
                      )
                    }
                  >
                    −
                  </button>
                </span>
              )}
            </li>
          );
        })}
        {displaySongs.length === 0 && (
          <li className="empty-list">
            {query
              ? "No matching songs"
              : activeSetlist
                ? "Empty setlist — add songs below"
                : "No songs"}
          </li>
        )}
      </ul>

      {editable && activeSetlist && addable.length > 0 && (
        <div className="setlist-add">
          <button
            type="button"
            className="setlist-add-toggle"
            onClick={() => {
              setAddQuery("");
              setAddOpen(true);
            }}
          >
            ＋ Add songs ({addable.length})
          </button>
        </div>
      )}

      {addOpen &&
        activeSetlist &&
        createPortal(
          <div
            className="modal-overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) setAddOpen(false);
            }}
          >
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-label="Add songs to setlist"
            >
              <div className="modal-head">
                <p className="modal-title">
                  Add songs
                  <span className="modal-sub"> · {activeSetlist.name}</span>
                </p>
                <button
                  type="button"
                  className="modal-close"
                  aria-label="Close"
                  onClick={() => setAddOpen(false)}
                >
                  ✕
                </button>
              </div>
              <label className="search modal-search">
                <span className="sr-only">Search songs</span>
                <input
                  type="search"
                  autoFocus
                  placeholder="Search title or artist…"
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAddOpen(false);
                  }}
                />
              </label>
              <ul className="modal-song-list">
                {addableFiltered.map((s) => (
                  <li key={s.slug}>
                    <button
                      type="button"
                      onClick={() =>
                        mutate([...activeSetlist.songs, s.slug])
                      }
                    >
                      <span className="song-meta">
                        <span className="song-title">{s.title}</span>
                        <span className="song-artist">{s.artist}</span>
                      </span>
                      <span className="add-plus" aria-hidden>
                        ＋
                      </span>
                    </button>
                  </li>
                ))}
                {addableFiltered.length === 0 && (
                  <li className="empty-list">No matching songs</li>
                )}
              </ul>
              <p className="popover-hint modal-hint">
                Tap a song to add it — the dialog stays open for multiple adds.
              </p>
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
