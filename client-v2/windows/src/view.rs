use std::cell::Cell;
use std::path::Path;
use std::rc::Rc;

use gpui::{
    canvas, div, fill, img, point, prelude::*, px, rgb, size, Bounds, Context, Div, ElementId,
    FontWeight, KeyDownEvent, MouseButton, Pixels, SharedString, Stateful, Window,
};
use mbp_core::MAX_GAIN;

use crate::audio::WAVE_BARS;
use crate::chords::{self, ChordChart};
use crate::credits;
use crate::library::LyricsBlock;
use crate::player::{Command, Player};
use crate::sync;

const BACKGROUND: u32 = 0x12141c;
const SIDEBAR: u32 = 0x171a24;
const PANEL: u32 = 0x1b1f2b;
const CONTROL: u32 = 0x242938;
const HOVER: u32 = 0x30364a;
const BORDER: u32 = 0x34394a;
const TEXT: u32 = 0xf3f2fa;
const MUTED: u32 = 0xa6acc1;
const ACCENT: u32 = 0xd5f578;
const INK: u32 = 0x1a2311;
const WARNING: u32 = 0xffb5a5;
const WAVE_PLAYED: u32 = 0xffa362;
const WAVE_UNPLAYED: u32 = 0x5c6075;

impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let wide = window.viewport_size().width >= px(1080.);
        div()
            .id("practice")
            .track_focus(&self.focus)
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|player, _, _, _| player.dragged_gain = None),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|player, _, _, _| player.dragged_gain = None),
            )
            .on_key_down(cx.listener(|player, event: &KeyDownEvent, _, cx| {
                let stroke = &event.keystroke;
                if player.credits_open {
                    if stroke.key == "escape" {
                        player.dispatch(Command::ToggleCredits, cx);
                    }
                    return;
                }
                if player.sync_panel.is_some() {
                    if stroke.key == "escape" {
                        player.dispatch(Command::CloseSync, cx);
                    }
                    return;
                }
                if player.playlist_open || player.library_open || player.song_sheet_open {
                    if stroke.key == "escape" {
                        let command = if player.playlist_open {
                            Command::TogglePlaylists
                        } else if player.library_open {
                            Command::ToggleLibrary
                        } else {
                            Command::ToggleSongSheet
                        };
                        player.dispatch(command, cx);
                    }
                    return;
                }
                let command = match stroke.key.as_str() {
                    "o" if stroke.modifiers.control => Command::OpenFolder,
                    "space" if !stroke.modifiers.modified() && !event.is_held => {
                        Command::TogglePlayback
                    }
                    "left" if !stroke.modifiers.modified() => Command::Skip(-5.0),
                    "right" if !stroke.modifiers.modified() => Command::Skip(5.0),
                    _ => return,
                };
                cx.stop_propagation();
                player.dispatch(command, cx);
            }))
            .font_family("Segoe UI")
            .text_color(rgb(TEXT))
            .text_sm()
            .bg(rgb(BACKGROUND))
            .size_full()
            .flex()
            .relative()
            .child(self.sidebar(cx))
            .child(
                div()
                    .id("workspace")
                    .flex_1()
                    .min_w_0()
                    .overflow_y_scroll()
                    .px_7()
                    .py_6()
                    .child(
                        column()
                            .mx_auto()
                            .max_w(px(1000.))
                            .gap_5()
                            .child(self.deck(cx))
                            .when(self.active.is_some(), |content| {
                                let has_sheet = !self.lyrics.is_empty() || self.chords.is_some();
                                content.child(
                                    row()
                                        .when(!wide, |layout| layout.flex_col())
                                        .items_start()
                                        .gap_4()
                                        .child(
                                            self.mixer(cx)
                                                .when(wide && has_sheet, |mixer| mixer.w(px(400.))),
                                        )
                                        .when(has_sheet, |layout| {
                                            layout.child(self.practice_sheet(wide, cx))
                                        }),
                                )
                            }),
                    ),
            )
            .when_some(self.sync_panel.as_ref(), |app, panel| {
                app.child(sync_overlay(panel, cx))
            })
            .when(self.playlist_open, |app| {
                app.child(self.playlist_overlay(cx))
            })
            .when(self.library_open, |app| app.child(self.library_overlay(cx)))
            .when(self.song_sheet_open, |app| {
                app.child(self.song_sheet_overlay(cx))
            })
            .when(self.credits_open, |app| app.child(credits_overlay(cx)))
    }
}

impl Player {
    fn sidebar(&self, cx: &Context<Self>) -> Div {
        let visible = self.visible_songs();
        let location = self.library_path.as_deref().map(compact_path);
        column()
            .w(px(240.))
            .flex_none()
            .h_full()
            .bg(rgb(SIDEBAR))
            .border_r_1()
            .border_color(rgb(BORDER))
            .pt_5()
            .child(
                row()
                    .id("brand-credits")
                    .items_center()
                    .gap_3()
                    .px_2()
                    .py_1()
                    .mx_2()
                    .mb_4()
                    .rounded_md()
                    .cursor_pointer()
                    .hover(|style| style.bg(rgb(CONTROL)))
                    .on_click(
                        cx.listener(|player, _, _, cx| player.dispatch(Command::ToggleCredits, cx)),
                    )
                    .child(img(credits::icon()).size(px(38.)).flex_none())
                    .child(
                        column()
                            .child(
                                div()
                                    .font_weight(FontWeight::BOLD)
                                    .child("My Band Practice"),
                            )
                            .child(label("Credits")),
                    ),
            )
            .child(
                column()
                    .gap_2()
                    .mx_4()
                    .mb_4()
                    .child(
                        row()
                            .justify_between()
                            .items_center()
                            .child(div().id("library-title").child(label("LIBRARY")).when(
                                self.library_path.is_some(),
                                |title| {
                                    title.cursor_pointer().on_click(cx.listener(
                                        |player, _, _, cx| {
                                            player.dispatch(Command::ToggleLibrary, cx)
                                        },
                                    ))
                                },
                            ))
                            .child(label(format!("{} songs", self.songs.len()))),
                    )
                    .child(match location {
                        Some(path) => button(
                            "library-location",
                            path,
                            Command::ToggleLibrary,
                            true,
                            false,
                            cx,
                        )
                        .justify_start()
                        .pl_3(),
                        None => button(
                            "choose-library",
                            "Choose library…",
                            Command::OpenFolder,
                            self.busy.is_none(),
                            true,
                            cx,
                        ),
                    })
                    .when(!self.songs.is_empty(), |controls| {
                        controls.child(
                            row()
                                .gap_2()
                                .child(
                                    button(
                                        "choose-playlist",
                                        "Playlists",
                                        Command::TogglePlaylists,
                                        true,
                                        false,
                                        cx,
                                    )
                                    .flex_1(),
                                )
                                .child(
                                    button(
                                        "open-sync",
                                        "Sync",
                                        Command::OpenSync,
                                        self.busy.is_none(),
                                        false,
                                        cx,
                                    )
                                    .flex_1(),
                                ),
                        )
                    }),
            )
            .child(
                row()
                    .justify_between()
                    .px_4()
                    .pb_2()
                    .gap_2()
                    .child(
                        div()
                            .id("queue-title")
                            .when(!self.songs.is_empty(), |title| {
                                title
                                    .cursor_pointer()
                                    .on_click(cx.listener(|player, _, _, cx| {
                                        player.dispatch(Command::TogglePlaylists, cx);
                                    }))
                            })
                            .child(
                                label(self.playlist.map_or_else(
                                    || "All songs".into(),
                                    |index| self.setlists[index].name.clone(),
                                ))
                                .truncate(),
                            ),
                    )
                    .when(self.playlist.is_some(), |heading| {
                        heading.child(
                            label(if self.shuffle { "Shuffle" } else { "In order" }).flex_none(),
                        )
                    }),
            )
            .child(
                div()
                    .id("song-list")
                    .flex_1()
                    .overflow_y_scroll()
                    .px_2()
                    .children(
                        visible
                            .into_iter()
                            .map(|index| self.library_song(index, cx)),
                    ),
            )
    }

