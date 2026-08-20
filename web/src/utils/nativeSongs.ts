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
  // App-specific external storage (/Android/data/<pkg>/files/) requires no runtime permissions
  return true;
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
    if (!entry.name || entry.name.startsWith(".") || entry.name.includes(".")) {
      continue; // skip dotfiles / files with extensions at root
    }
    const slug = entry.name;
    const dirPath = `${SONGS_ROOT}/${slug}`;

    let baseUri = entry.uri;
    if (!baseUri) {
      try {
        const uriRes = await Filesystem.getUri({
          path: dirPath,
          directory: Directory.External,
        });
        baseUri = uriRes.uri;
      } catch {
        /* ignore */
      }
    }

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

    const AUDIO_EXTS = [".ogg", ".opus", ".flac", ".mp3", ".wav", ".m4a"];

    const mainAudio =
      files.find((f) => f.name === `${slug}.ogg`) ??
      files.find((f) => f.name === `${slug}.opus`) ??
      files.find((f) => f.name === `${slug}.flac`) ??
      files.find((f) => f.name === `${slug}.mp3`) ??
      files.find((f) => f.name.toLowerCase().endsWith(".ogg")) ??
      files.find((f) => f.name.toLowerCase().endsWith(".opus")) ??
      files.find((f) => f.name.toLowerCase().endsWith(".flac")) ??
      files.find((f) => f.name.toLowerCase().endsWith(".mp3")) ??
      files.find((f) =>
        AUDIO_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
      );

    const duration =
      meta.audio?.output_duration_seconds ?? meta.yt_duration_seconds ?? null;

    // Separated stems live in stems/<stem>.ogg, .flac or .mp3
    let stems: string[] | undefined;
    let stemUrls: Record<string, string> | undefined;
    try {
      const stemDir = await Filesystem.readdir({
        path: `${dirPath}/stems`,
        directory: Directory.External,
      });
      const validStemFiles = stemDir.files
        .map((f) => f.name ?? "")
        .filter((name) => {
          const lower = name.toLowerCase();
          return (
            AUDIO_EXTS.some((ext) => lower.endsWith(ext)) &&
            !["mix", "mixdown", "original"].some((prefix) =>
              lower.startsWith(prefix),
            )
          );
        });

      if (validStemFiles.length > 0) {
        const stemsMap = new Map<string, string>(); // stemName -> fileName (.ogg/.opus prioritized)
        for (const fname of validStemFiles) {
          const extMatch = fname.match(/\.(ogg|opus|flac|mp3|wav|m4a)$/i);
          if (!extMatch) continue;
          const stemName = fname.slice(0, -extMatch[0].length);
          const lower = fname.toLowerCase();
          const existing = stemsMap.get(stemName);
          if (
            !existing ||
            lower.endsWith(".ogg") ||
            lower.endsWith(".opus") ||
            (!existing.toLowerCase().endsWith(".ogg") && !existing.toLowerCase().endsWith(".opus") && lower.endsWith(".flac"))
          ) {
            stemsMap.set(stemName, fname);
          }
        }

        if (stemsMap.size > 0) {
          stems = Array.from(stemsMap.keys()).sort();
          if (baseUri) {
            stemUrls = {};
            const stemDirAbs = `${toAbs(baseUri)}/stems`;
            for (const [stemName, fname] of stemsMap.entries()) {
              const fullPath = `${stemDirAbs}/${encodeURIComponent(fname)}`;
              // Direct Linux POSIX Chromium file access (completely bypasses Java IPC and LocalServer)
              stemUrls[stemName] = `file://${fullPath}`;
            }
          }
        }
      }
    } catch {
      /* no stems dir */
    }

    const audioUrl = mainAudio && baseUri
      ? `file://${toAbs(baseUri)}/${encodeURIComponent(mainAudio.name)}`
      : null;

    songs.push({
      slug,
      title: meta.title || slug,
      artist: meta.artist || "Unknown",
      durationSeconds: duration,
      audioUrl,
      stems,
      stemUrls,
      stemBaseUrl:
        stems && baseUri
          ? `${Capacitor.convertFileSrc(toAbs(baseUri))}/stems/`
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

/** Per-song on-device storage usage in bytes (audio + stems + text). */
export async function getNativeSongStorage(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let root: ReaddirResult;
  try {
    root = await Filesystem.readdir({
      path: SONGS_ROOT,
      directory: Directory.External,
    });
  } catch {
    return out;
  }

  const dirSize = async (dirPath: string): Promise<number> => {
    let total = 0;
    let listing: ReaddirResult;
    try {
      listing = await Filesystem.readdir({
        path: dirPath,
        directory: Directory.External,
      });
    } catch {
      return 0;
    }
    for (const f of listing.files) {
      const p = `${dirPath}/${f.name}`;
      if (f.type?.toLowerCase().startsWith("dir")) {
        total += await dirSize(p);
      } else {
        try {
          const st = await Filesystem.stat({
            path: p,
            directory: Directory.External,
          });
          total += st.size;
        } catch {
          /* unreadable file */
        }
      }
    }
    return total;
  };

  for (const entry of root.files) {
    const isDir =
      entry.type?.toLowerCase() === "directory" ||
      entry.type?.toLowerCase() === "dir";
    if (!isDir || !entry.name) continue;
    out.set(entry.name, await dirSize(`${SONGS_ROOT}/${entry.name}`));
  }
  return out;
}

/** Delete a song directory (audio, stems, lyrics, practice data). */
export async function deleteNativeSong(slug: string): Promise<void> {
  await Filesystem.rmdir({
    path: `${SONGS_ROOT}/${slug}`,
    directory: Directory.External,
    recursive: true,
  });
}

/** Create/overwrite a setlist file. */
export async function saveNativeSetlist(
  id: string,
  name: string,
  songSlugs: string[],
): Promise<void> {
  await Filesystem.writeFile({
    path: `setlists/${id}.json`,
    directory: Directory.External,
    encoding: Encoding.UTF8,
    data: JSON.stringify({ name, songs: songSlugs }, null, 2) + "\n",
  });
}

/** Delete a setlist file. */
export async function deleteNativeSetlist(id: string): Promise<void> {
  await Filesystem.deleteFile({
    path: `setlists/${id}.json`,
    directory: Directory.External,
  });
}
