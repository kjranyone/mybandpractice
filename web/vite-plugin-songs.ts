import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";

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

export type SongSummary = {
  slug: string;
  title: string;
  artist: string;
  durationSeconds: number | null;
  audioUrl: string | null;
  hasLyrics: boolean;
  sourceUrl?: string;
  lyricist?: string;
  composer?: string;
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
    // Prefer convention: {slug}.mp3, then any .mp3, then meta.audio.file
    const preferred = `${slug}.mp3`;
    const mp3 =
      files.find((f) => f === preferred) ??
      files.find((f) => f.toLowerCase().endsWith(".mp3")) ??
      (meta.audio?.file && files.includes(meta.audio.file)
        ? meta.audio.file
        : null);

    const duration =
      meta.audio?.output_duration_seconds ?? meta.yt_duration_seconds ?? null;

    songs.push({
      slug,
      title: meta.title || slug,
      artist: meta.artist || "Unknown",
      durationSeconds: duration,
      audioUrl: mp3
        ? `/songs/${encodeURIComponent(slug)}/${encodeURIComponent(mp3)}`
        : null,
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

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
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

function attachMiddleware(middlewares: Connect.Server, songsDir: string) {
  middlewares.use((req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const rawUrl = req.url ?? "";
    const url = new URL(rawUrl, "http://localhost");

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

    // GET /api/songs/:slug
    const songMatch = url.pathname.match(/^\/api\/songs\/([^/]+)$/);
    if (songMatch) {
      const slug = decodeURIComponent(songMatch[1]);
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

/** Serves `../songs` at /songs and exposes /api/songs for the React app. */
export function songsPlugin(songsDir: string): Plugin {
  const resolved = path.resolve(songsDir);

  const setup = (server: ViteDevServer | PreviewServer) => {
    attachMiddleware(server.middlewares, resolved);
  };

  return {
    name: "songs-plugin",
    configureServer: setup,
    configurePreviewServer: setup,
  };
}
