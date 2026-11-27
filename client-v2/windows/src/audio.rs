use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, Stream, StreamConfig};
use mbp_core::Engine;

pub struct Playback {
    pub engine: Engine,
    pub revision: u64,
    pub waveform: Waveform,
    pub compressor: bool,
    pub meters: [f32; 2],
    pub limiter_gain: f32,
}

pub const WAVE_BARS: usize = 64;

pub struct Waveform {
    data: [u8; WAVE_BARS],
    next: usize,
    frames: usize,
    peak: f32,
}

impl Default for Waveform {
    fn default() -> Self {
        Self {
            data: [0; WAVE_BARS],
            next: 0,
            frames: 0,
            peak: 0.0,
        }
    }
}

impl Waveform {
    pub fn values(&self) -> [u8; WAVE_BARS] {
        std::array::from_fn(|index| self.data[(self.next + index) % WAVE_BARS])
    }

    fn push(&mut self, stereo: &[f32], output_rate: u32) {
        let interval = (output_rate / 50).max(1) as usize;
        for frame in stereo.chunks_exact(2) {
            self.peak = self.peak.max(frame[0].abs()).max(frame[1].abs());
            self.frames += 1;
            if self.frames >= interval {
                self.data[self.next] = (self.peak * 255.0) as u8;
                self.next = (self.next + 1) % WAVE_BARS;
                self.frames = 0;
                self.peak = 0.0;
            }
        }
    }
}

pub struct Output {
    _stream: Stream,
    pub error: Arc<Mutex<Option<String>>>,
}

impl Output {
    pub fn open(playback: Arc<Mutex<Playback>>) -> Result<Self, String> {
        let device = cpal::default_host()
            .default_output_device()
            .ok_or("No default audio output device.")?;
        let supported = device.default_output_config().map_err(|e| e.to_string())?;
        let config = supported.config();
        let error = Arc::new(Mutex::new(None));
        let stream = match supported.sample_format() {
            SampleFormat::F32 => build_stream::<f32>(&device, &config, playback, error.clone()),
            SampleFormat::I16 => build_stream::<i16>(&device, &config, playback, error.clone()),
            SampleFormat::U16 => build_stream::<u16>(&device, &config, playback, error.clone()),
            format => return Err(format!("Unsupported output format: {format:?}")),
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(Self {
            _stream: stream,
            error,
        })
    }
}

fn build_stream<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: &StreamConfig,
    playback: Arc<Mutex<Playback>>,
    error: Arc<Mutex<Option<String>>>,
) -> Result<Stream, cpal::BuildStreamError> {
    let channels = usize::from(config.channels);
    let output_rate = config.sample_rate.0;
    let mut stereo = Vec::new();
    let mut resampler = Resampler::default();
    let mut limiter = PeakLimiter::new(output_rate);
    let mut compressor = Compressor::new(output_rate);
    let mut tail_frames = 0;
    let mut revision = None;
    device.build_output_stream(
        config,
        move |output: &mut [T], _| {
            output.fill(T::from_sample(0.0));
            let Ok(mut state) = playback.try_lock() else {
                return;
            };
            if revision != Some(state.revision) {
                resampler.reset();
                limiter.reset();
                compressor.gain = 1.0;
                tail_frames = 0;
                revision = Some(state.revision);
            }
            let playing = state.engine.is_playing();
            if !playing && !(state.engine.ended() && tail_frames > 0) {
                state.meters = [0.0; 2];
                state.limiter_gain = 1.0;
                return;
            }
            stereo.resize(output.len() / channels * 2, 0.0);
            if playing {
                resampler.render(&mut state.engine, output_rate, &mut stereo);
                tail_frames = limiter.delay.len();
            } else {
                stereo.fill(0.0);
                tail_frames = tail_frames.saturating_sub(stereo.len() / 2);
            }
            if state.compressor || compressor.gain < 0.999 {
                compressor.process(&mut stereo, state.compressor);
            } else {
                compressor.gain = 1.0;
            }
            limiter.process(&mut stereo);
            let decay = (-((stereo.len() / 2) as f32) / (output_rate as f32 * 0.25)).exp();
            let mut peak = [0.0_f32; 2];
            for frame in stereo.chunks_exact(2) {
                for channel in 0..2 {
                    peak[channel] = peak[channel].max(frame[channel].abs());
                }
            }
            for (meter, peak) in state.meters.iter_mut().zip(peak) {
                *meter = peak.max(*meter * decay);
            }
            state.limiter_gain = limiter.gain;
            state.waveform.push(&stereo, output_rate);
            drop(state);
            for (frame, samples) in output
                .chunks_exact_mut(channels)
                .zip(stereo.chunks_exact(2))
            {
                if channels == 1 {
                    frame[0] = T::from_sample(((samples[0] + samples[1]) * 0.5).clamp(-1.0, 1.0));
                } else {
                    frame[0] = T::from_sample(samples[0].clamp(-1.0, 1.0));
                    frame[1] = T::from_sample(samples[1].clamp(-1.0, 1.0));
                }
            }
        },
        move |err| {
            if let Ok(mut slot) = error.lock() {
                *slot = Some(err.to_string());
            }
        },
        None,
    )
}

