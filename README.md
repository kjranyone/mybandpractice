# My Band Practice

バンド練習効率化のための音源管理・ノーマライズ・歌詞同期・プレイヤー Web アプリケーション & CLI ツールキット。

---

## 🚀 主な機能

### 🎧 1. バンド練習用 Web プレイヤー (`web/`)
- **波形シークバー & マーカー機能**: A-Bリピートや特定のセクション（サビ、ギターソロ等）へのマーキング
- **再生速度調整**: ピッチを維持したままスロー再生 / 高速再生
- **歌詞ディスプレイ**: 曲ごとの歌詞（`lyrics.md`）とメタデータを同時表示
- **モバイル対応**: React 19 + Vite + Capacitor による PWA / Android アプリ化

### 🔊 2. 音声ダウンロード & LUFS ノーマライズ (`bin/yt-to-mp3.py`)
- **音量平準化**: EBU R128 (`-16 LUFS`, True Peak `-1.5 dB`) に合わせた `ffmpeg` 2-pass 自動ノーマライズ
- **無音カット**: 曲前後の無駄な静寂を自動トリミング
- **メタデータ生成**: ディレクトリ構造 `songs/<slug>/` と `meta.json` を自動作成

### 📝 3. 設定駆動型 歌詞取得スクリプト (`bin/fetch-lyrics.py`)
- **YAML 設定駆動**: `config.yaml` に定義された検索エンドポイントや CSS セレクタに基づいて自動検索・抽出
- **メタデータ自動付与**: Frontmatter 付きの `lyrics.md` を生成

### 📱 4. Android デプロイ & 同期 (`bin/sync.ps1`)
- ADB 経由での Android タブレット/スマホへの APK インストール & `songs/` 音源の自動同期

---

## 📁 ディレクトリ構造

```text
mybandpractice/
├── bin/
│   ├── yt-to-mp3.py        # 音量ノーマライズ付き MP3 抽出スクリプト
│   ├── fetch-lyrics.py     # config.yaml 駆動の歌詞フェッチャー
│   └── sync.ps1            # Android 実機デプロイ & 音源同期スクリプト
├── config.example.yaml     # 歌詞フェッチャー等の設定テンプレート
├── songs/                  # ローカル音源・歌詞ストレージ (Git除外)
│   └── <song-slug>/
│       ├── <song-slug>.mp3
│       ├── meta.json
│       └── lyrics.md
└── web/                    # React + Vite + TypeScript プレイヤー Web アプリ
```

---

## 🛠️ 前提条件 (Prerequisites)

- **Node.js** (v18+) & **npm**
- **Python** (3.10+)
- **ffmpeg** & **ffprobe** (システム PATH に追加されていること)
- **yt-dlp** (システム PATH に追加されていること)

---

## 📦 セットアップ & 使い方

### 1. リポジトリのクローン & 初期設定

```bash
git clone https://github.com/kjranyone/mybandpractice.git
cd mybandpractice

# 設定ファイルを準備 (必要に応じて編集)
cp config.example.yaml config.yaml
```

### 2. Web プレイヤーの起動

```bash
cd web
npm install
npm run dev
```

ブラウザで `http://localhost:5173` にアクセスすると、ローカルの `songs/` 内にある曲が一覧表示されます。

### 3. 音源の追加 (`yt-to-mp3.py`)

YouTube の URL から練習用音源を作成します。

```bash
# 対話モード
python bin/yt-to-mp3.py "https://www.youtube.com/watch?v=XXXXX"

# 非対話モード (自動命名・上書き)
python bin/yt-to-mp3.py "https://www.youtube.com/watch?v=XXXXX" -y
```

`songs/<slug>/<slug>.mp3` および `meta.json` が生成されます。

### 4. 歌詞の自動取得 (`fetch-lyrics.py`)

`config.yaml` の設定に基づいて歌詞を取得します。

```bash
# 全ての曲の歌詞を取得
python bin/fetch-lyrics.py

# 特定の曲のみ取得
python bin/fetch-lyrics.py <song-slug>
```

---

## 📄 ライセンス

[MIT License](LICENSE)
