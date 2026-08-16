export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Practice time: m:ss.d (tenths) */
export function formatTimePrecise(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "0:00.0";
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const t = Math.floor((total % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${t}`;
}

/** Linear 0–1 → dB string (0 dB at full, -∞ at 0). */
export function volumeToDbLabel(volume: number): string {
  if (volume <= 0.0001) return "-∞";
  const db = 20 * Math.log10(volume);
  if (db > -0.05) return "0.0";
  return db.toFixed(1);
}

/** Strip YAML frontmatter and return body + optional frontmatter fields. */
export function parseLyricsMarkdown(markdown: string): {
  body: string;
  title?: string;
  artist?: string;
} {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) {
    return { body: markdown.trim() };
  }

  const yaml = fm[1];
  const body = fm[2].trim();
  const title = yaml.match(/^title:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  const artist = yaml.match(/^artist:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  return { body, title, artist };
}

export type LyricsBlock =
  | { type: "heading"; text: string }
  | { type: "artist"; text: string }
  | { type: "section"; text: string }
  | { type: "stanza"; lines: string[] };

/** Parse lyrics body into structured blocks (stanzas keep their lines). */
export function parseLyricsBlocks(body: string): LyricsBlock[] {
  const blocks: LyricsBlock[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      blocks.push({ type: "stanza", lines: buf });
      buf = [];
    }
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      flush();
      blocks.push({ type: "heading", text: line.replace(/^#{1,3}\s+/, "") });
      continue;
    }
    if (/^\*[^*]+\*$/.test(line)) {
      flush();
      blocks.push({ type: "artist", text: line.slice(1, -1) });
      continue;
    }
    if (/^\[[^\]]+\]$/.test(line)) {
      flush();
      blocks.push({ type: "section", text: line });
      continue;
    }
    buf.push(raw.trimEnd());
  }
  flush();
  return blocks;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
