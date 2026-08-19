# My Band Practice

バンド練習効率化のための音源管理・ノーマライズ・ステム分離・歌詞同期・プレイヤー Web アプリケーション & CLI ツールキット。

![App preview](docs/app-preview.webp)

---

## 🚀 主な機能

### 🎧 1. バンド練習用 Web プレイヤー (`web/`)
- **波形シークバー & マーカー機能**: A-Bリピートや特定のセクション（サビ、ギターソロ等）へのマーキング
- **再生速度調整**: ピッチを維持したままスロー再生 / 高速再生
- **ピッチシフター**: 再生速度を変えずに ±12 半音のキー変更 (AudioWorklet、0でバイパス)
- **ミキサー & マイナスワン**: ステム (vocals/drums/bass/other) のオン/オフを Web Audio でライブ合成。ボーカルを消したインスト演奏 (マイナスワン) が可能。全オン時は原音ファイルを再生
- **ステータスチップ**: 速度・ステム・音量を常時表示 (音量は割合インジケーター)。クリックでミキサーモーダル
- **歌詞ディスプレイ**: 曲ごとの歌詞（`lyrics.md`）とメタデータを同時表示
- **メディアセッション通知**: Android で音楽アプリ風の通知・ロック画面コントロール・バックグラウンド再生
- **モバイル対応**: React 19 + Vite + Capacitor による PWA / Android アプリ化。狭い画面ではソングリストがフルスクリーンモーダル化

### 🔊 2. 音声ダウンロード & LUFS ノーマライズ (`bin/yt-to-mp3.py`)
- **音量平準化**: EBU R128 (`-16 LUFS`, True Peak `-1.5 dB`) に合わせた `ffmpeg` 2-pass 自動ノーマライズ
- **無音カット**: 曲前後の無駄な静寂を自動トリミング
- **メタデータ生成**: ディレクトリ構造 `songs/<slug>/` と `meta.json` を自動作成

### 📝 3. 設定駆動型 歌詞取得スクリプト (`bin/fetch-lyrics.py`)
- **YAML 設定駆動**: `config.yaml` に定義された検索エンドポイントや CSS セレクタに基づいて自動検索・抽出
- **メタデータ自動付与**: Frontmatter 付きの `lyrics.md` を生成

### 🎚️ 4. ステム分離 (`bin/separate-stems.py`)
- **AI 音源分離**: vocals / drums / bass / other の 4 ステムに自動分離
- **アンサンブル標準**: 複数モデル (BS-RoFormer + SCNet) の結果を avg_wave で合成し高品質化
- **取り込み時実行**: `yt-to-mp3.py --stems` でダウンロードと同時に分離
- **マルチ GPU 対応**: NVIDIA CUDA / Intel Arc XPU (VRAM ガード付きの明示指定) / AMD ROCm (Linux では `--device cuda` で動作) / CPU

### 🎼 5. AI コード解析 & リードシート (`bin/analyze-chords.py`)
- **ステム活用のニューラルコード推定**: BTC Transformer (ISMIR19, 170クラス大語彙モデル) で bass + other ステムから高精度にコードを推定 (ボーカルのフォルマント/ビブラートやシンバルノイズを排除)
- **スラッシュコード検出**: bass ステムの低音 (C1-C3) クロマから転回形 (例: `G#/B`) を検出
- **音楽理論ポストプロセッサ**: ドミナント モーション (V7→I)、II-V-I ケイデンス検出・ラベリング、非和声音的な一過性グリッチの除去
- **ドラム駆動のビート/小節構造検出**:
  - テンポはドラムステムの prior-free tempogram から候補生成し、拍の規則性×オンセット強度で選択 (yt-dlp 由来音源の数% ズレにも追従)
  - メーター (3/4 or 4/4) はキック/スネア パターンの周期性から決定
  - ダウンビートは段階的に決定: ①キック (1&3拍) / スネア (2&4拍) のヒット率で偶奇位相を確定 → ②ハーモニックリズム (コード変化の小節頭整列) + クラッシュシンバル残響 (高域持続エネルギー) で p vs p+2 を解決
- **検証済み BPM オーバーライド**: 公式 BPM が判明している曲は `BPM_OVERRIDES` (スクリプト内定数) で確定可能
- **リードシートビューア** (Web プレイヤー統合): 4小節/段の楽譜レイアウト、再生位置連動ハイライト・自動スクロール、クリックシーク、**ダイアトニック配色** (キー内コード=青 / 借用コード=ローズ) とローマ数字度数表示、ピッチシフター連動の移調表示

