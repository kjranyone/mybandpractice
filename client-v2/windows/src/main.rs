#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod chords;
#[cfg(windows)]
mod credits;
#[cfg(windows)]
mod library;
#[cfg(windows)]
mod player;
#[cfg(windows)]
mod sync;
#[cfg(windows)]
mod view;
#[cfg(windows)]
mod waveform;

#[cfg(windows)]
fn main() {
    use gpui::{
        px, size, App, AppContext, Application, Bounds, TitlebarOptions, WindowBounds,
        WindowOptions,
    };

    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1140.), px(790.)), cx);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(780.), px(580.))),
                titlebar: Some(TitlebarOptions {
                    title: Some("My Band Practice".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |window, cx| cx.new(|cx| player::Player::new(window, cx)),
        )
        .expect("could not open the practice window");
        cx.activate(true);
    });
}

#[cfg(not(windows))]
fn main() {
    eprintln!("mbp-windows requires Windows.");
}
