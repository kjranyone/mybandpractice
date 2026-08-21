import { describe, expect, it } from "vitest";
import {
  chunkUrl,
  effectiveRowDuration,
  locateChunk,
  parseChunkManifest,
  rowWallDuration,
} from "../src/audio/chunkMath";

describe("locateChunk", () => {
  const CS = 30;
  it("maps t=0 to chunk 0", () => {
    expect(locateChunk(0, CS, 10)).toEqual({ idx: 0, intra: 0 });
  });
  it("maps exact boundaries to the next chunk start", () => {
    expect(locateChunk(30, CS, 10)).toEqual({ idx: 1, intra: 0 });
    expect(locateChunk(90, CS, 10)).toEqual({ idx: 3, intra: 0 });
  });
  it("computes intra-chunk offsets", () => {
    expect(locateChunk(75.5, CS, 10)).toEqual({ idx: 2, intra: 15.5 });
  });
  it("clamps negative offsets to zero", () => {
    expect(locateChunk(-5, CS, 10)).toEqual({ idx: 0, intra: 0 });
  });
  it("clamps offsets beyond the last chunk into the final chunk", () => {
    const { idx, intra } = locateChunk(950, CS, 10);
    expect(idx).toBe(9);
    expect(intra).toBeGreaterThan(0);
  });
  it("honors song duration shorter than chunk grid", () => {
    // 272s song: 10 chunks x 30s = 300s grid; seek to 280s must clamp
    const { idx, intra } = locateChunk(280, CS, 10, 272.35);
    expect(idx).toBe(9);
    expect(intra).toBeLessThanOrEqual(272.35 - 9 * CS + 1e-9);
  });
  it("handles sub-second chunk sizes", () => {
    const { idx, intra } = locateChunk(1.2, 0.5, 4);
    expect(idx).toBe(2);
    expect(intra).toBeCloseTo(0.2, 9);
  });
});

describe("effectiveRowDuration", () => {
  it("passes through nominal 30s decodes", () => {
    expect(effectiveRowDuration(30.0, 30)).toBeCloseTo(30.0, 9);
  });
  it("clamps Opus end padding to the nominal boundary", () => {
    expect(effectiveRowDuration(30.0065, 30)).toBeCloseTo(30.001, 9);
  });
  it("keeps a short final chunk as-is", () => {
    expect(effectiveRowDuration(2.32, 30)).toBeCloseTo(2.32, 9);
  });
});

describe("rowWallDuration", () => {
  it("full row at rate 1", () => {
    expect(rowWallDuration(30, 0, 1)).toBeCloseTo(30, 9);
  });
  it("intra offset shortens the wall duration", () => {
    expect(rowWallDuration(30, 10, 1)).toBeCloseTo(20, 9);
  });
  it("rate 2x halves the wall duration", () => {
    expect(rowWallDuration(30, 0, 2)).toBeCloseTo(15, 9);
  });
  it("floors at 50ms for boundary-adjacent seeks", () => {
    expect(rowWallDuration(30, 30, 1)).toBeCloseTo(0.05, 9);
  });
  it("guards against zero/negative rates", () => {
    expect(rowWallDuration(30, 0, 0)).toBeCloseTo(30, 9);
  });
});

describe("chunkUrl", () => {
  it("zero-pads indices to 5 digits with manifest ext", () => {
    expect(chunkUrl("/b", 0, "opus")).toBe("/b/00000.opus");
    expect(chunkUrl("/b", 123, "opus")).toBe("/b/00123.opus");
  });
  it("defaults to flac for legacy manifests", () => {
    expect(chunkUrl("/b", 7)).toBe("/b/00007.flac");
  });
});

describe("parseChunkManifest", () => {
  const valid = {
    chunkSeconds: 30,
    ext: "opus",
    stems: { vocals: { count: 10 }, bass: { count: 10 } },
  };

  it("parses a valid manifest", () => {
    const m = parseChunkManifest(valid);
    expect(m).not.toBeNull();
    expect(m!.chunkSeconds).toBe(30);
    expect(m!.ext).toBe("opus");
    expect(Object.keys(m!.stems)).toEqual(["vocals", "bass"]);
  });

  it("rejects out-of-bounds chunk seconds", () => {
    expect(parseChunkManifest({ ...valid, chunkSeconds: 4 })).toBeNull();
    expect(parseChunkManifest({ ...valid, chunkSeconds: 121 })).toBeNull();
  });

  it("defaults unknown ext to flac", () => {
    const m = parseChunkManifest({ ...valid, ext: "mp3" });
    expect(m?.ext).toBe("flac");
  });

  it("drops stems with invalid counts", () => {
    const m = parseChunkManifest({
      ...valid,
      stems: { vocals: { count: 10 }, bad: { count: 0 }, worse: { count: 1.5 } },
    });
    expect(Object.keys(m!.stems)).toEqual(["vocals"]);
  });

  it("rejects empty stem sets", () => {
    expect(parseChunkManifest({ ...valid, stems: {} })).toBeNull();
    expect(
      parseChunkManifest({ ...valid, stems: { x: { count: -1 } } }),
    ).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseChunkManifest(null)).toBeNull();
    expect(parseChunkManifest("x")).toBeNull();
    expect(parseChunkManifest(42)).toBeNull();
  });
});
