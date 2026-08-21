import { useCallback, useEffect, useState } from "react";
import type { SongSummary } from "../types";
import {
  isNative,
  listNativeSongs,
  readNativeLyrics,
} from "../utils/nativeSongs";

export function useSongs() {
  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isNative()) {
        const result = await listNativeSongs();
        setSongs(result);
      } else {
        const res = await fetch("/api/songs.json", { cache: "no-cache" });
        if (!res.ok) throw new Error(`Failed to load songs (${res.status})`);
        setSongs((await res.json()) as SongSummary[]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setSongs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { songs, loading, error, reload };
}

export function useLyrics(slug: string | null) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLyrics = useCallback(async () => {
    if (!slug) {
      setMarkdown(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      let md: string | null = null;
      if (isNative()) {
        md = await readNativeLyrics(slug);
        if (md == null) throw new Error("Lyrics not found");
      } else {
        const res = await fetch(
          `/api/songs/${encodeURIComponent(slug)}/lyrics.json`,
          { cache: "no-cache" },
        );
        if (!res.ok) throw new Error("Lyrics not found");
        md = ((await res.json()) as { markdown: string }).markdown;
      }
      setMarkdown(md);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load lyrics");
      setMarkdown(null);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void fetchLyrics();
  }, [fetchLyrics]);

  return { markdown, loading, error, reload: fetchLyrics };
}
