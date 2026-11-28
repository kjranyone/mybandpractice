//! JNI entry points for the two calls the Android player makes dozens of times a
//! second: pulling PCM and reading the transport. Everything else goes through
//! UniFFI, whose JNA marshalling costs a good part of a millisecond per call.
//!
//! Kotlin calls these through `NativeAudio` with the address that
//! `Player::native_handle` returns. The address is the `Arc<NativeHandle>` the player
//! owns, so it is good for as long as that player is.

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use jni::objects::{JByteBuffer, JClass};
use jni::sys::{jint, jlong};
use jni::JNIEnv;
use mbp_core::Engine;

/// What the JNI functions address: the engine behind a `Player`.
pub struct NativeHandle {
    pub engine: Arc<Mutex<Engine>>,
}

/// The most a pull asks for. A buffer holds four bytes per frame.
const MAX_FRAMES: usize = 8192;
/// position, duration, flags: the bytes `readTransport` writes.
const TRANSPORT_BYTES: usize = 17;
const FLAG_PLAYING: u8 = 1;
const FLAG_BUFFERING: u8 = 2;
const FLAG_ENDED: u8 = 4;
const FLAG_ERROR: u8 = 8;

const BAD_HANDLE: jint = -1;
const BAD_BUFFER: jint = -2;

thread_local! {
    /// The engine mixes into f32. Kept here, a pull allocates nothing.
    static SCRATCH: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

fn resolve(address: jlong) -> Option<&'static NativeHandle> {
    if address == 0 {
        return None;
    }
    // SAFETY: the address comes from `Player::native_handle`, which hands out the
    // `Arc` the player owns, and Kotlin keeps that player alive while using the address.
    Some(unsafe { &*(address as usize as *const NativeHandle) })
}

/// The writable memory of a direct buffer of at least `len` bytes.
fn direct<'a>(env: &mut JNIEnv, buffer: &JByteBuffer, len: usize) -> Result<&'a mut [u8], jint> {
    // The jni crate clears a pending exception for us (a buffer that is not direct
    // makes Android throw), so returning a code is all that is left to do.
    let capacity = env
        .get_direct_buffer_capacity(buffer)
        .map_err(|_| BAD_BUFFER)?;
    if capacity < len {
        return Err(BAD_BUFFER);
    }
    let address = env
        .get_direct_buffer_address(buffer)
        .map_err(|_| BAD_BUFFER)?;
    if address.is_null() {
        return Err(BAD_BUFFER);
    }
    // SAFETY: Android keeps the buffer's memory mapped while the buffer object exists,
    // and the capacity was checked above.
    Ok(unsafe { std::slice::from_raw_parts_mut(address, len) })
}

/// Stereo i16 PCM, little-endian, like `AudioTrack` takes it in a byte buffer.
fn pcm16(samples: &[f32], out: &mut [u8]) {
    for (i, sample) in samples.iter().enumerate() {
        let s = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out[2 * i..2 * i + 2].copy_from_slice(&s.to_le_bytes());
    }
}

/// Mixes `frames` frames into `dst`, starting at its first byte whatever its position.
/// Returns the number of frames, or negative: -1 for an unknown handle, -2 when `dst`
/// is not a direct buffer with room for the frames.
#[no_mangle]
pub extern "system" fn Java_com_donoy_mybandpractice_v2_NativeAudio_renderPcm<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    handle: jlong,
    dst: JByteBuffer<'local>,
    frames: jint,
) -> jint {
    let Some(native) = resolve(handle) else {
        return BAD_HANDLE;
    };
    let frames = frames.clamp(1, MAX_FRAMES as jint) as usize;
    let Ok(out) = direct(&mut env, &dst, frames * 4) else {
        return BAD_BUFFER;
    };
    SCRATCH.with(|scratch| {
        let mut scratch = scratch.borrow_mut();
        scratch.resize(frames * 2, 0.0);
        native
            .engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .render(&mut scratch);
        pcm16(&scratch, out);
    });
    frames as jint
}

/// Writes the transport into the first bytes of `dst`: the position and the duration
/// as f64, then a byte of flags (1 playing, 2 buffering, 4 ended, 8 an error is set).
/// Returns the number of bytes, or negative as `renderPcm` does.
#[no_mangle]
pub extern "system" fn Java_com_donoy_mybandpractice_v2_NativeAudio_readTransport<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    handle: jlong,
    dst: JByteBuffer<'local>,
) -> jint {
    let Some(native) = resolve(handle) else {
        return BAD_HANDLE;
    };
    let Ok(out) = direct(&mut env, &dst, TRANSPORT_BYTES) else {
        return BAD_BUFFER;
    };
    let engine = native.engine.lock().unwrap_or_else(|e| e.into_inner());
    let mut flags = 0u8;
    if engine.is_playing() {
        flags |= FLAG_PLAYING;
    }
    if engine.is_buffering() {
        flags |= FLAG_BUFFERING;
    }
    if engine.ended() {
        flags |= FLAG_ENDED;
    }
    if engine.last_error().is_some() {
        flags |= FLAG_ERROR;
    }
    out[..8].copy_from_slice(&engine.position().to_le_bytes());
    out[8..16].copy_from_slice(&engine.duration().to_le_bytes());
    out[16] = flags;
    TRANSPORT_BYTES as jint
}