    fn library_song(&self, index: usize, cx: &Context<Self>) -> Stateful<Div> {
        let song = &self.songs[index];
        let current = self
            .active
            .as_ref()
            .is_some_and(|active| active.chunks == song.chunks);
        let pending = self
            .selection
            .as_ref()
            .is_some_and(|next| next.song.chunks == song.chunks);
        row()
            .id(("song", index))
            .items_center()
            .gap_3()
            .min_h(px(44.))
            .py_2()
            .px_2()
            .mb_1()
            .rounded_md()
            .when(current || pending, |item| item.bg(rgb(CONTROL)))
            .when(!pending && (!current || self.selection.is_some()), |item| {
                item.cursor_pointer()
                    .hover(|style| style.bg(rgb(CONTROL)))
                    .on_click(cx.listener(move |player, _, _, cx| {
                        player.dispatch(Command::Load(index), cx)
                    }))
            })
            .child(
                div()
                    .size(px(4.))
                    .flex_none()
                    .rounded_full()
                    .bg(rgb(if current {
                        ACCENT
                    } else if pending {
                        MUTED
                    } else {
                        BORDER
                    })),
            )
            .child(
                column()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .truncate()
                            .text_color(rgb(if current { ACCENT } else { TEXT }))
                            .child(song.title.clone()),
                    )
                    .when(!song.artist.is_empty(), |item| {
                        item.child(label(song.artist.clone()).truncate())
                    }),
            )
    }

    fn library_overlay(&self, cx: &Context<Self>) -> Stateful<Div> {
        overlay("library-dialog", Command::ToggleLibrary, cx).child(
            panel()
                .occlude()
                .w_full()
                .max_w(px(600.))
                .p_6()
                .gap_4()
                .child(
                    row()
                        .justify_between()
                        .items_center()
                        .child(
                            div()
                                .text_xl()
                                .font_weight(FontWeight::BOLD)
                                .child("Library location"),
                        )
                        .child(button(
                            "close-library",
                            "Close",
                            Command::ToggleLibrary,
                            true,
                            false,
                            cx,
                        )),
                )
                .when_some(self.library_path.as_ref(), |content, path| {
                    content.child(
                        div()
                            .id("current-library-path")
                            .overflow_x_scroll()
                            .rounded_md()
                            .bg(rgb(BACKGROUND))
                            .px_3()
                            .py_3()
                            .child(
                                div()
                                    .whitespace_nowrap()
                                    .font_family("Consolas")
                                    .child(path.display().to_string()),
                            ),
                    )
                })
                .when_some(self.error.as_ref(), |content, error| {
                    content.child(div().text_color(rgb(WARNING)).child(error.clone()))
                })
                .child(
                    row()
                        .justify_between()
                        .items_center()
                        .child(label(if self.busy.is_some() {
                            "Scanning library…".into()
                        } else {
                            format!("{} songs available", self.songs.len())
                        }))
                        .child(button(
                            "change-library",
                            "Change folder…",
                            Command::OpenFolder,
                            self.busy.is_none(),
                            true,
                            cx,
                        )),
                ),
        )
    }

    fn playlist_overlay(&self, cx: &Context<Self>) -> Stateful<Div> {
        let visible = self.visible_songs();
        let count = visible.len();
        let current_playlist = self.playlist.map(|index| &self.setlists[index]);
        let title = current_playlist.map_or("All songs", |entry| entry.name.as_str());
        let rows = if self.playlist_add {
            let included: std::collections::HashSet<_> = visible.into_iter().collect();
            (0..self.songs.len())
                .filter(|index| !included.contains(index))
                .collect()
        } else {
            visible
        };
        overlay("collection-dialog", Command::TogglePlaylists, cx).child(
            panel()
                .occlude()
                .w_full()
                .max_w(px(806.))
                .h(px(448.))
                .overflow_hidden()
                .child(
                    row()
                        .items_center()
                        .justify_between()
                        .px_5()
                        .py_3()
                        .border_b_1()
                        .border_color(rgb(BORDER))
                        .child(
                            div()
                                .text_lg()
                                .font_weight(FontWeight::BOLD)
                                .child("Playlists"),
                        )
                        .child(
                            row()
                                .gap_2()
                                .child(button(
                                    "new-playlist",
                                    "New playlist…",
                                    Command::NewPlaylist,
                                    self.busy.is_none(),
                                    false,
                                    cx,
                                ))
                                .child(button(
                                    "close-playlists",
                                    "Close",
                                    Command::TogglePlaylists,
                                    true,
                                    false,
                                    cx,
                                )),
                        ),
                )
                .child(
                    row()
                        .flex_1()
                        .min_h_0()
                        .child(
                            column()
                                .id("playlists-collection")
                                .w(px(206.))
                                .flex_none()
                                .overflow_y_scroll()
                                .border_r_1()
                                .border_color(rgb(BORDER))
                                .bg(rgb(SIDEBAR))
                                .p_3()
                                .gap_1()
                                .child(
                                    button(
                                        "all-songs",
                                        "All songs",
                                        Command::Playlist(None),
                                        true,
                                        self.playlist.is_none(),
                                        cx,
                                    )
                                    .justify_start()
                                    .px_3(),
                                )
                                .children(self.setlists.iter().enumerate().map(
                                    |(index, playlist)| {
                                        button(
                                            ("playlist", index),
                                            playlist.name.clone(),
                                            Command::Playlist(Some(index)),
                                            true,
                                            self.playlist == Some(index),
                                            cx,
                                        )
                                        .justify_start()
                                        .px_3()
                                    },
                                )),
                        )
                        .child(
                            column()
                                .flex_1()
                                .min_w_0()
                                .min_h_0()
                                .child(
                                    column()
                                        .flex_none()
                                        .px_4()
                                        .pt_4()
                                        .pb_3()
                                        .gap_2()
                                        .child(
                                            row()
                                                .items_center()
                                                .justify_between()
                                                .gap_2()
                                                .child(
                                                    column()
                                                        .min_w_0()
                                                        .gap_1()
                                                        .child(
                                                            div()
                                                                .truncate()
                                                                .text_size(px(24.))
                                                                .font_weight(FontWeight::BOLD)
                                                                .child(title.to_owned()),
                                                        )
                                                        .child(label(format!("{count} songs"))),
                                                )
                                                .when(current_playlist.is_some(), |heading| {
                                                    heading.child(
                                                        row()
                                                            .gap_1()
                                                            .flex_none()
                                                            .child(button(
                                                                "play-order",
                                                                if self.shuffle {
                                                                    "Shuffle"
                                                                } else {
                                                                    "In order"
                                                                },
                                                                Command::Shuffle,
                                                                true,
                                                                self.shuffle,
                                                                cx,
                                                            ))
                                                            .child(button(
                                                                "edit-playlist",
                                                                if self.playlist_edit {
                                                                    "Done"
                                                                } else {
                                                                    "Edit"
                                                                },
                                                                Command::EditPlaylist,
                                                                true,
                                                                self.playlist_edit,
                                                                cx,
                                                            )),
                                                    )
                                                }),
                                        )
                                        .when(self.playlist_edit, |content| {
                                            content.child(row().child(button(
                                                "add-playlist-songs",
                                                if self.playlist_add {
                                                    "Back to list"
                                                } else {
                                                    "Add songs"
                                                },
                                                Command::AddPlaylistSongs,
                                                true,
                                                self.playlist_add,
                                                cx,
                                            )))
                                        })
                                        .when_some(self.error.as_ref(), |content, error| {
                                            content.child(
                                                div().text_color(rgb(WARNING)).child(error.clone()),
                                            )
                                        }),
                                )
                                .child(
                                    column()
                                        .id((
                                            "playlist-contents",
                                            self.playlist.unwrap_or(usize::MAX),
                                        ))
                                        .flex_1()
                                        .min_h_0()
                                        .overflow_y_scroll()
                                        .px_4()
                                        .pb_3()
                                        .gap_1()
                                        .children(rows.into_iter().enumerate().map(
                                            |(position, index)| {
                                                self.playlist_song(index, position, count, cx)
                                            },
                                        )),
                                ),
                        ),
                ),
        )
    }

    fn playlist_song(
        &self,
        index: usize,
        position: usize,
        count: usize,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let song = &self.songs[index];
        let current = self
            .active
            .as_ref()
            .is_some_and(|active| active.chunks == song.chunks);
        let command = if self.playlist_add {
            Command::AddToPlaylist(index)
        } else {
            Command::Load(index)
        };
        row()
            .id(("playlist-song", index))
            .min_h(px(42.))
            .items_center()
            .gap_3()
            .px_3()
            .rounded_md()
            .bg(rgb(if current { CONTROL } else { BACKGROUND }))
            .when(!self.playlist_edit || self.playlist_add, |item| {
                item.cursor_pointer()
                    .hover(|style| style.bg(rgb(HOVER)))
                    .on_click(cx.listener(move |player, _, _, cx| player.dispatch(command, cx)))
            })
            .child(
                label(if self.playlist_add {
                    "+".into()
                } else {
                    format!("{:02}", position + 1)
                })
                .font_family("Consolas")
                .w(px(25.))
                .flex_none(),
            )
            .child(
                column()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_color(rgb(if current { ACCENT } else { TEXT }))
                            .child(song.title.clone()),
                    )
                    .when(!song.artist.is_empty(), |item| {
                        item.child(label(song.artist.clone()).truncate())
                    }),
            )
            .when(self.playlist_edit && !self.playlist_add, |item| {
                item.child(
                    row()
                        .gap_1()
                        .flex_none()
                        .child(
                            button(
                                ("playlist-up", index),
                                "↑",
                                Command::EditPlaylistSong(index, -1),
                                position > 0,
                                false,
                                cx,
                            )
                            .size(px(27.)),
                        )
                        .child(
                            button(
                                ("playlist-down", index),
                                "↓",
                                Command::EditPlaylistSong(index, 1),
                                position + 1 < count,
                                false,
                                cx,
                            )
                            .size(px(27.)),
                        )
                        .child(
                            button(
                                ("playlist-remove", index),
                                "×",
                                Command::EditPlaylistSong(index, 0),
                                true,
                                false,
                                cx,
                            )
                            .size(px(27.)),
                        ),
                )
            })
    }

    fn wave_seek(&self, enabled: bool, cx: &Context<Self>) -> Stateful<Div> {
        let bounds = Rc::new(Cell::new(Bounds::default()));
        let draw = bounds.clone();
        let down = bounds.clone();
        let movement = bounds.clone();
        let up = bounds.clone();
        let peaks = self.seek_peaks.clone();
        let progress = self
            .seek_preview
            .unwrap_or_else(|| {
                if self.transport.duration > 0.0 {
                    self.transport.position / self.transport.duration
                } else {
                    0.0
                }
            })
            .clamp(0.0, 1.0) as f32;
        let hover = self.seek_hover.filter(|_| self.seek_preview.is_none());
        let finish = |player: &mut Player, ratio, cx: &mut Context<Player>| {
            if player.seek_preview.take().is_some() {
                player.seek_hover = None;
                player.dispatch(Command::Seek(ratio), cx);
                cx.notify();
            }
        };
        div()
            .id("waveform-seek")
            .h(px(84.))
            .w_full()
            .rounded_md()
            .overflow_hidden()
            .bg(rgb(BACKGROUND))
            .border_1()
            .border_color(rgb(BORDER))
            .when(enabled, |track| {
                track
                    .cursor_pointer()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |player, event: &gpui::MouseDownEvent, _, cx| {
                            player.seek_preview = Some(slider_value(down.get(), event.position.x));
                            cx.notify();
                        }),
                    )
                    .on_mouse_move(cx.listener(
                        move |player, event: &gpui::MouseMoveEvent, _, cx| {
                            let ratio = slider_value(movement.get(), event.position.x);
                            if event.pressed_button == Some(MouseButton::Left)
                                && player.seek_preview.is_some()
                            {
                                player.seek_preview = Some(ratio);
                            } else {
                                player.seek_hover = Some(ratio);
                            }
                            cx.notify();
                        },
                    ))
                    .on_hover(cx.listener(|player, hovering: &bool, _, cx| {
                        if !*hovering && player.seek_hover.take().is_some() {
                            cx.notify();
                        }
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(move |player, event: &gpui::MouseUpEvent, _, cx| {
                            finish(player, slider_value(up.get(), event.position.x), cx);
                        }),
                    )
                    .on_mouse_up_out(
                        MouseButton::Left,
                        cx.listener(move |player, event: &gpui::MouseUpEvent, _, cx| {
                            finish(player, slider_value(bounds.get(), event.position.x), cx);
                        }),
                    )
            })
            .child(
                canvas(
                    move |bounds, _, _| draw.set(bounds),
                    move |bounds, (), window, _| {
                        let left = bounds.origin.x + px(4.);
                        let top = bounds.origin.y + px(5.);
                        let height = bounds.size.height - px(10.);
                        let width = (bounds.size.width - px(8.)).max(px(1.));
                        let middle = top + height / 2.;
                        let bars = (f32::from(width) / 3.4).round().clamp(1., 360.) as usize;
                        let pitch = width / bars as f32;
                        for index in 0..bars {
                            let start = index * peaks.len() / bars;
                            let end = ((index + 1) * peaks.len() / bars)
                                .max(start + 1)
                                .min(peaks.len());
                            let peak = peaks
                                .get(start..end)
                                .unwrap_or_default()
                                .iter()
                                .copied()
                                .fold(0.0, f32::max);
                            let bar_height = (height * peak).max(px(3.));
                            let played = (index as f32 + 0.5) / bars as f32 <= progress;
                            window.paint_quad(fill(
                                Bounds::new(
                                    point(left + pitch * index as f32, middle - bar_height / 2.),
                                    size((pitch - px(1.)).max(px(1.)), bar_height),
                                ),
                                rgb(if played { WAVE_PLAYED } else { WAVE_UNPLAYED }),
                            ));
                        }
                        if let Some(hover) = hover {
                            window.paint_quad(fill(
                                Bounds::new(
                                    point(left + width * hover as f32, top),
                                    size(px(1.), height),
                                ),
                                gpui::rgba(0xeccdb777),
                            ));
                        }
                        window.paint_quad(fill(
                            Bounds::new(
                                point(left + width * progress - px(0.75), top),
                                size(px(1.5), height),
                            ),
                            rgb(0xffefe5),
                        ));
                    },
                )
                .size_full(),
            )
    }

    fn deck(&self, cx: &Context<Self>) -> Stateful<Div> {
        let loaded = self.active.is_some();
        let ready = self.busy.is_none();
        let transport = &self.transport;
        let title = self
            .active
            .as_ref()
            .map(|song| song.title.as_str())
            .unwrap_or("Open a song to practice");
        let artist = self
            .active
            .as_ref()
            .map(|song| song.artist.as_str())
            .unwrap_or("");
        let status = self.busy.unwrap_or(if self.selection.is_some() {
            "Loading stems…"
        } else if transport.buffering {
            "Buffering…"
        } else if self.output_error.is_some() {
            "Audio unavailable"
        } else if transport.playing {
            "Playing"
        } else if transport.ended {
            "Finished"
        } else if loaded {
            "Paused"
        } else {
            "No song"
        });
        let error = self.error.as_ref().or(transport.error.as_ref());
        panel()
            .id("player")
            .relative()
            .overflow_hidden()
            .p_5()
            .gap_4()
            .when(self.wave_bars.iter().any(|&value| value != 0), |deck| {
                deck.child(wave_background(self.wave_bars))
            })
            .child(
                row()
                    .items_start()
                    .justify_between()
                    .gap_3()
                    .child(
                        column()
                            .min_w_0()
                            .gap_1()
                            .child(
                                div()
                                    .id("song-title")
                                    .when(
                                        !self.lyrics.is_empty() || self.chords.is_some(),
                                        |title| {
                                            title
                                                .cursor_pointer()
                                                .hover(|text| text.text_color(rgb(WAVE_PLAYED)))
                                                .on_click(cx.listener(|player, _, _, cx| {
                                                    player.dispatch(Command::ToggleSongSheet, cx)
                                                }))
                                        },
                                    )
                                    .truncate()
                                    .text_size(px(30.))
                                    .font_weight(FontWeight::BOLD)
                                    .child(SharedString::from(title.to_owned())),
                            )
                            .when(!artist.is_empty(), |heading| {
                                heading.child(label(SharedString::from(artist.to_owned())))
                            }),
                    )
                    .child(
                        row()
                            .flex_none()
                            .items_center()
                            .gap_2()
                            .pt_2()
                            .child(
                                div()
                                    .size(px(6.))
                                    .rounded_full()
                                    .bg(rgb(if transport.playing { ACCENT } else { MUTED })),
                            )
                            .child(label(status)),
                    ),
            )
            .when_some(error, |deck, error| {
                deck.child(div().text_color(rgb(WARNING)).child(error.clone()))
            })
            .when_some(self.output_error.as_ref(), |deck, error| {
                deck.child(
                    row()
                        .items_center()
                        .justify_between()
                        .gap_3()
                        .child(div().text_color(rgb(WARNING)).child(error.clone()))
                        .child(
                            button(
                                "reconnect",
                                "Retry audio",
                                Command::Reconnect,
                                ready,
                                false,
                                cx,
                            )
                            .flex_none(),
                        ),
                )
            })
            .when(loaded, |deck| {
                deck.child(
                    column().child(self.wave_seek(ready, cx)).child(
                        row()
                            .justify_between()
                            .child(time_label(
                                self.seek_preview
                                    .map_or(transport.position, |ratio| ratio * transport.duration),
                            ))
                            .when_some(
                                self.seek_hover.filter(|_| self.seek_preview.is_none()),
                                |times, ratio| {
                                    times.child(
                                        time_label(ratio * transport.duration)
                                            .text_color(rgb(WAVE_PLAYED)),
                                    )
                                },
                            )
                            .child(time_label(transport.duration)),
                    ),
                )
                .child(
                    row()
                        .items_center()
                        .justify_between()
                        .gap_2()
                        .flex_wrap()
                        .child(
                            row()
                                .gap_2()
                                .when(self.playlist.is_some(), |controls| {
                                    controls.child(button(
                                        "previous-track",
                                        "‹",
                                        Command::TrackStep(-1),
                                        self.neighboring_track(-1).is_some(),
                                        false,
                                        cx,
                                    ))
                                })
                                .child(button(
                                    "back",
                                    "−5 s",
                                    Command::Skip(-5.0),
                                    ready,
                                    false,
                                    cx,
                                ))
                                .child(
                                    button(
                                        "play",
                                        if self.wants_playback() {
                                            "Pause"
                                        } else {
                                            "Play"
                                        },
                                        Command::TogglePlayback,
                                        ready && self.output_error.is_none(),
                                        true,
                                        cx,
                                    )
                                    .w(px(86.)),
                                )
                                .child(button(
                                    "forward",
                                    "+5 s",
                                    Command::Skip(5.0),
                                    ready,
                                    false,
                                    cx,
                                ))
                                .when(self.playlist.is_some(), |controls| {
                                    controls.child(button(
                                        "next-track",
                                        "›",
                                        Command::TrackStep(1),
                                        self.neighboring_track(1).is_some(),
                                        false,
                                        cx,
                                    ))
                                })
                                .child(button(
                                    "repeat-one",
                                    "Repeat 1",
                                    Command::ToggleRepeatOne,
                                    ready,
                                    self.repeat_one,
                                    cx,
                                )),
                        )
                        .child(
                            row()
                                .items_center()
                                .gap_2()
                                .child(stepper(
                                    "speed",
                                    format!("{:.0}%", self.rate * 100.0),
                                    Command::Rate(-0.05),
                                    Command::Rate(0.05),
                                    ready,
                                    cx,
                                ))
                                .child(stepper(
                                    "pitch",
                                    format!("{:+} st", self.pitch),
                                    Command::Pitch(-1),
                                    Command::Pitch(1),
                                    ready,
                                    cx,
                                ))
                                .child(button(
                                    "reset",
                                    "Reset",
                                    Command::ResetTuning,
                                    ready && (self.rate != 1.0 || self.pitch != 0),
                                    false,
                                    cx,
                                )),
                        ),
                )
            })
    }

    fn mixer(&self, cx: &Context<Self>) -> Div {
        let ready = self.busy.is_none();
        panel()
            .w_full()
            .min_w_0()
            .p_5()
            .gap_3()
            .child(
                row()
                    .items_center()
                    .justify_between()
                    .gap_4()
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::BOLD)
                            .child("Stem mixer"),
                    )
                    .child(
                        row()
                            .items_center()
                            .gap_2()
                            .child(label("Master"))
                            .child(
                                slider(
                                    "master",
                                    f64::from(self.master / MAX_GAIN),
                                    ACCENT,
                                    ready,
                                    |value| Command::Master(value as f32 * MAX_GAIN),
                                    cx,
                                )
                                .w(px(90.)),
                            )
                            .child(gain_label(
                                "reset-master",
                                self.master,
                                Command::Master(1.0),
                                ready,
                                cx,
                            )),
                    ),
            )
            .child(
                row()
                    .items_center()
                    .gap_2()
                    .child(
                        column()
                            .gap(px(3.))
                            .flex_1()
                            .min_w_0()
                            .child(level_meter("L", self.meters[0]))
                            .child(level_meter("R", self.meters[1])),
                    )
                    .child(button(
                        "compressor",
                        "Comp",
                        Command::Compressor,
                        ready,
                        self.compressor,
                        cx,
                    ))
                    .child(
                        div()
                            .text_xs()
                            .w(px(53.))
                            .text_center()
                            .text_color(rgb(if self.limiter_gain < 0.99 {
                                ACCENT
                            } else {
                                MUTED
                            }))
                            .child(if self.limiter_gain < 0.99 {
                                format!("Lim −{:.1}", -20.0 * self.limiter_gain.max(0.0001).log10())
                            } else {
                                "Lim".into()
                            }),
                    ),
            )
            .children(self.tracks.iter().enumerate().map(|(index, track)| {
                let color = stem_color(&track.name);
                let soloed = self.solo == Some(index);
                let audible = !track.muted && self.solo.is_none_or(|solo| solo == index);
                row()
                    .items_center()
                    .gap_3()
                    .min_h(px(48.))
                    .px_3()
                    .bg(rgb(BACKGROUND))
                    .rounded_md()
                    .child(
                        row()
                            .items_center()
                            .gap_2()
                            .w(px(81.))
                            .flex_none()
                            .child(div().w(px(3.)).h(px(17.)).rounded_sm().bg(rgb(color)))
                            .child(
                                div()
                                    .truncate()
                                    .text_color(rgb(if audible { TEXT } else { MUTED }))
                                    .child(stem_label(&track.name)),
                            ),
                    )
                    .child(
                        slider(
                            ("gain", index),
                            f64::from(track.gain / MAX_GAIN),
                            if audible { color } else { MUTED },
                            ready,
                            move |value| Command::SetGain(index, value as f32 * MAX_GAIN),
                            cx,
                        )
                        .flex_1(),
                    )
                    .child(gain_label(
                        ("reset-gain", index),
                        track.gain,
                        Command::SetGain(index, 1.0),
                        ready,
                        cx,
                    ))
                    .child(
                        button(
                            ("mute", index),
                            "Mute",
                            Command::Mute(index),
                            ready,
                            track.muted,
                            cx,
                        )
                        .w(px(56.))
                        .flex_none(),
                    )
                    .child(
                        button(
                            ("solo", index),
                            "Solo",
                            Command::Solo(index),
                            ready,
                            soloed,
                            cx,
                        )
                        .w(px(56.))
                        .flex_none(),
                    )
            }))
    }
}

