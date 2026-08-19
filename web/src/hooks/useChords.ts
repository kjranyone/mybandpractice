import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadChords,
  type SongChordsData,
} from "../utils/chordStore";

export function useChords(slug: string | null, currentTime: number) {
  const [data, setData] = useState<SongChordsData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchChords = useCallback(async () => {
    if (!slug) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const chords = await loadChords(slug);
      setData(chords);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void fetchChords();
  }, [fetchChords]);

  const { currentChord, nextChord } = useMemo(() => {
    if (!data || data.chords.length === 0) {
      return { currentChord: null, nextChord: null };
    }
    const idx = data.chords.findIndex(
      (c) => currentTime >= c.start && currentTime < c.end,
    );
    if (idx !== -1) {
      return {
        currentChord: data.chords[idx],
        nextChord: data.chords[idx + 1] ?? null,
      };
    }
    // Before first chord
    if (currentTime < data.chords[0].start) {
      return { currentChord: null, nextChord: data.chords[0] };
    }
    return { currentChord: null, nextChord: null };
  }, [data, currentTime]);

  return {
    data,
    loading,
    hasChords: data != null && data.chords.length > 0,
    currentChord,
    nextChord,
    reload: fetchChords,
  };
}
