//! Granular pitch shifter, matching `web/src/audio/pitchWorklet.ts`.
//!
//! Two read taps sweep a delay line and crossfade with sin windows.
//! `ratio == 1` writes the current sample with no delay.
//! An engaged shift adds about 1.5 grains of latency.

const BUF: usize = 8192;
const GRAIN: f64 = 3072.0;

/// Delay that time-aligns drums with the shifter: `(1.5 * grain + 128)` samples.
pub const DRUM_ALIGN_SAMPLES: usize = (1.5 * GRAIN + 128.0) as usize;

pub struct PitchShifter {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    w: usize,
    phase: f64,
}

impl PitchShifter {
    pub fn new() -> Self {
        Self {
            buf_l: vec![0.0; BUF],
            buf_r: vec![0.0; BUF],
            w: 0,
            phase: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.w = 0;
        self.phase = 0.0;
    }

    /// `ratio` is the playback-rate-compensated pitch: `2^(semitones/12) / rate`.
    pub fn process(&mut self, left: f32, right: f32, ratio: f64) -> (f32, f32) {
        let w = self.w;
        self.buf_l[w] = left;
        self.buf_r[w] = right;
        let bypass = (ratio - 1.0).abs() < 0.0005;
        let out = if bypass {
            (self.buf_l[w], self.buf_r[w])
        } else {
            let phase2 = (self.phase + 0.5).rem_euclid(1.0);
            let off1 = self.phase * GRAIN;
            let off2 = phase2 * GRAIN;
            let w1 = (std::f64::consts::PI * self.phase).sin() as f32;
            let w2 = (std::f64::consts::PI * phase2).sin() as f32;
            let base = w as f64 - GRAIN;
            (
                read(&self.buf_l, base - off1) * w1 + read(&self.buf_l, base - off2) * w2,
                read(&self.buf_r, base - off1) * w1 + read(&self.buf_r, base - off2) * w2,
            )
        };
        self.w = if w + 1 >= BUF { 0 } else { w + 1 };
        self.phase = (self.phase + (1.0 - ratio) / GRAIN).rem_euclid(1.0);
        out
    }
}

impl Default for PitchShifter {
    fn default() -> Self {
        Self::new()
    }
}

fn read(buf: &[f32], pos: f64) -> f32 {
    let p = pos.rem_euclid(BUF as f64);
    let i0 = p.floor() as usize;
    let frac = (p - i0 as f64) as f32;
    let i1 = (i0 + 1) % BUF;
    buf[i0] * (1.0 - frac) + buf[i1] * frac
}

/// Fixed delay used so unshifted drums stay aligned with the shifter.
pub struct SampleDelay {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    w: usize,
}

impl SampleDelay {
    pub fn new(samples: usize) -> Self {
        let n = samples.max(1);
        Self {
            buf_l: vec![0.0; n],
            buf_r: vec![0.0; n],
            w: 0,
        }
    }

    pub fn reset(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.w = 0;
    }

    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        let out = (self.buf_l[self.w], self.buf_r[self.w]);
        self.buf_l[self.w] = left;
        self.buf_r[self.w] = right;
        self.w += 1;
        if self.w >= self.buf_l.len() {
            self.w = 0;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_one_is_bit_transparent() {
        let mut shifter = PitchShifter::new();
        for i in 0..200 {
            let s = (i as f32 * 0.17).sin();
            let (l, r) = shifter.process(s, -s, 1.0);
            assert!((l - s).abs() < 1e-6, "left {l} != {s}");
            assert!((r + s).abs() < 1e-6, "right {r} != {}", -s);
        }
    }

    #[test]
    fn octave_up_doubles_zero_crossings() {
        let mut shifter = PitchShifter::new();
        let period = 80.0;
        let n = 8_000;
        let mut out = vec![0.0f32; n];
        for i in 0..n {
            let s = (i as f64 / period * std::f64::consts::TAU).sin() as f32;
            out[i] = shifter.process(s, s, 2.0).0;
        }
        let slow = crossings_of_sine(period, 4_500, 7_000);
        let fast = crossings(&out, 4_500, 7_000);
        assert!(
            fast > slow + slow / 3,
            "octave shift crossings {fast}, unshifted would be {slow}"
        );
    }

    fn crossings(samples: &[f32], start: usize, end: usize) -> i32 {
        let mut n = 0;
        let mut prev = samples[start];
        for sample in samples.iter().take(end).skip(start + 1) {
            if (prev < 0.0 && *sample >= 0.0) || (prev >= 0.0 && *sample < 0.0) {
                n += 1;
            }
            prev = *sample;
        }
        n
    }

    fn crossings_of_sine(period: f64, start: usize, end: usize) -> i32 {
        let mut buf = vec![0.0f32; end];
        for (i, sample) in buf.iter_mut().enumerate().take(end) {
            *sample = (i as f64 / period * std::f64::consts::TAU).sin() as f32;
        }
        crossings(&buf, start, end)
    }
}
