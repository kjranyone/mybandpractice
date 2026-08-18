export type SongSummary = {
  slug: string;
  title: string;
  artist: string;
  durationSeconds: number | null;
  audioUrl: string | null;
  /** available separated stems, e.g. ["vocals","drums","bass","other"] */
  stems?: string[];
  /** base URL for stem files; `${stemBaseUrl}${stem}.mp3` resolves audio */
  stemBaseUrl?: string;
  hasLyrics: boolean;
  sourceUrl?: string;
  lyricist?: string;
  composer?: string;
};

export type LyricsResponse = {
  slug: string;
  markdown: string;
};