fn level_meter(channel: &'static str, peak: f32) -> Div {
    let db = 20.0 * peak.max(0.001).log10();
    let lit = ((db + 60.0) / 60.0).clamp(0.0, 1.0);
    row().items_center().gap_2().child(label(channel)).child(
        row()
            .gap(px(2.))
            .h(px(5.))
            .flex_1()
            .children((0..20).map(|index| {
                let value = (index + 1) as f32 / 20.0;
                let color = if value > lit {
                    BORDER
                } else if value > 0.9 {
                    0xf5c279
                } else {
                    ACCENT
                };
                div().flex_1().bg(rgb(color)).rounded_sm()
            })),
    )
}

fn compact_path(path: &Path) -> String {
    let name = path.file_name().map(|name| name.to_string_lossy());
    match (path.parent().and_then(Path::file_name), name) {
        (Some(parent), Some(name)) => format!("{} / {name}", parent.to_string_lossy()),
        (_, Some(name)) => name.into_owned(),
        _ => path.display().to_string(),
    }
}

fn overlay(id: &'static str, close: Command, cx: &Context<Player>) -> Stateful<Div> {
    div()
        .id(id)
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .p_6()
        .child(
            div()
                .id("backdrop")
                .absolute()
                .inset_0()
                .occlude()
                .bg(gpui::rgba(0x090b13c5))
                .on_click(cx.listener(move |player, _, _, cx| player.dispatch(close, cx))),
        )
}

