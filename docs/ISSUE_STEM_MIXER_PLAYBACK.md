# Issue #11: 曲選択時の再生挙動・ステムミキサーの適用不具合 (RESOLVED)

> **Status: RESOLVED.** 元の分析ノートを下に残していますが、記載されている
> アーキテクチャ（`file://` 直接 fetch、`ensureAudioGraph` の fire-and-forget、
> HTMLAudioElement ストリームプール等）は**すべて現行コードには存在しません**。
> 現状は `src/audio/PlaybackEngine.ts`（React 非依存の再生エンジン）による
> チャンクストリーミング再生です。
>
> 解決の要点:
> 1. **BUFFERING 表示** — 曲タップ直後に中央オーバーレイ + 行スピナーを即時描画
>    （デコード開始前に 2 rAF + 30ms の描画 yield を挟む）
> 2. **原音リーク** — グラフ初期化は共有 Promise で完全 await 保証、stem GainNode
>    は保存済みミキサーレベルで生成（デフォルト 1.0 は存在しない）
> 3. **起動速度** — 30 秒サンプル整列 Opus チャンク (bin/make-stem-chunks.py) で
>    再生開始 3.4s → ~0.4s。ミキサーは最初のサンプルから有効
>
> 詳細は README「チャンク分割」セクションとコミット履歴 (PR #12 以降) を参照。

---

# 以下、当時の調査ノート (historical)

## 1. 概要 (Summary)
Android 実機（ALLDOCUBE iPlay60_mini_Pro, Android 14）において、曲リストから曲を選択して再生する際に、以下の明確な不具合事象が確認されています。

1. **曲をタップした時、BUFFERINGと表示されず、フリーズしたように見える**
2. **再生してからしばらくステムのミキサー（ミュートや音量設定）が反映されず、原音が再生される。数秒後に突然ミキサーが有効化される**

---

## 2. 確認されている具体的な事象 (Confirmed Symptoms)

### 事象 A: 曲選択時の無反応（フリーズ感）
- 曲リストの曲をタップした際、画面上に「BUFFERING」やローディング状態が視覚的に伝わらず、アプリがフリーズしたように見える。
- **背景/原因の分析**:
  - 現在の `WaveformSeekBar.tsx` の `waveform-buffering-overlay` は、波形コンポーネント内部に限定されている。
  - 曲切り替え直後は `duration` や `audioUrl` の切り替え再レンダリングで波形要素自体が一瞬消えるため、オーバーレイが表示されない。
  - また、メイン画面中央（歌詞エリアなど）や曲リスト行のタッチフィードバックが即座にレンダリングされていない。

### 事象 B: 原音先行再生とミキサーの突然の有効化
- 曲が再生され始めた直後は、ユーザーが設定したステムミキサーのバランス（例: ボーカルミュートやベース強調など）が無視され、**すべての音が 100% 音量（原音）で再生される**。
- **再生開始から約 1〜2 秒後に突然ミキサーが適用され、ミュートや音量バランスが反映される**。
- **背景/原因の分析**:
  - `useAudioPlayer.ts` のオーディオグラフ初期化（`ensureAudioGraph` / `registerPitchWorklet`）が非同期で走っている。
  - 初期化完了前に仮の `GainNode`（ゲイン初期値 1.0）経由で `AudioBufferSourceNode` が再生を開始してしまう。
  - その後、Worklet の登録完了時や後続の再レンダリング時に `stemLevels` が適用され、オーディオグラフの再接続またはゲイン更新が走ることで、「突然ミキサーが効く」という挙動を引き起こしている。

---

## 3. 現在のアーキテクチャと実装状況 (Current Architecture)

### 3.1 音源ファイル構成
- パス: `/sdcard/Android/data/com.donoy.mybandpractice/files/songs/{slug}/`
  - メイン音源: `{slug}.ogg` (256kbps Ogg Opus)
  - ステム音源: `stems/vocals.ogg`, `stems/drums.ogg`, `stems/bass.ogg`, `stems/other.ogg` (各 ~4-6MB)
- `nativeSongs.ts` にて、Chromium 直接アクセスプロトコル `file:///storage/emulated/0/...` を用いて `stemUrls` および `audioUrl` を構築。

### 3.2 オーディオ再生パイプライン (`useAudioPlayer.ts`)
- **オーディオグラフ (`ensureAudioGraph`)**:
  - 各ステム (`vocals`, `drums`, `bass`, `other`) に対応する `GainNode` (`stemGains`) を保持。
  - `stemGains` -> `pitchIn` -> `PitchWorklet` (or bypass) -> `postPitchGain` -> `masterGain` -> `ctx.destination`
- **曲選択・デコード (`playSong`)**:
  - `song.stems` が存在する場合、`Promise.all` で 4 つのステムを並列 fetch & `ctx.decodeAudioData`。
  - `startSourcesAt(0, fullBuffers)` を呼び出し、各パートの `AudioBufferSourceNode` を作成して `stemGain` に接続・再生開始。

---

## 4. 解決のための必須改修方針 (Required Fixes)

### 4.1 ミキサーゲインの絶対的事前適用
1. `AudioContext` およびすべての `GainNode`（各ステム用）を、**音声再生が始まる前に確実にユーザーの `stemLevels`（保存されている設定値）で完全初期化・固定**する。
2. 音声ソース（`AudioBufferSourceNode`）が接続される `GainNode` は、接続した瞬間から設定音量（0.0〜1.0）になっており、**1 サンプルたりともデフォルトの 1.0（原音）で漏れない**ようにする。
3. 非同期の Worklet 登録やグラフ配線が完全に完了するまで、音声を鳴らし始めない（`await ensureAudioGraph()` の完全保証）。

### 4.2 画面全体での明確な即時ローディング表示 (Instant Global Buffering UI)
1. 曲をタップした瞬間（0ms）、画面中央（歌詞エリア等）および再生バーに「**読み込み中 (BUFFERING)**」オーバーレイまたは明確なスピナーを即時表示する。
2. 音声のデコードとオーディオグラフの準備が 100% 完了し、実際に音が耳に届くタイミングでローディング表示をフェードアウトさせて再生状態へ遷移する。

---

## 5. 対象ファイル一覧 (Relevant Files)

1. `web/src/hooks/useAudioPlayer.ts` - オーディオ再生、ミキサー、ゲイン適用、Worklet 初期化ロジック
2. `web/src/utils/nativeSongs.ts` - ストレージからの曲・ステムファイル走査と URL 解決
3. `web/src/components/SongList.tsx` - 曲リストのタップ処理およびバッファリングスピナー表示
4. `web/src/components/PlayerBar.tsx` - 再生バー、ステムミキサーモーダル
5. `web/src/components/WaveformSeekBar.tsx` - シークバーとバッファリングオーバーレイ
6. `web/src/components/LyricsPanel.tsx` - 歌詞エリア（中央ローディング表示の配置先）
7. `web/src/audio/pitchWorklet.ts` - ピッチシフター AudioWorklet プロセッサ

---

## 6. 検証環境 (Test Environment)
- **端末**: ALLDOCUBE iPlay60_mini_Pro (MediaTek Helio G99 MT6789, Android 14)
- **解像度**: 1920 x 1200 (Landscape)
- **ADB ビルド & デプロイ コマンド**:
  ```powershell
  cd web
  npm run build; npx cap sync android; $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"; Set-Location android; .\gradlew.bat installDebug; Set-Location ..; adb shell am force-stop com.donoy.mybandpractice; adb shell am start -n com.donoy.mybandpractice/.MainActivity
  ```
