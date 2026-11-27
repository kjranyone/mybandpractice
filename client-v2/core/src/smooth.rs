//! One-sided join between a newly decoded chunk and cached neighbours.
//! Only the new buffer is modified. Port of `smoothChunkEdges`.

pub const EDGE_SMOOTH_SAMPLES: usize = 128;

pub fn smooth_chunk_edges(
    buf: &mut [f32],
    channels: usize,
    previous: Option<&[f32]>,
    next: Option<&[f32]>,
) {
    if channels == 0 || buf.len() < channels {
        return;
    }
    let frames = buf.len() / channels;
    let n = EDGE_SMOOTH_SAMPLES.min(frames / 4);
    if n == 0 {
        return;
    }

    if let Some(prev) = previous {
        let prev_frames = prev.len() / channels;
        if prev_frames > 0 {
            let chs = channels.min(prev.len() / prev_frames.max(1));
            for ch in 0..chs {
                let start = buf[ch];
                let join = prev[(prev_frames - 1) * channels + ch];
                for i in 0..n {
                    let w = if n == 1 {
                        0.0
                    } else {
                        (1.0 - (std::f32::consts::PI * i as f32 / (n - 1) as f32).cos()) / 2.0
                    };
                    let idx = i * channels + ch;
                    buf[idx] += (join - start) * (1.0 - w);
                }
            }
        }
    }

    if let Some(next) = next {
        let next_frames = next.len() / channels;
        if next_frames > 0 {
            let chs = channels.min(next.len() / next_frames.max(1));
            for ch in 0..chs {
                let end = buf[(frames - 1) * channels + ch];
                let join = next[ch];
                for i in 0..n {
                    let w = if n == 1 {
                        1.0
                    } else {
                        (1.0 - (std::f32::consts::PI * i as f32 / (n - 1) as f32).cos()) / 2.0
                    };
                    let idx = (frames - n + i) * channels + ch;
                    buf[idx] += (join - end) * w;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_chunk_meets_the_previous_tail() {
        let prev = vec![0.0, 0.0, 0.5, 0.5];
        let mut buf = vec![0.0; 16];
        // 8 frames, stereo. n = min(128, 8/4) = 2.
        smooth_chunk_edges(&mut buf, 2, Some(&prev), None);
        assert!((buf[0] - 0.5).abs() < 1e-5, "left start {}", buf[0]);
        assert!((buf[1] - 0.5).abs() < 1e-5, "right start {}", buf[1]);
    }
}
