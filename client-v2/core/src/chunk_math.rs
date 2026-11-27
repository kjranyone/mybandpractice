//! Pure chunk indexing. Port of `web/src/audio/chunkMath.ts`.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChunkLocator {
    pub idx: usize,
    /// Offset inside the chunk, in seconds.
    pub intra: f64,
}

pub fn locate_chunk(
    offset_sec: f64,
    chunk_seconds: f64,
    chunk_count: usize,
    song_duration: f64,
) -> ChunkLocator {
    if chunk_count == 0 || chunk_seconds <= 0.0 {
        return ChunkLocator { idx: 0, intra: 0.0 };
    }
    let dur = if song_duration > 0.0 {
        song_duration
    } else {
        f64::INFINITY
    };
    let grid = chunk_count as f64 * chunk_seconds;
    let t = offset_sec.clamp(0.0, dur.min(grid));
    let idx = ((t / chunk_seconds).floor() as usize).min(chunk_count - 1);
    let intra = (t - idx as f64 * chunk_seconds).max(0.0);
    ChunkLocator { idx, intra }
}

/// Lossy decoders pad the end (Opus 20 ms frames). Clamp to the nominal
/// boundary so scheduled rows stay sample-aligned.
pub fn effective_row_duration(decoded_duration: f64, chunk_seconds: f64) -> f64 {
    decoded_duration.min(chunk_seconds)
}

pub fn row_wall_duration(row_dur: f64, intra: f64, rate: f64) -> f64 {
    let r = if rate > 0.0 { rate } else { 1.0 };
    ((row_dur - intra) / r).max(0.05)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CS: f64 = 30.0;

    #[test]
    fn maps_zero_to_chunk_zero() {
        assert_eq!(
            locate_chunk(0.0, CS, 10, f64::INFINITY),
            ChunkLocator { idx: 0, intra: 0.0 }
        );
    }

    #[test]
    fn maps_exact_boundaries_to_the_next_chunk() {
        assert_eq!(
            locate_chunk(30.0, CS, 10, f64::INFINITY),
            ChunkLocator { idx: 1, intra: 0.0 }
        );
        assert_eq!(
            locate_chunk(90.0, CS, 10, f64::INFINITY),
            ChunkLocator { idx: 3, intra: 0.0 }
        );
    }

    #[test]
    fn computes_intra_chunk_offsets() {
        let loc = locate_chunk(75.5, CS, 10, f64::INFINITY);
        assert_eq!(loc.idx, 2);
        assert!((loc.intra - 15.5).abs() < 1e-9);
    }

    #[test]
    fn clamps_negative_offsets() {
        assert_eq!(
            locate_chunk(-5.0, CS, 10, f64::INFINITY),
            ChunkLocator { idx: 0, intra: 0.0 }
        );
    }

    #[test]
    fn clamps_past_the_last_chunk() {
        let loc = locate_chunk(950.0, CS, 10, f64::INFINITY);
        assert_eq!(loc.idx, 9);
        assert!(loc.intra > 0.0);
    }

    #[test]
    fn honors_song_duration_shorter_than_the_grid() {
        let loc = locate_chunk(280.0, CS, 10, 272.35);
        assert_eq!(loc.idx, 9);
        assert!(loc.intra <= 272.35 - 9.0 * CS + 1e-9);
    }

    #[test]
    fn handles_sub_second_chunks() {
        let loc = locate_chunk(1.2, 0.5, 4, f64::INFINITY);
        assert_eq!(loc.idx, 2);
        assert!((loc.intra - 0.2).abs() < 1e-9);
    }

    #[test]
    fn effective_row_clamps_opus_padding() {
        assert!((effective_row_duration(30.0, 30.0) - 30.0).abs() < 1e-9);
        assert!((effective_row_duration(30.0065, 30.0) - 30.0).abs() < 1e-9);
        assert!((effective_row_duration(2.32, 30.0) - 2.32).abs() < 1e-9);
    }

    #[test]
    fn row_wall_duration_matches_the_ts_cases() {
        assert!((row_wall_duration(30.0, 0.0, 1.0) - 30.0).abs() < 1e-9);
        assert!((row_wall_duration(30.0, 10.0, 1.0) - 20.0).abs() < 1e-9);
        assert!((row_wall_duration(30.0, 0.0, 2.0) - 15.0).abs() < 1e-9);
        assert!((row_wall_duration(30.0, 30.0, 1.0) - 0.05).abs() < 1e-9);
        assert!((row_wall_duration(30.0, 0.0, 0.0) - 30.0).abs() < 1e-9);
    }
}
