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

export async function ensureNativePermissions(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    const status = await Filesystem.checkPermissions();
    if (status.publicStorage !== "granted") {
      const req = await Filesystem.requestPermissions();
      return req.publicStorage === "granted";
    }
    return true;
  } catch {
    return false;
  }
}

export async function listNativeSongs(): Promise<SongSummary[]> {
  await ensureNativePermissions();
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
    const isDir = entry.type?.toLowerCase() === "directory" || entry.type?.toLowerCase() === "dir";
    if (!isDir) continue;
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

    // Separated stems (bin/separate-stems.py) live in stems/<stem>.mp3
    let stems: string[] | undefined;
    try {
      const stemDir = await Filesystem.readdir({
        path: `${dirPath}/stems`,
        directory: Directory.External,
      });
      const found = stemDir.files
        .map((f) => f.name ?? "")
        .filter(
          (f) =>
            f.toLowerCase().endsWith(".mp3") &&
            !["mix.mp3", "mixdown.mp3", "original.mp3"].includes(
              f.toLowerCase(),
            ),
        )
        .map((f) => f.slice(0, -".mp3".length))
        .sort();
      if (found.length > 0) stems = found;
    } catch {
      /* no stems dir */
    }

    const audioUrl = mp3 && entry.uri
      ? Capacitor.convertFileSrc(
          `${toAbs(entry.uri)}/${encodeURIComponent(mp3.name)}`,
        )
      : null;

    songs.push({
      slug,
      title: meta.title || slug,
      artist: meta.artist || "Unknown",
      durationSeconds: duration,
      audioUrl,
      stems,
      stemBaseUrl:
        stems && entry.uri
          ? `${Capacitor.convertFileSrc(toAbs(entry.uri))}/stems/`
          : undefined,
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

export type NativeSetlist = {
  id: string; // filename stem
  name: string; // display name from JSON
  songs: string[];
};

/** Read-only setlists/ scan (setlists are edited on the PC web UI). */
export async function listNativeSetlists(): Promise<NativeSetlist[]> {
  let root: ReaddirResult;
  try {
    root = await Filesystem.readdir({
      path: "setlists",
      directory: Directory.External,
    });
  } catch {
    return [];
  }

  const out: NativeSetlist[] = [];
  for (const entry of root.files) {
    if (entry.type === "directory" || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    const text = await readTextFile(`setlists/${entry.name}`);
    if (text == null) continue;
    try {
      const v = JSON.parse(text) as { name?: unknown; songs?: unknown };
      out.push({
        id,
        name: typeof v.name === "string" ? v.name : id,
        songs: Array.isArray(v.songs)
          ? v.songs.filter((s): s is string => typeof s === "string")
          : [],
      });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
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
