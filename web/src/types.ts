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
  hasLyrics: boolean;
  sourceUrl?: string;
  lyricist?: string;
  composer?: string;
};

export type LyricsResponse = {
  slug: string;
  markdown: string;
};
