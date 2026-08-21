import { clamp } from "../utils/format";

/**
 * Fader gain mapping for the mixer: fader position 0..1 (track travel) maps
 * to gain 0..1 linearly up to UNITY_POS, then dB-linearly to +6 dB at the
 * top of the travel — so every fader can boost past 100% like a real mixer.
 */
export const MAX_GAIN_DB = 6;
export const MAX_GAIN = 10 ** (MAX_GAIN_DB / 20);
export const UNITY_POS = 0.8;

export function posToGain(pos: number): number {
  const p = clamp(pos, 0, 1);
  if (p <= UNITY_POS) return p / UNITY_POS;
  const db = ((p - UNITY_POS) / (1 - UNITY_POS)) * MAX_GAIN_DB;
  return 10 ** (db / 20);
}

export function gainToPos(gain: number): number {
  const g = Math.max(0, gain);
  if (g <= 1) return g * UNITY_POS;
  const db = 20 * Math.log10(Math.min(g, MAX_GAIN));
  return UNITY_POS + (db / MAX_GAIN_DB) * (1 - UNITY_POS);
}

export function formatGain(gain: number): string {
  if (gain <= 1) return `${Math.round(gain * 100)}%`;
  return `+${(20 * Math.log10(gain)).toFixed(1)}dB`;
}
