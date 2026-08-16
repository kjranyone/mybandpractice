import { useEffect, useRef } from "react";
import { MediaSession } from "@capgo/capacitor-media-session";
import type { MediaSessionAction } from "@capgo/capacitor-media-session";
import type { AudioPlayer } from "./useAudioPlayer";

type ActionDetails = { seekTime?: number | null };

const SEEK_STEP = 10; // seconds for notification seek buttons

const HANDLED_ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekbackward",
  "seekforward",
  "seekto",
  "stop",
];

/**
 * Mirrors the audio player state into the OS media session so Android
 * shows a music-style notification (play/pause/seek/prev/next) and
 * keeps playing in the background via the plugin's foreground service.
 * On Web/iOS the plugin delegates to the standard Media Session API.
 */
export function useMediaSession(player: AudioPlayer) {
  const playerRef = useRef(player);
  playerRef.current = player;

  // --- action handlers (registered once, latest player via ref) ---
  useEffect(() => {
    const handlers: Record<
      MediaSessionAction,
      (details: ActionDetails) => void
    > = {
      play: () => playerRef.current.play(),
      pause: () => playerRef.current.pause(),
      previoustrack: () => playerRef.current.playPrev(),
      nexttrack: () => playerRef.current.playNext(),
      seekbackward: () => playerRef.current.skip(-SEEK_STEP),
      seekforward: () => playerRef.current.skip(SEEK_STEP),
      seekto: (d) => {
        if (d.seekTime != null) playerRef.current.seek(d.seekTime);
      },
      stop: () => {
        playerRef.current.pause();
        playerRef.current.seek(0);
      },
    };
    for (const action of HANDLED_ACTIONS) {
      void MediaSession.setActionHandler({ action }, handlers[action]);
    }
    return () => {
      for (const action of HANDLED_ACTIONS) {
        void MediaSession.setActionHandler({ action }, null);
      }
    };
  }, []);

  // --- metadata on track change ---
  useEffect(() => {
    const song = player.current;
    if (!song) {
      void MediaSession.setPlaybackState({ playbackState: "none" });
      return;
    }
    void MediaSession.setMetadata({
      title: song.title,
      artist: song.artist,
    });
  }, [player.current]);

  // --- playback state ---
  useEffect(() => {
    const state = !player.current
      ? "none"
      : player.playing
        ? "playing"
        : "paused";
    void MediaSession.setPlaybackState({ playbackState: state });
  }, [player.playing, player.current]);

  // --- position state (throttled to ~1s) ---
  const lastPosRef = useRef(-Infinity);
  useEffect(() => {
    const { currentTime, duration, playbackRate } = player;
    if (!player.current || !duration) return;
    if (Math.abs(currentTime - lastPosRef.current) < 1) return;
    lastPosRef.current = currentTime;
    void MediaSession.setPositionState({
      duration,
      playbackRate,
      position: Math.min(currentTime, duration),
    });
  }, [player.currentTime, player.duration, player.playbackRate, player.current]);
}
