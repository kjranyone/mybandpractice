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

export type LyricsResponse = {
  slug: string;
  markdown: string;
};
