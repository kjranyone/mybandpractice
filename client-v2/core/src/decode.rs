//! Decode one Ogg Opus chunk to interleaved stereo f32.
//!
//! Pre-skip and the final granule come from the OpusHead / Ogg pages
//! (RFC 7845). Non-last chunks are then trimmed to the nominal length by
//! the song loader, same as the Web Audio engine.

use std::fs::File;
use std::path::Path;

use ogg::reading::PacketReader;
use rusty_opus::OpusDecoder;

use crate::CoreError;

pub struct DecodedAudio {
    pub sample_rate: u32,
    pub channels_in: u16,
    /// Interleaved stereo, after pre-skip and end-granule trim.
    pub stereo: Vec<f32>,
}

impl DecodedAudio {
    pub fn frames(&self) -> usize {
        self.stereo.len() / 2
    }
}

pub fn decode_audio_file(path: &Path) -> Result<DecodedAudio, CoreError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "opus" && ext != "ogg" {
        return Err(CoreError::Message(format!(
            "{}: v2 prototype decodes opus chunks only",
            path.display()
        )));
    }
    let file =
        File::open(path).map_err(|e| CoreError::Message(format!("{}: {e}", path.display())))?;
    let mut reader = PacketReader::new(file);
    let mut head: Option<(u16, u16)> = None;
    let mut audio: Vec<Vec<u8>> = Vec::new();
    let mut last_granule: Option<u64> = None;

    loop {
        let packet = match reader.read_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(err) => {
                let msg = err.to_string();
                if audio.is_empty() && head.is_none() {
                    return Err(CoreError::Message(format!("ogg {}: {msg}", path.display())));
                }
                break;
            }
        };
        if head.is_none() {
            head = Some(
                parse_opus_head(&packet.data)
                    .map_err(|e| CoreError::Message(format!("{}: {e}", path.display())))?,
            );
            continue;
        }
        if packet.data.starts_with(b"OpusTags") {
            continue;
        }
        // A page granule of -1 is "unknown" and shows up as u64::MAX.
        if packet.absgp_page() != u64::MAX {
            last_granule = Some(packet.absgp_page());
        }
        audio.push(packet.data);
    }

    let (channels, pre_skip) =
        head.ok_or_else(|| CoreError::Message(format!("no OpusHead in {}", path.display())))?;
    if channels == 0 || channels > 2 {
        return Err(CoreError::Message(format!(
            "{}: {channels} channels, prototype supports 1 or 2",
            path.display()
        )));
    }

    let mut decoder = OpusDecoder::new(48_000, channels as usize)
        .map_err(|err| CoreError::Message(format!("opus decoder {}: {err}", path.display())))?;
    let mut frame = vec![0.0f32; 5760 * channels as usize];
    let mut decoded: Vec<f32> = Vec::new();
    for packet in &audio {
        let n = decoder
            .decode(packet, 5760, &mut frame)
            .map_err(|err| CoreError::Message(format!("opus {}: {err}", path.display())))?;
        let samples = n * channels as usize;
        if samples > frame.len() {
            return Err(CoreError::Message(format!(
                "opus {} returned {n} samples into a {} buffer",
                path.display(),
                frame.len()
            )));
        }
        decoded.extend_from_slice(&frame[..samples]);
    }

    let skip = pre_skip as usize * channels as usize;
    if decoded.len() < skip {
        return Err(CoreError::Message(format!(
            "{} shorter than its pre-skip",
            path.display()
        )));
    }
    decoded.drain(..skip);
    if let Some(granule) = last_granule {
        let keep_frames = granule.saturating_sub(pre_skip as u64) as usize;
        let keep = keep_frames * channels as usize;
        if keep < decoded.len() {
            decoded.truncate(keep);
        }
    }

    let frames = decoded.len() / channels as usize;
    let mut stereo = Vec::with_capacity(frames * 2);
    if channels == 1 {
        for s in decoded {
            stereo.push(s);
            stereo.push(s);
        }
    } else {
        stereo = decoded;
    }
    if stereo.is_empty() {
        return Err(CoreError::Message(format!(
            "empty decode {}",
            path.display()
        )));
    }
    Ok(DecodedAudio {
        sample_rate: 48_000,
        channels_in: channels,
        stereo,
    })
}

/// Peak envelope of a main mix, normalized the same way as
/// `web/src/utils/waveform.ts` (`clamp(p / peak, 0.04, 1)`).
pub fn waveform_peaks(path: &Path, bars: usize) -> Result<Vec<f32>, CoreError> {
    let decoded = decode_audio_file(path)?;
    let frames = decoded.frames().max(1);
    let bars = bars.clamp(1, 8_192);
    let mut peaks = vec![0.0f32; bars];
    let block = (frames / bars).max(1);
    for (i, peak) in peaks.iter_mut().enumerate() {
        let start = i * block;
        if start >= frames {
            break;
        }
        let end = (start + block).min(frames);
        let mut max = 0.0f32;
        for frame in start..end {
            let base = frame * 2;
            let v = decoded.stereo[base]
                .abs()
                .max(decoded.stereo[base + 1].abs());
            if v > max {
                max = v;
            }
        }
        *peak = max;
    }
    let peak = peaks.iter().copied().fold(0.0001f32, f32::max);
    for sample in &mut peaks {
        *sample = (*sample / peak).clamp(0.04, 1.0);
    }
    Ok(peaks)
}

fn parse_opus_head(data: &[u8]) -> Result<(u16, u16), String> {
    if data.len() < 19 || &data[..8] != b"OpusHead" {
        return Err("first packet is not OpusHead".into());
    }
    if data[8] != 1 {
        return Err(format!("unsupported OpusHead version {}", data[8]));
    }
    let channels = data[9] as u16;
    let pre_skip = u16::from_le_bytes([data[10], data[11]]);
    Ok((channels, pre_skip))
}
