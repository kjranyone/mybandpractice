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

export type HarmonicRole =
  | "tonic"
  | "dominant"
  | "secondary-dominant"
  | "sub-v"
  | "related-two"
  | "diatonic"
  | "nondiatonic";

export type DiatonicInfo = {
  isDiatonic: boolean;
  roman: string | null;
  baseRoman?: string;
  secondaryRoman?: string | null;
  harmonicRole?: HarmonicRole;
  isDominant?: boolean;
  targetDegree?: string | null;
  targetRoot?: string | null;
  resolvesToNext?: boolean;
  resolutionType?: "5th-down" | "half-step-down" | "cycle";
  resolutionLabel?: string | null;
  description?: string;
};

export type ChordAnalysis = {
  isDiatonic: boolean;
  roman: string;
  baseRoman: string;
  secondaryRoman: string | null;
  harmonicRole: HarmonicRole;
  isDominant: boolean;
  targetDegree: string | null;
  targetRoot: string | null;
  resolvesToNext: boolean;
  resolutionType?: "5th-down" | "half-step-down" | "cycle";
  resolutionLabel: string | null;
  description: string;
};

export type BarCadenceInfo = {
  type: string;
  badgeText: string;
  title: string;
  className: string;
};

const QUALITY_CANON: Record<string, string> = {
  "": "maj",
  M: "maj",
  maj: "maj",
  m: "min",
  min: "min",
  "-": "min",
  m7: "min7",
  min7: "min7",
  "-7": "min7",
  "7": "7",
  maj7: "maj7",
  M7: "maj7",
  "6": "6",
  maj6: "6",
  m6: "min6",
  min6: "min6",
  dim: "dim",
  "°": "dim",
  o: "dim",
  dim7: "dim7",
  "°7": "dim7",
  hdim7: "hdim7",
  "m7-5": "hdim7",
  m7b5: "hdim7",
  "ø7": "hdim7",
  minmaj7: "minmaj7",
  mM7: "minmaj7",
  aug: "aug",
  "+": "aug",
  sus2: "sus2",
  sus4: "sus4",
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

const MAJOR_DEG_QUAL: string[][] = [
  ["maj", "maj7", "6"],
  ["min", "min7", "min6"],
  ["min", "min7"],
  ["maj", "maj7", "6"],
  ["maj", "7", "maj7"],
  ["min", "min7"],
  ["dim", "hdim7"],
];

const MINOR_DEG_QUAL: string[][] = [
  ["min", "min7", "min6", "minmaj7"],
  ["dim", "hdim7"],
  ["maj", "maj7"],
  ["min", "min7"],
  ["min", "min7", "maj", "7"],
  ["maj", "maj7"],
  ["maj", "maj7", "dim7", "hdim7"],
];

const MAJOR_ROMAN: Record<number, string> = {
  0: "I", 1: "♭II", 2: "II", 3: "♭III", 4: "III", 5: "IV",
  6: "♯IV", 7: "V", 8: "♭VI", 9: "VI", 10: "♭VII", 11: "VII",
};

const MINOR_ROMAN: Record<number, string> = {
  0: "i", 1: "♭II", 2: "ii", 3: "III", 4: "♯iii", 5: "iv",
  6: "♯iv", 7: "v", 8: "VI", 9: "♯vi", 10: "VII", 11: "♯vii",
};

function canonQuality(raw: string): string {
  return QUALITY_CANON[raw] ?? raw;
}

export function parseChordParts(chord: string): {
  root: string;
  rootCanon: string;
  qualRaw: string;
  qual: string;
  bass: string;
} {
  if (!chord || chord === "N.C." || chord === "--" || chord === "X") {
    return { root: "", rootCanon: "", qualRaw: "", qual: "N.C.", bass: "" };
  }
  let base = chord;
  let bass = "";
  if (base.includes("/")) {
    const parts = base.split("/");
    base = parts[0];
    bass = parts[1];
  }
  let root = base;
  let qualRaw = "";
  if (base.length >= 2 && (base[1] === "#" || base[1] === "b")) {
    root = base.slice(0, 2);
    qualRaw = base.slice(2);
  } else if (base.length >= 1) {
    root = base.slice(0, 1);
    qualRaw = base.slice(1);
  }
  const rootCanon = FLAT_TO_SHARP[root] ?? root;
  const qual = canonQuality(qualRaw);
  return { root, rootCanon, qualRaw, qual, bass };
}

function isMinorOrDim(qual: string): boolean {
  return (
    qual === "min" ||
    qual === "min7" ||
    qual === "min6" ||
    qual === "hdim7" ||
    qual === "dim" ||
    qual === "dim7" ||
    qual === "minmaj7"
  );
}

function isDominant7thQuality(qual: string, qualRaw: string): boolean {
  if (isMinorOrDim(qual)) return false;
  if (
    qual === "maj7" ||
    qualRaw === "maj7" ||
    qualRaw === "Maj7" ||
    qualRaw === "M7" ||
    qualRaw.includes("Δ")
  ) {
    return false;
  }
  return (
    qual === "7" ||
    qualRaw === "7" ||
    qualRaw === "9" ||
    qualRaw === "11" ||
    qualRaw === "13" ||
    qualRaw.includes("7") ||
    qualRaw.includes("9") ||
    qualRaw.includes("11") ||
    qualRaw.includes("13") ||
    qualRaw.includes("alt")
  );
}

function isMajorTriadOrDom(qual: string, qualRaw: string): boolean {
  if (isMinorOrDim(qual)) return false;
  return (
    qual === "maj" ||
    isDominant7thQuality(qual, qualRaw) ||
    qual === "sus4" ||
    qual === "sus2" ||
    qual === "aug"
  );
}

/** Static Single-Chord Music Theory Analysis against Key (Pass 1) */
export function analyzeChordHarmonics(
  chord: string,
  key: string,
): ChordAnalysis {
  if (!chord || chord === "N.C." || chord === "--" || chord === "X" || !key) {
    return {
      isDiatonic: false,
      roman: "N.C.",
      baseRoman: "N.C.",
      secondaryRoman: null,
      harmonicRole: "nondiatonic",
      isDominant: false,
      targetDegree: null,
      targetRoot: null,
      resolvesToNext: false,
      resolutionLabel: null,
      description: "Non-chord / Rest (コードなし)",
    };
  }

  const km = key.match(/^([A-G][#b]?)(m)?$/);
  if (!km) {
    return {
      isDiatonic: false,
      roman: chord,
      baseRoman: chord,
      secondaryRoman: null,
      harmonicRole: "nondiatonic",
      isDominant: false,
      targetDegree: null,
      targetRoot: null,
      resolvesToNext: false,
      resolutionLabel: null,
      description: chord,
    };
  }

  const keyRoot = FLAT_TO_SHARP[km[1]] ?? km[1];
  const isMinor = Boolean(km[2]);
  const keyIdx = SEMITONES.indexOf(keyRoot);
  if (keyIdx === -1) {
    return {
      isDiatonic: false,
      roman: chord,
      baseRoman: chord,
      secondaryRoman: null,
      harmonicRole: "nondiatonic",
      isDominant: false,
      targetDegree: null,
      targetRoot: null,
      resolvesToNext: false,
      resolutionLabel: null,
      description: chord,
    };
  }

  const { rootCanon, qualRaw, qual } = parseChordParts(chord);
  const rootIdx = SEMITONES.indexOf(rootCanon);
  if (rootIdx === -1) {
    return {
      isDiatonic: false,
      roman: chord,
      baseRoman: chord,
      secondaryRoman: null,
      harmonicRole: "nondiatonic",
      isDominant: false,
      targetDegree: null,
      targetRoot: null,
      resolvesToNext: false,
      resolutionLabel: null,
      description: chord,
    };
  }

  const offset = ((rootIdx - keyIdx) % 12 + 12) % 12;
  const scale = isMinor ? MINOR_SCALE : MAJOR_SCALE;
  const degree = scale.indexOf(offset);

  const romanTable = isMinor ? MINOR_ROMAN : MAJOR_ROMAN;
  let baseRoman = romanTable[offset] ?? "?";

  const allowed = degree !== -1 ? (isMinor ? MINOR_DEG_QUAL[degree] : MAJOR_DEG_QUAL[degree]) : [];
  const isDiatonic = degree !== -1 && (qual === "sus2" || qual === "sus4" || allowed.includes(qual));

  // Format standard base roman
  if (isDiatonic) {
    const isDimFamily = qual === "dim" || qual === "hdim7" || qual === "dim7";
    const isMinFamily = qual === "min" || qual === "min7" || qual === "min6" || qual === "minmaj7";
    const isMajAtV = isMinor && offset === 7 && (qual === "maj" || qual === "7" || qual === "maj7");
    if (isDimFamily) {
      baseRoman = `${baseRoman.toLowerCase()}°`;
    } else if (isMinFamily) {
      baseRoman = baseRoman.toLowerCase();
    } else if (isMajAtV) {
      baseRoman = "V";
    }
  }

  let harmonicRole: HarmonicRole = isDiatonic ? (offset === 0 ? "tonic" : "diatonic") : "nondiatonic";
  let secondaryRoman: string | null = null;
  let targetDegree: string | null = null;
  let targetRoot: string | null = null;
  let isDominant = false;
  let description = `${chord} [${baseRoman}]`;

  const isDom7 = isDominant7thQuality(qual, qualRaw);
  const isMajDom = isMajorTriadOrDom(qual, qualRaw);

  // 1. Primary Dominant Check (V or V7)
  if (offset === 7 && isMajDom) {
    harmonicRole = "dominant";
    isDominant = true;
    baseRoman = isDom7 ? "V7" : "V";
    targetDegree = isMinor ? "i" : "I";
    targetRoot = keyRoot;
    description = `${chord} [${baseRoman}] (主調プライマリドミナント ➔ ${key} に解決)`;
  }
  // 2. Candidate Secondary Dominants (V/x) - resolved in Pass 2
  else if (!isMinor) {
    // Major Key Secondary Dominants: V/ii (VI), V/iii (VII), V7/IV (I7), V/V (II), V/vi (III)
    if (offset === 9 && isMajDom) {
      targetDegree = "ii";
      targetRoot = SEMITONES[(keyIdx + 2) % 12];
      secondaryRoman = isDom7 ? "V7/ii" : "V/ii";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot}m (${targetDegree}) に解決)`;
    } else if (offset === 11 && isMajDom) {
      targetDegree = "iii";
      targetRoot = SEMITONES[(keyIdx + 4) % 12];
      secondaryRoman = isDom7 ? "V7/iii" : "V/iii";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot}m (${targetDegree}) に解決)`;
    } else if (offset === 0 && isDom7) {
      targetDegree = "IV";
      targetRoot = SEMITONES[(keyIdx + 5) % 12];
      secondaryRoman = "V7/IV";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot} (${targetDegree}) に解決)`;
    } else if (offset === 2 && isMajDom) {
      targetDegree = "V";
      targetRoot = SEMITONES[(keyIdx + 7) % 12];
      secondaryRoman = isDom7 ? "V7/V" : "V/V";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント / Double Dominant ➔ ${targetRoot} (${targetDegree}) に解決)`;
    } else if (offset === 4 && isMajDom) {
      targetDegree = "vi";
      targetRoot = SEMITONES[(keyIdx + 9) % 12];
      secondaryRoman = isDom7 ? "V7/vi" : "V/vi";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot}m (${targetDegree}) に解決)`;
    }
    // 3. Candidate Tritone Substitution (SubV in Major Key)
    else if (isDom7) {
      if (offset === 1) {
        targetDegree = "I";
        targetRoot = SEMITONES[keyIdx];
        secondaryRoman = "SubV/I";
        description = `${chord} [${secondaryRoman}] (裏コード / 代理ドミナント ➔ ${targetRoot} (${targetDegree}) に半音下降解決)`;
      } else if (offset === 3) {
        targetDegree = "ii";
        targetRoot = SEMITONES[(keyIdx + 2) % 12];
        secondaryRoman = "SubV/ii";
        description = `${chord} [${secondaryRoman}] (裏コード ➔ ${targetRoot}m (${targetDegree}) に半音下降解決)`;
      } else if (offset === 6) {
        targetDegree = "IV";
        targetRoot = SEMITONES[(keyIdx + 5) % 12];
        secondaryRoman = "SubV/IV";
        description = `${chord} [${secondaryRoman}] (裏コード ➔ ${targetRoot} (${targetDegree}) に半音下降解決)`;
      } else if (offset === 8) {
        targetDegree = "V";
        targetRoot = SEMITONES[(keyIdx + 7) % 12];
        secondaryRoman = "SubV/V";
        description = `${chord} [${secondaryRoman}] (裏コード ➔ ${targetRoot} (${targetDegree}) に半音下降解決)`;
      } else if (offset === 10) {
        targetDegree = "vi";
        targetRoot = SEMITONES[(keyIdx + 9) % 12];
        secondaryRoman = "SubV/vi";
        description = `${chord} [${secondaryRoman}] (裏コード ➔ ${targetRoot}m (${targetDegree}) に半音下降解決)`;
      }
    }
  } else {
    // Minor Key Secondary Dominants: V/III (VII), V/iv (I), V/V (II), V7/VI (III), V/VII (IV)
    if (offset === 10 && isDom7) {
      targetDegree = "III";
      targetRoot = SEMITONES[(keyIdx + 3) % 12];
      secondaryRoman = "V7/III";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot} (${targetDegree}) に解決)`;
    } else if (offset === 0 && isMajDom) {
      targetDegree = "iv";
      targetRoot = SEMITONES[(keyIdx + 5) % 12];
      secondaryRoman = isDom7 ? "V7/iv" : "V/iv";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot}m (${targetDegree}) に解決)`;
    } else if (offset === 2 && isMajDom) {
      targetDegree = "V";
      targetRoot = SEMITONES[(keyIdx + 7) % 12];
      secondaryRoman = isDom7 ? "V7/V" : "V/V";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot} (${targetDegree}) に解決)`;
    } else if (offset === 3 && isDom7) {
      targetDegree = "VI";
      targetRoot = SEMITONES[(keyIdx + 8) % 12];
      secondaryRoman = "V7/VI";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot} (${targetDegree}) に解決)`;
    } else if (offset === 5 && isMajDom) {
      targetDegree = "VII";
      targetRoot = SEMITONES[(keyIdx + 10) % 12];
      secondaryRoman = isDom7 ? "V7/VII" : "V/VII";
      description = `${chord} [${secondaryRoman}] (セカンダリードミナント ➔ ${targetRoot} (${targetDegree}) に解決)`;
    }
    // SubV in Minor Key
    else if (isDom7) {
      if (offset === 1) {
        targetDegree = "i";
        targetRoot = SEMITONES[keyIdx];
        secondaryRoman = "SubV/i";
        description = `${chord} [${secondaryRoman}] (裏コード ➔ ${targetRoot}m (${targetDegree}) に半音下降解決)`;
      } else if (offset === 6) {
        targetDegree = "iv";
        targetRoot = SEMITONES[(keyIdx + 5) % 12];
        secondaryRoman = "SubV/iv";
        description = `${chord} [${secondaryRoman}] (裏コード ➔ ${targetRoot}m (${targetDegree}) に半音下降解決)`;
      } else if (offset === 8) {
        targetDegree = "V";
        targetRoot = SEMITONES[(keyIdx + 7) % 12];
        secondaryRoman = "SubV/V";
        description = `${chord} [${secondaryRoman}] (裏コード ➔ ${targetRoot} (${targetDegree}) に半音下降解決)`;
      }
    }
  }

  const roman = baseRoman;

  return {
    isDiatonic,
    roman,
    baseRoman,
    secondaryRoman,
    harmonicRole,
    isDominant,
    targetDegree,
    targetRoot,
    resolvesToNext: false,
    resolutionLabel: null,
    description,
  };

  return {
    isDiatonic,
    roman,
    baseRoman,
    secondaryRoman,
    harmonicRole,
    isDominant,
    targetDegree,
    targetRoot,
    resolvesToNext: false,
    resolutionLabel: null,
    description,
  };
}

/** 2-Pass Comprehensive Harmonic Sequence Analysis for Chord Sheet */
export function analyzeBarChordsWithContext(
  bars: BarSegment[],
  key: string,
  pitch = 0,
): {
  chordMap: Map<string, ChordAnalysis>;
  barCadences: Map<number, BarCadenceInfo | null>;
} {
  const chordMap = new Map<string, ChordAnalysis>();
  const barCadences = new Map<number, BarCadenceInfo | null>();

  if (!key || bars.length === 0) {
    return { chordMap, barCadences };
  }

  // Flatten chords into chronological array with keys
  type FlattenedChord = {
    keyId: string;
    barNumber: number;
    chordTransposed: string;
    analysis: ChordAnalysis;
    beats: number;
    start: number;
    end: number;
  };

  const flatList: FlattenedChord[] = [];
  for (const b of bars) {
    for (const c of b.chords) {
      const keyId = `${b.bar_number}-${c.start}`;
      const chordTransposed = transposeChord(c.chord, pitch);
      const analysis = analyzeChordHarmonics(chordTransposed, key);
      flatList.push({
        keyId,
        barNumber: b.bar_number,
        chordTransposed,
        analysis,
        beats: c.beats,
        start: c.start,
        end: c.end,
      });
    }
  }

  const n = flatList.length;

  // Pass 2: Contextual Progression Analysis (Lookahead for Resolution & Related II)
  for (let i = 0; i < n; i++) {
    const cur = flatList[i];
    const curAnalysis = cur.analysis;

    if (cur.chordTransposed === "N.C." || !curAnalysis) {
      continue;
    }

    // Look ahead to next non-NC chord
    let next: FlattenedChord | null = null;
    for (let j = i + 1; j < n; j++) {
      if (flatList[j].chordTransposed !== "N.C.") {
        next = flatList[j];
        break;
      }
    }

    if (next) {
      const { rootCanon: curRoot } = parseChordParts(cur.chordTransposed);
      const { rootCanon: nextRoot } = parseChordParts(next.chordTransposed);
      const curIdx = SEMITONES.indexOf(curRoot);
      const nextIdx = SEMITONES.indexOf(nextRoot);

      if (curIdx !== -1 && nextIdx !== -1) {
        const intervalDown = ((curIdx - nextIdx) % 12 + 12) % 12;

        // 1. Dominant 5th-down resolution ((cur - next) % 12 === 7)
        if (intervalDown === 7) {
          if (curAnalysis.harmonicRole === "dominant") {
            curAnalysis.resolvesToNext = true;
            curAnalysis.resolutionType = "5th-down";
            curAnalysis.resolutionLabel = `➔ ${next.analysis.baseRoman}`;
            curAnalysis.description = `${cur.chordTransposed} [${curAnalysis.roman}] (主調プライマリドミナント ➔ ${next.chordTransposed} に完全5度解決)`;
          } else if (curAnalysis.secondaryRoman && !curAnalysis.secondaryRoman.startsWith("SubV")) {
            const targetCanon = curAnalysis.targetRoot ? FLAT_TO_SHARP[curAnalysis.targetRoot] ?? curAnalysis.targetRoot : "";
            if (nextRoot === targetCanon) {
              curAnalysis.harmonicRole = "secondary-dominant";
              curAnalysis.isDominant = true;
              curAnalysis.resolvesToNext = true;
              curAnalysis.resolutionType = "5th-down";
              curAnalysis.resolutionLabel = `➔ ${curAnalysis.targetDegree}`;
              curAnalysis.roman = curAnalysis.secondaryRoman;
              curAnalysis.description = `${cur.chordTransposed} [${curAnalysis.secondaryRoman}] (セカンダリードミナント ➔ ${next.chordTransposed} (${curAnalysis.targetDegree}) に完全5度解決)`;
            } else if (next.analysis.isDominant) {
              // Cycle of Dominants (e.g. E7 -> A7 -> D7 -> G7)
              curAnalysis.harmonicRole = "secondary-dominant";
              curAnalysis.isDominant = true;
              curAnalysis.resolvesToNext = true;
              curAnalysis.resolutionType = "cycle";
              curAnalysis.resolutionLabel = `➔ ${next.analysis.baseRoman}`;
              curAnalysis.roman = curAnalysis.secondaryRoman;
              curAnalysis.description = `${cur.chordTransposed} [${curAnalysis.secondaryRoman}] (ドミナントモーション連鎖 / Cycle of 5ths ➔ ${next.chordTransposed})`;
            }
          }
        }
        // 2. Half-step down resolution for SubV ((cur - next) % 12 === 1)
        else if (intervalDown === 1 && curAnalysis.secondaryRoman && curAnalysis.secondaryRoman.startsWith("SubV")) {
          const targetCanon = curAnalysis.targetRoot ? FLAT_TO_SHARP[curAnalysis.targetRoot] ?? curAnalysis.targetRoot : "";
          if (nextRoot === targetCanon) {
            curAnalysis.harmonicRole = "sub-v";
            curAnalysis.isDominant = true;
            curAnalysis.resolvesToNext = true;
            curAnalysis.resolutionType = "half-step-down";
            curAnalysis.resolutionLabel = `➔ ${curAnalysis.targetDegree}`;
            curAnalysis.roman = curAnalysis.secondaryRoman;
            curAnalysis.description = `${cur.chordTransposed} [${curAnalysis.secondaryRoman}] (裏コード / 代理ドミナント ➔ ${next.chordTransposed} (${curAnalysis.targetDegree}) に半音下降解決)`;
          }
        }

        // 3. Related II-V (Secondary II-V) detection (e.g. Em7 -> A7 -> Dm or Bm7b5 -> E7 -> Am)
        const { qual: curQual } = parseChordParts(cur.chordTransposed);
        if (
          isMinorOrDim(curQual) &&
          next.analysis.harmonicRole === "secondary-dominant" &&
          intervalDown === 7
        ) {
          const isHdim = curQual === "hdim7" || curQual === "dim";
          curAnalysis.harmonicRole = "related-two";
          curAnalysis.targetDegree = next.analysis.targetDegree;
          curAnalysis.targetRoot = next.analysis.targetRoot;
          curAnalysis.secondaryRoman = `${isHdim ? "iiø" : "ii"}/${next.analysis.targetDegree}`;
          curAnalysis.roman = curAnalysis.secondaryRoman;
          curAnalysis.description = `${cur.chordTransposed} [${curAnalysis.secondaryRoman}] (関連II / Secondary Supertonic ➔ ${next.chordTransposed} ➔ ${next.analysis.targetDegree})`;
        }
      }
    }

    chordMap.set(cur.keyId, curAnalysis);
  }

  // Pass 3: Bar-level Cadence Detection (II-V-I, V-I, Secondary II-V-I, Secondary V-I, SubV)
  for (const b of bars) {
    const barChords = flatList.filter((fc) => fc.barNumber === b.bar_number && fc.chordTransposed !== "N.C.");
    if (barChords.length === 0) {
      barCadences.set(b.bar_number, null);
      continue;
    }

    // Find next bar first chord
    const nextBarChord = flatList.find((fc) => fc.barNumber === b.bar_number + 1 && fc.chordTransposed !== "N.C.");

    let cadenceInfo: BarCadenceInfo | null = null;

    // Check for Secondary II-V-I or Primary II-V-I
    for (let i = 0; i < barChords.length; i++) {
      const cur = barChords[i];
      const next = i + 1 < barChords.length ? barChords[i + 1] : nextBarChord;
      const afterNext = i + 2 < barChords.length ? barChords[i + 2] : (i + 1 === barChords.length ? null : nextBarChord);

      // II-V-I Cadence Check
      if (cur && next && afterNext) {
        if (
          (cur.analysis.harmonicRole === "diatonic" || cur.analysis.harmonicRole === "related-two") &&
          next.analysis.harmonicRole === "dominant" &&
          (afterNext.analysis.harmonicRole === "tonic" || afterNext.analysis.baseRoman.toLowerCase() === "i")
        ) {
          cadenceInfo = {
            type: "2-5-1",
            badgeText: "Ⅱ-Ⅴ-Ⅰ",
            title: "Ⅱ-Ⅴ-Ⅰ Cadence (ツーファイブワン進行)",
            className: "cadence-251",
          };
          break;
        } else if (
          cur.analysis.harmonicRole === "related-two" &&
          next.analysis.harmonicRole === "secondary-dominant" &&
          next.analysis.resolvesToNext
        ) {
          cadenceInfo = {
            type: "2-5-1-sec",
            badgeText: `Ⅱ-Ⅴ/${next.analysis.targetDegree}`,
            title: `セカンダリー・ツーファイブ (Ⅱ-Ⅴ/${next.analysis.targetDegree} ➔ ${next.analysis.targetDegree})`,
            className: "cadence-sec-251",
          };
          break;
        }
      }

      // V-I Cadence / Secondary Dominant Motion Check
      if (cur && next) {
        if (cur.analysis.harmonicRole === "dominant" && cur.analysis.resolvesToNext) {
          cadenceInfo = {
            type: "5-1",
            badgeText: "Ⅴ➔Ⅰ",
            title: "Dominant Motion (Ⅴ ➔ Ⅰ 主和音解決)",
            className: "cadence-51",
          };
          break;
        } else if (cur.analysis.harmonicRole === "secondary-dominant" && cur.analysis.resolvesToNext) {
          const tgt = cur.analysis.targetDegree ?? "";
          cadenceInfo = {
            type: "5-1-sec",
            badgeText: `Ⅴ/${tgt}➔${tgt}`,
            title: `セカンダリードミナント解決 (Ⅴ/${tgt} ➔ ${tgt})`,
            className: "cadence-sec-51",
          };
          break;
        } else if (cur.analysis.harmonicRole === "sub-v" && cur.analysis.resolvesToNext) {
          const tgt = cur.analysis.targetDegree ?? "";
          cadenceInfo = {
            type: "sub-v",
            badgeText: `SubV➔${tgt}`,
            title: `裏コード半音下降解決 (SubV ➔ ${tgt})`,
            className: "cadence-sub-v",
          };
          break;
        } else if (cur.analysis.resolutionType === "cycle") {
          cadenceInfo = {
            type: "cycle",
            badgeText: "Ⅴ➔Ⅴ",
            title: "ドミナント連鎖 (Cycle of Dominants)",
            className: "cadence-cycle",
          };
          break;
        }
      }
    }

    barCadences.set(b.bar_number, cadenceInfo);
  }

  return { chordMap, barCadences };
}

/** Backward-compatible single chord helper */
export function analyzeDiatonic(chord: string, key: string): DiatonicInfo {
  const analysis = analyzeChordHarmonics(chord, key);
  return {
    isDiatonic: analysis.isDiatonic,
    roman: analysis.roman,
    baseRoman: analysis.baseRoman,
    secondaryRoman: analysis.secondaryRoman,
    harmonicRole: analysis.harmonicRole,
    isDominant: analysis.isDominant,
    targetDegree: analysis.targetDegree,
    targetRoot: analysis.targetRoot,
    resolvesToNext: analysis.resolvesToNext,
    resolutionType: analysis.resolutionType,
    resolutionLabel: analysis.resolutionLabel,
    description: analysis.description,
  };
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
    const res = await fetch(`/songs/${encodeURIComponent(slug)}/chords.json`, {
      cache: "no-cache",
    });
    if (!res.ok) return null;
    return validateChords(await res.json());
  } catch {
    return null;
  }
}
