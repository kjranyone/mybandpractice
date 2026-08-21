import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";
import { parseChunkManifest } from "./src/audio/chunkMath";
import type { SongSummary } from "./src/types";

export type { SongSummary };

export type SongMeta = {
  slug: string;
  title: string;
  artist: string;
  source_url?: string;
  yt_duration_seconds?: number;
  audio?: {
    file?: string;
    output_duration_seconds?: number;
  };
  lyrics?: {
    source_url?: string;
    matched_artist?: string;
    lyricist?: string;
    composer?: string;
    stanza_count?: number;
    line_count?: number;
  };
};

function listSongs(songsDir: string): SongSummary[] {
  if (!fs.existsSync(songsDir)) return [];

  const slugs = fs
    .readdirSync(songsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const songs: SongSummary[] = [];

  for (const slug of slugs) {
    const dir = path.join(songsDir, slug);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) continue;

    let meta: SongMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as SongMeta;
    } catch {
      continue;
    }

    const files = fs.readdirSync(dir);
    // Prefer convention: {slug}.ogg, {slug}.opus, {slug}.flac, {slug}.mp3, then meta.audio.file
    const mainAudio =
      files.find((f) => f === `${slug}.ogg`) ??
      files.find((f) => f === `${slug}.opus`) ??
      files.find((f) => f === `${slug}.flac`) ??
      files.find((f) => f === `${slug}.mp3`) ??
      files.find((f) => f.toLowerCase().endsWith(".ogg")) ??
      files.find((f) => f.toLowerCase().endsWith(".opus")) ??
      files.find((f) => f.toLowerCase().endsWith(".flac")) ??
      files.find((f) => f.toLowerCase().endsWith(".mp3")) ??
      (meta.audio?.file && files.includes(meta.audio.file)
        ? meta.audio.file
        : null);

    const duration =
      meta.audio?.output_duration_seconds ?? meta.yt_duration_seconds ?? null;

    // Separated stems live in stems/<stem>.ogg, .flac or .mp3
    let stems: string[] | undefined;
    let stemUrls: Record<string, string> | undefined;
    const stemsDir = path.join(dir, "stems");
    if (fs.existsSync(stemsDir)) {
      const stemFiles = fs.readdirSync(stemsDir);
      const stemsMap = new Map<string, string>();
      for (const fname of stemFiles) {
        const extMatch = fname.match(/\.(ogg|opus|flac|mp3|wav|m4a)$/i);
        if (!extMatch) continue;
        const stemName = fname.slice(0, -extMatch[0].length);
        if (["mix", "mixdown", "original"].includes(stemName.toLowerCase())) continue;
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
        stemUrls = {};
        for (const [stemName, fname] of stemsMap.entries()) {
          stemUrls[stemName] = `/songs/${encodeURIComponent(slug)}/stems/${encodeURIComponent(fname)}`;
        }
      }
    }

    // Pre-split sample-aligned chunks (bin/make-stem-chunks.py): served the
    // same way as on the device — instant playback decodes only the chunk at
    // the playhead. Whole-file stems above stay as the fallback path.
    let chunks: SongSummary["chunks"];
    if (stems && stems.length > 0) {
      const manifestPath = path.join(stemsDir, "chunks", "chunks.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
          const parsed = parseChunkManifest(raw);
          if (parsed && stems.every((s) => parsed.stems[s])) {
            const chunkStems: Record<string, { count: number; urlBase: string }> = {};
            for (const stemName of stems) {
              chunkStems[stemName] = {
                count: parsed.stems[stemName].count,
                urlBase: `/songs/${encodeURIComponent(slug)}/stems/chunks/${encodeURIComponent(stemName)}`,
              };
            }
            chunks = { chunkSeconds: parsed.chunkSeconds, ext: parsed.ext, stems: chunkStems };
          }
        } catch {
          /* malformed chunks manifest — fall back to whole-file stems */
        }
      }
    }

    songs.push({
      slug,
      title: meta.title || slug,
      artist: meta.artist || "Unknown",
      durationSeconds: duration,
      audioUrl: mainAudio
        ? `/songs/${encodeURIComponent(slug)}/${encodeURIComponent(mainAudio)}`
        : null,
      stems,
      stemUrls,
      chunks,
      stemBaseUrl: stems
        ? `/songs/${encodeURIComponent(slug)}/stems/`
        : undefined,
      hasLyrics: files.includes("lyrics.md"),
      sourceUrl: meta.source_url,
      lyricist: meta.lyrics?.lyricist || undefined,
      composer: meta.lyrics?.composer || undefined,
    });
  }

  return songs;
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function walkFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walkFiles(path.join(dir, ent.name), rel));
    else if (ent.isFile() && !rel.endsWith(".part")) out.push(rel);
  }
  return out;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".flac":
      return "audio/flac";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function safeJoin(root: string, ...parts: string[]): string | null {
  const resolved = path.resolve(root, ...parts);
  const rootResolved = path.resolve(root);
  if (
    resolved !== rootResolved &&
    !resolved.startsWith(rootResolved + path.sep)
  ) {
    return null;
  }
  return resolved;
}

