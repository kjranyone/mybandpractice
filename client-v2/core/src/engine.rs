//! Transport and mix. `render` only reads PCM that is already decoded.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::pitch::{PitchShifter, SampleDelay, DRUM_ALIGN_SAMPLES};
use crate::song::{ChunkPcm, Song};
use crate::CoreError;

/// +6 dB, same ceiling as `web/src/audio/gain.ts`.
pub const MAX_GAIN: f32 = 1.995_262_3;
pub const RAMP_SECONDS: f64 = 0.02;
const PREFETCH_LEAD_SECONDS: f64 = 8.0;

#[derive(Clone, Copy)]
pub struct StemGain {
    pub current: f32,
    pub target: f32,
}

impl Default for StemGain {
    fn default() -> Self {
        Self {
            current: 1.0,
            target: 1.0,
        }
    }
}

struct Transport {
    position: u64,
    /// Fractional source frame in `[0, 1)`. Song time is `position + pos_frac`.
    pos_frac: f64,
    /// Tape speed. 1 keeps the original tempo. Pitch is compensated separately.
    rate: f64,
    /// Semitones. Heard pitch is `2^(pitch/12)` and does not follow `rate`.
    pitch: i32,
    playing: bool,
    buffering: bool,
    ended: bool,
    gains: HashMap<String, StemGain>,
    master: StemGain,
    last_error: Option<String>,
    shifter: PitchShifter,
    drum_delay: SampleDelay,
}

impl Transport {
    fn new() -> Self {
        let mut gains = HashMap::new();
        for name in ["vocals", "drums", "bass", "other"] {
            gains.insert(name.to_string(), StemGain::default());
        }
        Self {
            position: 0,
            pos_frac: 0.0,
            rate: 1.0,
            pitch: 0,
            playing: false,
            buffering: false,
            ended: false,
            gains,
            master: StemGain::default(),
            last_error: None,
            shifter: PitchShifter::new(),
            drum_delay: SampleDelay::new(DRUM_ALIGN_SAMPLES),
        }
    }

    fn snap_gains(&mut self) {
        for gain in self.gains.values_mut() {
            gain.current = gain.target;
        }
        self.master.current = self.master.target;
    }
}

struct Shared {
    song: Mutex<Option<Arc<Song>>>,
    transport: Mutex<Transport>,
    shutdown: std::sync::atomic::AtomicBool,
}

pub struct Engine {
    shared: Arc<Shared>,
    prefetch: Option<JoinHandle<()>>,
    prefetch_thread: thread::Thread,
}

impl Engine {
    pub fn new() -> Self {
        let shared = Arc::new(Shared {
            song: Mutex::new(None),
            transport: Mutex::new(Transport::new()),
            shutdown: std::sync::atomic::AtomicBool::new(false),
        });
        let thread_shared = Arc::clone(&shared);
        let prefetch = thread::Builder::new()
            .name("mbp-prefetch".into())
            .spawn(move || prefetch_loop(thread_shared))
            .expect("prefetch thread");
        let prefetch_thread = prefetch.thread().clone();
        Self {
            shared,
            prefetch: Some(prefetch),
            prefetch_thread,
        }
    }

    pub fn load_chunks_dir(&mut self, path: &Path) -> Result<(), CoreError> {
        let song = Song::open(path)?;
        self.install(song)
    }

    pub fn load_synthetic(
        &mut self,
        sample_rate: u32,
        chunk_frames: usize,
        stems: Vec<(String, Vec<f32>)>,
    ) -> Result<(), CoreError> {
        let song = Song::from_synthetic(sample_rate, chunk_frames, stems)?;
        self.install(song)
    }

    fn install(&mut self, song: Arc<Song>) -> Result<(), CoreError> {
        {
            let mut transport = self.transport();
            *transport = Transport::new();
            for stem in &song.stems {
                transport.gains.entry(stem.clone()).or_default();
            }
        }
        *self.shared.song.lock().unwrap_or_else(|e| e.into_inner()) = Some(song);
        self.prefetch_thread.unpark();
        Ok(())
    }

