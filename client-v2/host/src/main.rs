//! Hear the core on this machine, or check it without opening a device.
//!
//! ```text
//! mbp-play songs/zankyou-sanka
//! mbp-play --check songs/zankyou-sanka
//! ```
//!
//! space play/pause, left/right seek 5s, 1-4 toggle stems, -/= master, q quit.

use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{self, ClearType};
use crossterm::{cursor, execute, style::Print};
use mbp_core::{decode_audio_file, resolve_chunks_dir, Engine};

const STEMS: [&str; 4] = ["vocals", "drums", "bass", "other"];

fn main() {
    let mut args = env::args().skip(1);
    let mut check = false;
    let mut song: Option<PathBuf> = None;
    for arg in args.by_ref() {
        match arg.as_str() {
            "--check" => check = true,
            "-h" | "--help" => {
                eprintln!("usage: mbp-play [--check] <song-dir-or-chunks-dir>");
                return;
            }
            other if other.starts_with('-') => {
                eprintln!("unknown flag {other}");
                std::process::exit(2);
            }
            other => song = Some(PathBuf::from(other)),
        }
    }
    let Some(song) = song else {
        eprintln!("usage: mbp-play [--check] <song-dir-or-chunks-dir>");
        std::process::exit(2);
    };
    let Some(chunks) = resolve_chunks_dir(&song) else {
        eprintln!("chunks.json not found under {}", song.display());
        std::process::exit(1);
    };

    let mut engine = Engine::new();
    if let Err(err) = engine.load_chunks_dir(&chunks) {
        eprintln!("load failed: {err}");
        std::process::exit(1);
    }
    if check {
        match run_check(&mut engine) {
            Ok(()) => println!("CHECK_OK"),
            Err(err) => {
                eprintln!("CHECK_FAIL {err}");
                std::process::exit(1);
            }
        }
        return;
    }
    if let Err(err) = run_interactive(engine) {
        eprintln!("audio device: {err}");
        std::process::exit(1);
    }
}

fn run_check(engine: &mut Engine) -> Result<(), String> {
    let rate = engine.sample_rate();
    if rate != 48_000 {
        return Err(format!("sample rate {rate}"));
    }
    let duration = engine.duration();
    if duration < 1.0 {
        return Err(format!("duration {duration} is too short"));
    }
    println!(
        "loaded {}  {:.2}s  {} Hz  chunks {:.0}s",
        engine.title(),
        duration,
        rate,
        engine.chunk_seconds()
    );

    engine.play();
    let mix = render_secs(engine, 1.0);
    let mix_rms = rms(&mix);
    if mix_rms < 1e-4 {
        return Err(format!("first second is silent (rms {mix_rms})"));
    }

    engine.pause();
    engine.seek(0.0).map_err(|e| e.to_string())?;
    for stem in STEMS {
        engine.set_stem_gain(stem, if stem == "bass" { 1.0 } else { 0.0 });
    }
    engine.play();
    let bass = render_secs(engine, 1.0);

    engine.pause();
    engine.seek(0.0).map_err(|e| e.to_string())?;
    for stem in STEMS {
        engine.set_stem_gain(stem, if stem == "drums" { 1.0 } else { 0.0 });
    }
    engine.play();
    let drums = render_secs(engine, 1.0);

    engine.pause();
    engine.seek(0.0).map_err(|e| e.to_string())?;
    for stem in STEMS {
        engine.set_stem_gain(
            stem,
            if stem == "bass" || stem == "drums" {
                1.0
            } else {
                0.0
            },
        );
    }
    engine.play();
    let sum = render_secs(engine, 1.0);
    let n = bass.len().min(drums.len()).min(sum.len());
    let mut err = 0.0f32;
    for i in 0..n {
        err = err.max((sum[i] - (bass[i] + drums[i])).abs());
    }
    if err > 1e-3 {
        return Err(format!("mix is not linear, max error {err}"));
    }
    println!("mix linear  max_err {err:.3e}  rms {mix_rms:.4}");

    let probe = (duration * 0.5).clamp(5.0, duration - 0.5);
    engine.pause();
    for stem in STEMS {
        engine.set_stem_gain(stem, 1.0);
    }
    engine.seek(0.0).map_err(|e| e.to_string())?;
    engine.play();
    let head = render_secs(engine, 0.5);
    engine.pause();
    engine.seek(probe).map_err(|e| e.to_string())?;
    engine.play();
    let mid = render_secs(engine, 0.5);
    let corr = correlation(&head, &mid);
    if corr > 0.98 {
        return Err(format!(
            "seek to {probe:.2}s still matches the start (corr {corr:.3})"
        ));
    }
    println!("seek {probe:.2}s  corr_with_start {corr:.3}");

    let vocals = engine
        .chunk_file("vocals", 0)
        .ok_or("vocals chunk 0 missing")?;
    let ours = decode_audio_file(&vocals).map_err(|e| e.to_string())?;
    let ffmpeg = ffmpeg_f32(&vocals)?;
    let lag0 = correlation(&ours.stereo, &ffmpeg);
    let (best_lag, best_corr) = if lag0 >= 0.98 {
        (0i32, lag0)
    } else {
        best_lag(&ours.stereo, &ffmpeg, 2_000)
    };
    println!(
        "opus vocals/00000  ours {} frames  ffmpeg {} frames  lag0 {lag0:.4}  best lag {best_lag} corr {best_corr:.4}",
        ours.frames(),
        ffmpeg.len() / 2
    );
    if best_corr < 0.98 {
        return Err(format!(
            "opus decode does not match ffmpeg (corr {best_corr:.4})"
        ));
    }
    if best_lag.unsigned_abs() > 64 {
        return Err(format!(
            "opus is shifted by {best_lag} samples against ffmpeg (pre-skip)"
        ));
    }
    let nominal = (30.0 * rate as f64) as usize;
    let diff = ours.frames().abs_diff(ffmpeg.len() / 2);
    if diff > rate as usize / 20 {
        return Err(format!("frame count differs from ffmpeg by {diff}"));
    }
    if ours.frames() + rate as usize / 50 < nominal {
        return Err(format!(
            "chunk 0 is {} frames, nominal {nominal}",
            ours.frames()
        ));
    }
    Ok(())
}

