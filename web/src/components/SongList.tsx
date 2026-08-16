import type { SongSummary } from "../types";
import { formatDuration } from "../utils/format";

type Props = {
  songs: SongSummary[];
  currentSlug: string | null;
  playing: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  onSelect: (song: SongSummary) => void;
};

export function SongList({
  songs,
  currentSlug,
  playing,
  query,
  onQueryChange,
  onSelect,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <div className="brand-title">Band Practice</div>
            <div className="brand-sub">{songs.length} tracks</div>
          </div>
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
        {songs.map((song, i) => {
          const active = song.slug === currentSlug;
          return (
            <li key={song.slug}>
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
        {songs.length === 0 && (
          <li className="empty-list">No matching songs</li>
        )}
      </ul>
    </aside>
  );
}
