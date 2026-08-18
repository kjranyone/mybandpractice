/**
 * Granular pitch-shifter AudioWorklet processor.
 *
 * Two read taps sweep a delay line at a rate derived from the pitch ratio,
 * crossfaded with sin/cos windows (constant power). ratio == 1 bypasses
 * the granular path entirely (zero latency, bit-transparent passthrough).
 *
 * Trade-off note: engaged shifting adds ~1.5 x grain latency (~100 ms) —
 * acceptable for practice use, and disabled by default.
 */

const PROCESSOR_NAME = "pitch-shifter";

const PROCESSOR_SOURCE = `
class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'ratio',
      defaultValue: 1,
      minValue: 0.25,
      maxValue: 4,
      automationRate: 'k-rate'
    }];
  }
  constructor() {
    super();
    this.bufSize = 8192;
    this.grain = 3072;
    this.bufL = new Float32Array(this.bufSize);
    this.bufR = new Float32Array(this.bufSize);
    this.w = 0;
    this.phase = 0;
  }
  read(buf, pos) {
    const M = this.bufSize;
    let p = pos;
    while (p < 0) p += M;
    p = p % M;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % M;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const n = output[0].length;
    const ratio = params.ratio[0];
    const bypass = Math.abs(ratio - 1) < 0.0005;
    const g = this.grain;
    const inL = input && input[0];
    const inR = input && input[1];
    const outL = output[0];
    const outR = output[1];
    let w = this.w;
    let phase = this.phase;
    for (let i = 0; i < n; i++) {
      this.bufL[w] = inL ? inL[i] : 0;
      this.bufR[w] = inR ? inR[i] : (inL ? inL[i] : 0);
      if (bypass) {
        outL[i] = this.bufL[w];
        if (outR) outR[i] = this.bufR[w];
      } else {
        const phase2 = (phase + 0.5) % 1;
        const off1 = phase * g;
        const off2 = phase2 * g;
        const w1 = Math.sin(Math.PI * phase);
        const w2 = Math.sin(Math.PI * phase2);
        const base = w - g;
        outL[i] =
          this.read(this.bufL, base - off1) * w1 +
          this.read(this.bufL, base - off2) * w2;
        if (outR) {
          outR[i] =
            this.read(this.bufR, base - off1) * w1 +
            this.read(this.bufR, base - off2) * w2;
        }
      }
      w++;
      if (w >= this.bufSize) w -= this.bufSize;
      phase += (1 - ratio) / g;
      phase = phase % 1;
      if (phase < 0) phase += 1;
    }
    this.w = w;
    this.phase = phase;
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', PitchShifterProcessor);
`;

let blobUrl: string | null = null;
const registeredContexts = new WeakSet<AudioContext>();

/** Register the pitch-shifter worklet module on a context (once per ctx). */
export function registerPitchWorklet(ctx: AudioContext): Promise<void> {
  if (registeredContexts.has(ctx)) return Promise.resolve();
  if (!blobUrl) {
    blobUrl = URL.createObjectURL(
      new Blob([PROCESSOR_SOURCE], { type: "application/javascript" }),
    );
  }
  return ctx.audioWorklet.addModule(blobUrl).then(() => {
    registeredContexts.add(ctx);
  });
}

export function createPitchNode(ctx: AudioContext): AudioWorkletNode {
  return new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
}
