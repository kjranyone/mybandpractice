use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use mbp_core::{decode_audio_file, parse_chunk_manifest, waveform_peaks};

use crate::library::SongEntry;

const PEAK_COUNT: usize = 1024;

pub fn load(song: &SongEntry, duration: f64, cancel: &AtomicBool) -> Option<Vec<f32>> {
    let directory = song.directory();
    let mut mixes = ["ogg", "opus"]
        .map(|extension| directory.join(format!("{}.{extension}", song.slug)))
        .to_vec();
    let mut other_mixes = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_mix(path))
        .collect::<Vec<_>>();
    other_mixes.sort();
    other_mixes.retain(|path| !mixes.contains(path));
    mixes.extend(other_mixes);

    for path in mixes.into_iter().filter(|path| path.is_file()) {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        if let Ok(peaks) = waveform_peaks(&path, PEAK_COUNT) {
            return Some(peaks);
        }
    }
    from_stems(&song.chunks, duration, cancel)
}

fn is_mix(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("ogg") || extension.eq_ignore_ascii_case("opus")
        })
}

fn from_stems(chunks: &Path, duration: f64, cancel: &AtomicBool) -> Option<Vec<f32>> {
    let manifest =
        parse_chunk_manifest(&fs::read_to_string(chunks.join("chunks.json")).ok()?).ok()?;
    let total_frames = (duration * 48_000.0).round() as usize;
    let chunk_frames = (manifest.chunk_seconds * 48_000.0).round() as usize;
    let mut peaks = vec![0.0_f32; PEAK_COUNT];
    let count = manifest.stems.iter().map(|(_, count)| *count).min()?;
    for index in 0..count {
        let mut mix = Vec::new();
        for (stem, _) in &manifest.stems {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let path: PathBuf = chunks
                .join(stem)
                .join(format!("{index:05}.{}", manifest.ext));
            let audio = decode_audio_file(&path).ok()?;
            if mix.is_empty() {
                mix = audio.stereo;
            } else {
                mix.truncate(mix.len().min(audio.stereo.len()));
                for (sample, stem_sample) in mix.iter_mut().zip(audio.stereo) {
                    *sample += stem_sample;
                }
            }
        }
        mix.truncate(chunk_frames * 2);
        accumulate_peaks(
            &mut peaks,
            &mix,
            index as usize * chunk_frames,
            total_frames,
        );
    }
    let max_peak = peaks.iter().copied().fold(0.0001_f32, f32::max);
    for peak in &mut peaks {
        *peak = (*peak / max_peak).clamp(0.04, 1.0);
    }
    Some(peaks)
}

fn accumulate_peaks(peaks: &mut [f32], stereo: &[f32], start: usize, total: usize) {
    let count = peaks.len() as u64;
    for (i, samples) in stereo
        .chunks_exact(2)
        .take(total.saturating_sub(start))
        .enumerate()
    {
        let bin = (((start + i) as u64 * count) / total as u64) as usize;
        peaks[bin] = peaks[bin].max(samples[0].abs()).max(samples[1].abs());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stem_peaks_keep_chunk_offsets_and_ignore_final_padding() {
        let mut peaks = [0.0; 4];
        accumulate_peaks(&mut peaks, &[0.25, -0.1, 0.2, -0.5], 0, 5);
        accumulate_peaks(
            &mut peaks,
            &[0.0, -0.75, -0.1, 0.4, 0.9, 0.1, 2.0, 2.0],
            2,
            5,
        );
        assert_eq!(peaks, [0.5, 0.75, 0.4, 0.9]);
    }
}
