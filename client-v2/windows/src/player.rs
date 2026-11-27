use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui::{AppContext, ClipboardItem, Context, ElementId, FocusHandle, PathPromptOptions, Window};
use mbp_core::{Engine, MAX_GAIN};
use rand::seq::SliceRandom;

use crate::audio::{Output, Playback, Waveform, WAVE_BARS};
use crate::chords::ChordChart;
use crate::library::{self, LoadedSong, LyricsBlock, Setlist, SongEntry};
use crate::sync;
use crate::waveform;

const WARM_CACHE_BYTES: usize = 128 * 1024 * 1024;

pub struct Selection {
    pub song: SongEntry,
    playing: bool,
}

pub struct Track {
    pub name: String,
    pub gain: f32,
    pub muted: bool,
}

#[derive(Clone, Default, PartialEq)]
pub struct Transport {
    pub position: f64,
    pub duration: f64,
    pub playing: bool,
    pub buffering: bool,
    pub ended: bool,
    pub error: Option<String>,
}

impl Transport {
    fn read(engine: &Engine) -> Self {
        Self {
            position: engine.position(),
            duration: engine.duration(),
            playing: engine.is_playing(),
            buffering: engine.is_buffering(),
            ended: engine.ended(),
            error: engine.last_error(),
        }
    }
}

pub struct Player {
    pub focus: FocusHandle,
    pub songs: Vec<SongEntry>,
    pub library_path: Option<PathBuf>,
    pub library_open: bool,
    pub credits_open: bool,
    pub setlists: Vec<Setlist>,
    pub playlist: Option<usize>,
    pub playlist_open: bool,
    pub playlist_edit: bool,
    pub playlist_add: bool,
    pub shuffle: bool,
    pub active: Option<SongEntry>,
    pub selection: Option<Selection>,
    pub lyrics: Vec<LyricsBlock>,
    pub chords: Option<ChordChart>,
    pub show_chords: bool,
    pub song_sheet_open: bool,
    pub tracks: Vec<Track>,
    pub transport: Transport,
    pub solo: Option<usize>,
    pub master: f32,
    pub rate: f64,
    pub pitch: i32,
    pub busy: Option<&'static str>,
    pub error: Option<String>,
    pub output_error: Option<String>,
    pub wave_bars: [u8; WAVE_BARS],
    pub meters: [f32; 2],
    pub limiter_gain: f32,
    pub compressor: bool,
    pub sync_panel: Option<sync::Panel>,
    pub dragged_gain: Option<ElementId>,
    pub seek_peaks: Arc<[f32]>,
    pub seek_preview: Option<f64>,
    pub seek_hover: Option<f64>,
    waveform_cancel: Option<Arc<AtomicBool>>,
    waveform_cache: VecDeque<(PathBuf, Arc<[f32]>)>,
    track_settings: HashMap<String, (f32, bool)>,
    solo_name: Option<String>,
    loading: Option<PathBuf>,
    preloading: Option<PathBuf>,
    last_preloaded: Option<PathBuf>,
    warm: VecDeque<(PathBuf, LoadedSong)>,
    shuffled: Vec<usize>,
    sync_id: u64,
    setlists_dir: Option<PathBuf>,
    playback: Arc<Mutex<Playback>>,
    output: Option<Output>,
    picking_folder: bool,
}