fn credits_overlay(cx: &Context<Player>) -> Stateful<Div> {
    overlay("credits-dialog", Command::ToggleCredits, cx).child(
        panel()
            .occlude()
            .w_full()
            .max_w(px(540.))
            .p_5()
            .gap_4()
            .child(
                row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .child("Credits"),
                    )
                    .child(button(
                        "close-credits",
                        "Close",
                        Command::ToggleCredits,
                        true,
                        false,
                        cx,
                    )),
            )
            .child(
                row()
                    .items_center()
                    .gap_3()
                    .rounded_md()
                    .bg(rgb(BACKGROUND))
                    .p_3()
                    .child(img(credits::icon()).size(px(66.)).flex_none())
                    .child(
                        column()
                            .gap_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_xl()
                                    .font_weight(FontWeight::BOLD)
                                    .child("My Band Practice"),
                            )
                            .child(label(concat!("Windows · v", env!("CARGO_PKG_VERSION"))))
                            .child(label("© 2026 kjranyone")),
                    ),
            )
            .child(
                row()
                    .gap_2()
                    .child(button(
                        "project-link",
                        "GitHub repository",
                        Command::OpenCreditLink(credits::PROJECT_URL),
                        true,
                        false,
                        cx,
                    ))
                    .child(button(
                        "license-link",
                        "MIT License",
                        Command::OpenCreditLink(credits::LICENSE_URL),
                        true,
                        false,
                        cx,
                    )),
            )
            .child(
                column()
                    .gap_1()
                    .child(label("Open-source libraries").pb_1())
                    .children(credits::LIBRARIES.iter().map(|credit| {
                        row()
                            .id(credit.name)
                            .items_center()
                            .justify_between()
                            .gap_2()
                            .min_h(px(37.))
                            .px_2()
                            .rounded_md()
                            .cursor_pointer()
                            .hover(|style| style.bg(rgb(CONTROL)))
                            .on_click(cx.listener(move |player, _, _, cx| {
                                player.dispatch(Command::OpenCreditLink(credit.url), cx)
                            }))
                            .child(
                                row()
                                    .items_center()
                                    .gap_2()
                                    .child(div().font_weight(FontWeight::MEDIUM).child(credit.name))
                                    .child(label(credit.role)),
                            )
                            .child(label(credit.license))
                    })),
            ),
    )
}

