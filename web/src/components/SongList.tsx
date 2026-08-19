import { useEffect, useRef, useState } from "react";
import type { Setlist } from "../hooks/useSetlists";
import type { SongSummary } from "../types";
import { formatDuration } from "../utils/format";

type Props = {
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
  mobileOpen: boolean;
  onManageSongs: () => void;
};

export function SongList({
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
  mobileOpen,
  onManageSongs,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDocDown);
    return () => document.removeEventListener("pointerdown", onDocDown);
  }, [menuOpen]);

  return (
    <aside className={`sidebar${mobileOpen ? " is-open" : ""}`}>
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
                <button
                  key={sl.id}
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
              ))}
              <div className="mode-menu-footer">
                <button
                  type="button"
                  className="mode-item mode-item-manage"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onManageSongs();
                  }}
                >
                  ⚙ Manage Songs…
                </button>
              </div>
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
            </li>
          );
        })}
        {displaySongs.length === 0 && (
          <li className="empty-list">
            {query
              ? "No matching songs"
              : activeSetlist
                ? "Empty setlist — manage via ⚙ Manage Songs"
                : "No songs"}
          </li>
        )}
      </ul>
    </aside>
  );
}