#[derive(Clone, Copy)]
pub enum Command {
    OpenFolder,
    ToggleLibrary,
    ToggleCredits,
    OpenCreditLink(&'static str),
    Load(usize),
    TogglePlaylists,
    Playlist(Option<usize>),
    NewPlaylist,
    EditPlaylist,
    AddPlaylistSongs,
    AddToPlaylist(usize),
    EditPlaylistSong(usize, i32),
    TrackStep(i32),
    Shuffle,
    TogglePlayback,
    Skip(f64),
    Seek(f64),
    Rate(f64),
    Pitch(i32),
    ResetTuning,
    SetGain(usize, f32),
    Mute(usize),
    Solo(usize),
    Master(f32),
    Compressor,
    OpenSync,
    CloseSync,
    CopyOffer,
    PasteAnswer,
    OpenAnswerImage,
    ShowChords(bool),
    ToggleSongSheet,
    SeekTo(f64),
    Reconnect,
}

impl Player {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window);
        let mut player = Self {
            focus,
            songs: Vec::new(),
            library_path: None,
            library_open: false,
            credits_open: false,
            setlists: Vec::new(),
            playlist: None,
            playlist_open: false,
            playlist_edit: false,
            playlist_add: false,
            shuffle: false,
            active: None,
            selection: None,
            lyrics: Vec::new(),
            chords: None,
            show_chords: false,
            song_sheet_open: false,
            tracks: Vec::new(),
            transport: Transport::default(),
            solo: None,
            master: 1.0,
            rate: 1.0,
            pitch: 0,
            busy: None,
            error: None,
            output_error: None,
            wave_bars: [0; WAVE_BARS],
            meters: [0.0; 2],
            limiter_gain: 1.0,
            compressor: false,
            sync_panel: None,
            dragged_gain: None,
            seek_peaks: Arc::default(),
            seek_preview: None,
            seek_hover: None,
            waveform_cancel: None,
            waveform_cache: VecDeque::new(),
            track_settings: HashMap::new(),
            solo_name: None,
            loading: None,
            preloading: None,
            last_preloaded: None,
            warm: VecDeque::new(),
            shuffled: Vec::new(),
            sync_id: 0,
            setlists_dir: None,
            playback: Arc::new(Mutex::new(Playback {
                engine: Engine::new(),
                revision: 0,
                waveform: Waveform::default(),
                compressor: false,
                meters: [0.0; 2],
                limiter_gain: 1.0,
            })),
            output: None,
            picking_folder: false,
        };
        player.connect();
        if let Some(path) = library::startup_path() {
            player.open(path, cx);
        }
        let executor = cx.background_executor().clone();
        cx.spawn(async move |entity, cx| loop {
            executor.timer(Duration::from_millis(65)).await;
            if entity
                .update(cx, |player, cx| {
                    let ended = player.transport.ended;
                    let changed = player.refresh();
                    if !ended
                        && player.transport.ended
                        && player.playlist.is_some()
                        && player.selection.is_none()
                    {
                        player.step_track(1, true, cx);
                    }
                    if changed {
                        cx.notify();
                    }
                })
                .is_err()
            {
                break;
            }
        })
        .detach();
        player
    }

    fn connect(&mut self) {
        self.output = None;
        self.output_error = match Output::open(self.playback.clone()) {
            Ok(output) => {
                self.output = Some(output);
                None
            }
            Err(error) => Some(error),
        };
    }

    fn refresh(&mut self) -> bool {
        let error = self
            .output
            .as_ref()
            .and_then(|output| output.error.try_lock().ok()?.take());
        let mut changed = error.is_some();
        if let Some(error) = error {
            self.output = None;
            self.output_error = Some(error);
        }
        if self.busy.is_none() {
            if let Ok(mut state) = self.playback.try_lock() {
                if self.output.is_none() && state.engine.is_playing() {
                    state.engine.pause();
                    state.revision += 1;
                }
                let transport = Transport::read(&state.engine);
                changed |= self.transport != transport;
                self.transport = transport;
                let wave_bars = state.waveform.values();
                changed |= self.wave_bars != wave_bars;
                self.wave_bars = wave_bars;
                changed |= self.meters != state.meters || self.limiter_gain != state.limiter_gain;
                self.meters = state.meters;
                self.limiter_gain = state.limiter_gain;
            }
        }
        changed | self.sync_panel.as_mut().is_some_and(sync::Panel::refresh)
    }

    pub fn dispatch(&mut self, command: Command, cx: &mut Context<Self>) {
        if self.picking_folder {
            return;
        }
        match command {
            Command::ToggleCredits => self.credits_open = !self.credits_open,
            Command::OpenCreditLink(url) => cx.open_url(url),
            Command::OpenFolder if self.busy.is_none() => self.choose_folder(cx),
            Command::ToggleLibrary => self.library_open = !self.library_open,
            Command::Load(index) => {
                if let Some(song) = self.songs.get(index).cloned() {
                    self.select(song, cx);
                    self.shuffle_queue();
                    self.preload_neighbor(cx);
                }
            }
            Command::TogglePlaylists => self.playlist_open = !self.playlist_open,
            Command::Playlist(index) => {
                self.playlist = index.filter(|index| *index < self.setlists.len());
                self.playlist_edit = false;
                self.playlist_add = false;
                let visible = self.visible_songs();
                if self.selection.as_ref().is_some_and(|next| {
                    !visible
                        .iter()
                        .any(|&i| self.songs[i].chunks == next.song.chunks)
                }) {
                    self.selection = None;
                }
                self.shuffle_queue();
                if !visible.iter().any(|&index| {
                    self.active
                        .as_ref()
                        .is_some_and(|active| active.chunks == self.songs[index].chunks)
                }) && self.selection.is_none()
                {
                    if let Some(&first) = self.shuffled.first().or_else(|| visible.first()) {
                        self.select(self.songs[first].clone(), cx);
                    }
                }
                self.preload_neighbor(cx);
            }
            Command::NewPlaylist => self.new_playlist(cx),
            Command::EditPlaylist => {
                self.playlist_edit = !self.playlist_edit;
                self.playlist_add = false;
            }
            Command::AddPlaylistSongs => self.playlist_add = !self.playlist_add,
            Command::AddToPlaylist(song) => self.edit_playlist(song, None, cx),
            Command::EditPlaylistSong(song, edit) => self.edit_playlist(song, Some(edit), cx),
            Command::Shuffle => {
                self.shuffle = !self.shuffle;
                self.shuffle_queue();
                self.preload_neighbor(cx);
            }
            Command::TrackStep(step) => self.step_track(step, false, cx),
            Command::OpenSync => {
                if !self.songs.is_empty() {
                    self.sync_id += 1;
                    self.sync_panel = Some(sync::Panel::new(
                        self.sync_id,
                        self.songs.clone(),
                        self.setlists.clone(),
                    ));
                }
            }
            Command::CloseSync => self.sync_panel = None,
            Command::CopyOffer => {
                if let Some((offer, _)) = self
                    .sync_panel
                    .as_ref()
                    .and_then(|panel| panel.offer.as_ref())
                {
                    cx.write_to_clipboard(ClipboardItem::new_string(offer.clone()));
                }
            }
            Command::PasteAnswer => {
                if let Some(panel) = &mut self.sync_panel {
                    let answer = cx
                        .read_from_clipboard()
                        .and_then(|item| item.text())
                        .ok_or_else(|| anyhow::anyhow!("The clipboard has no answer code."))
                        .and_then(|code| sync::decode_answer(&code));
                    panel.accept(answer);
                }
            }
            Command::OpenAnswerImage => self.open_answer_image(cx),
            Command::ShowChords(show) => self.show_chords = show,
            Command::ToggleSongSheet => {
                self.song_sheet_open = !self.song_sheet_open;
                if self.song_sheet_open && self.chords.is_some() {
                    self.show_chords = true;
                }
            }
            _ if self.busy.is_some() => return,
            Command::Reconnect => self.connect(),
            _ if self.active.is_none() => return,
            Command::Seek(fraction) => self.seek(self.transport.duration * fraction, cx),
            Command::SeekTo(seconds) => self.seek(seconds, cx),
            Command::Skip(seconds) => self.seek(self.transport.position + seconds, cx),
            _ => self.adjust(command),
        }
        cx.notify();
    }

    fn new_playlist(&mut self, cx: &mut Context<Self>) {
        let Some(directory) = self.setlists_dir.clone() else {
            return;
        };
        self.picking_folder = true;
        let prepare = cx.background_spawn(async move {
            std::fs::create_dir_all(&directory)?;
            std::path::absolute(directory)
        });
        cx.spawn(async move |entity, cx| {
            let directory = prepare.await;
            let result = match directory {
                Ok(directory) => {
                    let result = entity.update(cx, |_, cx| {
                        cx.prompt_for_new_path(&directory, Some("New playlist.json"))
                    });
                    if let Ok(prompt) = result {
                        match prompt.await {
                            Ok(Ok(Some(path))) => {
                                cx.background_executor()
                                    .spawn(
                                        async move { create_playlist(&directory, path).map(Some) },
                                    )
                                    .await
                            }
                            Ok(Ok(None)) => Ok(None),
                            Ok(Err(error)) => Err(error),
                            Err(error) => Err(error.into()),
                        }
                    } else {
                        return;
                    }
                }
                Err(error) => Err(error.into()),
            };
            let _ = entity.update(cx, |player, cx| {
                player.picking_folder = false;
                match result {
                    Ok(Some(list)) => {
                        player.playlist = Some(player.setlists.len());
                        player.setlists.push(list);
                        player.selection = None;
                        player.playlist_edit = true;
                        player.playlist_add = true;
                        player.shuffle_queue();
                    }
                    Ok(None) => (),
                    Err(error) => player.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn edit_playlist(&mut self, song_index: usize, edit: Option<i32>, cx: &mut Context<Self>) {
        let (Some(index), Some(song)) = (self.playlist, self.songs.get(song_index)) else {
            return;
        };
        let mut list = self.setlists[index].clone();
        let position = list.songs.iter().position(|slug| slug == &song.slug);
        match (position, edit) {
            (None, None) => list.songs.push(song.slug.clone()),
            (Some(_), Some(0)) => list.songs.retain(|slug| slug != &song.slug),
            (Some(position), Some(offset)) => {
                let mut positions = list
                    .songs
                    .iter()
                    .enumerate()
                    .filter(|(_, slug)| self.songs.iter().any(|song| &song.slug == *slug))
                    .map(|(index, _)| index);
                let to = if offset < 0 {
                    positions.rfind(|&index| index < position)
                } else {
                    positions.find(|&index| index > position)
                };
                let Some(to) = to else {
                    return;
                };
                list.songs.swap(position, to);
            }
            _ => return,
        }
        match list.save(false) {
            Ok(()) => {
                self.setlists[index] = list;
                self.error = None;
                self.shuffle_queue();
                self.preload_neighbor(cx);
            }
            Err(error) => self.error = Some(format!("Could not save the playlist. {error}")),
        }
    }

    fn open_answer_image(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self
            .sync_panel
            .as_ref()
            .filter(|panel| panel.offer.is_some())
            .map(|panel| panel.id)
        else {
            return;
        };
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Open the answer QR image".into()),
        });
        cx.spawn(async move |entity, cx| {
            let answer = match paths.await {
                Ok(Ok(Some(paths))) => {
                    let Some(path) = paths.into_iter().next() else {
                        return;
                    };
                    cx.background_executor()
                        .spawn(async move { sync::answer_from_image(&path) })
                        .await
                }
                Ok(Ok(None)) => return,
                Ok(Err(error)) => Err(error),
                Err(error) => Err(error.into()),
            };
            let _ = entity.update(cx, |player, cx| {
                if let Some(panel) = player.sync_panel.as_mut().filter(|panel| panel.id == id) {
                    panel.accept(answer);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn choose_folder(&mut self, cx: &mut Context<Self>) {
        self.picking_folder = true;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose a songs folder or a song".into()),
        });
        cx.spawn(async move |entity, cx| {
            let result = paths.await;
            let _ = entity.update(cx, |player, cx| {
                player.picking_folder = false;
                match result {
                    Ok(Ok(Some(paths))) => {
                        if let Some(path) = paths.into_iter().next() {
                            player.open(path, cx);
                        }
                    }
                    Ok(Ok(None)) => (),
                    Ok(Err(error)) => player.error = Some(error.to_string()),
                    Err(error) => player.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        self.busy = Some("Scanning library…");
        self.error = None;
        let path = std::path::absolute(&path).unwrap_or(path);
        let directory = path.clone();
        let scan = cx.background_spawn(async move { library::scan(&directory) });
        cx.spawn(async move |entity, cx| {
            let result = scan.await;
            let _ = entity.update(cx, |player, cx| {
                player.busy = None;
                match result {
                    Ok(library) => {
                        player.library_path = Some(path);
                        player.library_open = false;
                        let songs = library.songs;
                        let first = songs[0].clone();
                        player.songs = songs;
                        player.playlist = None;
                        player.playlist_open = false;
                        player.playlist_edit = false;
                        player.playlist_add = false;
                        player.setlists = library.setlists;
                        player.setlists_dir = Some(library.setlists_dir);
                        player.shuffled.clear();
                        if !player.songs.iter().any(|song| {
                            player
                                .active
                                .as_ref()
                                .is_some_and(|active| active.chunks == song.chunks)
                        }) {
                            player.select(first, cx);
                        } else {
                            player.advance_selection(cx);
                        }
                    }
                    Err(error) => {
                        player.error = Some(error);
                        player.advance_selection(cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn wants_playback(&self) -> bool {
        self.selection
            .as_ref()
            .map_or(self.transport.playing, |next| next.playing)
    }

    pub fn visible_songs(&self) -> Vec<usize> {
        let Some(playlist) = self.playlist.map(|index| &self.setlists[index]) else {
            return (0..self.songs.len()).collect();
        };
        let mut seen = std::collections::HashSet::new();
        playlist
            .songs
            .iter()
            .filter(|slug| seen.insert(*slug))
            .filter_map(|slug| self.songs.iter().position(|song| &song.slug == slug))
            .collect()
    }

    fn shuffle_queue(&mut self) {
        self.shuffled = if self.shuffle && self.playlist.is_some() {
            self.visible_songs()
        } else {
            Vec::new()
        };
        self.shuffled.shuffle(&mut rand::rng());
        let current = self
            .selection
            .as_ref()
            .map(|next| &next.song)
            .or(self.active.as_ref());
        if let Some(index) = self
            .shuffled
            .iter()
            .position(|&i| current.is_some_and(|song| self.songs[i].chunks == song.chunks))
        {
            self.shuffled.swap(0, index);
        }
    }

    pub fn neighboring_track(&self, step: i32) -> Option<usize> {
        let visible;
        let queue = if self.shuffle && self.playlist.is_some() {
            &self.shuffled
        } else {
            visible = self.visible_songs();
            &visible
        };
        let current = self
            .selection
            .as_ref()
            .map(|next| &next.song)
            .or(self.active.as_ref())?;
        let index = queue
            .iter()
            .position(|&i| self.songs[i].chunks == current.chunks)?;
        queue.get(index.checked_add_signed(step as isize)?).copied()
    }

    fn step_track(&mut self, step: i32, autoplay: bool, cx: &mut Context<Self>) {
        if let Some(song) = self
            .neighboring_track(step)
            .map(|index| self.songs[index].clone())
        {
            self.request(song, autoplay || self.wants_playback(), cx);
        }
    }

    fn select(&mut self, song: SongEntry, cx: &mut Context<Self>) {
        let playing = self.selection.as_ref().map_or_else(
            || {
                self.playback
                    .try_lock()
                    .map_or(self.transport.playing, |state| state.engine.is_playing())
            },
            |selection| selection.playing,
        );
        self.request(song, playing, cx);
    }

    fn request(&mut self, song: SongEntry, playing: bool, cx: &mut Context<Self>) {
        self.error = None;
        self.selection = (!self
            .active
            .as_ref()
            .is_some_and(|active| active.chunks == song.chunks))
        .then_some(Selection { song, playing });
        self.advance_selection(cx);
    }

    fn advance_selection(&mut self, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        let Some(selection) = self.selection.as_ref() else {
            return;
        };
        let path = &selection.song.chunks;
        if let Some(index) = self.warm.iter().position(|(key, _)| key == path) {
            let (_, ready) = self.warm.remove(index).unwrap();
            self.install(ready, cx);
        } else if self.loading.is_none() && self.preloading.as_ref() != Some(path) {
            self.start_load(selection.song.clone(), false, cx);
        }
    }

    fn start_load(&mut self, song: SongEntry, preload: bool, cx: &mut Context<Self>) {
        let path = song.chunks.clone();
        if preload {
            self.preloading = Some(path.clone());
            self.last_preloaded = Some(path.clone());
        } else {
            self.loading = Some(path.clone());
        }
        let load = cx.background_spawn(async move { song.load() });
        cx.spawn(async move |entity, cx| {
            let result = load.await;
            let _ = entity.update(cx, move |player, cx| {
                if preload {
                    player.preloading = None;
                } else {
                    player.loading = None;
                }
                let wanted = player
                    .selection
                    .as_ref()
                    .filter(|next| next.song.chunks == path);
                let loaded = result.is_ok();
                match result {
                    Ok(ready) if wanted.is_some() && player.busy.is_none() => {
                        player.install(ready, cx);
                    }
                    Ok(ready) if wanted.is_some() => {
                        // A seek may still hold the audio engine. Keep this result until it completes.
                        player.warm.push_back((path, ready));
                    }
                    Ok(ready) => player.cache(path, ready, cx),
                    Err(error) if !preload && wanted.is_some() => {
                        let title = &wanted.unwrap().song.title;
                        player.error = Some(format!("Could not load {title}. {error}"));
                        player.selection = None;
                    }
                    Err(_) => (),
                }
                player.advance_selection(cx);
                if loaded {
                    player.preload_neighbor(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn install(&mut self, ready: LoadedSong, cx: &mut Context<Self>) {
        let Selection { song, playing } = self.selection.take().unwrap();
        let LoadedSong {
            mut engine,
            lyrics,
            chords,
        } = ready;
        let mut stems = engine.stem_names();
        stems.sort_by_key(|name| match name.as_str() {
            "vocals" => 0,
            "drums" => 1,
            "bass" => 2,
            "other" => 3,
            _ => 4,
        });
        self.solo = stems
            .iter()
            .position(|name| self.solo_name.as_ref() == Some(name));
        self.tracks = stems
            .into_iter()
            .map(|name| {
                let (gain, muted) = self
                    .track_settings
                    .get(&name)
                    .copied()
                    .unwrap_or((1.0, false));
                Track { name, gain, muted }
            })
            .collect();
        engine.set_master_gain(self.master);
        engine.set_playback_rate(self.rate);
        engine.set_pitch(self.pitch);
        apply_mix(&mut engine, &self.tracks, self.solo);
        if playing && self.output.is_some() {
            engine.play();
        }
        self.transport = Transport::read(&engine);
        let mut old = {
            let mut state = self.playback.lock().unwrap();
            state.revision += 1;
            state.waveform = Waveform::default();
            state.meters = [0.0; 2];
            state.limiter_gain = 1.0;
            std::mem::replace(&mut state.engine, engine)
        };
        let previous = self.active.replace(song);
        self.last_preloaded = None;
        let previous_lyrics = std::mem::replace(&mut self.lyrics, lyrics);
        let previous_chords = std::mem::replace(&mut self.chords, chords);
        self.dragged_gain = None;
        self.seek_preview = None;
        self.seek_hover = None;
        if self.lyrics.is_empty() && self.chords.is_none() {
            self.song_sheet_open = false;
        }
        self.wave_bars = [0; WAVE_BARS];
        self.meters = [0.0; 2];
        self.limiter_gain = 1.0;
        self.load_seek_waveform(cx);
        old.pause();
        if let Some(previous) = previous.filter(|_| old.cached_pcm_bytes() <= WARM_CACHE_BYTES) {
            // The opening chunk is already decoded, so this rewind does no disk I/O.
            if old.seek(0.0).is_ok() {
                self.cache(
                    previous.chunks,
                    LoadedSong {
                        engine: old,
                        lyrics: previous_lyrics,
                        chords: previous_chords,
                    },
                    cx,
                );
                self.preload_neighbor(cx);
                return;
            }
        }
        cx.background_spawn(async move { drop(old) }).detach();
        self.preload_neighbor(cx);
    }

    fn load_seek_waveform(&mut self, cx: &mut Context<Self>) {
        if let Some(cancel) = self.waveform_cancel.take() {
            cancel.store(true, Ordering::Relaxed);
        }
        self.seek_peaks = Arc::default();
        let Some(song) = self.active.clone() else {
            return;
        };
        if let Some(index) = self
            .waveform_cache
            .iter()
            .position(|(path, _)| *path == song.chunks)
        {
            let entry = self.waveform_cache.remove(index).unwrap();
            self.seek_peaks = entry.1.clone();
            self.waveform_cache.push_back(entry);
            return;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.waveform_cancel = Some(cancel.clone());
        let duration = self.transport.duration;
        let load = cx.background_spawn({
            let source = song.clone();
            let cancel = cancel.clone();
            async move { waveform::load(&source, duration, &cancel) }
        });
        cx.spawn(async move |entity, cx| {
            let peaks = load.await;
            let _ = entity.update(cx, |player, cx| {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                player.waveform_cancel = None;
                if let Some(peaks) = peaks {
                    let peaks: Arc<[f32]> = peaks.into();
                    player.seek_peaks = peaks.clone();
                    player.waveform_cache.push_back((song.chunks, peaks));
                    if player.waveform_cache.len() > 16 {
                        player.waveform_cache.pop_front();
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn cache(&mut self, path: PathBuf, song: LoadedSong, cx: &mut Context<Self>) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.chunks == path)
            || self.warm.iter().any(|(cached, _)| *cached == path)
        {
            cx.background_spawn(async move { drop(song) }).detach();
            return;
        }
        self.warm.push_back((path, song));
        while self.warm.len() > 2
            || self
                .warm
                .iter()
                .map(|(_, song)| song.engine.cached_pcm_bytes())
                .sum::<usize>()
                > WARM_CACHE_BYTES
        {
            let evicted = self.warm.pop_front();
            cx.background_spawn(async move { drop(evicted) }).detach();
        }
    }

    fn preload_neighbor(&mut self, cx: &mut Context<Self>) {
        if self.preloading.is_some() || self.selection.is_some() {
            return;
        }
        if let Some(song) = self
            .neighboring_track(1)
            .or_else(|| self.neighboring_track(-1))
            .map(|index| &self.songs[index])
        {
            if self.loading.as_ref() != Some(&song.chunks)
                && self.last_preloaded.as_ref() != Some(&song.chunks)
                && !self.warm.iter().any(|(path, _)| path == &song.chunks)
            {
                self.start_load(song.clone(), true, cx);
            }
        }
    }

    fn seek(&mut self, seconds: f64, cx: &mut Context<Self>) {
        self.busy = Some("Seeking…");
        self.error = None;
        let playback = self.playback.clone();
        let seek = cx.background_spawn(async move {
            let mut state = playback.lock().unwrap();
            state.revision += 1;
            state.waveform = Waveform::default();
            let _ = state.engine.seek(seconds);
            Transport::read(&state.engine)
        });
        cx.spawn(async move |entity, cx| {
            let transport = seek.await;
            let _ = entity.update(cx, |player, cx| {
                player.busy = None;
                player.transport = transport;
                player.advance_selection(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn adjust(&mut self, command: Command) {
        let mut state = self.playback.lock().unwrap();
        match command {
            Command::TogglePlayback if self.output.is_some() => {
                let playing = !self
                    .selection
                    .as_ref()
                    .map_or(state.engine.is_playing(), |next| next.playing);
                if !playing {
                    state.engine.pause();
                } else {
                    state.engine.play();
                }
                if let Some(next) = &mut self.selection {
                    next.playing = playing;
                }
                state.revision += 1;
            }
            Command::Rate(step) => {
                self.rate = ((self.rate + step) * 100.0).round().clamp(25.0, 200.0) / 100.0;
                state.engine.set_playback_rate(self.rate);
            }
            Command::Pitch(step) => {
                self.pitch = (self.pitch + step).clamp(-12, 12);
                state.engine.set_pitch(self.pitch);
            }
            Command::ResetTuning => {
                self.rate = 1.0;
                self.pitch = 0;
                state.engine.set_playback_rate(self.rate);
                state.engine.set_pitch(self.pitch);
            }
            Command::Master(gain) => {
                self.master = gain.clamp(0.0, MAX_GAIN);
                state.engine.set_master_gain(self.master);
            }
            Command::Compressor => {
                self.compressor = !self.compressor;
                state.compressor = self.compressor;
            }
            Command::SetGain(index, gain) => {
                self.tracks[index].gain = gain.clamp(0.0, MAX_GAIN);
                let track = &self.tracks[index];
                self.track_settings
                    .insert(track.name.clone(), (track.gain, track.muted));
            }
            Command::Mute(index) => {
                let track = &mut self.tracks[index];
                track.muted = !track.muted;
                self.track_settings
                    .insert(track.name.clone(), (track.gain, track.muted));
            }
            Command::Solo(index) => {
                self.solo = (self.solo != Some(index)).then_some(index);
                self.solo_name = self.solo.map(|index| self.tracks[index].name.clone());
            }
            _ => (),
        }
        if matches!(
            command,
            Command::SetGain(..) | Command::Mute(_) | Command::Solo(_)
        ) {
            apply_mix(&mut state.engine, &self.tracks, self.solo);
        }
        self.transport = Transport::read(&state.engine);
    }
}

fn apply_mix(engine: &mut Engine, tracks: &[Track], solo: Option<usize>) {
    for (index, track) in tracks.iter().enumerate() {
        let silent = track.muted || solo.is_some_and(|solo| solo != index);
        engine.set_stem_gain(&track.name, if silent { 0.0 } else { track.gain });
    }
}

fn create_playlist(directory: &std::path::Path, mut path: PathBuf) -> anyhow::Result<Setlist> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Choose a playlist file."))?;
    anyhow::ensure!(
        parent.canonicalize()? == directory.canonicalize()?,
        "Save the playlist in {}.",
        directory.display()
    );
    if path.extension().is_none() {
        path.set_extension("json");
    }
    anyhow::ensure!(
        path.extension().is_some_and(|ext| ext == "json"),
        "Choose a .json file."
    );
    let name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("Give the playlist a name."))?
        .to_owned();
    let list = Setlist {
        path,
        name,
        songs: Vec::new(),
    };
    list.save(true)?;
    Ok(list)
}
