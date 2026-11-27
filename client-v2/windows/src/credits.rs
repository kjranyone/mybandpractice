use std::sync::{Arc, OnceLock};

use gpui::{Image, ImageFormat};

pub const PROJECT_URL: &str = "https://github.com/kjranyone/mybandpractice";
pub const LICENSE_URL: &str = "https://github.com/kjranyone/mybandpractice/blob/main/LICENSE";

pub struct Credit {
    pub name: &'static str,
    pub role: &'static str,
    pub license: &'static str,
    pub url: &'static str,
}

pub const LIBRARIES: [Credit; 4] = [
    Credit {
        name: "GPUI",
        role: "Native interface",
        license: "Apache-2.0",
        url: "https://github.com/zed-industries/zed/tree/main/crates/gpui",
    },
    Credit {
        name: "CPAL",
        role: "Audio output",
        license: "Apache-2.0",
        url: "https://github.com/RustAudio/cpal",
    },
    Credit {
        name: "rusty-opus",
        role: "Opus decoding",
        license: "BSD-3-Clause",
        url: "https://github.com/Remade-With-Rust/rusty-opus",
    },
    Credit {
        name: "WebRTC.rs",
        role: "Device sync",
        license: "MIT OR Apache-2.0",
        url: "https://github.com/webrtc-rs/webrtc",
    },
];

pub fn icon() -> Arc<Image> {
    static ICON: OnceLock<Arc<Image>> = OnceLock::new();
    ICON.get_or_init(|| {
        let bytes = include_bytes!("../../../web/public/brand-icon.png");
        Arc::new(Image::from_bytes(ImageFormat::Png, bytes.to_vec()))
    })
    .clone()
}
