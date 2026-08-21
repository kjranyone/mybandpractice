export type SongSummary = {
  slug: string;
  title: string;
  artist: string;
  durationSeconds: number | null;
  audioUrl: string | null;
  /** available separated stems, e.g. ["vocals","drums","bass","other"] */
  stems?: string[];
  /** base URL for stem files; `${stemBaseUrl}${stem}.flac` / `.mp3` resolves audio */
  stemBaseUrl?: string;
  /** Explicit map from stem name to resolved audio URL (supports .flac, .mp3, .wav) */
  stemUrls?: Record<string, string>;
  /** Pre-split sample-aligned stem chunks for instant playback (bin/make-stem-chunks.py) */
  chunks?: {
    chunkSeconds: number;
    /** chunk file extension ("flac" | "opus" | "ogg") */
    ext?: string;
    /** stem name -> chunk count and URL base; chunk i = `${urlBase}/${i}.${ext}` */
    stems: Record<string, { count: number; urlBase: string }>;
  };
  hasLyrics: boolean;
  sourceUrl?: string;
  lyricist?: string;
  composer?: string;
};

/** Raw meta.json shape (snake_case, written by the bin/ pipeline). */
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

export type LyricsResponse = {
  slug: string;
  markdown: string;
};
