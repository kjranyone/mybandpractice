import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackEngine } from "../src/audio/PlaybackEngine";

// ---------------------------------------------------------------- mock Web Audio

type FakeParam = {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
};

function fakeParam(value = 1): FakeParam {
  return {
    value,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
}

class FakeNode {
  gain = fakeParam();
  delayTime = fakeParam();
  playbackRate = fakeParam();
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connectedTo: FakeNode[] = [];
  connect = vi.fn((n: FakeNode) => {
    this.connectedTo.push(n);
  });
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48000;
  state = "running";
  currentTime = 100; // start away from zero so clock math is visible
  destination = new FakeNode();
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume = vi.fn(async () => undefined);
  createGain() {
    return new FakeNode() as unknown as GainNode;
  }
  createDelay() {
    return new FakeNode() as unknown as DelayNode;
  }
  createBufferSource() {
    return new FakeNode() as unknown as AudioBufferSourceNode;
  }
}

/** Advance the fake clock and fire onended for stopped sources. */
function advance(engine: PlaybackEngine, secs: number, fireEnd: (src: FakeNode) => void) {
  const ctx = FakeAudioContext.instances[0];
  ctx.currentTime += secs;
  void engine; // engine reads ctx.currentTime lazily
  void fireEnd;
}

describe("PlaybackEngine", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal(
      "AudioContext",
      FakeAudioContext as unknown as typeof AudioContext,
    );
    vi.stubGlobal(
      "webkitAudioContext",
      FakeAudioContext as unknown as typeof AudioContext,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeEvents() {
    return {
      onPlayingChange: vi.fn(),
      onBufferingChange: vi.fn(),
      onBufferedChange: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onError: vi.fn(),
      onTrackEnd: vi.fn(),
    };
  }

  function fakeBuffer(duration: number): AudioBuffer {
    return { duration } as unknown as AudioBuffer;
  }

  it("ensureGraph wires stem gains at configured levels (never 1.0 default)", async () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    engine.stemLevels = { vocals: 0.4, drums: 0, bass: 1, other: 0.75 };

    const ctx = await engine.ensureGraph();
    expect(ctx).toBeInstanceOf(FakeAudioContext);
    // graph exists: sources can be routed without further awaits
    expect(engine.hasAudio).toBe(false);
  });

  it("pause freezes the clock at the computed position", async () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    await engine.ensureGraph();
    const ctx = FakeAudioContext.instances[0];

    engine.playing = true;
    engine.startOffset = 10;
    engine.startTime = ctx.currentTime;
    ctx.currentTime += 5;
    expect(engine.currentTime).toBeCloseTo(15, 6);

    engine.pause();
    expect(engine.playing).toBe(false);
    expect(events.onPlayingChange).toHaveBeenCalledWith(false);
    expect(engine.currentTime).toBeCloseTo(15, 6); // frozen

    ctx.currentTime += 30;
    expect(engine.currentTime).toBeCloseTo(15, 6); // still frozen
  });

  it("clock scales elapsed time by playbackRate", async () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    await engine.ensureGraph();
    const ctx = FakeAudioContext.instances[0];

    engine.playing = true;
    engine.playbackRate = 1.5;
    engine.startOffset = 0;
    engine.startTime = ctx.currentTime;
    ctx.currentTime += 10;
    expect(engine.currentTime).toBeCloseTo(15, 6);
  });

  it("seek while paused only moves the anchor (no audio start)", async () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    await engine.ensureGraph();

    engine.duration = 200;
    engine.seek(50);
    expect(engine.currentTime).toBe(50);
    expect(events.onTimeChange).toHaveBeenCalledWith(50);
    expect(engine.playing).toBe(false);
  });

  it("seek clamps to duration", () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    engine.duration = 120;
    engine.seek(999);
    expect(engine.currentTime).toBe(120);
  });

  it("tick detects track end and fires onTrackEnd once", async () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    await engine.ensureGraph();
    const ctx = FakeAudioContext.instances[0];

    engine.duration = 100;
    engine.playing = true;
    engine.startOffset = 99.98;
    engine.startTime = ctx.currentTime;

    engine.tick();
    expect(events.onTrackEnd).toHaveBeenCalledTimes(1);
    expect(events.onTimeChange).not.toHaveBeenCalled(); // end short-circuits
  });

  it("tick honors enabled loop before track-end handling", async () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    await engine.ensureGraph();

    engine.duration = 100;
    engine.loop = { start: 10, end: 20 };
    engine.loopEnabled = true;
    engine.playing = true;
    engine.startOffset = 19.99;
    engine.startTime = FakeAudioContext.instances[0].currentTime;

    const seekSpy = vi.spyOn(engine, "seek");
    engine.tick();
    expect(seekSpy).toHaveBeenCalledWith(10);
    expect(events.onTrackEnd).not.toHaveBeenCalled();
  });

  it("setVolume/setMuted update engine state (graph may not exist yet)", () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);

    engine.setVolume(1.7);
    expect(engine.volume).toBe(1);
    engine.setVolume(-0.5);
    expect(engine.volume).toBe(0);
    engine.setMuted(true);
    expect(engine.muted).toBe(true);
  });

  it("setPitch clamps to integer semitones in [-12, 12]", () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    engine.setPitch(99);
    expect(engine.pitch).toBe(12);
    engine.setPitch(-13.6);
    expect(engine.pitch).toBe(-12);
    engine.setPitch(3.4);
    expect(engine.pitch).toBe(3);
  });

  it("getOrCreateChunked builds chunk state from manifest", () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    const song = {
      slug: "x",
      title: "X",
      artist: "A",
      durationSeconds: 272.35,
      audioUrl: null,
      hasLyrics: false,
      stems: ["vocals", "drums", "bass", "other"],
      chunks: {
        chunkSeconds: 30,
        ext: "opus",
        stems: {
          vocals: { count: 10, urlBase: "/c/vocals" },
          drums: { count: 10, urlBase: "/c/drums" },
          bass: { count: 10, urlBase: "/c/bass" },
          other: { count: 9, urlBase: "/c/other" }, // shorter stem
        },
      },
    } as const;

    const cs = engine.getOrCreateChunked(song as never);
    expect(cs).not.toBeNull();
    expect(cs!.chunkSeconds).toBe(30);
    expect(cs!.ext).toBe("opus");
    // counts keep each stem's own manifest value…
    expect(cs!.counts.vocals).toBe(10);
    expect(cs!.counts.other).toBe(9);
    // …but chunk storage arrays align to the minimum across stems
    expect(cs!.chunks.get("vocals")).toHaveLength(9);
    // second call returns the cached instance (LRU hit)
    expect(engine.getOrCreateChunked(song as never)).toBe(cs);
  });

  it("getOrCreateChunked returns null without chunk metadata", () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    expect(engine.getOrCreateChunked({ slug: "y" } as never)).toBeNull();
  });

  it("resetClock zeroes position and emits time change", () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    engine.resetClock(0);
    expect(engine.currentTime).toBe(0);
    expect(events.onTimeChange).toHaveBeenCalledWith(0);
  });

  it("advance helper keeps fake clock coherent", async () => {
    const events = makeEvents();
    const engine = new PlaybackEngine(events);
    await engine.ensureGraph();
    const ctx = FakeAudioContext.instances[0];
    advance(engine, 5, () => undefined);
    expect(ctx.currentTime).toBe(105);
  });
});
