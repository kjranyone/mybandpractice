//! Golden output of the mix and of the pitch-shift path. The engine's arithmetic must
//! stay bit for bit the same when its loops are rearranged, so these digests are what
//! the loops produced before any of that.

use mbp_core::Engine;

/// Deterministic noise in [-1, 1]: constant tones would hide a wrong gain ramp.
fn noise(frames: usize, seed: u64) -> Vec<f32> {
    let mut state = seed | 1;
    let mut samples = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let left = ((state >> 33) as i32 as f32 / 2147483648.0) * 0.9;
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let right = ((state >> 33) as i32 as f32 / 2147483648.0) * 0.9;
        // a slow sweep on top, so neighbouring samples are not independent
        let sweep = (i as f32 * 0.013).sin() * 0.3;
        samples.push(left + sweep);
        samples.push(right - sweep);
    }
    samples
}

fn digest(samples: &[f32]) -> u64 {
    samples.iter().fold(0xcbf2_9ce4_8422_2325, |hash, sample| {
        (hash ^ sample.to_bits() as u64).wrapping_mul(0x1000_0000_01b3)
    })
}

fn loaded(pitch: i32, rate: f64) -> Engine {
    let mut engine = Engine::new();
    engine
        .load_synthetic(
            48_000,
            1_000,
            vec![
                ("vocals".into(), noise(5_000, 11)),
                ("drums".into(), noise(5_000, 23)),
                ("bass".into(), noise(5_000, 37)),
                ("other".into(), noise(5_000, 41)),
            ],
        )
        .unwrap();
    engine.set_stem_gain("vocals", 0.8);
    engine.set_stem_gain("bass", 0.5);
    engine.set_stem_gain("other", 0.25);
    engine.set_master_gain(0.9);
    engine.set_pitch(pitch);
    engine.set_playback_rate(rate);
    engine
}

/// Play through with gain changes, a pause and a seek; returns everything rendered.
fn perform(engine: &mut Engine) -> Vec<f32> {
    let mut all = Vec::new();
    let mut block = vec![0.0f32; 1024 * 2];
    engine.play();
    for _ in 0..3 {
        engine.render(&mut block);
        all.extend_from_slice(&block);
    }
    engine.set_stem_gain("vocals", 0.0);
    engine.set_stem_gain("bass", 1.9);
    engine.set_master_gain(0.4);
    for _ in 0..3 {
        engine.render(&mut block);
        all.extend_from_slice(&block);
    }
    engine.pause();
    engine.set_stem_gain("drums", 0.1);
    engine.render(&mut block);
    all.extend_from_slice(&block);
    engine.seek(1.5).unwrap();
    engine.play();
    while engine.is_playing() {
        engine.render(&mut block);
        all.extend_from_slice(&block);
    }
    engine.render(&mut block);
    all.extend_from_slice(&block);
    all
}

#[test]
fn mix_output_is_unchanged() {
    let mut engine = loaded(0, 1.0);
    let all = perform(&mut engine);
    assert_eq!(digest(&all), 0x9e57_ec91_8b69_a20e, "mix digest");
    assert!(engine.ended());
}

#[test]
fn shaped_output_is_unchanged() {
    let mut engine = loaded(3, 1.07);
    let all = perform(&mut engine);
    assert_eq!(digest(&all), 0x174b_2fe6_fc6e_3ae0, "shaped digest");
    assert!(engine.ended());
}
