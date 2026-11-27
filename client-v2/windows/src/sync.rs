use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};
use bytes::Bytes;
use qrcode::{EcLevel, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc as async_mpsc, oneshot};
use tokio::time::{sleep, timeout};
use webrtc::api::{
    setting_engine::{SctpMaxMessageSize, SettingEngine},
    APIBuilder,
};
use webrtc::data_channel::{data_channel_state::RTCDataChannelState, RTCDataChannel};
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice::network_type::NetworkType;
use webrtc::peer_connection::{
    configuration::RTCConfiguration, sdp::session_description::RTCSessionDescription,
    RTCPeerConnection,
};

use crate::library::{Setlist, SongEntry};

const CHUNK_BYTES: usize = 16 * 1024;
const MESSAGE_LIMIT: usize = 262_144;
const REPARSE_POINT: u32 = 0x400;

pub enum Event {
    Offer(String, QrCode),
    Status(String),
    Progress(u64, u64),
    Complete,
    Failed(String),
}

pub struct Sender {
    pub events: mpsc::Receiver<Event>,
    pub answer: Option<oneshot::Sender<RTCSessionDescription>>,
    _cancel: oneshot::Sender<()>,
}

pub struct Panel {
    pub id: u64,
    pub sender: Sender,
    pub offer: Option<(String, QrCode)>,
    pub status: String,
    pub error: Option<String>,
    pub progress: Option<(u64, u64)>,
    pub finished: bool,
}

impl Panel {
    pub fn new(id: u64, songs: Vec<SongEntry>, lists: Vec<Setlist>) -> Self {
        Self {
            id,
            sender: Sender::start(songs, lists),
            offer: None,
            status: "Preparing connection…".into(),
            error: None,
            progress: None,
            finished: false,
        }
    }

    pub fn refresh(&mut self) -> bool {
        let mut changed = false;
        for event in self.sender.events.try_iter().take(16) {
            changed = true;
            match event {
                Event::Offer(payload, qr) => {
                    self.offer = Some((payload, qr));
                    self.status = "Waiting for the answer code…".into();
                }
                Event::Status(status) => self.status = status,
                Event::Progress(done, total) => {
                    self.status = "Sending…".into();
                    self.progress = Some((done, total));
                }
                Event::Complete => {
                    self.status = "Transfer complete".into();
                    self.finished = true;
                }
                Event::Failed(error) => {
                    self.status = "Sync stopped".into();
                    self.error = Some(error);
                    self.offer = None;
                    self.finished = true;
                }
            }
        }
        changed
    }

    pub fn accept(&mut self, answer: Result<RTCSessionDescription>) {
        match answer {
            Ok(answer) => {
                if let Some(send) = self.sender.answer.take() {
                    if send.send(answer).is_ok() {
                        self.offer = None;
                        self.error = None;
                        self.status = "Connecting…".into();
                    }
                }
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }
}

impl Sender {
    pub fn start(songs: Vec<SongEntry>, lists: Vec<Setlist>) -> Self {
        let (events, receiver) = mpsc::channel();
        let (answer, answer_rx) = oneshot::channel();
        let (cancel, cancel_rx) = oneshot::channel();
        std::thread::spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread().enable_all().build()
                .map_err(anyhow::Error::from)
                .and_then(|runtime| runtime.block_on(async {
                    let peer = peer(false).await?;
                    let result = tokio::select! {
                        _ = cancel_rx => Ok(false),
                    result = send(&peer, songs, lists, answer_rx, &events, false) => result.map(|()| true),
                    };
                    let _ = peer.close().await;
                    result
                }));
            match result {
                Ok(true) => {
                    let _ = events.send(Event::Complete);
                }
                Ok(false) => (),
                Err(error) => {
                    let _ = events.send(Event::Failed(error.to_string()));
                }
            }
        });
        Self {
            events: receiver,
            answer: Some(answer),
            _cancel: cancel,
        }
    }
}

async fn peer(loopback: bool) -> Result<RTCPeerConnection> {
    let mut settings = SettingEngine::default();
    settings.set_ice_multicast_dns_mode(MulticastDnsMode::QueryOnly);
    settings.set_network_types(vec![NetworkType::Udp4]);
    settings.set_include_loopback_candidate(loopback);
    settings.set_sctp_max_message_size_can_send(SctpMaxMessageSize::Bounded(MESSAGE_LIMIT as u32));
    let api = APIBuilder::new().with_setting_engine(settings).build();
    Ok(api.new_peer_connection(RTCConfiguration::default()).await?)
}