### 📱 6. Android デプロイ & 同期 (`bin/sync.ps1`)
- ADB 経由での Android タブレット/スマホへの APK インストール & `songs/` 音源の自動同期

---

## 📁 ディレクトリ構造

```text
mybandpractice/
├── bin/
│   ├── yt-to-mp3.py        # 音量ノーマライズ付き MP3 抽出スクリプト
│   ├── separate-stems.py   # 4 ステム分離 (BS-RoFormer)
│   ├── analyze-chords.py   # ステム活用 AI コード解析 (BTC Transformer)
│   ├── fetch-lyrics.py     # config.yaml 駆動の歌詞フェッチャー
│   └── sync.ps1            # Android 実機デプロイ & 音源同期スクリプト
├── config.example.yaml     # 歌詞フェッチャー等の設定テンプレート
├── pyproject.toml          # uv による Python 環境定義 (torch XPU ビルド)
├── tools/btc/              # BTC-ISMIR19 クローン (初回実行時に自動クローン, Git除外)
├── tools/msst/             # Music-Source-Separation-Training クローン (Git除外)
├── models/                 # 分離モデルのチェックポイント (Git除外)
├── songs/                  # ローカル音源・歌詞ストレージ (Git除外)
│   └── <song-slug>/
│       ├── <song-slug>.mp3
│       ├── stems/          # vocals / drums / bass / other の mp3
│       ├── chords.json     # コード解析結果 (キー/BPM/小節/ケイデンス)
│       ├── meta.json
│       └── lyrics.md
└── web/                    # React + Vite + TypeScript プレイヤー Web アプリ
```

---

## 🛠️ 前提条件 (Prerequisites)