fn sync_overlay(sync: &sync::Panel, cx: &Context<Player>) -> Stateful<Div> {
    let title = if sync.finished { "Close" } else { "Cancel" };
    overlay("sync-dialog", Command::CloseSync, cx).child(
        panel()
            .occlude()
            .w(px(440.))
            .p_5()
            .gap_4()
            .child(
                row()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::BOLD)
                            .child("Sync to other device"),
                    )
                    .child(button(
                        "close-sync",
                        title,
                        Command::CloseSync,
                        true,
                        false,
                        cx,
                    )),
            )
            .child(div().child(sync.status.clone()))
            .when_some(sync.error.as_ref(), |panel, error| {
                panel.child(div().text_color(rgb(WARNING)).child(error.clone()))
            })
            .when_some(sync.offer.as_ref(), |panel, (_, qr)| {
                panel
                    .child(label(
                        "On the same Wi-Fi, open Sync → Receive on the other device.",
                    ))
                    .child(div().mx_auto().child(sync_qr(qr)))
                    .child(
                        row()
                            .gap_2()
                            .flex_wrap()
                            .child(button(
                                "open-answer-image",
                                "Open answer QR image",
                                Command::OpenAnswerImage,
                                true,
                                true,
                                cx,
                            ))
                            .child(button(
                                "paste-answer",
                                "Paste answer",
                                Command::PasteAnswer,
                                true,
                                false,
                                cx,
                            ))
                            .child(button(
                                "copy-offer",
                                "Copy offer",
                                Command::CopyOffer,
                                true,
                                false,
                                cx,
                            )),
                    )
            })
            .when_some(sync.progress, |panel, (sent, total)| {
                let percent = if total == 0 {
                    100.0
                } else {
                    (sent as f32 / total as f32 * 100.0).min(100.0)
                };
                panel
                    .child(
                        div().w_full().h(px(5.)).rounded_sm().bg(rgb(BORDER)).child(
                            div()
                                .w(gpui::relative(percent / 100.0))
                                .h_full()
                                .rounded_sm()
                                .bg(rgb(ACCENT)),
                        ),
                    )
                    .child(label(format!("{percent:.0}%")))
            }),
    )
}

