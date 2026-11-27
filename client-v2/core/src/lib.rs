//! Pull-based stem mixer.
//!
//! The host asks for interleaved stereo frames. Chunk `i` of every stem starts
//! at `i * chunk_seconds` (the contract from `bin/make-stem-chunks.py`). Stem
//! gains are already at their target on the first sample after play or seek.

mod chunk_math;
mod decode;
mod engine;
mod manifest;
mod pitch;
mod smooth;
mod song;

pub use chunk_math::{effective_row_duration, locate_chunk, row_wall_duration, ChunkLocator};
pub use decode::decode_audio_file;
pub use decode::waveform_peaks;
pub use decode::DecodedAudio;
pub use engine::{Engine, StemGain, MAX_GAIN, RAMP_SECONDS};
pub use manifest::{parse_chunk_manifest, ChunkManifest};

use std::path::Path;

/// `songs/<slug>` or `songs/<slug>/stems/chunks`.
pub fn resolve_chunks_dir(path: &Path) -> Option<std::path::PathBuf> {
    if path.join("chunks.json").is_file() {
        return Some(path.to_path_buf());
    }
    let nested = path.join("stems").join("chunks");
    if nested.join("chunks.json").is_file() {
        return Some(nested);
    }
    None
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{0}")]
    Message(String),
    #[error("no song is loaded")]
    NotLoaded,
}

impl From<std::io::Error> for CoreError {
    fn from(value: std::io::Error) -> Self {
        CoreError::Message(value.to_string())
    }
}
