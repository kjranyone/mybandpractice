use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use mbp_core::{resolve_chunks_dir, Engine};

use crate::chords::ChordChart;

#[derive(Clone)]
pub struct SongEntry {
    pub chunks: PathBuf,
    pub title: String,
    pub artist: String,
    pub slug: String,
    lyrics_path: PathBuf,
}

pub struct Library {
    pub songs: Vec<SongEntry>,
    pub setlists: Vec<Setlist>,
    pub setlists_dir: PathBuf,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Setlist {
    #[serde(skip)]
    pub path: PathBuf,
    pub name: String,
    pub songs: Vec<String>,
}

impl Setlist {
    pub fn save(&self, create: bool) -> io::Result<()> {
        let directory = self.path.parent().ok_or(io::ErrorKind::InvalidInput)?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut temporary, self)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        if create {
            temporary.persist_noclobber(&self.path)?;
        } else {
            temporary.persist(&self.path)?;
        }
        Ok(())
    }
}

pub struct LoadedSong {
    pub engine: Engine,
    pub lyrics: Vec<LyricsBlock>,
    pub chords: Option<ChordChart>,
}

pub enum LyricsBlock {
    Heading(String),
    Artist(String),
    Section(String),
    Stanza(Vec<String>),
}

impl SongEntry {
    fn from_chunks(chunks: PathBuf) -> Self {
        let song = if chunks
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "stems")
        {
            chunks.parent().and_then(Path::parent).unwrap_or(&chunks)
        } else {
            &chunks
        };
        let meta = fs::read_to_string(song.join("meta.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        let field = |key| {
            meta.as_ref()?
                .get(key)?
                .as_str()
                .filter(|value| !value.trim().is_empty())
        };
        Self {
            title: field("title")
                .map(String::from)
                .or_else(|| {
                    song.file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| "Untitled song".into()),
            artist: field("artist").unwrap_or("").to_owned(),
            slug: song
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            lyrics_path: song.join("lyrics.md"),
            chunks,
        }
    }

    pub fn load(&self) -> Result<LoadedSong, String> {
        let mut engine = Engine::new();
        engine
            .load_chunks_dir(&self.chunks)
            .map_err(|e| e.to_string())?;
        let lyrics = fs::read_to_string(&self.lyrics_path)
            .map(|markdown| parse_lyrics(&markdown))
            .unwrap_or_default();
        let chords = ChordChart::load(self.directory());
        Ok(LoadedSong {
            engine,
            lyrics,
            chords,
        })
    }

    pub fn directory(&self) -> &Path {
        self.lyrics_path.parent().unwrap_or(&self.chunks)
    }
}

fn parse_lyrics(markdown: &str) -> Vec<LyricsBlock> {
    let markdown = markdown.trim_start_matches('\u{feff}').trim();
    let mut lines = markdown.lines();
    if lines.next().is_none_or(|line| line.trim() != "---")
        || !lines.by_ref().any(|line| line.trim() == "---")
    {
        lines = markdown.lines();
    }
    let mut blocks = Vec::new();
    let mut stanza = Vec::new();
    for raw in lines.chain(std::iter::once("")) {
        let line = raw.trim();
        let heading = line.trim_start_matches('#');
        let block = if (1..=3).contains(&(line.len() - heading.len()))
            && heading.starts_with(char::is_whitespace)
        {
            Some(LyricsBlock::Heading(heading.trim_start().into()))
        } else if let Some(artist) = line
            .strip_prefix('*')
            .and_then(|line| line.strip_suffix('*'))
            .filter(|text| !text.is_empty() && !text.contains('*'))
        {
            Some(LyricsBlock::Artist(artist.into()))
        } else if line
            .strip_prefix('[')
            .and_then(|line| line.strip_suffix(']'))
            .is_some_and(|text| !text.is_empty() && !text.contains(']'))
        {
            Some(LyricsBlock::Section(line.into()))
        } else {
            None
        };
        if line.is_empty() || block.is_some() {
            if !stanza.is_empty() {
                blocks.push(LyricsBlock::Stanza(std::mem::take(&mut stanza)));
            }
            blocks.extend(block);
        } else {
            stanza.push(raw.trim_end().into());
        }
    }
    blocks
}

pub fn scan(path: &Path) -> Result<Library, String> {
    let (mut songs, root) = if let Some(chunks) = resolve_chunks_dir(path) {
        let song = SongEntry::from_chunks(chunks);
        let root = song.directory().parent().unwrap_or(path).to_owned();
        (vec![song], root)
    } else {
        let songs = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| resolve_chunks_dir(&entry.path()))
            .map(SongEntry::from_chunks)
            .collect::<Vec<_>>();
        (songs, path.to_owned())
    };
    songs.sort_by_cached_key(|song| (song.title.to_lowercase(), song.chunks.clone()));
    if songs.is_empty() {
        return Err(
            "No songs found. Select a songs folder or a folder containing chunks.json.".into(),
        );
    }
    let setlists_dir = if root.file_name().is_some_and(|name| name == "songs") {
        root.with_file_name("setlists")
    } else {
        root.join("setlists")
    };
    let mut setlists = fs::read_dir(&setlists_dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                return None;
            }
            let mut setlist: Setlist = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
            setlist.path = path;
            Some(setlist)
        })
        .collect::<Vec<_>>();
    setlists.sort_by_cached_key(|list| (list.name.to_lowercase(), list.path.clone()));
    Ok(Library {
        songs,
        setlists,
        setlists_dir,
    })
}

pub fn startup_path() -> Option<PathBuf> {
    if let Some(path) = std::env::args_os().nth(1) {
        return Some(path.into());
    }
    let current = std::env::current_dir().ok();
    let executable = std::env::current_exe().ok();
    current
        .as_deref()
        .into_iter()
        .chain(executable.as_deref().and_then(Path::parent))
        .flat_map(Path::ancestors)
        .map(|directory| directory.join("songs"))
        .find(|path| path.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_shared_markdown_lyric_format() {
        let blocks = parse_lyrics("\u{feff}---\r\ntitle: Test\r\n---\r\n# Test\r\n*Band*\r\n[Verse]\r\n一行目\r\n二行目\r\n\r\n[Outro]\r\nLast line");
        assert!(matches!(&blocks[..], [
            LyricsBlock::Heading(title), LyricsBlock::Artist(artist), LyricsBlock::Section(section),
            LyricsBlock::Stanza(lines), LyricsBlock::Section(outro), LyricsBlock::Stanza(last)
        ] if title == "Test" && artist == "Band" && section == "[Verse]" && lines == &["一行目", "二行目"]
            && outro == "[Outro]" && last == &["Last line"]));
    }

    #[test]
    fn shares_sibling_setlists_with_other_clients() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let songs = root.path().join("songs");
        let dir = root.path().join("setlists");
        fs::create_dir_all(songs.join("demo"))?;
        fs::write(songs.join("demo/chunks.json"), "{}")?;
        fs::create_dir_all(&dir)?;
        let mut list = Setlist {
            path: dir.join("practice.json"),
            name: "Practice".into(),
            songs: vec!["demo".into()],
        };
        list.save(true)?;
        assert_eq!(
            list.save(true).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        list.songs.push("future-song".into());
        list.save(false)?;
        let library = scan(&songs).map_err(io::Error::other)?;
        assert_eq!(library.setlists[0].songs, ["demo", "future-song"]);
        assert_eq!(library.setlists_dir, dir);
        Ok(())
    }
}