async fn send(
    peer: &RTCPeerConnection,
    songs: Vec<SongEntry>,
    lists: Vec<Setlist>,
    answer: oneshot::Receiver<RTCSessionDescription>,
    events: &mpsc::Sender<Event>,
    loopback: bool,
) -> Result<()> {
    let channel = peer.create_data_channel("mbp-sync", None).await?;
    let (opened, channel_open) = oneshot::channel();
    channel.on_open(Box::new(move || {
        let _ = opened.send(());
        Box::pin(async {})
    }));
    let (controls, mut reader) = async_mpsc::channel(16);
    channel.on_close(Box::new({
        let controls = controls.clone();
        move || {
            let _ = controls.try_send(Control::Closed);
            Box::pin(async {})
        }
    }));
    channel.on_message(Box::new(move |message| {
        if message.is_string && message.data.len() <= MESSAGE_LIMIT {
            if let Ok(control) = serde_json::from_slice(&message.data) {
                let _ = controls.try_send(control);
            }
        }
        Box::pin(async {})
    }));

    let offer = local_offer(peer).await?;
    let payload = encode_sdp(&offer.sdp, 'O', loopback)?;
    let qr = QrCode::with_error_correction_level(payload.as_bytes(), EcLevel::M)?;
    events.send(Event::Offer(payload, qr))?;
    let answer = timeout(Duration::from_secs(300), answer)
        .await
        .context("Pairing timed out")??;
    events.send(Event::Status("Connecting…".into()))?;
    peer.set_remote_description(answer).await?;
    timeout(Duration::from_secs(30), channel_open)
        .await
        .context("Could not connect on the local network")??;
    events.send(Event::Status("Reading library…".into()))?;
    let (manifest, sources) =
        tokio::task::spawn_blocking(move || build_manifest(songs, lists)).await??;
    let manifest_text =
        serde_json::to_string(&json!({ "type": "manifest", "manifest": &manifest }))?;
    ensure!(
        manifest_text.len() <= MESSAGE_LIMIT,
        "This library is too large for one sync session."
    );
    channel.send_text(manifest_text).await?;
    events.send(Event::Status(
        "Waiting for the other device’s selection…".into(),
    ))?;
    let Control::Want { slugs, setlists } = next_control(&mut reader, 300).await? else {
        bail!("The other device did not request files.");
    };
    let slugs: HashSet<_> = slugs.into_iter().collect();
    let setlists: HashSet<_> = setlists.into_iter().collect();
    let files: Vec<_> = manifest
        .songs
        .iter()
        .filter(|song| slugs.contains(&song.slug))
        .flat_map(|song| &song.files)
        .chain(
            manifest
                .setlists
                .iter()
                .filter(|list| setlists.contains(&list.id))
                .flat_map(|list| &list.files),
        )
        .collect();
    let total = files.iter().map(|file| file.bytes).sum();
    let mut sent = 0;
    let mut updated = Instant::now();
    events.send(Event::Progress(sent, total))?;
    for (index, file) in files.into_iter().enumerate() {
        let id = (index + 1) as u32;
        send_file(
            &channel,
            &mut reader,
            id,
            file,
            &sources[&file.name],
            |count| {
                sent += count as u64;
                if updated.elapsed() >= Duration::from_millis(90) || sent == total {
                    let _ = events.send(Event::Progress(sent, total));
                    updated = Instant::now();
                }
            },
        )
        .await?;
    }
    channel.send_text(r#"{"type":"done"}"#).await?;
    timeout(Duration::from_secs(10), drain(&channel, 0)).await??;
    Ok(())
}

async fn local_offer(peer: &RTCPeerConnection) -> Result<RTCSessionDescription> {
    let offer = peer.create_offer(None).await?;
    let mut gathering = peer.gathering_complete_promise().await;
    peer.set_local_description(offer).await?;
    let _ = timeout(Duration::from_secs(4), gathering.recv()).await;
    peer.local_description()
        .await
        .context("Could not generate the connection code.")
}

#[derive(Serialize, Deserialize)]
struct MiniSdp {
    t: String,
    p: String,
    u: String,
    f: String,
    s: String,
    c: Vec<String>,
}

fn encode_sdp(sdp: &str, role: char, loopback: bool) -> Result<String> {
    let attribute = |key: &str| {
        sdp.lines()
            .find_map(|line| line.trim().strip_prefix(key))
            .map(str::to_owned)
            .context("Incomplete WebRTC offer")
    };
    let mut mini = MiniSdp {
        t: role.to_string(),
        p: attribute("a=ice-pwd:")?,
        u: attribute("a=ice-ufrag:")?,
        f: attribute("a=fingerprint:")?,
        s: attribute("a=setup:")?,
        c: Vec::new(),
    };
    for candidate in sdp
        .lines()
        .filter_map(|line| line.trim().strip_prefix("a=candidate:"))
    {
        let parts: Vec<_> = candidate.split_ascii_whitespace().collect();
        if let [foundation, "1", transport, priority, ip, port, "typ", "host", ..] =
            parts.as_slice()
        {
            if transport.eq_ignore_ascii_case("udp")
                && ip
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| loopback || !ip.is_loopback())
            {
                mini.c.push(format!("{foundation}/{priority}/{ip}/{port}"));
            }
        }
    }
    ensure!(
        !mini.c.is_empty(),
        "No local IPv4 network connection is available."
    );
    Ok(format!(
        "{role}{}",
        lz_str::compress_to_encoded_uri_component(serde_json::to_string(&mini)?.as_str())
    ))
}

