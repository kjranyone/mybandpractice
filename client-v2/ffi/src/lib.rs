//! Control and pull-render API used by the Kotlin player.
//! The audio callback stays on the Kotlin side and asks for PCM.

use std::path::Path;
use std::sync::Mutex;

use mbp_core::{waveform_peaks as peaks_of, Engine};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum PlayerError {
    #[error("{reason}")]
    Engine { reason: String },
}

#[derive(uniffi::Object)]
pub struct Player {
    engine: Mutex<Engine>,
}

#[uniffi::export]
impl Player {
    #[uniffi::constructor]
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            engine: Mutex::new(Engine::new()),
        })
    }

    pub fn load_chunks_dir(&self, path: String) -> Result<(), PlayerError> {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .load_chunks_dir(Path::new(&path))
            .map_err(|err| PlayerError::Engine {
                reason: err.to_string(),
            })
    }

    pub fn play(&self) {
        self.engine.lock().unwrap_or_else(|e| e.into_inner()).play();
    }

    pub fn pause(&self) {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pause();
    }

    pub fn seek(&self, seconds: f64) -> Result<(), PlayerError> {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .seek(seconds)
            .map_err(|err| PlayerError::Engine {
                reason: err.to_string(),
            })
    }

    pub fn set_stem_gain(&self, stem: String, gain: f32) {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_stem_gain(&stem, gain);
    }

    pub fn set_master_gain(&self, gain: f32) {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_master_gain(gain);
    }

    /// Tape speed in `0.25..=2`. Heard pitch stays at `set_pitch`.
    pub fn set_playback_rate(&self, rate: f64) {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_playback_rate(rate);
    }

    /// Semitones in `-12..=12`. Independent of playback rate.
    pub fn set_pitch(&self, semitones: i32) {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_pitch(semitones);
    }

    pub fn position(&self) -> f64 {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .position()
    }

    pub fn duration(&self) -> f64 {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .duration()
    }

    pub fn playing(&self) -> bool {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_playing()
    }

    pub fn buffering(&self) -> bool {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_buffering()
    }

    pub fn ended(&self) -> bool {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .ended()
    }

    pub fn title(&self) -> String {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .title()
    }

    pub fn stem_gain(&self, stem: String) -> f32 {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stem_gain(&stem)
    }

    pub fn master_gain(&self) -> f32 {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .master_gain()
    }

    pub fn last_error(&self) -> String {
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_error()
            .unwrap_or_default()
    }

    /// Interleaved stereo little-endian i16, `frames` per call.
    pub fn render_pcm(&self, frames: u32) -> Vec<u8> {
        let frames = frames.clamp(1, 8_192) as usize;
        let mut pcm = vec![0.0f32; frames * 2];
        self.engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .render(&mut pcm);
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for sample in pcm {
            let s = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        bytes
    }
}

/// Downsampled peaks of a main-mix ogg/opus file. `bars` is clamped to 1..=8192.
#[uniffi::export]
pub fn waveform_peaks(path: String, bars: u32) -> Result<Vec<f32>, PlayerError> {
    peaks_of(Path::new(&path), bars as usize).map_err(|err| PlayerError::Engine {
        reason: err.to_string(),
    })
}