const PEAK_CEILING: f32 = 0.98;

struct Compressor {
    gain: f32,
    attack: f32,
    release: f32,
}

impl Compressor {
    fn new(rate: u32) -> Self {
        Self {
            gain: 1.0,
            attack: smoothing(rate, 0.012),
            release: smoothing(rate, 0.14),
        }
    }

    fn process(&mut self, stereo: &mut [f32], enabled: bool) {
        const THRESHOLD: f32 = 0.158_489_32; // -16 dBFS
        for frame in stereo.chunks_exact_mut(2) {
            let peak = frame[0].abs().max(frame[1].abs());
            let target = if enabled && peak > THRESHOLD {
                (THRESHOLD / peak).powf(2.0 / 3.0)
            } else {
                1.0
            };
            let coefficient = if target < self.gain {
                self.attack
            } else {
                self.release
            };
            self.gain += (target - self.gain) * coefficient;
            for sample in frame {
                *sample *= self.gain;
            }
        }
    }
}

fn smoothing(sample_rate: u32, seconds: f32) -> f32 {
    1.0 - (-1.0_f32 / (sample_rate as f32 * seconds)).exp()
}

struct PeakLimiter {
    delay: Vec<[f32; 2]>,
    peaks: VecDeque<(u64, f32)>,
    position: u64,
    gain: f32,
    attack: f32,
    release: f32,
}

impl PeakLimiter {
    fn new(sample_rate: u32) -> Self {
        let frames = (sample_rate / 200).max(1) as usize;
        Self {
            delay: vec![[0.0; 2]; frames],
            peaks: VecDeque::with_capacity(frames + 1),
            position: 0,
            gain: 1.0,
            attack: smoothing(sample_rate, 0.001),
            release: smoothing(sample_rate, 0.085),
        }
    }

    fn reset(&mut self) {
        self.delay.fill([0.0; 2]);
        self.peaks.clear();
        self.position = 0;
        self.gain = 1.0;
    }

    fn process(&mut self, stereo: &mut [f32]) {
        for frame in stereo.chunks_exact_mut(2) {
            let len = self.delay.len() as u64;
            let slot = (self.position % len) as usize;
            let delayed = std::mem::replace(&mut self.delay[slot], [frame[0], frame[1]]);
            let peak = frame[0].abs().max(frame[1].abs());
            while self
                .peaks
                .front()
                .is_some_and(|&(at, _)| self.position - at > len)
            {
                self.peaks.pop_front();
            }
            while self.peaks.back().is_some_and(|&(_, prior)| prior <= peak) {
                self.peaks.pop_back();
            }
            self.peaks.push_back((self.position, peak));
            let ahead = self.peaks[0].1;
            let target = PEAK_CEILING / ahead.max(PEAK_CEILING);
            let coefficient = if target < self.gain {
                self.attack
            } else {
                self.release
            };
            self.gain += (target - self.gain) * coefficient;
            let current_peak = delayed[0].abs().max(delayed[1].abs());
            self.gain = self.gain.min(PEAK_CEILING / current_peak.max(PEAK_CEILING));
            frame[0] = delayed[0] * self.gain;
            frame[1] = delayed[1] * self.gain;
            self.position += 1;
        }
    }
}