pub fn decode_answer(payload: &str) -> Result<RTCSessionDescription> {
    decode_sdp(payload, 'A')
}

fn decode_sdp(payload: &str, role: char) -> Result<RTCSessionDescription> {
    let compressed = payload
        .trim()
        .strip_prefix(role)
        .filter(|s| s.len() <= 8192)
        .context("Expected an answer code beginning with A.")?;
    let wide = lz_str::decompress_from_encoded_uri_component(compressed)
        .context("Invalid answer code.")?;
    let raw = String::from_utf16(&wide)?;
    let description = if role == 'O' {
        RTCSessionDescription::offer
    } else {
        RTCSessionDescription::answer
    };
    if raw.starts_with("v=0") {
        return Ok(description(raw)?);
    }
    let mini: MiniSdp = serde_json::from_str(&raw).context("Invalid answer code.")?;
    ensure!(
        mini.t.starts_with(role)
            && mini.t.len() == 1
            && if role == 'O' {
                mini.s == "actpass"
            } else {
                matches!(mini.s.as_str(), "active" | "passive")
            },
        "Invalid answer type."
    );
    ensure!(
        [&mini.u, &mini.p, &mini.f]
            .into_iter()
            .all(|value| !value.contains(['\r', '\n'])),
        "Invalid answer attributes."
    );
    let mut sdp = format!(
        "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:{}\r\na=ice-pwd:{}\r\na=fingerprint:{}\r\na=setup:{}\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n", mini.u, mini.p, mini.f, mini.s
    );
    for candidate in mini.c {
        let parts: Vec<_> = candidate.split('/').collect();
        if let [foundation, priority, address, port] = parts.as_slice() {
            if !candidate.contains(char::is_whitespace)
                && priority.parse::<u32>().is_ok()
                && port.parse::<u16>().is_ok()
            {
                sdp.push_str(&format!("a=candidate:{foundation} 1 udp {priority} {address} {port} typ host generation 0\r\n"));
            }
        }
    }
    Ok(description(sdp)?)
}