    pub fn play(&mut self) {
        let song = self.song();
        let mut transport = self.transport();
        if let Some(song) = song.as_ref() {
            let dur = song.duration_frames();
            if dur > 0 && transport.position >= dur {
                transport.position = 0;
            }
        }
        transport.playing = song.is_some();
        transport.ended = false;
        transport.snap_gains();
    }

    pub fn pause(&mut self) {
        self.transport().playing = false;
    }

    pub fn seek(&mut self, seconds: f64) -> Result<(), CoreError> {
        let song = self.song().ok_or(CoreError::NotLoaded)?;
        let dur = song.duration_frames();
        let rate = song.sample_rate as f64;
        let frame = if dur == 0 {
            0
        } else {
            ((seconds.max(0.0) * rate).round() as u64).min(dur - 1)
        };
        {
            let mut transport = self.transport();
            transport.position = frame;
            transport.pos_frac = 0.0;
            transport.ended = false;
            transport.buffering = true;
            transport.snap_gains();
            transport.last_error = None;
            transport.shifter.reset();
            transport.drum_delay.reset();
        }
        let idx = frame / song.chunk_frames as u64;
        let result = song.decode_chunk(idx as u32);
        let mut transport = self.transport();
        transport.buffering = false;
        if let Err(ref err) = result {
            transport.last_error = Some(err.to_string());
            transport.playing = false;
        }
        result
    }

    pub fn set_stem_gain(&mut self, stem: &str, gain: f32) -> bool {
        let mut transport = self.transport();
        let playing = transport.playing;
        let Some(slot) = transport.gains.get_mut(stem) else {
            return false;
        };
        slot.target = gain.clamp(0.0, MAX_GAIN);
        if !playing {
            slot.current = slot.target;
        }
        true
    }

    pub fn set_master_gain(&mut self, gain: f32) {
        let mut transport = self.transport();
        transport.master.target = gain.clamp(0.0, MAX_GAIN);
        if !transport.playing {
            transport.master.current = transport.master.target;
        }
    }

    /// Tape speed. The source is read at this rate, then the granular shifter
    /// puts the heard pitch back to `2^(semitones/12)`. Same contract as
    /// `PlaybackEngine.setPlaybackRate` plus the pitch worklet.
    pub fn set_playback_rate(&mut self, rate: f64) {
        self.transport().rate = rate.clamp(0.25, 2.0);
    }

    pub fn set_pitch(&mut self, semitones: i32) {
        self.transport().pitch = semitones.clamp(-12, 12);
    }

    pub fn playback_rate(&self) -> f64 {
        self.transport().rate
    }

    pub fn pitch(&self) -> i32 {
        self.transport().pitch
    }

    pub fn stem_gain(&self, stem: &str) -> f32 {
        self.transport()
            .gains
            .get(stem)
            .map(|g| g.target)
            .unwrap_or(0.0)
    }

    pub fn stem_names(&self) -> Vec<String> {
        self.song().map_or_else(Vec::new, |song| song.stems.clone())
    }

    pub fn cached_pcm_bytes(&self) -> usize {
        self.song().map_or(0, |song| song.cached_pcm_bytes())
    }

    pub fn master_gain(&self) -> f32 {
        self.transport().master.target
    }

    pub fn position(&self) -> f64 {
        let song = self.song();
        let sample_rate = song.as_ref().map(|s| s.sample_rate).unwrap_or(48_000) as f64;
        let transport = self.transport();
        (transport.position as f64 + transport.pos_frac) / sample_rate
    }

    pub fn duration(&self) -> f64 {
        let Some(song) = self.song() else {
            return 0.0;
        };
        song.duration_frames() as f64 / song.sample_rate as f64
    }

    pub fn is_playing(&self) -> bool {
        self.transport().playing
    }

    pub fn is_buffering(&self) -> bool {
        self.transport().buffering
    }

    pub fn ended(&self) -> bool {
        self.transport().ended
    }