fn sync_qr(qr: &qrcode::QrCode) -> impl IntoElement {
    let width = qr.width();
    let colors = qr.to_colors();
    // Whole-pixel modules and the four-module quiet zone improve phone scanning.
    let scale = (280 / (width + 8)).max(2) as f32;
    let extent = px((width + 8) as f32 * scale);
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            window.paint_quad(fill(bounds, gpui::white()));
            let start = bounds.origin + point(px(4. * scale), px(4. * scale));
            for (index, color) in colors.into_iter().enumerate() {
                if color == qrcode::Color::Dark {
                    let origin = start
                        + point(
                            px((index % width) as f32 * scale),
                            px((index / width) as f32 * scale),
                        );
                    window.paint_quad(fill(
                        Bounds::new(origin, size(px(scale), px(scale))),
                        gpui::black(),
                    ));
                }
            }
        },
    )
    .size(extent)
}

fn wave_background(bars: [u8; WAVE_BARS]) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let y = bounds.origin.y + bounds.size.height * 0.48;
            let step = bounds.size.width / WAVE_BARS as f32;
            for (index, value) in bars.into_iter().enumerate() {
                if value == 0 {
                    continue;
                }
                let height = bounds.size.height * (f32::from(value) / 255.0).sqrt() * 0.68;
                let x = bounds.origin.x + step * index as f32;
                window.paint_quad(fill(
                    Bounds::new(point(x, y - height / 2.), size(step * 0.55, height)),
                    gpui::rgba(0xa9c36b12),
                ));
            }
        },
    )
    .absolute()
    .inset_0()
}

