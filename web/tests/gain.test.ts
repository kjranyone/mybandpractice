import { describe, expect, it } from "vitest";
import {
  MAX_GAIN,
  UNITY_POS,
  formatGain,
  gainToPos,
  posToGain,
} from "../src/audio/gain";

describe("fader gain mapping", () => {
  it("maps bottom of travel to silence", () => {
    expect(posToGain(0)).toBe(0);
    expect(gainToPos(0)).toBe(0);
  });

  it("maps the unity mark to gain 1", () => {
    expect(posToGain(UNITY_POS)).toBeCloseTo(1, 10);
    expect(gainToPos(1)).toBeCloseTo(UNITY_POS, 10);
  });

  it("maps top of travel to the +6 dB boost ceiling", () => {
    expect(posToGain(1)).toBeCloseTo(MAX_GAIN, 10);
    expect(gainToPos(MAX_GAIN)).toBeCloseTo(1, 10);
  });

  it("is monotonic across the whole travel", () => {
    let prev = posToGain(0);
    for (let p = 0.01; p <= 1.0001; p += 0.01) {
      const g = posToGain(p);
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
  });

  it("round-trips positions through gain", () => {
    for (const p of [0, 0.1, 0.37, 0.79, 0.8, 0.81, 0.9, 0.99, 1]) {
      expect(gainToPos(posToGain(p))).toBeCloseTo(p, 6);
    }
  });

  it("clamps out-of-range positions and gains", () => {
    expect(posToGain(-1)).toBe(0);
    expect(posToGain(2)).toBeCloseTo(MAX_GAIN, 10);
    expect(gainToPos(99)).toBeCloseTo(1, 10);
  });

  it("formats unity as percent and boost as dB", () => {
    expect(formatGain(0)).toBe("0%");
    expect(formatGain(0.85)).toBe("85%");
    expect(formatGain(1)).toBe("100%");
    expect(formatGain(MAX_GAIN)).toBe("+6.0dB");
  });
});