    pub fn last_error(&self) -> Option<String> {
        self.transport().last_error.clone()
    }

    pub fn sample_rate(&self) -> u32 {
        self.song().map(|s| s.sample_rate).unwrap_or(48_000)
    }

    pub fn chunk_seconds(&self) -> f64 {
        self.song().map(|s| s.chunk_seconds).unwrap_or(0.0)
    }

    pub fn title(&self) -> String {
        self.song().map(|s| s.title.clone()).unwrap_or_default()
    }

    pub fn slug(&self) -> String {
        self.song().map(|s| s.slug.clone()).unwrap_or_default()
    }

    pub fn chunk_file(&self, stem: &str, idx: u32) -> Option<std::path::PathBuf> {
        let song = self.song()?;
        if !song.stems.iter().any(|s| s == stem) || idx >= song.chunk_count {
            return None;
        }
        Some(song.chunk_path(stem, idx))
    }

    /// Fill `out` with interleaved stereo frames at the song rate.
    /// A missing chunk becomes silence and is requested from the prefetch thread.
    pub fn render(&mut self, out: &mut [f32]) {
        out.fill(0.0);
        let song = match self.song() {
            Some(song) => song,
            None => return,
        };
        let mut transport = self.transport();
        if !transport.playing {
            return;
        }
        if transport.pitch != 0 || (transport.rate - 1.0).abs() > 1e-4 {
            render_shaped(&song, &mut transport, out, &self.prefetch_thread);
            return;
        }
        let channels = 2usize;
        let frames = out.len() / channels;
        let chunk_frames = song.chunk_frames as u64;
        let duration = song.duration_frames();
        let ramp_samples = (song.sample_rate as f64 * RAMP_SECONDS).max(1.0) as f32;
        let lead = (song.sample_rate as f64 * PREFETCH_LEAD_SECONDS) as u64;

        let mut wrote = 0usize;
        while wrote < frames {
            if transport.position >= duration {
                transport.playing = false;
                transport.ended = true;
                transport.position = duration;
                break;
            }
            let idx = (transport.position / chunk_frames) as u32;
            if idx >= song.chunk_count {
                transport.playing = false;
                transport.ended = true;
                break;
            }
            if !song.ready(idx) {
                transport.buffering = true;
                song.wanted.store(idx, Ordering::Relaxed);
                self.prefetch_thread.unpark();
                break;
            }
            transport.buffering = false;
            let intra = (transport.position % chunk_frames) as usize;
            let mut available = usize::MAX;
            let mut chunks = Vec::with_capacity(song.stems.len());
            for si in 0..song.stems.len() {
                match song.chunk(si, idx) {
                    Some(chunk) => {
                        available = available.min(chunk.frames.saturating_sub(intra));
                        chunks.push(chunk);
                    }
                    None => {
                        available = 0;
                        break;
                    }
                }
            }
            if available == 0 || chunks.len() != song.stems.len() {
                transport.buffering = true;
                song.wanted.store(idx, Ordering::Relaxed);
                self.prefetch_thread.unpark();
                break;
            }
            let remain_song = (duration - transport.position) as usize;
            let n = available.min(frames - wrote).min(remain_song);
            if n == 0 {
                transport.playing = false;
                transport.ended = true;
                break;
            }
            for frame in 0..n {
                let master = advance(&mut transport.master, ramp_samples);
                let mut left = 0.0f32;
                let mut right = 0.0f32;
                for (si, name) in song.stems.iter().enumerate() {
                    let gain = transport
                        .gains
                        .get_mut(name)
                        .map(|g| advance(g, ramp_samples))
                        .unwrap_or(0.0);
                    let base = (intra + frame) * channels;
                    let g = gain * master;
                    left += chunks[si].samples[base] * g;
                    right += chunks[si].samples[base + 1] * g;
                }
                let o = (wrote + frame) * channels;
                out[o] = left;
                out[o + 1] = right;
            }
            wrote += n;
            transport.position += n as u64;

            let pos_in_chunk = transport.position % chunk_frames;
            let remain = chunk_frames.saturating_sub(pos_in_chunk);
            let next = idx.saturating_add(1);
            if next < song.chunk_count && remain < lead && !song.ready(next) {
                song.wanted.store(next, Ordering::Relaxed);
                self.prefetch_thread.unpark();
            }
        }
    }