pub fn answer_from_image(path: &Path) -> Result<RTCSessionDescription> {
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    reader.limits(limits);
    let mut image = rqrr::PreparedImage::prepare(reader.decode()?.to_luma8());
    image
        .detect_grids()
        .into_iter()
        .filter_map(|grid| grid.decode().ok())
        .find_map(|(_, code)| decode_answer(&code).ok())
        .context("Could not read an answer QR code from this image.")
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Control {
    Want {
        slugs: Vec<String>,
        #[serde(default)]
        setlists: Vec<String>,
    },
    Ack {
        id: u32,
        ok: bool,
        error: Option<String>,
    },
    Error {
        message: String,
    },
    Closed,
}

async fn next_control(reader: &mut async_mpsc::Receiver<Control>, seconds: u64) -> Result<Control> {
    match timeout(Duration::from_secs(seconds), reader.recv()).await? {
        Some(Control::Error { message }) => bail!("The other device reported: {message}"),
        Some(Control::Closed) | None => bail!("The other device disconnected."),
        Some(control) => Ok(control),
    }
}

async fn drain(channel: &RTCDataChannel, threshold: usize) -> Result<()> {
    while channel.buffered_amount().await > threshold {
        ensure!(
            channel.ready_state() == RTCDataChannelState::Open,
            "The other device disconnected."
        );
        sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

async fn send_file(
    channel: &RTCDataChannel,
    reader: &mut async_mpsc::Receiver<Control>,
    id: u32,
    file: &ManifestFile,
    source: &Path,
    mut progress: impl FnMut(usize),
) -> Result<()> {
    let mut source = tokio::fs::File::open(source).await?;
    ensure!(
        source.metadata().await?.len() == file.bytes,
        "{} changed during sync.",
        file.name
    );
    channel
        .send_text(
            json!({"type":"file","id":id,"name":file.name,"bytes":file.bytes,"sha256":file.sha256})
                .to_string(),
        )
        .await?;
    let mut buffer = vec![0; CHUNK_BYTES + 8];
    buffer[..4].copy_from_slice(&id.to_le_bytes());
    let mut remaining = file.bytes;
    let mut sequence = 0_u32;
    while remaining > 0 {
        let size = remaining.min(CHUNK_BYTES as u64) as usize;
        source.read_exact(&mut buffer[8..8 + size]).await?;
        buffer[4..8].copy_from_slice(&sequence.to_le_bytes());
        timeout(Duration::from_secs(30), drain(channel, 1024 * 1024)).await??;
        channel
            .send(&Bytes::copy_from_slice(&buffer[..8 + size]))
            .await?;
        remaining -= size as u64;
        sequence += 1;
        progress(size);
    }
    match next_control(reader, 30).await? {
        Control::Ack {
            id: ack, ok: true, ..
        } if id == ack => Ok(()),
        Control::Ack { error, .. } => bail!(
            "The other device rejected {}. {}",
            file.name,
            error.unwrap_or_default()
        ),
        _ => bail!("Unexpected response after sending {}.", file.name),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    songs: Vec<ManifestSong>,
    setlists: Vec<ManifestSetlist>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSong {
    slug: String,
    title: String,
    artist: String,
    duration_seconds: Option<f64>,
    has_lyrics: bool,
    has_stems: bool,
    total_bytes: u64,
    files: Vec<ManifestFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSetlist {
    id: String,
    name: String,
    songs: Vec<String>,
    total_bytes: u64,
    files: Vec<ManifestFile>,
}

#[derive(Serialize)]
struct ManifestFile {
    name: String,
    bytes: u64,
    sha256: String,
}

fn build_manifest(
    songs: Vec<SongEntry>,
    lists: Vec<Setlist>,
) -> Result<(Manifest, HashMap<String, PathBuf>)> {
    let mut sources = HashMap::new();
    let mut manifest = Manifest {
        songs: Vec::new(),
        setlists: Vec::new(),
    };
    for song in songs.into_iter().filter(|song| valid_component(&song.slug)) {
        let mut files = Vec::new();
        let prefix = format!("songs/{}", song.slug);
        let song_dir = song.directory();
        let chunks = song.chunks.clone();
        // Normalize standalone chunk folders to the layout used by the other clients.
        add_chunks(
            &chunks,
            &format!("{prefix}/stems/chunks"),
            &mut files,
            &mut sources,
        )?;
        for entry in fs::read_dir(song_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str().filter(|name| valid_component(name)) else {
                continue;
            };
            if name == "practice.json" || name == "chunks.json" || name.ends_with(".part") {
                continue;
            }
            if entry.file_type()?.is_file() {
                add_file(
                    entry.path(),
                    format!("{prefix}/{name}"),
                    &mut files,
                    &mut sources,
                )?;
            }
        }
        let meta = fs::read(song_dir.join("meta.json"))
            .ok()
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok());
        let duration_seconds = meta.as_ref().and_then(|value| {
            value
                .pointer("/audio/output_duration_seconds")
                .or_else(|| value.get("yt_duration_seconds"))?
                .as_f64()
        });
        manifest.songs.push(ManifestSong {
            slug: song.slug,
            title: song.title,
            artist: song.artist,
            duration_seconds,
            has_lyrics: files.iter().any(|file| file.name.ends_with("/lyrics.md")),
            has_stems: true,
            total_bytes: files.iter().map(|file| file.bytes).sum(),
            files,
        });
    }
    for list in lists {
        let Some(id) = list
            .path
            .file_stem()
            .and_then(|id| id.to_str())
            .filter(|id| valid_component(id))
        else {
            continue;
        };
        let mut files = Vec::new();
        add_file(
            list.path.clone(),
            format!("setlists/{id}.json"),
            &mut files,
            &mut sources,
        )?;
        if let Some(file) = files.first() {
            manifest.setlists.push(ManifestSetlist {
                id: id.into(),
                name: list.name,
                songs: list.songs,
                total_bytes: file.bytes,
                files,
            });
        }
    }
    Ok((manifest, sources))
}

fn add_chunks(
    chunks: &Path,
    prefix: &str,
    files: &mut Vec<ManifestFile>,
    sources: &mut HashMap<String, PathBuf>,
) -> Result<()> {
    ensure!(
        fs::symlink_metadata(chunks)?.file_attributes() & REPARSE_POINT == 0,
        "Cannot sync linked chunk folder {}.",
        chunks.display()
    );
    add_file(
        chunks.join("chunks.json"),
        format!("{prefix}/chunks.json"),
        files,
        sources,
    )?;
    for entry in fs::read_dir(chunks)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(stem) = name.to_str().filter(|name| valid_component(name)) else {
            continue;
        };
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_dir() || metadata.file_attributes() & REPARSE_POINT != 0 {
            continue;
        }
        for chunk in fs::read_dir(entry.path())? {
            let chunk = chunk?;
            let name = chunk.file_name();
            let Some(name) = name
                .to_str()
                .filter(|name| !name.ends_with(".part") && valid_component(name))
            else {
                continue;
            };
            if chunk.file_type()?.is_file() {
                add_file(
                    chunk.path(),
                    format!("{prefix}/{stem}/{name}"),
                    files,
                    sources,
                )?;
            }
        }
    }
    Ok(())
}

fn valid_component(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', ':'])
}

fn add_file(
    path: PathBuf,
    name: String,
    files: &mut Vec<ManifestFile>,
    sources: &mut HashMap<String, PathBuf>,
) -> Result<()> {
    if fs::symlink_metadata(&path)?.file_attributes() & REPARSE_POINT != 0 {
        return Ok(());
    }
    let mut file =
        fs::File::open(&path).with_context(|| format!("Could not read {}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        bytes += count as u64;
    }
    let sha256 = format!("{:x}", digest.finalize());
    ensure!(
        sources.insert(name.clone(), path).is_none(),
        "Duplicate sync file {name}"
    );
    files.push(ManifestFile {
        name,
        bytes,
        sha256,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library;
    use std::sync::Arc;

    #[tokio::test]
    async fn pairs_and_sends_requested_audio_with_ordered_frames() -> Result<()> {
        timeout(Duration::from_secs(25), transfer_fixture()).await?
    }

    async fn transfer_fixture() -> Result<()> {
        let root = tempfile::tempdir()?;
        let song = root.path().join("demo");
        let chunks = song.join("stems/chunks");
        fs::create_dir_all(chunks.join("vocals"))?;
        fs::write(chunks.join("chunks.json"), "{}")?;
        let audio = vec![0x7d; CHUNK_BYTES + 13];
        fs::write(chunks.join("vocals/00000.opus"), &audio)?;
        fs::write(song.join("lyrics.md"), "Demo")?;
        fs::write(song.join("practice.json"), "private local edit")?;
        let library = library::scan(root.path()).map_err(anyhow::Error::msg)?;

        let sender = Arc::new(peer(true).await?);
        let receiver = peer(true).await?;
        let (events, offer_events) = mpsc::channel();
        let (answer, answer_rx) = oneshot::channel();
        let mut task = tokio::spawn({
            let sender = sender.clone();
            async move {
                send(
                    &sender,
                    library.songs,
                    library.setlists,
                    answer_rx,
                    &events,
                    true,
                )
                .await
            }
        });
        let (channel_tx, mut channel_rx) = async_mpsc::channel(1);
        let (message_tx, mut messages) = async_mpsc::unbounded_channel();
        receiver.on_data_channel(Box::new(move |channel| {
            let message_tx = message_tx.clone();
            channel.on_message(Box::new(move |message| {
                let _ = message_tx.send(message);
                Box::pin(async {})
            }));
            let _ = channel_tx.try_send(channel);
            Box::pin(async {})
        }));
        let (offer, _offer_events) =
            tokio::task::spawn_blocking(move || match offer_events.recv()? {
                Event::Offer(offer, _) => Ok((offer, offer_events)),
                _ => bail!("expected a pairing code"),
            })
            .await??;
        receiver
            .set_remote_description(decode_sdp(&offer, 'O')?)
            .await?;
        let description = receiver.create_answer(None).await?;
        let mut gather = receiver.gathering_complete_promise().await;
        receiver.set_local_description(description).await?;
        gather.recv().await;
        let description = receiver.local_description().await.context("no answer")?;
        let payload = encode_sdp(&description.sdp, 'A', true)?;
        let qr = QrCode::with_error_correction_level(payload.as_bytes(), EcLevel::M)?;
        let size = (qr.width() + 8) * 5;
        let mut qr_image =
            image::GrayImage::from_pixel(size as u32, size as u32, image::Luma([255]));
        for (index, color) in qr.to_colors().into_iter().enumerate() {
            if color == qrcode::Color::Dark {
                let x = (index % qr.width() + 4) * 5;
                let y = (index / qr.width() + 4) * 5;
                for i in 0..25 {
                    qr_image.put_pixel((x + i % 5) as u32, (y + i / 5) as u32, image::Luma([0]));
                }
            }
        }
        let answer_path = root.path().join("answer.png");
        qr_image.save(&answer_path)?;
        ensure!(
            answer.send(answer_from_image(&answer_path)?).is_ok(),
            "sender dropped"
        );
        let channel = tokio::select! {
            channel = timeout(Duration::from_secs(10), channel_rx.recv()) => channel
                .context("peer did not open the data channel")?.context("data channel closed")?,
            result = &mut task => {
                result??;
                bail!("sender ended before data channel opened");
            }
        };
        let mut current = None;
        let mut received_audio = false;
        let mut sender_done = false;
        loop {
            let message = tokio::select! {
                biased;
                message = timeout(Duration::from_secs(7), messages.recv()) => message
                    .context("receiver timed out waiting for a file message")?.context("receiver channel closed")?,
                result = &mut task, if !sender_done => {
                    result??;
                    sender_done = true;
                    continue;
                }
            };
            if message.is_string {
                let message: Value = serde_json::from_slice(&message.data)?;
                match message["type"].as_str() {
                    Some("manifest") => {
                        let file_names =
                            message["manifest"]["songs"][0]["files"].as_array().unwrap();
                        assert!(file_names
                            .iter()
                            .any(|file| file["name"] == "songs/demo/lyrics.md"));
                        assert!(file_names
                            .iter()
                            .all(|file| file["name"] != "songs/demo/practice.json"));
                        channel
                            .send_text(r#"{"type":"want","slugs":["demo"],"setlists":[]}"#)
                            .await?;
                    }
                    Some("file") => current = Some((message, Vec::<u8>::new(), 0_u32)),
                    Some("done") => break,
                    kind => bail!("unexpected message {kind:?}"),
                }
            } else {
                let (header, file, sequence) =
                    current.as_mut().context("frame without file header")?;
                let id = header["id"].as_u64().unwrap() as u32;
                assert_eq!(message.data[..4], id.to_le_bytes());
                assert_eq!(message.data[4..8], sequence.to_le_bytes());
                *sequence += 1;
                file.extend_from_slice(&message.data[8..]);
                if file.len() == header["bytes"].as_u64().unwrap() as usize {
                    assert_eq!(header["sha256"], format!("{:x}", Sha256::digest(&*file)));
                    if header["name"] == "songs/demo/stems/chunks/vocals/00000.opus" {
                        assert_eq!(*file, audio);
                        assert_eq!(*sequence, 2);
                        received_audio = true;
                    }
                    channel
                        .send_text(json!({"type":"ack", "id":id, "ok":true}).to_string())
                        .await?;
                    current = None;
                }
            }
        }
        assert!(received_audio);
        if !sender_done {
            task.await??;
        }
        receiver.close().await?;
        sender.close().await?;
        Ok(())
    }
}
