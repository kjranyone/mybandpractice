//! A chunked song. PCM cells are published one chunk at a time.
//! Decode never runs on the audio thread.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::decode::decode_audio_file;
use crate::manifest::parse_chunk_manifest;
use crate::smooth::smooth_chunk_edges;
use crate::CoreError;

const CHANNELS: usize = 2;
/// Non-last chunks shorter than this are a decoder alignment failure.
const SHORT_TOLERANCE_FRAMES: usize = 2_400;

pub struct ChunkPcm {
    pub samples: Vec<f32>,
    pub frames: usize,
}

pub struct Song {
    pub chunks_dir: PathBuf,
    pub ext: String,
    pub slug: String,
    pub title: String,
    pub stems: Vec<String>,
    pub chunk_seconds: f64,
    pub chunk_frames: usize,
    pub chunk_count: u32,
    pub sample_rate: u32,
    pcm: Vec<Vec<Mutex<Option<Arc<ChunkPcm>>>>>,
    duration_frames: AtomicU64,
    /// Next chunk the prefetch thread should warm. `u32::MAX` means idle.
    pub wanted: AtomicU32,
    decode_lock: Mutex<()>,
}

impl Song {
    pub fn open(path: &Path) -> Result<Arc<Self>, CoreError> {
        let chunks_dir = path.to_path_buf();
        let raw = fs::read_to_string(chunks_dir.join("chunks.json"))?;
        let manifest = parse_chunk_manifest(&raw)?;
        let chunk_count = manifest
            .stems
            .iter()
            .map(|(_, c)| *c)
            .min()
            .ok_or_else(|| CoreError::Message("no stems".into()))?;
        if chunk_count == 0 {
            return Err(CoreError::Message("chunk count is zero".into()));
        }
        let stems: Vec<String> = manifest.stems.into_iter().map(|(n, _)| n).collect();
        let (slug, title) = read_identity(&chunks_dir);

        // Chunk length follows the decoded rate. Opus cuts are 48 kHz even
        // when an older manifest still mentions the pre-resample rate.
        let sample_rate = 48_000u32;
        let chunk_frames = (manifest.chunk_seconds * sample_rate as f64).round() as usize;
        if chunk_frames == 0 {
            return Err(CoreError::Message("chunk frame count is zero".into()));
        }

        let pcm = (0..stems.len())
            .map(|_| {
                (0..chunk_count)
                    .map(|_| Mutex::new(None))
                    .collect::<Vec<_>>()
            })
            .collect();

        let song = Arc::new(Self {
            chunks_dir,
            ext: manifest.ext,
            slug,
            title,
            stems,
            chunk_seconds: manifest.chunk_seconds,
            chunk_frames,
            chunk_count,
            sample_rate,
            pcm,
            duration_frames: AtomicU64::new(chunk_count as u64 * chunk_frames as u64),
            wanted: AtomicU32::new(u32::MAX),
            decode_lock: Mutex::new(()),
        });

        song.decode_chunk(0)?;
        if chunk_count > 1 {
            song.decode_chunk(chunk_count - 1)?;
            song.wanted.store(1, Ordering::Relaxed);
        }
        song.recompute_duration();
        Ok(song)
    }

