import { useEffect, useMemo, useState } from "react";
import { SongList } from "./components/SongList";
import { LyricsPanel } from "./components/LyricsPanel";
import { PlayerBar } from "./components/PlayerBar";
import { SyncScreen } from "./components/SyncScreen";
import { ManageSongsModal } from "./components/ManageSongsModal";
import { ChordSheetModal } from "./components/ChordSheetModal";
import { nextPlaybackMode, useAudioPlayer } from "./hooks/useAudioPlayer";
import { useMarkers } from "./hooks/useMarkers";
import { useMediaSession } from "./hooks/useMediaSession";
import { useLyrics, useSongs } from "./hooks/useSongs";
import { useSetlists } from "./hooks/useSetlists";
import { useChords } from "./hooks/useChords";
import { transposeChord } from "./utils/chordStore";
import type { SongSummary } from "./types";
import { deleteNativeSong, isNative } from "./utils/nativeSongs";
import "./App.css";

const MODE_KEY = "mbp:mode";

async function deleteSong(song: SongSummary): Promise<void> {
  if (isNative()) {
    await deleteNativeSong(song.slug);
    return;
  }
  const res = await fetch(`/api/songs/${encodeURIComponent(song.slug)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete (${res.status})`);
}

export default function App() {
  const { songs, loading, error, reload } = useSongs();
  const setlistState = useSetlists();
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [chordSheetOpen, setChordSheetOpen] = useState(false);
  const [mode, setMode] = useState<string | null>(() =>
    localStorage.getItem(MODE_KEY),
  );

  useEffect(() => {
    if (mode == null) localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  // Resolve a stale saved mode (deleted setlist) back to all songs
  const activeSetlist =
    setlistState.setlists.find((s) => s.id === mode) ?? null;
  const effectiveMode = activeSetlist ? mode : null;

  // Playback order: setlist order when active, otherwise all songs
  const playlistSongs = useMemo(() => {
    if (!activeSetlist) return songs;
    const bySlug = new Map(songs.map((s) => [s.slug, s]));
    return activeSetlist.songs
      .map((slug) => bySlug.get(slug))
      .filter((s): s is NonNullable<typeof s> => s != null);
  }, [songs, activeSetlist]);

  const player = useAudioPlayer(playlistSongs);
  useMediaSession(player);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return playlistSongs;
    return playlistSongs.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.artist.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q),
    );
  }, [playlistSongs, query]);

  const lyrics = useLyrics(player.current?.slug ?? null);
  const markerState = useMarkers(player.current?.slug ?? null);
  const chords = useChords(player.current?.slug ?? null, player.currentTime);
  const currentChordTransposed = chords.currentChord
    ? transposeChord(chords.currentChord.chord, player.pitch)
    : null;

  // Practice keyboard shortcuts (stable callbacks + latest state via refs)
  const loop = player.loop;
  const loopEnabled = player.loopEnabled;
  const playbackRate = player.playbackRate;
  const playbackMode = player.playbackMode;
  const {
    toggle,
    skip,
    setLoopIn,
    setLoopOut,
    setLoopEnabled,
    toggleMute,
    setPlaybackRate,
    setPlaybackMode,
    clearLoop,
  } = player;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          void toggle();
          break;
        case "ArrowLeft":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            skip(e.shiftKey ? -5 : -1);
          }
          break;
        case "ArrowRight":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            skip(e.shiftKey ? 5 : 1);
          }
          break;
        case "i":
        case "I":
          setLoopIn();
          break;
        case "o":
        case "O":
          setLoopOut();
          break;
        case "l":
        case "L":
          if (loop) setLoopEnabled(!loopEnabled);
          break;
        case "r":
        case "R":
          setPlaybackMode(nextPlaybackMode(playbackMode));
          break;
        case "m":
        case "M":
          toggleMute();
          break;
        case "[":
          setPlaybackRate(Math.max(0.5, playbackRate - 0.05));
          break;
        case "]":
          setPlaybackRate(Math.min(1.5, playbackRate + 0.05));
          break;
        case "Escape":
          clearLoop();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    toggle,
    skip,
    setLoopIn,
    setLoopOut,
    setLoopEnabled,
    toggleMute,
    setPlaybackRate,
    setPlaybackMode,
    clearLoop,
    loop,
    loopEnabled,
    playbackRate,
    playbackMode,
  ]);

  if (loading) {
    return (
      <div className="boot">
        <div className="boot-card">Loading songs…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="boot">
        <div className="boot-card error">
          <strong>Could not load songs</strong>
          <p>{error}</p>
          <p className="hint">
            Expected folder: <code>../songs/&#123;slug&#125;/</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <button
        type="button"
        className={`songlist-toggle${listOpen ? " is-open" : ""}`}
        onClick={() => setListOpen((v) => !v)}
        aria-label={listOpen ? "Close song list" : "Open song list"}
        aria-expanded={listOpen}
      >
        {listOpen ? "✕" : "☰"}
      </button>
      <div className="app-body">
        <SongList
          displaySongs={filtered}
          currentSlug={player.current?.slug ?? null}
          playing={player.playing}
          query={query}
          onQueryChange={setQuery}
          onSelect={(song) => {
            void player.playSong(song);
            setListOpen(false);
          }}
          mode={effectiveMode}
          onModeChange={setMode}
          setlists={setlistState.setlists}
          activeSetlist={activeSetlist}
          mobileOpen={listOpen}
          onManageSongs={() => setManageOpen(true)}
        />
        <LyricsPanel
          song={player.current}
          markdown={lyrics.markdown}
          loading={lyrics.loading}
          error={lyrics.error}
          markers={markerState.markers}
          stanzaTags={markerState.stanzaTags}
          currentTime={player.currentTime}
          onSeek={player.seek}
          onMarkerUpdate={markerState.updateMarker}
          onStanzaTagAdd={markerState.addStanzaTag}
          onStanzaTagRemove={markerState.removeStanzaTag}
        />
      </div>
      <PlayerBar
        song={player.current}
        playing={player.playing}
        currentTime={player.currentTime}
        duration={player.duration}
        volume={player.volume}
        muted={player.muted}
        playbackRate={player.playbackRate}
        loop={player.loop}
        loopEnabled={player.loopEnabled}
        buffered={player.buffered}
        playbackMode={player.playbackMode}
        stemLevels={player.stemLevels}
        onStemLevel={player.setStemLevel}
        onStemReset={player.resetStemLevels}
        pitch={player.pitch}
        onPitch={player.setPitch}
        markers={markerState.markers}
        currentChord={currentChordTransposed}
        hasChords={chords.hasChords}
        chordSheetOpen={chordSheetOpen}
        onToggleChordSheet={() => setChordSheetOpen((v) => !v)}
        onMarkerAdd={markerState.addMarker}
        onMarkerUpdate={markerState.updateMarker}
        onMarkerRemove={markerState.removeMarker}
        onToggle={() => void player.toggle()}
        onPrev={player.playPrev}
        onNext={player.playNext}
        onPlaybackMode={player.setPlaybackMode}
        onSeek={player.seek}
        onSkip={player.skip}
        onVolume={player.setVolume}
        onToggleMute={player.toggleMute}
        onRate={player.setPlaybackRate}
        onLoopChange={player.setLoop}
        onLoopEnable={player.setLoopEnabled}
        onLoopIn={player.setLoopIn}
        onLoopOut={player.setLoopOut}
        onClearLoop={player.clearLoop}
      />
      {chordSheetOpen && (
        <ChordSheetModal
          song={player.current}
          chordsData={chords.data}
          currentTime={player.currentTime}
          duration={player.duration}
          playing={player.playing}
          pitch={player.pitch}
          onSeek={player.seek}
          onTogglePlay={() => void player.toggle()}
          onClose={() => setChordSheetOpen(false)}
        />
      )}
      {manageOpen && (
        <ManageSongsModal
          songs={songs}
          setlists={setlistState.setlists}
          onClose={() => setManageOpen(false)}
          onDeleteSong={deleteSong}
          onSyncFromPc={() => {
            setManageOpen(false);
            setSyncOpen(true);
          }}
          onLibraryChanged={() => {
            void reload();
            void setlistState.reload();
          }}
          onSaveSetlist={setlistState.save}
          onRemoveSetlist={setlistState.remove}
          onCreateSetlist={setlistState.create}
        />
      )}
      {syncOpen && (
        <SyncScreen
          onClose={() => setSyncOpen(false)}
          onLibraryChanged={() => {
            void reload();
            void setlistState.reload();
          }}
        />
      )}
    </div>
  );
}
