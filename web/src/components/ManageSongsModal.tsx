import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import type { Setlist } from "../hooks/useSetlists";
import type { SongSummary } from "../types";
import { formatDuration } from "../utils/format";
import { formatBytes } from "../utils/p2pProtocol";
import { getNativeSongStorage, isNative } from "../utils/nativeSongs";

type Props = {
  songs: SongSummary[];
  setlists: Setlist[];
  onClose: () => void;
  /** Delete a song from the library (platform-appropriate). */
  onDeleteSong: (song: SongSummary) => Promise<void>;
  /** Open the P2P sync screen (send or receive, any platform). */
  onSyncFromPc: () => void;
  onLibraryChanged: () => void;
  onSaveSetlist: (setlist: Setlist) => Promise<boolean>;
  onRemoveSetlist: (id: string) => Promise<boolean>;
  onCreateSetlist: (name: string, songs?: string[]) => Setlist;
};

export function ManageSongsModal({
  songs,
  setlists,
  onClose,
  onDeleteSong,
  onSyncFromPc,
  onLibraryChanged,
  onSaveSetlist,
  onRemoveSetlist,
  onCreateSetlist,
}: Props) {
  const [tab, setTab] = useState<"songs" | "setlists">("songs");
  const [sizes, setSizes] = useState<Map<string, number> | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [addOpen, setAddOpen] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const m = new Map<string, number>();
      try {
        if (isNative()) {
          for (const [k, v] of await getNativeSongStorage()) m.set(k, v);
        } else {
          const res = await fetch("/api/storage");
          if (res.ok) {
            const data = (await res.json()) as Record<string, number>;
            for (const [k, v] of Object.entries(data)) m.set(k, v);
          }
        }
      } catch {
        /* sizes are informational */
      }
      if (!cancelled) setSizes(m);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bySlug = useMemo(
    () => new Map(songs.map((s) => [s.slug, s])),
    [songs],
  );

  const removeSong = async (song: SongSummary) => {
    if (!window.confirm(`Delete "${song.title}"?`)) return;
    setDeleting(song.slug);
    try {
      await onDeleteSong(song);
      setSizes((prev) => {
        const next = new Map(prev ?? []);
        next.delete(song.slug);
        return next;
      });
      onLibraryChanged();
    } catch {
      window.alert(`Could not delete "${song.title}"`);
    } finally {
      setDeleting(null);
    }
  };

  const createSetlist = () => {
    const name = newName.trim();
    if (!name) return;
    const sl = onCreateSetlist(name);
    void onSaveSetlist(sl);
    setNewName("");
    setExpanded(sl.id);
    setRenameValue(sl.name);
  };

  const renameSetlist = (sl: Setlist) => {
    const name = renameValue.trim();
    if (!name || name === sl.name) return;
    void onSaveSetlist({ ...sl, name });
  };

  const moveSong = (sl: Setlist, slug: string, dir: -1 | 1) => {
    const list = [...sl.songs];
    const i = list.indexOf(slug);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    void onSaveSetlist({ ...sl, songs: list });
  };

  const removeFromSetlist = (sl: Setlist, slug: string) => {
    void onSaveSetlist({ ...sl, songs: sl.songs.filter((s) => s !== slug) });
  };

  const addToSetlist = (sl: Setlist, slug: string) => {
    if (sl.songs.includes(slug)) return;
    void onSaveSetlist({ ...sl, songs: [...sl.songs, slug] });
  };

  const deleteSetlist = (sl: Setlist) => {
    if (!window.confirm(`Delete setlist "${sl.name}"?`)) return;
    void onRemoveSetlist(sl.id);
    if (expanded === sl.id) setExpanded(null);
    if (addOpen === sl.id) setAddOpen(null);
  };

  const activeSetlist = setlists.find((s) => s.id === expanded) ?? null;
  const addable = activeSetlist
    ? songs
        .filter((s) => !activeSetlist.songs.includes(s.slug))
        .filter((s) => {
          const q = addQuery.trim().toLowerCase();
          if (!q) return true;
          return (
            s.title.toLowerCase().includes(q) ||
            s.artist.toLowerCase().includes(q) ||
            s.slug.toLowerCase().includes(q)
          );
        })
    : [];

  const totalBytes = songs.reduce((a, s) => a + (sizes?.get(s.slug) ?? 0), 0);

  return (
    <Modal
      title="Manage Songs"
      sub="library & setlists"
      onClose={onClose}
      className="sync-card manage-card"
      overlayClassName="sync-overlay"
    >
      <div className="manage-toolbar">
        <div className="manage-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "songs"}
            className={`manage-tab${tab === "songs" ? " is-active" : ""}`}
            onClick={() => setTab("songs")}
          >
            Songs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "setlists"}
            className={`manage-tab${tab === "setlists" ? " is-active" : ""}`}
            onClick={() => setTab("setlists")}
          >
            Setlists
          </button>
        </div>
        <button
          type="button"
          className="manage-sync-btn"
          onClick={onSyncFromPc}
        >
          ⇅ Sync
        </button>
      </div>

        <div className="sync-body">
          {tab === "songs" && (
            <>
              <p className="manage-summary">
                {songs.length} songs ·{" "}
                {sizes ? formatBytes(totalBytes) : "…"} used
              </p>
              <ul className="sync-list">
                {songs.map((song) => (
                  <li key={song.slug}>
                    <div className="manage-row">
                      <span className="song-meta">
                        <span className="song-title">{song.title}</span>
                        <span className="song-artist">
                          {song.artist}
                          {song.stems?.length
                            ? ` · ${song.stems.length} stems`
                            : ""}
                          {song.hasLyrics ? " · lyrics" : ""}
                          {" · "}
                          {formatDuration(song.durationSeconds)}
                        </span>
                      </span>
                      <span className="sync-item-side">
                        <span className="sync-size">
                          {sizes ? formatBytes(sizes.get(song.slug) ?? 0) : "…"}
                        </span>
                        <button
                          type="button"
                          className="manage-del"
                          aria-label={`Delete ${song.title}`}
                          disabled={deleting === song.slug}
                          onClick={() => void removeSong(song)}
                        >
                          {deleting === song.slug ? "…" : "✕"}
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
                {songs.length === 0 && (
                  <li className="empty-list">No songs</li>
                )}
              </ul>
            </>
          )}

          {tab === "setlists" && (
            <>
              <div className="wf-me-row manage-new">
                <input
                  value={newName}
                  placeholder="New setlist name…"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createSetlist();
                  }}
                />
                <button
                  type="button"
                  className="wf-me-btn"
                  title="Create (Enter)"
                  disabled={!newName.trim()}
                  onClick={createSetlist}
                >
                  ＋
                </button>
              </div>

              <ul className="sync-list">
                {setlists.map((sl) => (
                  <li key={sl.id} className="manage-setlist">
                    <button
                      type="button"
                      className="manage-setlist-row"
                      aria-expanded={expanded === sl.id}
                      onClick={() => {
                        setExpanded(expanded === sl.id ? null : sl.id);
                        setRenameValue(sl.name);
                        setAddOpen(null);
                      }}
                    >
                      <span className="song-meta">
                        <span className="song-title">{sl.name}</span>
                        <span className="song-artist">
                          {sl.songs.length} songs
                        </span>
                      </span>
                      <span className="mode-chevron" aria-hidden>
                        {expanded === sl.id ? "▾" : "▸"}
                      </span>
                    </button>

                    {expanded === sl.id && (
                      <div className="manage-setlist-detail">
                        <div className="wf-me-row">
                          <input
                            value={renameValue}
                            aria-label="Setlist name"
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => renameSetlist(sl)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                            }}
                          />
                          <button
                            type="button"
                            className="wf-me-btn danger"
                            title="Delete setlist"
                            onClick={() => deleteSetlist(sl)}
                          >
                            🗑
                          </button>
                        </div>

                        <ul className="manage-setlist-songs">
                          {sl.songs.map((slug, i) => {
                            const song = bySlug.get(slug);
                            return (
                              <li key={slug}>
                                <span className="song-meta">
                                  <span className="song-title">
                                    {song?.title ?? slug}
                                  </span>
                                  <span className="song-artist">
                                    {song?.artist ?? "missing on this device"}
                                  </span>
                                </span>
                                <span className="song-row-tools">
                                  <button
                                    type="button"
                                    title="Move up"
                                    aria-label="Move up"
                                    disabled={i === 0}
                                    onClick={() => moveSong(sl, slug, -1)}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    title="Move down"
                                    aria-label="Move down"
                                    disabled={i === sl.songs.length - 1}
                                    onClick={() => moveSong(sl, slug, 1)}
                                  >
                                    ↓
                                  </button>
                                  <button
                                    type="button"
                                    title="Remove from setlist"
                                    aria-label="Remove from setlist"
                                    onClick={() => removeFromSetlist(sl, slug)}
                                  >
                                    −
                                  </button>
                                </span>
                              </li>
                            );
                          })}
                          {sl.songs.length === 0 && (
                            <li className="empty-list">Empty setlist</li>
                          )}
                        </ul>

                        {addOpen === sl.id ? (
                          <div className="manage-add">
                            <label className="search modal-search">
                              <span className="sr-only">Search songs</span>
                              <input
                                type="search"
                                autoFocus
                                placeholder="Search title or artist…"
                                value={addQuery}
                                onChange={(e) => setAddQuery(e.target.value)}
                              />
                            </label>
                            <ul className="manage-add-list">
                              {addable.map((s) => (
                                <li key={s.slug}>
                                  <button
                                    type="button"
                                    onClick={() => addToSetlist(sl, s.slug)}
                                  >
                                    <span className="song-meta">
                                      <span className="song-title">
                                        {s.title}
                                      </span>
                                      <span className="song-artist">
                                        {s.artist}
                                      </span>
                                    </span>
                                    <span className="add-plus" aria-hidden>
                                      ＋
                                    </span>
                                  </button>
                                </li>
                              ))}
                              {addable.length === 0 && (
                                <li className="empty-list">
                                  No matching songs
                                </li>
                              )}
                            </ul>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="manage-add-toggle"
                            onClick={() => {
                              setAddQuery("");
                              setAddOpen(sl.id);
                            }}
                          >
                            ＋ Add songs
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
                {setlists.length === 0 && (
                  <li className="empty-list">No setlists yet</li>
                )}
              </ul>
            </>
          )}
        </div>
    </Modal>
  );
}