- **Node.js** (v18+) & **npm**
- **uv** (Python 3.12+ の環境構築に使用 / [astral.sh/uv](https://docs.astral.sh/uv/))
- **ffmpeg** & **ffprobe** (システム PATH に追加されていること)
- **yt-dlp** (システム PATH に追加されていること)

---

## 📦 セットアップ & 使い方

### 1. リポジトリのクローン & 初期設定

```bash
git clone https://github.com/kjranyone/mybandpractice.git
cd mybandpractice

# Python 環境構築
# 注: 本リポジトリの pyproject.toml は Intel Arc (XPU) ビルドの torch に固定しています。
# NVIDIA / AMD ROCm 環境では pyproject.toml の [tool.uv] セクションを
# 対応するインデックス (cu128 / rocm) に差し替えてください。
uv sync

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

#### パイプライン

1. **yt-dlp**: メタデータ取得 + bestaudio を一時ファイルにダウンロード
2. **ffmpeg pass 1**: 前後の無音カット (`silenceremove`) + `loudnorm` 測定 (JSON)
3. **ffmpeg pass 2**: 無音カット + loudnorm リニア適用 → libmp3lame mp3 エンコード (ID3 タグ埋め込み)
4. **meta.json**: ラウドネス測定値・トリミング量等を `songs/<slug>/meta.json` に記録

スラグ (ディレクトリ名) は動画タイトルから「Official Music Video」等のノイズ語を除去し、pykakasi でローマ字化して生成されます (例: `YOASOBI「アイドル」Official Music Video` → `aidoru`)。

#### 使い方

```bash
# 対話モード (URL 入力 → スラグ確認)
uv run python bin/yt-to-mp3.py "https://www.youtube.com/watch?v=XXXXX"

# ytsearch での検索から取得
uv run python bin/yt-to-mp3.py "ytsearch1:バンド名 曲名"

# 非対話モード (スラグ自動決定・既存ディレクトリ上書き)
uv run python bin/yt-to-mp3.py "https://www.youtube.com/watch?v=XXXXX" -y

# スラグを明示指定
uv run python bin/yt-to-mp3.py "https://www.youtube.com/watch?v=XXXXX" --name my-song

# ダウンロード後に 4 ステム分離 (vocals/drums/bass/other) まで実行
uv run python bin/yt-to-mp3.py "https://www.youtube.com/watch?v=XXXXX" -y --stems
```

#### オプション

| オプション | 既定 | 説明 |
|---|---|---|
| `url` (位置引数) | — | YouTube 視聴 URL または `ytsearch1:<query>`。省略時は対話入力 |
| `-y`, `--yes` | — | 非対話モード: スラグを自動決定し既存ディレクトリを上書き |
| `--stems` | — | ダウンロード後に `separate-stems.py` を呼び出し 4 ステム分離まで実行 |
| `--name NAME` | 自動生成 | 曲ディレクトリ名 (slug) を上書き指定 |
| `--target-i` | `-16.0` | 統合ラウドネス目標 (LUFS, EBU R128) |
| `--target-tp` | `-1.5` | トゥルーピーク目標 (dBFS) |
| `--target-lra` | `11.0` | ラウドネスレンジ目標 |
| `--silence-db` | `-50.0` | 前後無音判定のしきい値 (dB, peak) |
| `--keep-silence` | `0.05` | 前後に保持する無音 (秒, クリック音防止) |
| `--bitrate` | `192k` | mp3 ビットレート |
| `--sample-rate` | `44100` | サンプルレート |

`songs/<slug>/<slug>.mp3` および `meta.json` が生成されます。

### 4. ステム分離 (`separate-stems.py`)

[Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) のモデル群で既存曲を vocals / drums / bass / other に分離し `songs/<slug>/stems/<stem>.mp3` (192k) に保存します。

#### パイプライン

1. **モデル取得**: 内蔵のモデル構成 (BS-RoFormer + SCNet XL IHF) に従い、config + チェックポイント (~500MB ずつ) を `models/<name>/` に自動ダウンロード
2. **推論**: モデルを 1 つずつロードして `demix` で分離し、ステムごとの波形をメモリに保持
   - **VRAM ガード**: 空き VRAM が 2.5 GiB 未満の場合、XPU では実行を拒否します (iGPU でのシステムフリーズ防止。CUDA は警告のみ)
   - **バッチサイズ**: 出荷 config は大型 NVIDIA GPU 向けのため、XPU は 1、それ以外は 4 にクランプ
   - モデルごとに VRAM を解放してから次のモデルへ
3. **アンサンブル**: 複数モデルの波形を `avg_wave` 等で合成し品質を底上げ
4. **エンコード**: クリッピング防止の正規化 → 16bit WAV → ffmpeg で 192k mp3 にエンコード
5. **記録**: モデルごとの処理時間・realtime factor を `meta.json` の `stems` に記録

**デフォルトはアンサンブル**: BS-RoFormer (SDR 9.65) + SCNet XL IHF (SDR 10.08) の 2 モデルで推論し `avg_wave` で合成します (所要時間はモデル数分)。

#### 使い方

```bash
# 特定の曲をアンサンブル分離 (CUDA GPU)
uv run python bin/separate-stems.py <song-slug>

# Intel Arc (XPU) GPU で高速実行 (推奨: --device xpu --batch-size 1)
uv run python bin/separate-stems.py <song-slug> --device xpu --batch-size 1

# ステム未生成の全曲を処理
uv run python bin/separate-stems.py --all --device xpu --batch-size 1

# 既存ステムを再生成
uv run python bin/separate-stems.py <song-slug> --force --device xpu --batch-size 1

# 単一モデルで高速に実行 (アンサンブルをスキップ)
uv run python bin/separate-stems.py <song-slug> --single bs_roformer_4stem --device xpu
```

> [!TIP]
> **GPU 加速の積極利用を推奨**: CPU での推論は数分〜数十分かかります。
> - **NVIDIA / AMD (ROCm)**: 自動で `cuda` が選択されます。
> - **Intel Arc (XPU)**: 安定性保護のため自動選択されませんので、`--device xpu --batch-size 1` を明示指定して実行してください。大幅に処理時間が短縮されます。
> - **tools/msst** は初回実行時に自動クローンされるため手動準備は不要です。

> [!WARNING]
> **Intel Arc (XPU) 推論時の注意 (システムクラッシュ・フリーズ防止)**:
> - **実行中の強制中断の禁止**: Intel Arc (oneAPI Level-Zero) での GPU 推論計算中にプロセスを外部から強制終了 (タスクキル / SIGKILL) すると、グラフィックスドライバのデッドロックにより Windows がブルースクリーン (BSoD) または再起動することがあります。推論実行中は途中で強制中断せず完了まで待機してください。
> - **バッチサイズ**: VRAM 枯渇によるフリーズを防ぐため、XPU 推論時は必ず `--batch-size 1` (既定) で実行してください。

#### オプション

| オプション | 既定 | 説明 |
|---|---|---|
| `slug` (位置引数) | — | `songs/` 配下の曲スラグ |
| `--all` | — | ステム未生成の全曲を処理 |
| `--force` | — | 既存のステムを再生成 |
| `--single NAME` | — | 指定名のモデルのみで実行 (アンサンブルをスキップ) |
| `--type ALGO` | `avg_wave` | アンサンブル合成アルゴリズム (`median_wave`, `min_fft`, `max_fft` 等) |
| `--device` | 自動 | `cuda` / `xpu` / `cpu`。自動は cuda > cpu のみ (xpu は明示指定が必要)。AMD GPU (ROCm) は Linux では ROCm ビルドの torch が `cuda` API として公開されるため `cuda` 指定で動作 |
| `--batch-size` | XPU: 1 / 他: 4 | 推論バッチサイズ |
| `--bitrate` | `192k` | ステム mp3 のビットレート |

モデル構成は `bin/separate-stems.py` 内の `ENSEMBLE_MODELS` 定数として定義されています (public なチェックポイントのため config 化は不要)。処理時間・realtime factor は `meta.json` の `stems.models` にモデル単位で記録されます。

### 5. 歌詞の自動取得 (`fetch-lyrics.py`)

`config.yaml` の設定に基づいて歌詞を取得します。

```bash
# 全ての曲の歌詞を取得
uv run python bin/fetch-lyrics.py

# 特定の曲のみ取得
uv run python bin/fetch-lyrics.py <song-slug>
```

### 6. AI コード解析 (`analyze-chords.py`)

ステム音源 (bass + other + drums) を活用してコード進行・キー・BPM・小節構造を解析し、`songs/<slug>/chords.json` に保存します。Web プレイヤーのリードシートビューアで表示されます。

#### パイプライン

1. **モデル取得**: BTC-ISMIR19 (Transformer ベース コード認識, ISMIR19) を `tools/btc/` に自動クローン (PyYAML/NumPy 互換パッチ適用済み)
2. **テンポ/ビート検出** (ドラムステム): prior-free tempogram の強ビンから候補生成 → 拍の規則性×オンセット強度でスコアリング → オクターブ関係は遅い方 (4分音符レベル) を優遇 → 実際の拍間隔から BPM を精密化
3. **メーター/ダウンビート検出**: ①キック (<120Hz) = 1&3拍 / スネア (180-500Hz) = 2&4拍 のヒット率で偶奇位相を確定 → ②残った p vs p+2 をコード変化位置の整列とクラッシュシンバル (6kHz+ の持続成分) の残響で決定
4. **コード推定**: bass + other を混合した CQT を BTC に入力し 170 クラスのコードを推定。bass ステム低域クロマでスラッシュコード (転回形) も検出
5. **音楽理論ポストプロセッサ**: ドミナント モーション (V7→I) の品質補正、II-V-I ケイデンスの検出・ラベリング、0.3 秒未満の非和声音グリッチ除去
6. **小節構造化**: 検出したダウンビート位相に合わせて拍を小節に割り付け、拍数比例でコードを配置し `chords.json` に保存

#### 使い方

```bash
# 特定の曲を解析 (ステム分離済みであること)
uv run python bin/analyze-chords.py <song-slug>

# 全曲を一括解析 (PowerShell)
Get-ChildItem songs -Directory | ForEach-Object { uv run python bin/analyze-chords.py $_.Name }
```

出力例:

```
==> analyzing chords for 'tiger-punch' with BTC Transformer + Music Theory Engine ...
    [3/6] beat, tempo & downbeat tracking ...
      tempo candidates: [92.3, ...] -> selected 143.6 BPM, 582 beats
      phase voting: m4p2=... (dEven=0.81 dOdd=0.79 ...)
      meter: 4/4, downbeat phase: 2
==> analysis complete in 6.4s: structured 148 bars (152 chords).
```

#### テンポ判定の信頼性

テンポのオクターブ ambiguities (倍/半分) は音声のみからの解決が本質的に難しいため、公式 BPM が判明している曲はスクリプト内の `BPM_OVERRIDES` に記述すると確定値で解析できます (tunebat / バンドスコア等の出典コメント付き)。また YouTube 音源には意図的に ±3% 程度ピッチ/テンポをずらしたアップロードが存在するため、グリッドは公式値ではなく実際の音源に整合するよう拍間隔から精密化されます。

`chords.json` の構造:

| フィールド | 説明 |
|---|---|
| `key` / `key_confidence` | Krumhansl-Schmuckler プロファイルによる推定キー |
| `bpm` / `time_signature` | テンポと拍子 |
| `bars[]` | 小節ごとの `bar_number` / `start` / `end` / `cadence` / `chords[]` |
| `chords[]` | 時刻付きのコード セグメント列 |

### 7. Android 実機へのデプロイ (`sync.ps1`)

APK ビルド & インストール、および `songs/`・`setlists/` の端末への同期を行います。

```powershell
# 対話モード: app / songs / both を選択 (Enter で both)
./bin/sync.ps1

# アプリの更新のみ (端末の音源はそのまま)
./bin/sync.ps1 -AppOnly

# songs/ と setlists/ の再転送のみ (再ビルドなし)
./bin/sync.ps1 -SongsOnly

# 複数端末接続時にシリアルを指定
./bin/sync.ps1 -Serial <device-serial>
```

事前に USB デバッグ有効な端末の接続と、`adb` (Android platform-tools) が必要です。音源は端末の `Android/data/com.donoy.mybandpractice/files/` 以下に配置されます。

---

## 🤖 AI コーディングエージェント・自動実行時の制約事項 (Agent Execution Constraints)

AI アシスタント (Antigravity, Cursor, Copilot 等) が本リポジトリで作業を実行する際は、**OS クラッシュ (BSoD / HYPERVISOR_ERROR) を防止するため以下のルールを厳守してください**。

1. **直列実行 (完全な逐次実行) の徹底**:
   - 音源のダウンロード (`yt-to-mp3.py`)、歌詞取得 (`fetch-lyrics.py`)、音源分離 (`separate-stems.py`)、ビルド・実機同期 (`sync.ps1`) などのプロセスは **絶対に並行実行しないでください**。
   - 必ず 1 つのタスクが正常終了したことを確認してから次の処理へ進んでください。バックグラウンドタスクが動作中に別の Python スクリプトや heavy なコマンドを多重起動してはなりません。

2. **GPU 推論中の中断・強制終了の厳禁**:
   - Intel Arc (oneAPI Level-Zero) や GPU 推論が走っている最中にプロセスを外部シグナル (SIGKILL / TerminateProcess / タスクキル) で強制切断すると、グラフィックスドライバのデッドロックおよび Windows Hyper-V の例外 (`0x20001 HYPERVISOR_ERROR`) が発生し、OS 全体がブルースクリーン (BSoD) でクラッシュします。
   - 推論開始後は、途中でプロセスを強制終了せず必ず処理完了まで待機してください。

3. **音源分離の実行パラメータ**:
   - Intel Arc GPU 環境では必ず `--device xpu --batch-size 1` を指定してください (VRAM 枯渇およびシステムフリーズ防止)。
   - CPU 推論は低速なため、GPU が利用可能な場合は適切な GPU オプションを指定してください。

---

## ⚠️ ツールおよびデータ利用に関する免責事項・注意事項 (Disclaimer)

* **私的使用の範囲での利用**: 本プロジェクトに含まれる音源取得ツール (`yt-to-mp3.py`)、ステム分離ツール (`separate-stems.py`)、歌詞取得ツール (`fetch-lyrics.py`)、および生成される各種データ (`*.mp3`, `stems/`, `lyrics.md` 等) は、個人またはバンド内での私的練習・学習（著作権法第30条「私的使用のための複製」）のみを目的として設計されています。
* **著作権・公衆送信の厳禁**: 取得・作成した音源ファイルや歌詞テキストを、インターネット上（Public Git リポジトリ、Web サーバー、SNS 等）にアップロード・公開・二次配布・送信可能化する行為は厳重に禁止されます。
* **対象サービスの利用規約遵守**: 音声・動画配信サービスおよび歌詞配信サイト等の各種 Web サービスを利用する際は、対象サービスの利用規約 (Terms of Service) や `robots.txt` を各自確認し、同意のうえで遵守してください。
* **クローリング・アクセスマナー**: 歌詞フェッチャー等のスクレイピング実行時は、相手方サーバーへの連続アクセスによる過度な負荷を避けるため、適切なウェイティング時間 (`polite_delay_seconds`) を確保して運用してください。また、違法にアップロードされたコンテンツからのデータ取得は行わないでください。
* **自己責任**: 本ツールの使用によって生じた一切のトラブル、損害、権利侵害、アクセス制限等について、開発者は一切の責任を負いません。

---

## 📄 ライセンス

[MIT License](LICENSE)
