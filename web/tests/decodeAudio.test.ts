import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAudioBuffer } from "../src/audio/decodeAudio";

const decoderMocks = vi.hoisted(() => ({
  constructSync: vi.fn(),
  constructWorker: vi.fn(),
  ready: vi.fn<() => Promise<void>>(),
  decodeFile: vi.fn(),
  free: vi.fn<() => Promise<void>>(),
}));

vi.mock("ogg-opus-decoder", () => {
  class MockDecoder {
    constructor() {
      decoderMocks.constructSync();
    }

    get ready() {
      return decoderMocks.ready();
    }

    decodeFile(data: Uint8Array) {
      return decoderMocks.decodeFile(data);
    }

    free() {
      return decoderMocks.free();
    }
  }

  class MockWorkerDecoder extends MockDecoder {
    constructor() {
      super();
      decoderMocks.constructWorker();
    }
  }

  return {
    OggOpusDecoder: MockDecoder,
    OggOpusDecoderWebWorker: MockWorkerDecoder,
  };
});

function fakeContext(nativeResult: AudioBuffer | Error) {
  return {
    decodeAudioData: vi.fn(async () => {
      if (nativeResult instanceof Error) throw nativeResult;
      return nativeResult;
    }),
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
      const channelData = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        copyToChannel: vi.fn((src: Float32Array, ch: number) => {
          channelData[ch].set(src);
        }),
        getChannelData: vi.fn((ch: number) => channelData[ch]),
      } as unknown as AudioBuffer;
    }),
  } as unknown as BaseAudioContext;
}

describe("decodeAudioBuffer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    decoderMocks.ready.mockResolvedValue();
    decoderMocks.free.mockResolvedValue();
  });

  it("uses native decodeAudioData when it succeeds", async () => {
    const mockBuffer = { duration: 30, numberOfChannels: 2 } as AudioBuffer;
    const ctx = fakeContext(mockBuffer);

    const result = await decodeAudioBuffer(ctx, new ArrayBuffer(64));

    expect(result).toBe(mockBuffer);
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(decoderMocks.constructSync).not.toHaveBeenCalled();
  });

  it("uses the worker-backed Opus decoder when native decoding fails", async () => {
    vi.stubGlobal("Worker", class Worker {});
    const nativeError = new DOMException("Unable to decode audio data", "EncodingError");
    const ctx = fakeContext(nativeError);
    decoderMocks.decodeFile.mockResolvedValue({
      channelData: [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])],
      samplesDecoded: 2,
      sampleRate: 48000,
    });

    const result = await decodeAudioBuffer(ctx, new ArrayBuffer(64));

    expect(decoderMocks.constructWorker).toHaveBeenCalledTimes(1);
    expect(decoderMocks.decodeFile).toHaveBeenCalledTimes(1);
    expect(decoderMocks.free).toHaveBeenCalledTimes(1);
    expect(result.sampleRate).toBe(48000);
    expect(result.numberOfChannels).toBe(2);
  });

  it("releases the decoder and preserves the native error when fallback decoding fails", async () => {
    vi.stubGlobal("Worker", class Worker {});
    const nativeError = new DOMException("Unable to decode audio data", "EncodingError");
    const ctx = fakeContext(nativeError);
    decoderMocks.decodeFile.mockRejectedValue(new Error("corrupt opus"));

    await expect(decodeAudioBuffer(ctx, new ArrayBuffer(64))).rejects.toBe(nativeError);
    expect(decoderMocks.free).toHaveBeenCalledTimes(1);
  });
});