#[derive(Default)]
struct Resampler {
    phase: f64,
    pending: Vec<f32>,
}

impl Resampler {
    fn reset(&mut self) {
        self.phase = 0.0;
        self.pending.clear();
    }

    fn render(&mut self, engine: &mut Engine, output_rate: u32, stereo: &mut [f32]) {
        let rate = engine.sample_rate();
        if rate == output_rate {
            engine.render(stereo);
            return;
        }

        let frames = stereo.len() / 2;
        if frames == 0 {
            return;
        }
        let ratio = f64::from(rate) / f64::from(output_rate);
        let next_phase = self.phase + frames as f64 * ratio;
        let consumed = next_phase.floor() as usize;
        let last = (self.phase + (frames - 1) as f64 * ratio).floor() as usize;
        let needed = consumed.max(last + 2) * 2;
        if self.pending.len() < needed {
            let retained = self.pending.len();
            self.pending.resize(needed, 0.0);
            engine.render(&mut self.pending[retained..]);
        }
        for (index, frame) in stereo.chunks_exact_mut(2).enumerate() {
            let pos = self.phase + index as f64 * ratio;
            let base = pos.floor() as usize * 2;
            let fraction = pos.fract() as f32;
            for (channel, sample) in frame.iter_mut().enumerate() {
                let before = self.pending[base + channel];
                let after = self.pending[base + 2 + channel];
                *sample = before + (after - before) * fraction;
            }
        }
        self.pending.drain(..consumed * 2);
        self.phase = next_phase.fract();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_preserves_quiet_audio_and_limits_both_channels_together() {
        let mut limiter = PeakLimiter::new(48_000);
        let delay = limiter.delay.len();
        let mut stereo = [0.2, -0.1].repeat(delay + 16);
        limiter.process(&mut stereo);
        assert!(stereo[..delay * 2].iter().all(|sample| *sample == 0.0));
        assert_eq!(stereo[delay * 2..delay * 2 + 2], [0.2, -0.1]);

        let mut stereo = [1.9, -0.95].repeat(delay * 3);
        limiter.process(&mut stereo);
        assert!(stereo
            .iter()
            .all(|sample| sample.abs() <= PEAK_CEILING + 1e-6));
        let peak = &stereo[delay * 2..delay * 2 + 2];
        assert!((peak[0] - PEAK_CEILING).abs() < 1e-4);
        assert!((peak[0] + 2.0 * peak[1]).abs() < 1e-6);

        limiter.reset();
        let mut stereo = [0.4, -0.2].repeat(delay + 1);
        limiter.process(&mut stereo);
        assert_eq!(stereo[delay * 2..], [0.4, -0.2]);
    }

    #[test]
    fn resampling_continues_across_callbacks_and_resets_after_a_seek() {
        let mut engine = Engine::new();
        let ramp = (0..4000)
            .flat_map(|index| {
                let value = index as f32 / 4000.0;
                [value, -value]
            })
            .collect();
        engine
            .load_synthetic(48_000, 4000, vec![("vocals".into(), ramp)])
            .unwrap();
        engine.play();

        for output_rate in [44_100, 96_000] {
            let mut resampler = Resampler::default();
            engine.seek(0.0).unwrap();
            for callback in 0..3 {
                let mut output = [0.0; 274];
                resampler.render(&mut engine, output_rate, &mut output);
                for (index, frame) in output.chunks_exact(2).enumerate() {
                    let source_frame =
                        (callback * 137 + index) as f32 * 48_000.0 / output_rate as f32;
                    let expected = source_frame / 4000.0;
                    assert!((frame[0] - expected).abs() < 1e-6);
                    assert!((frame[1] + expected).abs() < 1e-6);
                }
            }
            engine.seek(0.05).unwrap();
            resampler.reset();
            let mut output = [0.0; 2];
            resampler.render(&mut engine, output_rate, &mut output);
            assert!((output[0] - 0.6).abs() < 1e-6);
        }
    }
}
