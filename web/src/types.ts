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
  /** Pre-split sample-exact stem chunks for instant playback (bin/make-stem-chunks.py) */
  chunks?: {
    chunkSeconds: number;
    /** stem name -> chunk count and URL base; chunk i = `${urlBase}/${i}.flac` */
    stems: Record<string, { count: number; urlBase: string }>;
  };
  hasLyrics: boolean;
  sourceUrl?: string;
  lyricist?: string;
  composer?: string;
};

export type LyricsResponse = {
  slug: string;
  markdown: string;
};