fn render_secs(engine: &mut Engine, seconds: f64) -> Vec<f32> {
    let frames = (seconds * engine.sample_rate() as f64).round() as usize;
    let mut out = vec![0.0f32; frames * 2];
    engine.render(&mut out);
    out
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    (sum / samples.len() as f64).sqrt() as f32
}

fn correlation(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..n {
        let x = a[i] as f64;
        let y = b[i] as f64;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn best_lag(a: &[f32], b: &[f32], max_lag: usize) -> (i32, f64) {
    let window = 96_000.min(a.len()).min(b.len());
    let a = &a[..window];
    let b = &b[..window];
    let mut best = (0, correlation(a, b));
    for lag in 1..=max_lag {
        if lag >= window {
            break;
        }
        let c_pos = correlation(&a[lag..], &b[..window - lag]);
        if c_pos > best.1 {
            best = (lag as i32, c_pos);
        }
        let c_neg = correlation(&a[..window - lag], &b[lag..]);
        if c_neg > best.1 {
            best = (-(lag as i32), c_neg);
        }
    }
    best
}

fn ffmpeg_f32(path: &std::path::Path) -> Result<Vec<f32>, String> {
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-v", "error", "-i"])
        .arg(path)
        .args([
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            "2",
            "-ar",
            "48000",
            "pipe:1",
        ])
        .output()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    if output.stdout.len() % 4 != 0 {
        return Err("ffmpeg returned a partial f32 stream".into());
    }
    let mut pcm = Vec::with_capacity(output.stdout.len() / 4);
    for chunk in output.stdout.chunks_exact(4) {
        pcm.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(pcm)
}

struct Resampler {
    phase: f64,
    hold_l: f32,
    hold_r: f32,
    have_hold: bool,
    pending: Vec<f32>,
    scratch: Vec<f32>,
}

impl Resampler {
    fn new() -> Self {
        Self {
            phase: 0.0,
            hold_l: 0.0,
            hold_r: 0.0,
            have_hold: false,
            pending: Vec::new(),
            scratch: vec![0.0; 4096],
        }
    }

    fn pull(&mut self, engine: &mut Engine, out: &mut [f32], in_rate: u32, out_rate: u32) {
        if in_rate == out_rate {
            engine.render(out);
            return;
        }
        let out_frames = out.len() / 2;
        let ratio = in_rate as f64 / out_rate as f64;
        let need = (out_frames as f64 * ratio).ceil() as usize + 4;
        while self.pending.len() / 2 < need {
            engine.render(&mut self.scratch);
            self.pending.extend_from_slice(&self.scratch);
        }
        for frame in 0..out_frames {
            let idx = self.phase.floor() as usize;
            let frac = (self.phase - idx as f64) as f32;
            let (l0, r0) = self.at(idx);
            let (l1, r1) = self.at(idx + 1);
            let o = frame * 2;
            out[o] = l0 + (l1 - l0) * frac;
            out[o + 1] = r0 + (r1 - r0) * frac;
            self.phase += ratio;
        }
        let drop_frames = self.phase.floor() as usize;
        if drop_frames > 0 {
            let drop = drop_frames.min(self.pending.len() / 2);
            self.pending.drain(..drop * 2);
            self.phase -= drop as f64;
            if self.pending.len() >= 2 {
                self.hold_l = self.pending[0];
                self.hold_r = self.pending[1];
                self.have_hold = true;
            }
        }
    }

    fn at(&self, frame: usize) -> (f32, f32) {
        if frame == 0 && self.have_hold && self.phase < 1.0 {
            // hold is the sample before pending[0] only when phase was reduced.
        }
        let base = frame * 2;
        if base + 1 < self.pending.len() {
            (self.pending[base], self.pending[base + 1])
        } else if self.have_hold {
            (self.hold_l, self.hold_r)
        } else {
            (0.0, 0.0)
        }
    }
}

fn run_interactive(engine: Engine) -> Result<(), String> {
    enable_utf8();
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no output device")?;
    let device_name = device.name().unwrap_or_else(|_| "output".into());
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let song_rate = engine.sample_rate();
    let config = StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    let out_rate = config.sample_rate.0;
    println!(
        "{}  {:.0}s  device {device_name} {out_rate} Hz",
        engine.title(),
        engine.duration()
    );

    let engine = std::sync::Arc::new(std::sync::Mutex::new(engine));
    let audio_engine = std::sync::Arc::clone(&engine);
    let mut resampler = Resampler::new();
    let channels = config.channels as usize;
    let err_fn = |err| eprintln!("stream error: {err}");

    let stream = match supported.sample_format() {
        SampleFormat::F32 => device
            .build_output_stream(
                &config,
                move |data: &mut [f32], _| {
                    let mut guard = audio_engine.lock().unwrap_or_else(|e| e.into_inner());
                    if channels == 2 {
                        resampler.pull(&mut guard, data, song_rate, out_rate);
                    } else {
                        let mut stereo = vec![0.0f32; (data.len() / channels) * 2];
                        resampler.pull(&mut guard, &mut stereo, song_rate, out_rate);
                        downmix(&stereo, data, channels);
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| e.to_string())?,
        SampleFormat::I16 => device
            .build_output_stream(
                &config,
                move |data: &mut [i16], _| {
                    let mut guard = audio_engine.lock().unwrap_or_else(|e| e.into_inner());
                    let frames = data.len() / channels.max(1);
                    let mut stereo = vec![0.0f32; frames * 2];
                    resampler.pull(&mut guard, &mut stereo, song_rate, out_rate);
                    write_i16(&stereo, data, channels);
                },
                err_fn,
                None,
            )
            .map_err(|e| e.to_string())?,
        other => return Err(format!("unsupported sample format {other:?}")),
    };
    stream.play().map_err(|e| e.to_string())?;

    terminal::enable_raw_mode().map_err(|e| e.to_string())?;
    let mut stdout = io::stdout();
    execute!(stdout, terminal::Clear(ClearType::All), cursor::Hide).ok();
    loop {
        draw(&engine, &mut stdout);
        if event::poll(Duration::from_millis(80)).unwrap_or(false) {
            let Ok(Event::Key(key)) = event::read() else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }
            let mut guard = engine.lock().unwrap_or_else(|e| e.into_inner());
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => break,
                KeyCode::Char(' ') => {
                    if guard.is_playing() {
                        guard.pause();
                    } else {
                        guard.play();
                    }
                }
                KeyCode::Left | KeyCode::Char('h') => {
                    let t = (guard.position() - 5.0).max(0.0);
                    let _ = guard.seek(t);
                }
                KeyCode::Right | KeyCode::Char('l') => {
                    let t = guard.position() + 5.0;
                    let _ = guard.seek(t);
                }
                KeyCode::Char(ch @ '1'..='4') => {
                    let stem = STEMS[(ch as u8 - b'1') as usize];
                    let next = if guard.stem_gain(stem) > 0.01 {
                        0.0
                    } else {
                        1.0
                    };
                    guard.set_stem_gain(stem, next);
                }
                KeyCode::Char('-') => {
                    let g = (guard.master_gain() - 0.05).max(0.0);
                    guard.set_master_gain(g);
                }
                KeyCode::Char('=') | KeyCode::Char('+') => {
                    let g = (guard.master_gain() + 0.05).min(mbp_core::MAX_GAIN);
                    guard.set_master_gain(g);
                }
                _ => {}
            }
        }
    }
    execute!(stdout, cursor::Show, cursor::MoveToNextLine(1)).ok();
    terminal::disable_raw_mode().ok();
    Ok(())
}

fn draw(engine: &std::sync::Mutex<Engine>, stdout: &mut io::Stdout) {
    let guard = engine.lock().unwrap_or_else(|e| e.into_inner());
    let state = if guard.is_buffering() {
        "buffering"
    } else if guard.is_playing() {
        "play"
    } else if guard.ended() {
        "end"
    } else {
        "pause"
    };
    let headline = format!(
        "{}   {state}   {} / {}",
        guard.title(),
        fmt_time(guard.position()),
        fmt_time(guard.duration())
    );
    let gains = format!(
        "{}   master {:.2}",
        STEMS
            .iter()
            .map(|s| format!("{s} {:.2}", guard.stem_gain(s)))
            .collect::<Vec<_>>()
            .join("  "),
        guard.master_gain()
    );
    let err = guard.last_error().unwrap_or_default();
    drop(guard);
    execute!(
        stdout,
        cursor::MoveTo(0, 0),
        terminal::Clear(ClearType::CurrentLine),
        Print(headline),
        cursor::MoveTo(0, 1),
        terminal::Clear(ClearType::CurrentLine),
        Print(gains),
        cursor::MoveTo(0, 2),
        terminal::Clear(ClearType::CurrentLine),
        Print("space play/pause   arrows ±5s   1-4 stem   -/= master   q quit"),
        cursor::MoveTo(0, 3),
        terminal::Clear(ClearType::CurrentLine),
        Print(err),
    )
    .ok();
    let _ = stdout.flush();
}

fn downmix(stereo: &[f32], out: &mut [f32], channels: usize) {
    let frames = out.len() / channels;
    for frame in 0..frames {
        let l = stereo.get(frame * 2).copied().unwrap_or(0.0);
        let r = stereo.get(frame * 2 + 1).copied().unwrap_or(l);
        for ch in 0..channels {
            out[frame * channels + ch] = if ch % 2 == 0 { l } else { r };
        }
    }
}

fn write_i16(stereo: &[f32], out: &mut [i16], channels: usize) {
    let frames = out.len() / channels.max(1);
    for frame in 0..frames {
        let l = stereo.get(frame * 2).copied().unwrap_or(0.0);
        let r = stereo.get(frame * 2 + 1).copied().unwrap_or(l);
        for ch in 0..channels {
            let s = if ch % 2 == 0 { l } else { r };
            out[frame * channels + ch] = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        }
    }
}

fn fmt_time(seconds: f64) -> String {
    let secs = seconds.max(0.0).floor() as u64;
    format!("{}:{:02}", secs / 60, secs % 60)
}

fn enable_utf8() {
    #[cfg(windows)]
    unsafe {
        extern "system" {
            fn SetConsoleOutputCP(code_page: u32) -> i32;
        }
        SetConsoleOutputCP(65001);
    }
}
