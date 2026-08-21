/**
 * Decode audio data (ArrayBuffer) into an AudioBuffer.
 *
 * First attempts native BaseAudioContext.decodeAudioData (fast path for WAV, MP3, FLAC, Vorbis).
 * If the browser's native decoder fails (e.g. desktop Chrome / Safari rejecting Ogg Opus),
 * falls back to the WebAssembly-based OggOpusDecoderWebWorker (decoding in a dedicated
 * background Web Worker so the main UI and Web Audio rendering threads never experience
 * CPU stalls or audio glitches).
 */
export async function decodeAudioBuffer(
  ctx: BaseAudioContext,
  data: ArrayBuffer,
): Promise<AudioBuffer> {
  // Pass a copy to decodeAudioData because some browsers detach/neuter the ArrayBuffer on failure.
  try {
    const copy = data.slice(0);
    return await ctx.decodeAudioData(copy);
  } catch (nativeErr) {
    try {
      const { OggOpusDecoderWebWorker, OggOpusDecoder } = await import("ogg-opus-decoder");
      const DecoderClass =
        typeof Worker !== "undefined" ? OggOpusDecoderWebWorker : OggOpusDecoder;
      const decoder = new DecoderClass();
      try {
        await decoder.ready;
        const { channelData, samplesDecoded, sampleRate } = await decoder.decodeFile(
          new Uint8Array(data),
        );

        if (samplesDecoded === 0 || channelData.length === 0) {
          throw new Error("Opus decode produced 0 samples");
        }

        const audioBuf = ctx.createBuffer(
          channelData.length,
          samplesDecoded,
          sampleRate,
        );
        for (let ch = 0; ch < channelData.length; ch++) {
          audioBuf.copyToChannel(channelData[ch], ch);
        }
        return audioBuf;
      } finally {
        // Web-worker decoders terminate their worker from free(). Always await
        // it, including readiness/decode failures, so retries cannot leak workers.
        try {
          await decoder.free();
        } catch (freeErr) {
          console.warn("Could not release Ogg Opus decoder", freeErr);
        }
      }
    } catch {
      // Re-throw the original error if both native and WASM decoder fail
      throw nativeErr;
    }
  }
}
