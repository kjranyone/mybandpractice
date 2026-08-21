#!/usr/bin/env python3
"""Fetch lyrics for songs in songs/<slug>/ using YAML configuration (config.yaml).

This script operates as a configuration-driven lyrics fetcher. Target domain,
search endpoints, CSS selectors, and URL patterns are managed in config.yaml
(or overridden by config.local.yaml).

For each songs/<slug>/ that has a meta.json but no lyrics.md:
  1. Read title + artist from meta.json
  2. Perform search via configured primary provider endpoint -> candidate list
  3. Pick the candidate whose artist best matches meta.json's artist
  4. Fetch the song page and parse lyrics using configured CSS selectors
  5. Fallback to configured secondary provider if primary fails
  6. Write lyrics.md (YAML frontmatter + stanza text)

Usage
-----
    python bin/fetch-lyrics.py                 # all songs missing lyrics.md
    python bin/fetch-lyrics.py <slug>          # one song
    python bin/fetch-lyrics.py --force <slug>  # re-fetch even if lyrics.md exists
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests
import yaml
from bs4 import BeautifulSoup

# Import clean_title helper from sibling script
sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util as _ilu

_spec = _ilu.spec_from_file_location(
    "_ytm", Path(__file__).resolve().parent / "yt-to-mp3.py"
)
_ytm = _ilu.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_ytm)  # type: ignore[union-attr]
clean_title = _ytm.clean_title

ROOT = Path(__file__).resolve().parent.parent
SONGS_DIR = ROOT / "songs"


# --------------------------------------------------------------------------- #
# YAML Configuration Loader
# --------------------------------------------------------------------------- #
def load_config() -> dict:
    """Load configuration from config.yaml, falling back to config.example.yaml."""
    cfg = {}
    main_cfg = ROOT / "config.yaml"
    example_cfg = ROOT / "config.example.yaml"
    local_cfg = ROOT / "config.local.yaml"

    target_cfg = main_cfg if main_cfg.exists() else example_cfg

    if target_cfg.exists():
        with open(target_cfg, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}

    if local_cfg.exists():
        with open(local_cfg, "r", encoding="utf-8") as f:
            override = yaml.safe_load(f) or {}
            for k, v in override.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v

    return cfg


CONFIG = load_config()
LYRICS_CFG = CONFIG.get("lyrics_fetcher", {})
PRIMARY_CFG = LYRICS_CFG.get("primary_provider", {})
FALLBACK_CFG = LYRICS_CFG.get("fallback_provider", {})
SELECTORS = PRIMARY_CFG.get("selectors", {})

POLITE_DELAY = float(LYRICS_CFG.get("polite_delay_seconds", 1.5))
TIMEOUT = int(LYRICS_CFG.get("timeout_seconds", 20))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": UA,
    "Accept-Language": "ja,en;q=0.8",
}


# --------------------------------------------------------------------------- #
# HTTP Client
# --------------------------------------------------------------------------- #
_session: requests.Session | None = None


def session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(HEADERS)
    return _session


def get(url: str, **kwargs) -> str:
    last_exc: Exception = RuntimeError("no attempts")
    for attempt in range(3):
        try:
            resp = session().get(url, timeout=TIMEOUT, **kwargs)
            resp.raise_for_status()
            return resp.text
        except requests.HTTPError as e:
            last_exc = e
            if e.response is not None and e.response.status_code in (404, 429, 503):
                time.sleep(POLITE_DELAY * (attempt + 2))
                continue
            raise
        except requests.RequestException as e:
            last_exc = e
            time.sleep(POLITE_DELAY * (attempt + 1))
    raise last_exc


# --------------------------------------------------------------------------- #
# Search Logic (YAML Configured)
# --------------------------------------------------------------------------- #
def search_songs(keyword: str) -> list[dict]:
    """Return list of {title, artist, song_id} dicts using primary provider."""
    search_url = PRIMARY_CFG.get("search_url")
    row_selector = SELECTORS.get("search_row")
    if not search_url or not row_selector:
        return []

    params = dict(PRIMARY_CFG.get("search_params", {}))
    params["Keyword"] = keyword

    html = get(search_url, params=params)
    soup = BeautifulSoup(html, "lxml")
    rows = soup.select(row_selector)
    out = []

    link_re_str = SELECTORS.get("search_link_regex", r"/(\d+)/")
    link_re = re.compile(link_re_str)
    title_sel = SELECTORS.get("search_title")
    artist_sel = SELECTORS.get("search_artist")

    for tr in rows:
        a = tr.select_one("a[href]")
        if not a:
            continue
        href = a.get("href", "")
        m = link_re.search(href)
        if not m:
            continue
        song_id = m.group(1)

        title_el = tr.select_one(title_sel) if title_sel else None
        artist_el = tr.select_one(artist_sel) if artist_sel else None

        out.append(
            {
                "song_id": song_id,
                "title": title_el.get_text(strip=True) if title_el else a.get_text(strip=True),
                "artist": artist_el.get_text(strip=True) if artist_el else "",
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Matching Logic
# --------------------------------------------------------------------------- #
def normalize(s: str) -> str:
    """Lowercase, strip spaces/punctuation for fuzzy comparison."""
    s = s.lower()
    return re.sub(r"[\s\-_/\\.()\[\]「」『』'\"&+]", "", s)


def artist_similarity(a: str, b: str) -> float:
    """0..1 similarity score between artist strings."""
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        return 0.9
    ta = set(re.findall(r"[a-z0-9]+", na))
    tb = set(re.findall(r"[a-z0-9]+", nb))
    if ta and tb:
        return len(ta & tb) / len(ta | tb)
    return 0.0


def pick_best(candidates: list[dict], want_artist: str, want_title: str) -> dict | None:
    best, best_score = None, 0.0
    for c in candidates:
        score = artist_similarity(c["artist"], want_artist)
        if normalize(c["title"]) == normalize(want_title):
            score += 0.05
        if score > best_score:
            best, best_score = c, score
    if best and best_score >= 0.5:
        return best

    for c in candidates:
        if normalize(c["title"]) == normalize(want_title):
            return c
    return None


# --------------------------------------------------------------------------- #
# Page Parsing Logic
# --------------------------------------------------------------------------- #
def parse_song_page(html: str) -> dict:
    body_sel = SELECTORS.get("body")
    if not body_sel:
        raise RuntimeError("selectors.body is not configured in config.yaml")

    soup = BeautifulSoup(html, "lxml")
    lyrics_div = soup.select_one(body_sel)
    if not lyrics_div:
        raise RuntimeError(f"lyrics container '{body_sel}' not found")

    raw = lyrics_div.decode_contents().replace("\r", "")
    raw = re.sub(r"<br\s*/?>", "\n", raw, flags=re.IGNORECASE)
    raw = (
        raw.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )
    stanzas = []
    for stanza in raw.split("\n\n"):
        lines = [ln.strip() for ln in stanza.split("\n") if ln.strip()]
        if lines:
            stanzas.append(lines)

    def select_text(selector: str | None) -> str:
        if not selector:
            return ""
        el = soup.select_one(selector)
        return el.get_text(strip=True) if el else ""

    return {
        "title": select_text(SELECTORS.get("title")),
        "artist": select_text(SELECTORS.get("artist")),
        "lyricist": select_text(SELECTORS.get("lyricist")),
        "composer": select_text(SELECTORS.get("composer")),
        "arranger": select_text(SELECTORS.get("arranger")),
        "stanzas": stanzas,
    }


# --------------------------------------------------------------------------- #
# Fallback Provider Logic
# --------------------------------------------------------------------------- #
def _slugify(s: str) -> str:
    s = re.sub(r"[^\w\s-]", "", s)
    return re.sub(r"\s+", "-", s.strip())


def fetch_fallback(artist: str, title: str) -> dict | None:
    url_pattern = FALLBACK_CFG.get("url_pattern")
    container_sel = FALLBACK_CFG.get("container_selector")
    if not url_pattern or not container_sel:
        return None

    url = url_pattern.format(
        artist=_slugify(artist), title=_slugify(title)
    )
    try:
        html = get(url)
    except Exception:  # noqa: BLE001 — network/scrape failures mean "no lyrics"
        return None

    soup = BeautifulSoup(html, "lxml")
    containers = soup.select(container_sel)
    if not containers:
        return None

    from bs4 import NavigableString

    stanzas: list[list[str]] = []
    targets = containers[1:] if len(containers) > 1 else containers
    for c in targets:
        for br in c.find_all("br"):
            br.replace_with(NavigableString("\n"))
        text = c.get_text()
        buf: list[str] = []
        for ln in text.split("\n"):
            ln = ln.strip()
            if not ln:
                if buf:
                    stanzas.append(buf)
                    buf = []
                continue
            buf.append(ln)
        if buf:
            stanzas.append(buf)
    if not stanzas:
        return None

    return {
        "title": title,
        "artist": artist,
        "lyricist": "",
        "composer": "",
        "arranger": "",
        "stanzas": stanzas,
    }


# --------------------------------------------------------------------------- #
# Output Formatting
# --------------------------------------------------------------------------- #
def to_markdown(meta: dict, parsed: dict, source_url: str) -> str:
    lines = []
    lines.append("---")
    lines.append(f'title: "{parsed["title"] or meta.get("title", "")}"')
    lines.append(f'artist: "{parsed["artist"] or meta.get("artist", "")}"')
    if parsed["lyricist"]:
        lines.append(f'lyricist: "{parsed["lyricist"]}"')
    if parsed["composer"]:
        lines.append(f'composer: "{parsed["composer"]}"')
    if parsed["arranger"]:
        lines.append(f'arranger: "{parsed["arranger"]}"')
    lines.append(f"source: {source_url}")
    lines.append(f'slug: "{meta["slug"]}"')
    lines.append("---")
    lines.append("")
    lines.append(f"# {parsed['title'] or meta.get('title', '')}")
    lines.append(f"*{parsed['artist'] or meta.get('artist', '')}*")
    lines.append("")
    for stanza in parsed["stanzas"]:
        lines.extend(stanza)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


# --------------------------------------------------------------------------- #
# Processing Runner
# --------------------------------------------------------------------------- #
def process_song(song_dir: Path, force: bool = False) -> str:
    meta_path = song_dir / "meta.json"
    lyrics_path = song_dir / "lyrics.md"
    if not meta_path.exists():
        return "error: no meta.json"
    if lyrics_path.exists() and not force:
        return "skip (exists)"

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    raw_title = meta.get("title", song_dir.name)
    title = clean_title(raw_title)
    artist = meta.get("artist", "")

    best = None
    search_url = PRIMARY_CFG.get("search_url")
    song_url_pattern = PRIMARY_CFG.get("song_url_pattern")

    try:
        if search_url:
            time.sleep(POLITE_DELAY)
            candidates = search_songs(title)
            best = pick_best(candidates, artist, title) if candidates else None
        else:
            candidates = []
    except Exception:  # noqa: BLE001 — search failures fall through to other sources
        candidates = []

    if best and song_url_pattern:
        time.sleep(POLITE_DELAY)
        url = song_url_pattern.format(id=best["song_id"])
        html = get(url)
        parsed = parse_song_page(html)
        source = "configured_primary"
    else:
        time.sleep(POLITE_DELAY)
        parsed = fetch_fallback(artist, title)
        if not parsed or not parsed["stanzas"]:
            return "not found (no matches)"
        fallback_pattern = FALLBACK_CFG.get("url_pattern", "")
        url = fallback_pattern.format(
            artist=_slugify(artist), title=_slugify(title)
        )
        source = "configured_fallback"

    md = to_markdown(meta, parsed, url)
    lyrics_path.write_text(md, encoding="utf-8")

    meta["lyrics"] = {
        "source": source,
        "source_url": url,
        "matched_artist": parsed["artist"],
        "lyricist": parsed["lyricist"],
        "composer": parsed["composer"],
        "stanza_count": len(parsed["stanzas"]),
        "line_count": sum(len(s) for s in parsed["stanzas"]),
    }
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return f"ok ({len(parsed['stanzas'])} stanzas [{source}])"


def iter_songs() -> list[Path]:
    return sorted(
        d for d in SONGS_DIR.iterdir() if d.is_dir() and (d / "meta.json").exists()
    )


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(
        description="Fetch lyrics into songs/<slug>/lyrics.md using config.yaml.",
    )
    ap.add_argument("slug", nargs="?", help="process only this song")
    ap.add_argument(
        "--force", action="store_true", help="re-fetch even if lyrics.md already exists"
    )
    args = ap.parse_args()

    if not PRIMARY_CFG and not FALLBACK_CFG:
        print("Warning: config.yaml not found or missing lyrics_fetcher configuration.")

    if args.slug:
        targets = [SONGS_DIR / args.slug]
        if not targets[0].exists():
            sys.exit(f"song dir not found: {targets[0]}")
    else:
        targets = iter_songs()

    ok = skip = fail = 0
    for d in targets:
        try:
            status = process_song(d, force=args.force)
        except Exception as e:  # noqa: BLE001 — isolate per-song failures
            status = f"error: {type(e).__name__}: {e}"
        tag = status.split()[0]
        if tag == "ok":
            ok += 1
        elif tag == "skip":
            skip += 1
        else:
            fail += 1
        print(f"[{tag:>4}]  {d.name:<24}  {status}")

    print(f"\ndone: {ok} ok, {skip} skipped, {fail} failed")


if __name__ == "__main__":
    main()
