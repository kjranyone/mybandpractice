import { Capacitor } from "@capacitor/core";
import {
  Directory,
  Encoding,
  Filesystem,
  type ReaddirResult,
} from "@capacitor/filesystem";
import type { SongSummary } from "../types";

/**
 * Native (Capacitor) song storage:
 * songs live in the app's external files dir, pushed via adb:
 *   /storage/emulated/0/Android/data/<pkg>/files/songs/<slug>/
 * Audio is exposed to the WebView through Capacitor.convertFileSrc().
 */

const SONGS_ROOT = "songs";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const res = await Filesystem.readFile({
      path,
      directory: Directory.External,
      encoding: Encoding.UTF8,
    });
    if (typeof res.data === "string") return res.data;
    return null;
  } catch {
    return null;
  }
}

type Meta = {
  title?: string;
  artist?: string;
  source_url?: string;
  yt_duration_seconds?: number;
  audio?: { file?: string; output_duration_seconds?: number };
  lyrics?: { lyricist?: string; composer?: string };
};

function toAbs(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

export async function listNativeSongs(): Promise<SongSummary[]> {
  let root: ReaddirResult;
  try {
    root = await Filesystem.readdir({
      path: SONGS_ROOT,
      directory: Directory.External,
    });
  } catch {
    return []; // songs dir not pushed yet
  }

  const songs: SongSummary[] = [];
  for (const entry of root.files) {
    if (entry.type !== "directory") continue;
    const slug = entry.name;
    const dirPath = `${SONGS_ROOT}/${slug}`;

    const metaRaw = await readTextFile(`${dirPath}/meta.json`);
    let meta: Meta = {};
    if (metaRaw) {
      try {
        meta = JSON.parse(metaRaw) as Meta;
      } catch {
        /* malformed meta — fall back to slug */
      }
    }

    let files: { name: string; type: string }[] = [];
    try {
      const listing = await Filesystem.readdir({
        path: dirPath,
        directory: Directory.External,
      });
      files = listing.files.map((f) => ({
        name: f.name ?? "",
        type: f.type ?? "file",
      }));
    } catch {
      continue;
    }

    const mp3 =
      files.find((f) => f.name === `${slug}.mp3`) ??
      files.find((f) => f.name.toLowerCase().endsWith(".mp3"));

    const duration =
      meta.audio?.output_duration_seconds ?? meta.yt_duration_seconds ?? null;

    songs.push({
      slug,
      title: meta.title || slug,
      artist: meta.artist || "Unknown",
      durationSeconds: duration,
      audioUrl:
        mp3 && entry.uri
          ? Capacitor.convertFileSrc(
              `${toAbs(entry.uri)}/${encodeURIComponent(mp3.name)}`,
            )
          : null,
      hasLyrics: files.some((f) => f.name === "lyrics.md"),
      sourceUrl: meta.source_url,
      lyricist: meta.lyrics?.lyricist || undefined,
      composer: meta.lyrics?.composer || undefined,
    });
  }

  return songs.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readNativeLyrics(
  slug: string,
): Promise<string | null> {
  return readTextFile(`${SONGS_ROOT}/${slug}/lyrics.md`);
}

/** Read practice.json (markers + stanza tags) for a song. */
export async function readNativeJson(
  slug: string,
  file: string,
): Promise<unknown | null> {
  const text = await readTextFile(`${SONGS_ROOT}/${slug}/${file}`);
  if (text == null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Write practice.json (markers + stanza tags) for a song. */
export async function writeNativeJson(
  slug: string,
  file: string,
  data: unknown,
): Promise<void> {
  await Filesystem.writeFile({
    path: `${SONGS_ROOT}/${slug}/${file}`,
    directory: Directory.External,
    encoding: Encoding.UTF8,
    data: JSON.stringify(data, null, 2) + "\n",
  });
}
