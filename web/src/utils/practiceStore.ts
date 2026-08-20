import type { SongMarker, StanzaTag } from "../hooks/useMarkers";
import {
  isNative,
  readNativeJson,
  writeNativeJson,
} from "./nativeSongs";

/**
 * Practice data (section markers + stanza tags) persistence.
 * Stored per song in songs/<slug>/practice.json:
 *  - web dev server: GET/PUT /api/songs/:slug/practice (vite plugin)
 *  - native (Capacitor): Filesystem on the external files dir
 */

export type PracticeData = {
  markers: SongMarker[];
  stanzaTags: StanzaTag[];
};

function isMarker(v: unknown): v is SongMarker {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.time === "number" &&
    typeof m.label === "string"
  );
}

function isStanzaTag(v: unknown): v is StanzaTag {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.stanzaIndex === "number" &&
    typeof t.label === "string"
  );
}

function validate(v: unknown): PracticeData | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.markers) || !Array.isArray(o.stanzaTags)) return null;
  return {
    markers: o.markers.filter(isMarker),
    stanzaTags: o.stanzaTags.filter(isStanzaTag),
  };
}

export async function loadPractice(slug: string): Promise<PracticeData | null> {
  try {
    if (isNative()) {
      return validate(await readNativeJson(slug, "practice.json"));
    }
    const res = await fetch(
      `/api/songs/${encodeURIComponent(slug)}/practice`,
      { cache: "no-cache" },
    );
    if (!res.ok) return null;
    return validate(await res.json());
  } catch {
    return null;
  }
}

export async function savePractice(
  slug: string,
  data: PracticeData,
): Promise<boolean> {
  try {
    if (isNative()) {
      await writeNativeJson(slug, "practice.json", data);
      return true;
    }
    const res = await fetch(
      `/api/songs/${encodeURIComponent(slug)}/practice`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
