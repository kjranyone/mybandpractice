//! Control and pull-render API used by the Kotlin player.
//! The audio callback stays on the Kotlin side and asks for PCM.

use std::path::Path;
use std::sync::{Arc, Mutex};

use mbp_core::{waveform_peaks as peaks_of, Engine};

mod native;

use crate::native::NativeHandle;

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum PlayerError {
    #[error("{reason}")]
    Engine { reason: String },
}

#[derive(uniffi::Object)]
pub struct Player {
    engine: Arc<Mutex<Engine>>,
    /// What the JNI functions in `native` address.
    native: Arc<NativeHandle>,
}

#[uniffi::export]
impl Player {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        let engine = Arc::new(Mutex::new(Engine::new()));
        Arc::new(Self {
            native: Arc::new(NativeHandle {
                engine: Arc::clone(&engine),
            }),
            engine,
        })
    }

    /// Address of the JNI side of this player, for `NativeAudio`. It is good for as long
    /// as this object, which owns it.
    pub fn native_handle(&self) -> u64 {
        Arc::as_ptr(&self.native) as u64
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
}

/// Downsampled peaks of a main-mix ogg/opus file. `bars` is clamped to 1..=8192.
#[uniffi::export]
pub fn waveform_peaks(path: String, bars: u32) -> Result<Vec<f32>, PlayerError> {
    peaks_of(Path::new(&path), bars as usize).map_err(|err| PlayerError::Engine {
        reason: err.to_string(),
    })
}