function attachMiddleware(
  middlewares: Connect.Server,
  songsDir: string,
  setlistsDir: string,
) {
  // library root = parent of songs/ (contains songs/ and setlists/)
  const libRoot = path.dirname(songsDir);
  middlewares.use((req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const rawUrl = req.url ?? "";
    const url = new URL(rawUrl, "http://localhost");

    // ---- P2P sender (web): read-only library access ----

    // GET /api/sync-list?dir=songs  (recursive file listing)
    if (url.pathname === "/api/sync-list" && req.method === "GET") {
      const dir = url.searchParams.get("dir") ?? "";
      const root = safeJoin(libRoot, dir);
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        sendJson(res, 200, { files: [] });
        return;
      }
      const files = walkFiles(root).map((name) => ({
        name,
        bytes: fs.statSync(path.join(root, ...name.split("/"))).size,
      }));
      sendJson(res, 200, { files });
      return;
    }

    // GET/HEAD/PUT/DELETE /api/sync-file?path=songs/<slug>/x.mp3
    if (url.pathname === "/api/sync-file") {
      const rel = url.searchParams.get("path") ?? "";
      const p = safeJoin(libRoot, rel);
      if (!p) {
        res.statusCode = 400;
        res.end();
        return;
      }

      if (req.method === "PUT") {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, Buffer.concat(chunks));
          sendJson(res, 200, { ok: true });
        })();
        return;
      }

      if (req.method === "DELETE") {
        fs.rmSync(p, { force: true });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const stat = fs.statSync(p);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(stat.size));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(p).pipe(res);
      return;
    }

    // POST /api/sync-rename?from=x&to=y  (publish .part files etc.)
    if (url.pathname === "/api/sync-rename" && req.method === "POST") {
      const from = safeJoin(libRoot, url.searchParams.get("from") ?? "");
      const to = safeJoin(libRoot, url.searchParams.get("to") ?? "");
      if (!from || !to || !fs.existsSync(from)) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- setlists (ordered song lists) ----
    // URL segment is a filesystem-safe id (slug); the display name lives
    // inside the JSON so it may contain any unicode.
    const safeId = (p: string) =>
      p
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
        .replace(/[. ]+$/, "")
        .trim();

    if (url.pathname === "/api/setlists" && req.method === "GET") {
      const out: unknown[] = [];
      if (fs.existsSync(setlistsDir)) {
        for (const f of fs.readdirSync(setlistsDir)) {
          if (!f.endsWith(".json")) continue;
          try {
            const v = JSON.parse(
              fs.readFileSync(path.join(setlistsDir, f), "utf-8"),
            ) as { name?: unknown; songs?: unknown };
            out.push({
              id: f.slice(0, -".json".length),
              name: typeof v.name === "string" ? v.name : f,
              songs: Array.isArray(v.songs)
                ? v.songs.filter((s): s is string => typeof s === "string")
                : [],
            });
          } catch {
            /* skip corrupt */
          }
        }
      }
      sendJson(res, 200, out);
      return;
    }

    const setlistMatch = url.pathname.match(/^\/api\/setlists\/([^/]+)$/);
    if (setlistMatch) {
      void (async () => {
        const id = safeId(decodeURIComponent(setlistMatch[1]));
        if (!id) {
          sendJson(res, 400, { error: "Invalid id" });
          return;
        }
        const file = path.join(setlistsDir, `${id}.json`);

        if (req.method === "PUT") {
          let body = "";
          for await (const chunk of req) body += chunk as string;
          let data: unknown;
          try {
            data = JSON.parse(body);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON" });
            return;
          }
          const d = data as { name?: unknown; songs?: unknown };
          if (
            typeof d.name !== "string" ||
            !Array.isArray(d.songs) ||
            !d.songs.every((s) => typeof s === "string")
          ) {
            sendJson(res, 400, { error: "Expected { name, songs: string[] }" });
            return;
          }
          fs.mkdirSync(setlistsDir, { recursive: true });
          fs.writeFileSync(
            file,
            JSON.stringify({ name: d.name, songs: d.songs }, null, 2) + "\n",
            "utf-8",
          );
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === "DELETE") {
          if (fs.existsSync(file)) fs.unlinkSync(file);
          sendJson(res, 200, { ok: true });
          return;
        }

        res.statusCode = 405;
        res.end();
      })();
      return;
    }

    // GET /api/storage  (per-song on-disk usage in bytes)
    if (url.pathname === "/api/storage" && req.method === "GET") {
      const out: Record<string, number> = {};
      for (const song of listSongs(songsDir)) {
        const dir = path.join(songsDir, song.slug);
        let total = 0;
        for (const rel of walkFiles(dir)) {
          total += fs.statSync(path.join(dir, ...rel.split("/"))).size;
        }
        out[song.slug] = total;
      }
      sendJson(res, 200, out);
      return;
    }

    // GET /api/songs.json  (static-file variant for Capacitor builds)
    if (url.pathname === "/api/songs.json") {
      sendJson(res, 200, listSongs(songsDir));
      return;
    }

    // GET /api/songs
    if (url.pathname === "/api/songs") {
      sendJson(res, 200, listSongs(songsDir));
      return;
    }

    // GET/DELETE /api/songs/:slug
    const songMatch = url.pathname.match(/^\/api\/songs\/([^/]+)$/);
    if (songMatch) {
      const slug = decodeURIComponent(songMatch[1]);

      if (req.method === "DELETE") {
        const dir = safeJoin(songsDir, slug);
        if (
          !dir ||
          !fs.existsSync(dir) ||
          !fs.statSync(dir).isDirectory()
        ) {
          sendJson(res, 404, { error: "Song not found" });
          return;
        }
        fs.rmSync(dir, { recursive: true, force: true });
        sendJson(res, 200, { ok: true });
        return;
      }

      const songs = listSongs(songsDir);
      const song = songs.find((s) => s.slug === slug);
      if (!song) {
        sendJson(res, 404, { error: "Song not found" });
        return;
      }

      const metaPath = safeJoin(songsDir, slug, "meta.json");
      let meta: SongMeta | null = null;
      if (metaPath && fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as SongMeta;
      }
      sendJson(res, 200, { ...song, meta });
      return;
    }

    // GET /api/songs/:slug/lyrics.json  (static-file variant)
    const lyricsJsonMatch = url.pathname.match(/^\/api\/songs\/([^/]+)\/lyrics\.json$/);
    if (lyricsJsonMatch) {
      const slug = decodeURIComponent(lyricsJsonMatch[1]);
      const lyricsPath = safeJoin(songsDir, slug, "lyrics.md");
      if (!lyricsPath || !fs.existsSync(lyricsPath)) {
        sendJson(res, 404, { error: "Lyrics not found" });
        return;
      }
      const markdown = fs.readFileSync(lyricsPath, "utf-8");
      sendJson(res, 200, { slug, markdown });
      return;
    }

    // GET /api/songs/:slug/lyrics
    const lyricsMatch = url.pathname.match(/^\/api\/songs\/([^/]+)\/lyrics$/);
    if (lyricsMatch) {
      const slug = decodeURIComponent(lyricsMatch[1]);
      const lyricsPath = safeJoin(songsDir, slug, "lyrics.md");
      if (!lyricsPath || !fs.existsSync(lyricsPath)) {
        sendJson(res, 404, { error: "Lyrics not found" });
        return;
      }
      const markdown = fs.readFileSync(lyricsPath, "utf-8");
      sendJson(res, 200, { slug, markdown });
      return;
    }

    // GET/PUT /api/songs/:slug/practice  (markers + stanza tags in practice.json)
    const practiceMatch = url.pathname.match(/^\/api\/songs\/([^/]+)\/practice$/);
    if (practiceMatch) {
      void (async () => {
        const slug = decodeURIComponent(practiceMatch[1]);
        const songDir = safeJoin(songsDir, slug);
        if (!songDir) {
          sendJson(res, 404, { error: "Song not found" });
          return;
        }
        const practicePath = path.join(songDir, "practice.json");

        if (req.method === "GET") {
          const empty = { markers: [], stanzaTags: [] };
          if (!fs.existsSync(practicePath)) {
            sendJson(res, 200, empty);
            return;
          }
          try {
            sendJson(
              res,
              200,
              JSON.parse(fs.readFileSync(practicePath, "utf-8")),
            );
          } catch {
            sendJson(res, 200, empty);
          }
          return;
        }

        if (req.method === "PUT") {
          let body = "";
          for await (const chunk of req) body += chunk as string;
          let practice: unknown;
          try {
            practice = JSON.parse(body);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON" });
            return;
          }
          const p = practice as { markers?: unknown; stanzaTags?: unknown };
          if (!Array.isArray(p.markers) || !Array.isArray(p.stanzaTags)) {
            sendJson(res, 400, { error: "Expected { markers, stanzaTags }" });
            return;
          }
          fs.writeFileSync(
            practicePath,
            JSON.stringify(practice, null, 2) + "\n",
            "utf-8",
          );
          sendJson(res, 200, { ok: true });
          return;
        }

        res.statusCode = 405;
        res.end();
      })();
      return;
    }

    // GET /songs/:slug/:file  (mp3, meta.json, lyrics.md, ...)
    const fileMatch = url.pathname.match(/^\/songs\/([^/]+)\/(.+)$/);
    if (fileMatch) {
      const slug = decodeURIComponent(fileMatch[1]);
      const file = decodeURIComponent(fileMatch[2]);
      const filePath = safeJoin(songsDir, slug, file);
      if (
        !filePath ||
        !fs.existsSync(filePath) ||
        !fs.statSync(filePath).isFile()
      ) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const stat = fs.statSync(filePath);
      const type = contentTypeFor(filePath);
      res.setHeader("Content-Type", type);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=3600");

      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : stat.size - 1;
          if (start >= stat.size || end >= stat.size || start > end) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${stat.size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
      }

      res.setHeader("Content-Length", String(stat.size));
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    next();
  });
}

/** Serves `../songs` at /songs, `../setlists` via /api/setlists,
 * and exposes /api/songs for the React app. */
export function songsPlugin(songsDir: string, setlistsDir?: string): Plugin {
  const resolved = path.resolve(songsDir);
  const resolvedSetlists = path.resolve(setlistsDir ?? path.join(path.dirname(resolved), "setlists"));

  const setup = (server: ViteDevServer | PreviewServer) => {
    attachMiddleware(server.middlewares, resolved, resolvedSetlists);
  };

  return {
    name: "songs-plugin",
    configureServer: setup,
    configurePreviewServer: setup,
  };
}
