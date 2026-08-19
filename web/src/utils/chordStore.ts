import { isNative, readNativeJson } from "./nativeSongs";

export type ChordSegment = {
  start: number;
  end: number;
  chord: string;
  root: string;
  confidence: number;
};

export type BarChord = {
  chord: string;
  beats: number;
  start: number;
  end: number;
  is_dominant?: boolean;
  role?: string;
};

export type BarSegment = {
  bar_number: number;
  start: number;
  end: number;
  beats: number;
  cadence?: string;
  chords: BarChord[];
};

export type SongChordsData = {
  slug: string;
  key: string;
  key_confidence?: number;
  bpm?: number;
  time_signature?: string;
  analyzed_at?: string;
  elapsed_seconds?: number;
  bars?: BarSegment[];
  chords: ChordSegment[];
};

const SEMITONES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_TO_SHARP: Record<string, string> = {
  Db: "C#",
  Eb: "D#",
  Gb: "F#",
  Ab: "G#",
  Bb: "A#",
};

/** Transpose a chord symbol by a given number of semitones. */
export function transposeChord(chord: string, semitones: number): string {
  if (!chord || chord === "N.C." || semitones === 0) return chord;
  return chord.replace(/([A-G][b#]?)/g, (match) => {
    const root = FLAT_TO_SHARP[match] ?? match;
    const idx = SEMITONES.indexOf(root);
    if (idx === -1) return match;
    const newIdx = ((idx + semitones) % 12 + 12) % 12;
    return SEMITONES[newIdx];
  });
}

/** Converts standard chord symbols to classic Jazz/Real Book Lead Sheet notation.
 * e.g. "Cmaj7" -> "CΔ7", "Em7" -> "E-7", "F#m7-5" -> "F#ø7", "Cdim7" -> "C°7", "Caug" -> "C+"
 */
export function toLeadSheetNotation(chord: string): string {
  if (!chord || chord === "N.C." || chord === "--" || chord === "X") return chord;

  let base = chord;
  let bass = "";
  if (base.includes("/")) {
    const parts = base.split("/");
    base = parts[0];
    bass = parts[1];
  }

  let root = base;
  let qual = "";
  if (base.length >= 2 && (base[1] === "#" || base[1] === "b")) {
    root = base.slice(0, 2);
    qual = base.slice(2);
  } else if (base.length >= 1) {
    root = base.slice(0, 1);
    qual = base.slice(1);
  }

  const qualMap: Record<string, string> = {
    maj7: "Δ7",
    Maj7: "Δ7",
    maj: "Δ",
    Maj: "Δ",
    min7: "-7",
    m7: "-7",
    "m7-5": "ø7",
    "m7b5": "ø7",
    hdim7: "ø7",
    dim7: "°7",
    dim: "°",
    aug: "+",
    min6: "-6",
    m6: "-6",
    maj6: "6",
    minmaj7: "-Δ7",
    mM7: "-Δ7",
  };

  const fmtQual = qualMap[qual] ?? qual;
  return `${root}${fmtQual}${bass ? `/${bass}` : ""}`;
}

function isChordSegment(v: unknown): v is ChordSegment {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.start === "number" &&
    typeof c.end === "number" &&
    typeof c.chord === "string"
  );
}

function isBarChord(v: unknown): v is BarChord {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.chord === "string" && typeof c.beats === "number";
}

function isBarSegment(v: unknown): v is BarSegment {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.bar_number === "number" &&
    typeof b.start === "number" &&
    typeof b.end === "number" &&
    Array.isArray(b.chords) &&
    b.chords.every(isBarChord)
  );
}

function validateChords(v: unknown): SongChordsData | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.chords)) return null;
  return {
    slug: typeof o.slug === "string" ? o.slug : "",
    key: typeof o.key === "string" ? o.key : "C",
    key_confidence: typeof o.key_confidence === "number" ? o.key_confidence : undefined,
    bpm: typeof o.bpm === "number" ? o.bpm : undefined,
    time_signature: typeof o.time_signature === "string" ? o.time_signature : "4/4",
    analyzed_at: typeof o.analyzed_at === "string" ? o.analyzed_at : undefined,
    elapsed_seconds: typeof o.elapsed_seconds === "number" ? o.elapsed_seconds : undefined,
    bars: Array.isArray(o.bars) ? o.bars.filter(isBarSegment) : undefined,
    chords: o.chords.filter(isChordSegment),
  };
}

export async function loadChords(slug: string): Promise<SongChordsData | null> {
  try {
    if (isNative()) {
      return validateChords(await readNativeJson(slug, "chords.json"));
    }
    const res = await fetch(`/songs/${encodeURIComponent(slug)}/chords.json`);
    if (!res.ok) return null;
    return validateChords(await res.json());
  } catch {
    return null;
  }
}
