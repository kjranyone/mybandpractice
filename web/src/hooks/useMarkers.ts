import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadPractice,
  savePractice,
  type PracticeData,
} from "../utils/practiceStore";

export type SongMarker = {
  id: string;
  time: number;
  label: string;
  /** Fixed flag row on the waveform (0 = top, 1 = lower). Assigned once. */
  row?: number;
  /** Index of the linked lyrics stanza (blank-line separated block). */
  stanzaIndex?: number;
};

/** Lyrics-only tag: annotates a stanza without a waveform marker. */
export type StanzaTag = {
  id: string;
  stanzaIndex: number;
  label: string;
};

const LEGACY_STORAGE_PREFIX = "mbp:markers:"; // pre-practice.json era
const SAVE_DEBOUNCE_MS = 400;

export const MARKER_PRESETS = [
  "Int",
  "1A",
  "1B",
  "1サビ",
  "2A",
  "2B",
  "2サビ",
  "Solo",
  "Out",
] as const;

/** Suggest the next section label based on how many markers exist. */
export function suggestMarkerLabel(existingCount: number): string {
  return MARKER_PRESETS[existingCount] ?? `M${existingCount + 1}`;
}

function makeId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

function sortByTime(markers: SongMarker[]): SongMarker[] {
  return [...markers].sort((a, b) => a.time - b.time);
}

/**
 * Pick the flag row (0/1) with the most time clearance from markers already
 * on that row. Assigned once at creation and persisted, so a flag's Y
 * position never changes when other markers are added/removed/reordered.
 */
const ROW_CLEARANCE_SEC = 8;
function pickRow(markers: SongMarker[], time: number): number {
  const clearance = (row: number) => {
    let best = ROW_CLEARANCE_SEC;
    for (const m of markers) {
      if ((m.row ?? 0) !== row) continue;
      const d = Math.abs(m.time - time);
      if (d < best) best = d;
    }
    return best;
  };
  return clearance(1) > clearance(0) ? 1 : 0;
}

/** One-time migration: markers previously kept in localStorage. */
function readLegacy(slug: string): PracticeData | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_PREFIX + slug);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    const o = Array.isArray(v)
      ? { markers: v, stanzaTags: [] }
      : typeof v === "object" && v !== null
        ? (v as Record<string, unknown>)
        : null;
    if (!o) return null;
    return {
      markers: Array.isArray(o.markers) ? (o.markers as SongMarker[]) : [],
      stanzaTags: Array.isArray(o.stanzaTags)
        ? (o.stanzaTags as StanzaTag[])
        : [],
    };
  } catch {
    return null;
  }
}

type MarkerState = PracticeData & {
  slug: string | null;
  loaded: boolean;
};

/**
 * Section markers + stanza tags per song, persisted to
 * songs/<slug>/practice.json (shared across web dev and the Android app,
 * so markers sync to the tablet with `sync.ps1`).
 */
export function useMarkers(slug: string | null) {
  const [state, setState] = useState<MarkerState>({
    slug: null,
    loaded: true,
    markers: [],
    stanzaTags: [],
  });
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  const fetchMarkers = useCallback(async () => {
    if (!slug) {
      dirtyRef.current = false;
      setState({ slug: null, loaded: true, markers: [], stanzaTags: [] });
      return;
    }
    dirtyRef.current = false;
    setState({
      slug,
      loaded: false,
      markers: [],
      stanzaTags: [],
    });
    let data = await loadPractice(slug);
    if (!data) data = readLegacy(slug); // migrate once, then persist
    dirtyRef.current = data != null;
    setState({
      slug,
      loaded: true,
      markers: sortByTime(data?.markers ?? []),
      stanzaTags: data?.stanzaTags ?? [],
    });
  }, [slug]);

  // --- load on song switch ---
  useEffect(() => {
    void fetchMarkers();
  }, [fetchMarkers]);

  // --- debounced save (only after real edits) ---
  useEffect(() => {
    if (!slug || state.slug !== slug || !state.loaded || !dirtyRef.current)
      return;
    if (saveTimerRef.current != null)
      window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void savePractice(slug, {
        markers: state.markers,
        stanzaTags: state.stanzaTags,
      });
    }, SAVE_DEBOUNCE_MS);
  }, [slug, state]);

  // flush pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null)
        window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  const commit = useCallback(
    (updater: (prev: PracticeData) => PracticeData) => {
      dirtyRef.current = true;
      setState((prev) => ({ ...prev, ...updater(prev) }));
    },
    [],
  );

  const addMarker = useCallback(
    (time: number, label: string, stanzaIndex?: number) => {
      commit((prev) => ({
        markers: sortByTime([
          ...prev.markers,
          {
            id: makeId(),
            time,
            label,
            row: pickRow(prev.markers, time),
            ...(stanzaIndex != null ? { stanzaIndex } : {}),
          },
        ]),
        stanzaTags: prev.stanzaTags,
      }));
    },
    [commit],
  );

  const updateMarker = useCallback(
    (
      id: string,
      patch: Partial<Pick<SongMarker, "time" | "label" | "stanzaIndex">>,
    ) => {
      commit((prev) => ({
        markers: sortByTime(
          prev.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        ),
        stanzaTags: prev.stanzaTags,
      }));
    },
    [commit],
  );

  const removeMarker = useCallback(
    (id: string) => {
      commit((prev) => ({
        markers: prev.markers.filter((m) => m.id !== id),
        stanzaTags: prev.stanzaTags,
      }));
    },
    [commit],
  );

  const addStanzaTag = useCallback(
    (stanzaIndex: number, label: string) => {
      commit((prev) => ({
        markers: prev.markers,
        stanzaTags: [
          ...prev.stanzaTags,
          { id: makeId(), stanzaIndex, label },
        ],
      }));
    },
    [commit],
  );

  const removeStanzaTag = useCallback(
    (id: string) => {
      commit((prev) => ({
        markers: prev.markers,
        stanzaTags: prev.stanzaTags.filter((t) => t.id !== id),
      }));
    },
    [commit],
  );

  return {
    markers: state.markers,
    stanzaTags: state.stanzaTags,
    addMarker,
    updateMarker,
    removeMarker,
    addStanzaTag,
    removeStanzaTag,
    reload: fetchMarkers,
  };
}