impl Player {
    fn song_sheet_overlay(&self, cx: &Context<Self>) -> Stateful<Div> {
        overlay("song-sheet-dialog", Command::ToggleSongSheet, cx).child(
            column()
                .occlude()
                .w_full()
                .max_w(px(790.))
                .rounded_xl()
                .border_1()
                .border_color(rgb(BORDER))
                .bg(rgb(PANEL))
                .overflow_hidden()
                .child(
                    row()
                        .items_center()
                        .justify_between()
                        .gap_3()
                        .px_5()
                        .py_3()
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_lg()
                                .font_weight(FontWeight::BOLD)
                                .child(
                                    self.active
                                        .as_ref()
                                        .map_or_else(String::new, |song| song.title.clone()),
                                ),
                        )
                        .child(
                            button(
                                "close-song-sheet",
                                "Close",
                                Command::ToggleSongSheet,
                                true,
                                false,
                                cx,
                            )
                            .flex_none(),
                        ),
                )
                .child(
                    self.practice_sheet(false, cx)
                        .rounded_none()
                        .border_0()
                        .border_t_1(),
                ),
        )
    }

    fn practice_sheet(&self, wide: bool, cx: &Context<Self>) -> Div {
        let show_chords = self.chords.is_some() && (self.show_chords || self.lyrics.is_empty());
        panel()
            .w_full()
            .min_w_0()
            .when(wide, |panel| panel.flex_1())
            .p_5()
            .gap_3()
            .child(if self.chords.is_some() && !self.lyrics.is_empty() {
                row()
                    .gap_2()
                    .child(button(
                        "lyrics-tab",
                        "Lyrics",
                        Command::ShowChords(false),
                        true,
                        !show_chords,
                        cx,
                    ))
                    .child(button(
                        "chords-tab",
                        "Chords",
                        Command::ShowChords(true),
                        true,
                        show_chords,
                        cx,
                    ))
            } else {
                div()
                    .text_xl()
                    .font_weight(FontWeight::BOLD)
                    .child(if show_chords { "Chords" } else { "Lyrics" })
            })
            .when(show_chords, |sheet| {
                sheet.child(self.chord_bars(self.chords.as_ref().unwrap(), cx))
            })
            .when(!show_chords, |sheet| {
                sheet.child(
                    column()
                        .id(SharedString::from(format!(
                            "lyrics-{}",
                            self.active.as_ref().map_or("", |song| song.slug.as_str())
                        )))
                        .h(px(350.))
                        .overflow_y_scroll()
                        .gap_3()
                        .children(self.lyrics.iter().map(|block| {
                            match block {
                                LyricsBlock::Heading(text) => {
                                    div().font_weight(FontWeight::SEMIBOLD).child(text.clone())
                                }
                                LyricsBlock::Artist(text) => label(text.clone()),
                                LyricsBlock::Section(text) => {
                                    div().text_xs().text_color(rgb(ACCENT)).child(text.clone())
                                }
                                LyricsBlock::Stanza(lines) => column()
                                    .gap_1()
                                    .children(lines.iter().cloned().map(|line| div().child(line))),
                            }
                        })),
                )
            })
    }

    fn chord_bars(&self, chart: &ChordChart, cx: &Context<Self>) -> Div {
        column()
            .child(
                row()
                    .h(px(30.))
                    .gap_3()
                    .items_start()
                    .when_some(chart.key.as_ref(), |header, key| {
                        header.child(
                            label(chords::transpose(key, self.pitch)).text_color(rgb(ACCENT)),
                        )
                    })
                    .when_some(chart.bpm, |header, bpm| {
                        header.child(label(format!("{bpm:.0} BPM")))
                    })
                    .when_some(chart.time_signature.as_ref(), |header, meter| {
                        header.child(label(meter.clone()))
                    }),
            )
            .child(
                gpui::uniform_list(
                    SharedString::from(format!(
                        "chords-{}",
                        self.active.as_ref().map_or("", |song| song.slug.as_str())
                    )),
                    chart.bars.len().div_ceil(2),
                    cx.processor(|player, range: std::ops::Range<usize>, _, cx| {
                        range
                            .map(|index| player.chord_row(index, cx))
                            .collect::<Vec<_>>()
                    }),
                )
                .h(px(320.)),
            )
    }

    fn chord_row(&self, row_index: usize, cx: &Context<Self>) -> Div {
        let ready = self.busy.is_none();
        let position = self.transport.position;
        let start = row_index * 2;
        let bars = self
            .chords
            .as_ref()
            .map(|chart| chart.bars.iter().skip(start).take(2));
        row()
            .h(px(78.))
            .pb_2()
            .gap_2()
            .children(bars.into_iter().flatten().enumerate().map(|(offset, bar)| {
                let index = start + offset;
                let active = position >= bar.start && position < bar.end;
                column()
                    .id(("chart-bar", index))
                    .flex_1()
                    .min_w_0()
                    .rounded_md()
                    .border_1()
                    .overflow_hidden()
                    .border_color(rgb(if active { WAVE_PLAYED } else { BORDER }))
                    .bg(rgb(BACKGROUND))
                    .px_2()
                    .py_1()
                    .gap_1()
                    .child(
                        label(format!("{:02}", bar.bar_number.unwrap_or(index + 1)))
                            .font_family("Consolas"),
                    )
                    .child(
                        row()
                            .id("symbols")
                            .gap_1()
                            .overflow_x_scroll()
                            .items_center()
                            .when(bar.chords.is_empty(), |cells| {
                                cells.child(button(
                                    "no-chord",
                                    "N.C.",
                                    Command::SeekTo(bar.start),
                                    ready,
                                    false,
                                    cx,
                                ))
                            })
                            .children(bar.chords.iter().enumerate().map(|(chord_index, chord)| {
                                let playing =
                                    active && position >= chord.start && position < chord.end;
                                button(
                                    ("chord", chord_index),
                                    chords::transpose(&chord.chord, self.pitch),
                                    Command::SeekTo(chord.start),
                                    ready,
                                    playing,
                                    cx,
                                )
                                .h(px(27.))
                                .flex_none()
                                .text_sm()
                                .font_family("Consolas")
                            })),
                    )
            }))
    }
}