    /// Split already-stereo PCM into aligned chunks. Used by tests.
    pub fn from_synthetic(
        sample_rate: u32,
        chunk_frames: usize,
        stems: Vec<(String, Vec<f32>)>,
    ) -> Result<Arc<Self>, CoreError> {
        if stems.is_empty() || chunk_frames == 0 {
            return Err(CoreError::Message("empty synthetic song".into()));
        }
        let names: Vec<String> = stems.iter().map(|(n, _)| n.clone()).collect();
        let max_frames = stems
            .iter()
            .map(|(_, pcm)| pcm.len() / CHANNELS)
            .max()
            .unwrap_or(0);
        let chunk_count = (max_frames + chunk_frames - 1) / chunk_frames;
        let chunk_count = chunk_count.max(1) as u32;
        let pcm_cells = (0..names.len())
            .map(|_| {
                (0..chunk_count)
                    .map(|_| Mutex::new(None))
                    .collect::<Vec<_>>()
            })
            .collect();
        let song = Arc::new(Self {
            chunks_dir: PathBuf::new(),
            ext: "pcm".into(),
            slug: "synthetic".into(),
            title: "synthetic".into(),
            stems: names,
            chunk_seconds: chunk_frames as f64 / sample_rate as f64,
            chunk_frames,
            chunk_count,
            sample_rate,
            pcm: pcm_cells,
            duration_frames: AtomicU64::new(0),
            wanted: AtomicU32::new(u32::MAX),
            decode_lock: Mutex::new(()),
        });
        for (si, (_, samples)) in stems.into_iter().enumerate() {
            let frames = samples.len() / CHANNELS;
            for idx in 0..chunk_count {
                let start = idx as usize * chunk_frames;
                if start >= frames && idx + 1 != chunk_count {
                    continue;
                }
                let end = (start + chunk_frames).min(frames);
                let mut slice = if start < frames {
                    samples[start * CHANNELS..end * CHANNELS].to_vec()
                } else {
                    Vec::new()
                };
                let is_last = idx + 1 == chunk_count;
                if !is_last {
                    slice.resize(chunk_frames * CHANNELS, 0.0);
                }
                let mut owned_frames = slice.len() / CHANNELS;
                if let Some(prev) = song.cloned_samples(si, idx.wrapping_sub(1)) {
                    smooth_chunk_edges(&mut slice, CHANNELS, Some(&prev), None);
                }
                if is_last && owned_frames > chunk_frames {
                    slice.truncate(chunk_frames * CHANNELS);
                    owned_frames = chunk_frames;
                }
                *song.pcm[si][idx as usize]
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(ChunkPcm {
                    frames: owned_frames,
                    samples: slice,
                }));
            }
        }
        song.recompute_duration();
        Ok(song)
    }

    pub fn chunk_path(&self, stem: &str, idx: u32) -> PathBuf {
        self.chunks_dir
            .join(stem)
            .join(format!("{idx:05}.{}", self.ext))
    }

    pub fn duration_frames(&self) -> u64 {
        self.duration_frames.load(Ordering::Relaxed)
    }

    pub fn ready(&self, idx: u32) -> bool {
        if idx >= self.chunk_count {
            return false;
        }
        self.pcm.iter().all(|stem| {
            stem[idx as usize]
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
        })
    }

    pub fn chunk(&self, stem_index: usize, idx: u32) -> Option<Arc<ChunkPcm>> {
        self.pcm
            .get(stem_index)?
            .get(idx as usize)?
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn decode_chunk(&self, idx: u32) -> Result<(), CoreError> {
        if idx >= self.chunk_count {
            return Ok(());
        }
        let _guard = self.decode_lock.lock().unwrap_or_else(|e| e.into_inner());
        let is_last = idx + 1 == self.chunk_count;
        for (si, stem) in self.stems.iter().enumerate() {
            if self.pcm[si][idx as usize]
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
            {
                continue;
            }
            if self.ext == "pcm" {
                return Err(CoreError::Message("synthetic chunk missing".into()));
            }
            let path = self.chunk_path(stem, idx);
            let decoded = decode_audio_file(&path)?;
            if decoded.sample_rate != self.sample_rate {
                return Err(CoreError::Message(format!(
                    "{} is {} Hz, expected {}",
                    path.display(),
                    decoded.sample_rate,
                    self.sample_rate
                )));
            }
            let chunk = fit_chunk(decoded.stereo, is_last, self.chunk_frames)?;
            let prev = if idx > 0 {
                self.cloned_samples(si, idx - 1)
            } else {
                None
            };
            let next = self.cloned_samples(si, idx + 1);
            let mut samples = chunk.samples;
            smooth_chunk_edges(&mut samples, CHANNELS, prev.as_deref(), next.as_deref());
            let frames = samples.len() / CHANNELS;
            *self.pcm[si][idx as usize]
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(ChunkPcm { samples, frames }));
        }
        if is_last {
            self.recompute_duration();
        }
        Ok(())
    }

    fn cloned_samples(&self, stem_index: usize, idx: u32) -> Option<Vec<f32>> {
        let chunk = self.chunk(stem_index, idx)?;
        Some(chunk.samples.clone())
    }

    fn recompute_duration(&self) {
        let last = self.chunk_count - 1;
        let mut last_frames = self.chunk_frames;
        for stem in &self.pcm {
            if let Some(chunk) = stem[last as usize]
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
            {
                last_frames = last_frames.min(chunk.frames);
            }
        }
        let total = last as u64 * self.chunk_frames as u64 + last_frames as u64;
        self.duration_frames.store(total.max(1), Ordering::Relaxed);
    }
}

fn fit_chunk(
    mut samples: Vec<f32>,
    is_last: bool,
    chunk_frames: usize,
) -> Result<ChunkPcm, CoreError> {
    let mut frames = samples.len() / CHANNELS;
    if !is_last {
        if frames + SHORT_TOLERANCE_FRAMES < chunk_frames {
            return Err(CoreError::Message(format!(
                "decoded chunk is {frames} frames, nominal is {chunk_frames}"
            )));
        }
        if frames < chunk_frames {
            samples.resize(chunk_frames * CHANNELS, 0.0);
        } else {
            samples.truncate(chunk_frames * CHANNELS);
        }
        frames = chunk_frames;
    } else if frames > chunk_frames {
        samples.truncate(chunk_frames * CHANNELS);
        frames = chunk_frames;
    }
    Ok(ChunkPcm { samples, frames })
}

fn read_identity(chunks_dir: &Path) -> (String, String) {
    let song_dir = chunks_dir.parent().and_then(|p| p.parent());
    let slug = song_dir
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("song")
        .to_string();
    let mut title = slug.clone();
    if let Some(dir) = song_dir {
        if let Ok(raw) = fs::read_to_string(dir.join("meta.json")) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(t) = value.get("title").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        title = t.to_string();
                    }
                }
                if let Some(artist) = value.get("artist").and_then(|v| v.as_str()) {
                    if !artist.is_empty() {
                        title = format!("{artist} — {title}");
                    }
                }
            }
        }
    }
    (slug, title)
}
