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
        // songs/ lives in the app's external files dir (pushed via adb)
        setSongs(await listNativeSongs());
      } else {
        const res = await fetch("/api/songs.json");
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

  useEffect(() => {
    if (!slug) {
      setMarkdown(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setMarkdown(null);

    void (async () => {
      try {
        let markdown: string | null = null;
        if (isNative()) {
          markdown = await readNativeLyrics(slug);
          if (markdown == null) throw new Error("Lyrics not found");
        } else {
          const res = await fetch(
            `/api/songs/${encodeURIComponent(slug)}/lyrics.json`,
          );
          if (!res.ok) throw new Error("Lyrics not found");
          markdown = ((await res.json()) as { markdown: string }).markdown;
        }
        if (!cancelled) setMarkdown(markdown);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load lyrics");
          setMarkdown(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  return { markdown, loading, error };
}