fn row() -> Div {
    div().flex()
}

fn column() -> Div {
    div().flex().flex_col()
}

fn panel() -> Div {
    column()
        .bg(rgb(PANEL))
        .rounded_xl()
        .border_1()
        .border_color(rgb(BORDER))
}

fn label(text: impl Into<SharedString>) -> Div {
    div().text_xs().text_color(rgb(MUTED)).child(text.into())
}

fn time_label(seconds: f64) -> Div {
    let seconds = seconds.max(0.0) as u64;
    label(format!("{}:{:02}", seconds / 60, seconds % 60)).font_family("Consolas")
}

fn gain_label(
    id: impl Into<ElementId>,
    gain: f32,
    command: Command,
    enabled: bool,
    cx: &Context<Player>,
) -> Stateful<Div> {
    button(
        id,
        format!("{:.0}%", gain * 100.0),
        command,
        enabled,
        false,
        cx,
    )
    .font_family("Consolas")
    .h(px(25.))
    .w(px(42.))
    .px_0()
    .flex_none()
}

fn stem_label(name: &str) -> String {
    let mut letters = name.chars();
    letters.next().map_or_else(String::new, |first| {
        format!("{}{}", first.to_uppercase(), letters.as_str())
    })
}

fn stem_color(name: &str) -> u32 {
    match name {
        "vocals" => 0xbea5ff,
        "drums" => 0x74dcd5,
        "bass" => 0xffbf87,
        "other" => 0x8bb9ff,
        _ => ACCENT,
    }
}

fn button(
    id: impl Into<ElementId>,
    text: impl Into<SharedString>,
    command: Command,
    enabled: bool,
    selected: bool,
    cx: &Context<Player>,
) -> Stateful<Div> {
    row()
        .id(id)
        .h(px(33.))
        .px_2()
        .items_center()
        .justify_center()
        .rounded_md()
        .bg(rgb(if selected && enabled { ACCENT } else { CONTROL }))
        .text_color(rgb(if !enabled {
            MUTED
        } else if selected {
            INK
        } else {
            TEXT
        }))
        .font_weight(FontWeight::MEDIUM)
        .text_xs()
        .when(enabled, |button| {
            button
                .cursor_pointer()
                .hover(|style| style.bg(rgb(if selected { 0xe0fa9b } else { HOVER })))
                .on_click(cx.listener(move |player, _, _, cx| player.dispatch(command, cx)))
        })
        .child(text.into())
}

fn stepper(
    name: &'static str,
    value: String,
    decrease: Command,
    increase: Command,
    enabled: bool,
    cx: &Context<Player>,
) -> Div {
    row()
        .items_center()
        .gap_1()
        .child(button((name, 0_u32), "−", decrease, enabled, false, cx).w(px(27.)))
        .child(
            column()
                .items_center()
                .w(px(50.))
                .child(label(if name == "speed" { "Speed" } else { "Pitch" }))
                .child(div().text_xs().font_family("Consolas").child(value)),
        )
        .child(button((name, 1_u32), "+", increase, enabled, false, cx).w(px(27.)))
}

fn slider(
    id: impl Into<ElementId>,
    value: f64,
    color: u32,
    enabled: bool,
    command: impl Fn(f64) -> Command + Clone + 'static,
    cx: &Context<Player>,
) -> Stateful<Div> {
    let id = id.into();
    let mouse_down_id = id.clone();
    let mouse_move_id = id.clone();
    let bounds = Rc::new(Cell::new(Bounds::default()));
    let draw_bounds = bounds.clone();
    let click_bounds = bounds.clone();
    let click_command = command.clone();
    div()
        .id(id)
        .h(px(22.))
        .min_w(px(20.))
        .when(enabled, |slider| {
            slider.cursor_pointer().on_mouse_down(
                MouseButton::Left,
                cx.listener(move |player, event: &gpui::MouseDownEvent, _, cx| {
                    player.dragged_gain = Some(mouse_down_id.clone());
                    player.dispatch(
                        click_command(slider_value(click_bounds.get(), event.position.x)),
                        cx,
                    );
                }),
            )
        })
        .when(enabled, |slider| {
            slider.on_mouse_move(
                cx.listener(move |player, event: &gpui::MouseMoveEvent, _, cx| {
                    if event.pressed_button == Some(MouseButton::Left)
                        && player.dragged_gain.as_ref() == Some(&mouse_move_id)
                    {
                        player.dispatch(command(slider_value(bounds.get(), event.position.x)), cx);
                    }
                }),
            )
        })
        .child(
            canvas(
                move |bounds, _, _| draw_bounds.set(bounds),
                move |bounds, (), window, _| {
                    let value = value.clamp(0.0, 1.0) as f32;
                    let x = bounds.origin.x + px(4.);
                    let y = bounds.origin.y + bounds.size.height / 2.;
                    let width = (bounds.size.width - px(8.)).max(px(1.));
                    window.paint_quad(fill(
                        Bounds::new(point(x, y - px(2.)), size(width, px(4.))),
                        rgb(BORDER),
                    ));
                    if value > 0.0 {
                        window.paint_quad(fill(
                            Bounds::new(point(x, y - px(2.)), size(width * value, px(4.))),
                            rgb(color),
                        ));
                    }
                    let thumb = Bounds::new(
                        point(x + width * value - px(3.), y - px(5.)),
                        size(px(6.), px(10.)),
                    );
                    window.paint_quad(fill(thumb, rgb(color)));
                },
            )
            .size_full(),
        )
}

fn slider_value(bounds: Bounds<Pixels>, x: Pixels) -> f64 {
    let width = (bounds.size.width - px(8.)).max(px(1.));
    f64::from(((x - bounds.origin.x - px(4.)) / width).clamp(0.0, 1.0))
}