    fn song(&self) -> Option<Arc<Song>> {
        self.shared
            .song
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn transport(&self) -> std::sync::MutexGuard<'_, Transport> {
        self.shared
            .transport
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Release);
        self.prefetch_thread.unpark();
        if let Some(handle) = self.prefetch.take() {
            let _ = handle.join();
        }
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

/// Varispeed read plus the granular shifter.
///
/// Source time advances by `rate` per output frame (the playhead stays in
/// song time). The shifter ratio is `2^(semitones/12) / rate`, so a tempo
/// change does not change the heard pitch. A pure pitch change leaves drums
/// unshifted and delays them to match the shifter latency.
fn render_shaped(
    song: &Song,
    transport: &mut Transport,
    out: &mut [f32],
    prefetch: &std::thread::Thread,
) {
    let channels = 2usize;
    let frames = out.len() / channels;
    if frames == 0 {
        return;
    }
    let chunk_frames = song.chunk_frames as u64;
    let duration = song.duration_frames();
    let ramp_samples = (song.sample_rate as f64 * RAMP_SECONDS).max(1.0) as f32;
    let step = transport.rate;
    let ratio = 2.0_f64.powf(transport.pitch as f64 / 12.0) / transport.rate;
    let drums_dry = transport.pitch != 0 && (transport.rate - 1.0).abs() <= 1e-4;
    let drum_at = song.stems.iter().position(|name| name == "drums");
    let mut cursor = transport.position as f64 + transport.pos_frac;
    let mut wrote = 0usize;
    let lead = (song.sample_rate as f64 * PREFETCH_LEAD_SECONDS) as u64;

    while wrote < frames {
        if cursor >= duration as f64 {
            transport.playing = false;
            transport.ended = true;
            cursor = duration as f64;
            break;
        }
        let frame = cursor.floor() as u64;
        let frac = (cursor - frame as f64) as f32;
        let next = frame.saturating_add(1);
        let need_next = frac > 1.0e-5 && next < duration;
        let missing_frame = if !frames_ready(song, frame) {
            Some(frame)
        } else if need_next && !frames_ready(song, next) {
            Some(next)
        } else {
            None
        };
        if let Some(missing) = missing_frame {
            transport.buffering = true;
            let idx = (missing / chunk_frames) as u32;
            song.wanted.store(idx, Ordering::Relaxed);
            prefetch.unpark();
            break;
        }
        transport.buffering = false;
        let master = advance(&mut transport.master, ramp_samples);
        let mut wet_l = 0.0f32;
        let mut wet_r = 0.0f32;
        let mut dry_l = 0.0f32;
        let mut dry_r = 0.0f32;
        for (si, name) in song.stems.iter().enumerate() {
            let (a_l, a_r) = read_frame(song, si, frame);
            let (b_l, b_r) = if need_next {
                read_frame(song, si, next)
            } else {
                (a_l, a_r)
            };
            let sample_l = a_l + (b_l - a_l) * frac;
            let sample_r = a_r + (b_r - a_r) * frac;
            let gain = transport
                .gains
                .get_mut(name)
                .map(|g| advance(g, ramp_samples))
                .unwrap_or(0.0)
                * master;
            if drums_dry && Some(si) == drum_at {
                dry_l += sample_l * gain;
                dry_r += sample_r * gain;
            } else {
                wet_l += sample_l * gain;
                wet_r += sample_r * gain;
            }
        }
        let (shifted_l, shifted_r) = transport.shifter.process(wet_l, wet_r, ratio);
        let (delayed_l, delayed_r) = if drums_dry {
            transport.drum_delay.process(dry_l, dry_r)
        } else {
            (0.0, 0.0)
        };
        let o = wrote * channels;
        out[o] = shifted_l + delayed_l;
        out[o + 1] = shifted_r + delayed_r;
        cursor += step;
        wrote += 1;

        if wrote % 64 == 0 {
            let ahead = (cursor as u64).saturating_add(lead);
            let ahead_idx = (ahead / chunk_frames) as u32;
            if ahead_idx < song.chunk_count && !song.ready(ahead_idx) {
                song.wanted.store(ahead_idx, Ordering::Relaxed);
                prefetch.unpark();
            }
        }
    }

    if cursor >= duration as f64 {
        transport.position = duration;
        transport.pos_frac = 0.0;
        transport.playing = false;
        transport.ended = true;
    } else {
        transport.position = cursor.floor() as u64;
        transport.pos_frac = cursor - transport.position as f64;
    }
}

fn frames_ready(song: &Song, frame: u64) -> bool {
    if frame >= song.duration_frames() {
        return true;
    }
    let idx = (frame / song.chunk_frames as u64) as u32;
    idx < song.chunk_count && song.ready(idx)
}

fn read_frame(song: &Song, stem: usize, frame: u64) -> (f32, f32) {
    if frame >= song.duration_frames() {
        return (0.0, 0.0);
    }
    let chunk_frames = song.chunk_frames as u64;
    let idx = (frame / chunk_frames) as u32;
    let intra = (frame % chunk_frames) as usize;
    let Some(chunk) = song.chunk(stem, idx) else {
        return (0.0, 0.0);
    };
    sample_chunk(&chunk, intra)
}

fn sample_chunk(chunk: &ChunkPcm, intra: usize) -> (f32, f32) {
    if intra >= chunk.frames {
        return (0.0, 0.0);
    }
    let base = intra * 2;
    if base + 1 >= chunk.samples.len() {
        return (0.0, 0.0);
    }
    (chunk.samples[base], chunk.samples[base + 1])
}

fn advance(gain: &mut StemGain, ramp_samples: f32) -> f32 {
    let diff = gain.target - gain.current;
    let step = 1.0 / ramp_samples;
    if diff.abs() <= step {
        gain.current = gain.target;
    } else {
        gain.current += diff.signum() * step;
    }
    gain.current
}

fn prefetch_loop(shared: Arc<Shared>) {
    while !shared.shutdown.load(Ordering::Acquire) {
        let song = shared
            .song
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(song) = song {
            let idx = song.wanted.load(Ordering::Relaxed);
            if idx != u32::MAX && !song.ready(idx) {
                if let Err(err) = song.decode_chunk(idx) {
                    shared
                        .transport
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .last_error = Some(err.to_string());
                }
                continue;
            }
        }
        thread::park_timeout(Duration::from_millis(40));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, value: f32) -> Vec<f32> {
        vec![value; frames * 2]
    }

    #[test]
    fn mute_is_applied_from_the_first_sample() {
        let mut engine = Engine::new();
        engine
            .load_synthetic(48_000, 48_000, vec![("vocals".into(), tone(1000, 1.0))])
            .unwrap();
        assert!(engine.set_stem_gain("vocals", 0.0));
        engine.play();
        let mut out = [0.0f32; 4];
        engine.render(&mut out);
        assert!(
            out.iter().all(|s| s.abs() < 1e-6),
            "first samples leaked: {out:?}"
        );
    }

    #[test]
    fn mix_is_linear_and_seek_moves_the_playhead() {
        // 1000-frame chunks: the 128-sample edge blend stays off the probes.
        let mut drums = tone(2_000, 0.25);
        for frame in 1_000..2_000 {
            drums[frame * 2] = 0.75;
            drums[frame * 2 + 1] = 0.75;
        }
        let mut engine = Engine::new();
        engine
            .load_synthetic(
                48_000,
                1_000,
                vec![("drums".into(), drums), ("bass".into(), tone(2_000, 0.1))],
            )
            .unwrap();
        engine.play();
        let mut both = vec![0.0f32; 1_600 * 2];
        engine.render(&mut both);
        assert!(
            (both[500 * 2] - 0.35).abs() < 1e-4,
            "chunk 0 mix {}",
            both[500 * 2]
        );
        assert!(
            (both[1_500 * 2] - 0.85).abs() < 1e-4,
            "chunk 1 mix {}",
            both[1_500 * 2]
        );

        engine.pause();
        engine.seek(1_500.0 / 48_000.0).unwrap();
        engine.set_stem_gain("bass", 0.0);
        engine.play();
        let mut out = [0.0f32; 2];
        engine.render(&mut out);
        assert!(
            (out[0] - 0.75).abs() < 1e-4,
            "seek must play drums only, got {}",
            out[0]
        );
    }

    #[test]
    fn gain_change_while_playing_ramps() {
        let mut engine = Engine::new();
        engine
            .load_synthetic(48_000, 48_000, vec![("vocals".into(), tone(4000, 1.0))])
            .unwrap();
        engine.play();
        let mut first = [0.0f32; 2];
        engine.render(&mut first);
        assert!((first[0] - 1.0).abs() < 1e-4);
        engine.set_stem_gain("vocals", 0.0);
        let mut early = [0.0f32; 2];
        engine.render(&mut early);
        assert!(early[0] > 0.9, "ramp started too fast: {}", early[0]);
        let mut rest = vec![0.0f32; 2000 * 2];
        engine.render(&mut rest);
        assert!(rest[rest.len() - 2].abs() < 1e-4);
    }

    #[test]
    fn double_speed_keeps_pitch_and_advances_song_time() {
        // rate 2 and +12 semitones cancel in the shifter (ratio = 1), so a
        // constant stays a constant while song time runs at twice wall time.
        let mut engine = Engine::new();
        engine
            .load_synthetic(48_000, 48_000, vec![("vocals".into(), tone(4_000, 0.5))])
            .unwrap();
        engine.set_playback_rate(2.0);
        engine.set_pitch(12);
        engine.play();
        let mut out = vec![0.0f32; 100 * 2];
        engine.render(&mut out);
        assert!(
            out.iter().all(|s| (*s - 0.5).abs() < 1e-4),
            "varispeed constant drifted: {:?}",
            &out[..8]
        );
        let expected = 200.0 / 48_000.0;
        assert!(
            (engine.position() - expected).abs() < 1e-6,
            "song time {} expected {expected}",
            engine.position()
        );
    }

    #[test]
    fn pitch_up_raises_the_frequency() {
        let frames = 8_000;
        let period = 80.0;
        let mut pcm = vec![0.0f32; frames * 2];
        for i in 0..frames {
            let s = (i as f64 / period * std::f64::consts::TAU).sin() as f32;
            pcm[i * 2] = s;
            pcm[i * 2 + 1] = s;
        }
        let mut engine = Engine::new();
        engine
            .load_synthetic(48_000, frames, vec![("vocals".into(), pcm)])
            .unwrap();
        engine.set_pitch(12);
        engine.play();
        let mut out = vec![0.0f32; frames * 2];
        engine.render(&mut out);
        let slow = sine_crossings(period, 4_500, 7_000);
        let fast = buffer_crossings(&out, 4_500, 7_000);
        assert!(
            fast > slow + slow / 3,
            "pitch +12 crossings {fast}, unshifted {slow}"
        );
    }

    fn buffer_crossings(interleaved: &[f32], start: usize, end: usize) -> i32 {
        let mut n = 0;
        let mut prev = interleaved[start * 2];
        for i in (start + 1)..end {
            let sample = interleaved[i * 2];
            if (prev < 0.0 && sample >= 0.0) || (prev >= 0.0 && sample < 0.0) {
                n += 1;
            }
            prev = sample;
        }
        n
    }

    fn sine_crossings(period: f64, start: usize, end: usize) -> i32 {
        let mut buf = vec![0.0f32; end * 2];
        for i in 0..end {
            let s = (i as f64 / period * std::f64::consts::TAU).sin() as f32;
            buf[i * 2] = s;
        }
        buffer_crossings(&buf, start, end)
    }
}
