import { useEffect, useMemo, useRef, useState } from "react";
import type { SongChordsData, BarSegment, BarChord } from "../utils/chordStore";
import {
  transposeChord,
  analyzeBarChordsWithContext,
  type ChordAnalysis,
  type BarCadenceInfo,
} from "../utils/chordStore";
import type { SongSummary } from "../types";
import { formatTimePrecise } from "../utils/format";
import { Modal } from "./Modal";

type Props = {
  song: SongSummary | null;
  chordsData: SongChordsData | null;
  currentTime: number;
  duration: number;
  playing: boolean;
  pitch: number;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onClose: () => void;
};

const BARS_PER_SYSTEM = 4;

/** Classic Lead Sheet Quality Map (Maj7 -> Δ7, m7 -> -7, m7-5 -> ø7, dim -> °, aug -> +) */
const QUALITY_MAP: Record<string, string> = {
  maj7: "Δ7",
  Maj7: "Δ7",
  maj: "Δ",
  Maj: "Δ",
  min7: "-7",
  m7: "-7",
  "m7-5": "ø7",
  "m7b5": "ø7",
  hdim7: "ø7",
  dim7: "°7",
  dim: "°",
  aug: "+",
  min6: "-6",
  m6: "-6",
  maj6: "6",
  minmaj7: "-Δ7",
  mM7: "-Δ7",
};

/** Render chord symbol with distinct root, quality, and bass parts in compact Lead Sheet notation. */
function ChordSymbolDisplay({ chord }: { chord: string }) {
  if (!chord || chord === "N.C." || chord === "--" || chord === "X") {
    return <span className="lead-chord-nc">N.C.</span>;
  }

  let base = chord;
  let bass = "";
  if (base.includes("/")) {
    const parts = base.split("/");
    base = parts[0];
    bass = parts[1];
  }

  let root = base;
  let quality = "";
  if (base.length >= 2 && (base[1] === "#" || base[1] === "b")) {
    root = base.slice(0, 2);
    quality = base.slice(2);
  } else if (base.length >= 1) {
    root = base.slice(0, 1);
    quality = base.slice(1);
  }

  const fmtQual = QUALITY_MAP[quality] ?? quality;

  return (
    <span className="lead-chord-symbol-wrap">
      <span className="lead-chord-root">{root}</span>
      {fmtQual && (
        <span
          className={`lead-chord-quality${fmtQual.includes("Δ") ? " is-delta" : ""}${fmtQual.includes("-") ? " is-minus" : ""}${fmtQual.includes("ø") || fmtQual.includes("°") ? " is-dim" : ""}`}
        >
          {fmtQual}
        </span>
      )}
      {bass && (
        <span className="lead-chord-slash">
          /<span className="lead-chord-bass">{bass}</span>
        </span>
      )}
    </span>
  );
}

export function ChordSheetModal({
  song,
  chordsData,
  currentTime,
  duration,
  playing,
  pitch,
  onSeek,
  onTogglePlay,
  onClose,
}: Props) {
  const [autoScroll, setAutoScroll] = useState(true);
  const activeBarRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Bars data: use chordsData.bars if available, or generate from chords
  const bars: BarSegment[] = useMemo(() => {
    if (!chordsData) return [];
    if (chordsData.bars && chordsData.bars.length > 0) {
      return chordsData.bars;
    }
    // Fallback: group chords into 4-second virtual bars
    const list: BarSegment[] = [];
    const bpm = chordsData.bpm ?? 120;
    const barDur = (60 / bpm) * 4;
    let bNum = 1;
    let curT = 0;
    const maxT = chordsData.chords.length > 0
      ? chordsData.chords[chordsData.chords.length - 1].end
      : 0;

    while (curT < maxT) {
      const bStart = curT;
      const bEnd = curT + barDur;
      const matchingChords: BarChord[] = [];
      
      for (const c of chordsData.chords) {
        if (c.end > bStart && c.start < bEnd) {
          matchingChords.push({
            chord: c.chord,
            beats: 2,
            start: Math.max(bStart, c.start),
            end: Math.min(bEnd, c.end),
          });
        }
      }

      list.push({
        bar_number: bNum++,
        start: bStart,
        end: bEnd,
        beats: 4,
        chords: matchingChords.length > 0
          ? matchingChords
          : [{ chord: "N.C.", beats: 4, start: bStart, end: bEnd }],
      });
      curT += barDur;
    }
    return list;
  }, [chordsData]);

  // Group bars into systems (rows of 4 bars)
  const systems = useMemo(() => {
    const sys: BarSegment[][] = [];
    for (let i = 0; i < bars.length; i += BARS_PER_SYSTEM) {
      sys.push(bars.slice(i, i + BARS_PER_SYSTEM));
    }
    return sys;
  }, [bars]);

  // Find active bar, active chord, and dynamic bar BPM
  const { activeBarNum, activeChordKey, activeBarBpm, bpmDiff } = useMemo(() => {
    if (!bars || bars.length === 0) return { activeBarNum: null, activeChordKey: null, activeBarBpm: null, bpmDiff: null };
    const baseBpm = chordsData?.bpm ?? 120;
    for (const b of bars) {
      if (currentTime >= b.start && currentTime < b.end) {
        let chKey: string | null = null;
        for (const c of b.chords) {
          if (currentTime >= c.start && currentTime < c.end) {
            chKey = `${b.bar_number}-${c.start}`;
            break;
          }
        }
        const dur = b.end - b.start;
        const beats = b.beats || 4;
        let barBpm: number | null = null;
        if (dur > 0.1 && beats > 0) {
          barBpm = Math.round(((60.0 * beats) / dur) * 10) / 10;
        }
        const diff = barBpm != null ? Math.round((barBpm - baseBpm) * 10) / 10 : null;
        return { activeBarNum: b.bar_number, activeChordKey: chKey, activeBarBpm: barBpm, bpmDiff: diff };
      }
    }
    return { activeBarNum: null, activeChordKey: null, activeBarBpm: null, bpmDiff: null };
  }, [bars, currentTime, chordsData?.bpm]);

  const isInitialScrollRef = useRef(true);

  useEffect(() => {
    isInitialScrollRef.current = true;
  }, [song?.slug]);

  // Auto-scroll to active bar: instant on initial modal open, smooth during playback
  useEffect(() => {
    if (autoScroll && activeBarRef.current && containerRef.current) {
      const isInitial = isInitialScrollRef.current;
      activeBarRef.current.scrollIntoView({
        behavior: isInitial ? "instant" : "smooth",
        block: "center",
      });
      if (isInitial && activeBarNum != null) {
        isInitialScrollRef.current = false;
      }
    }
  }, [activeBarNum, autoScroll]);

  const displayKey = useMemo(() => {
    if (!chordsData?.key) return null;
    return transposeChord(chordsData.key, pitch);
  }, [chordsData?.key, pitch]);

  const [legendOpen, setLegendOpen] = useState(false);

  // 2-Pass Comprehensive Harmonic Sequence Analysis (Secondary Dominants, SubV, Related II, Cadences)
  const harmonicAnalysis = useMemo(() => {
    if (!displayKey || bars.length === 0) {
      return {
        chordMap: new Map<string, ChordAnalysis>(),
        barCadences: new Map<number, BarCadenceInfo | null>(),
      };
    }
    return analyzeBarChordsWithContext(bars, displayKey, pitch);
  }, [bars, displayKey, pitch]);

  return (
    <>
      <Modal
        title={`🎸 ${song?.title ?? "Chord Sheet"}`}
        sub={song?.artist}
        onClose={onClose}
        className="chord-sheet-modal"
      >
        <div className="chord-sheet-container" ref={containerRef}>
          {/* Toolbar Header */}
          <div className="chord-sheet-toolbar">
            <div className="chord-sheet-meta">
              {chordsData?.key && (
                <span className="chip chip-key" title="Key">
                  Key: <strong>{displayKey}</strong>
                  {pitch !== 0 && (
                    <span className="chip-transposed">
                      ({pitch > 0 ? `+${pitch}` : pitch}st)
                    </span>
                  )}
                </span>
              )}
              {chordsData?.bpm && (
                <div
                  className="chip chip-bpm-combo mono"
                  title={`基準テンポ: ${chordsData.bpm.toFixed(1)} BPM${activeBarBpm ? ` | 現在の小節 (#${activeBarNum}): ${activeBarBpm.toFixed(1)} BPM` : ""}`}
                >
                  <span className="chip-base-bpm">
                    ♩ 基準 <strong>{Math.round(chordsData.bpm)}</strong>
                  </span>
                  {activeBarBpm != null && (
                    <span
                      className={`chip-live-bpm ${
                        bpmDiff && bpmDiff > 1.5
                          ? "is-faster"
                          : bpmDiff && bpmDiff < -1.5
                          ? "is-slower"
                          : "is-steady"
                      }`}
                    >
                      <span className="live-dot" />
                      再生中: <strong>{activeBarBpm.toFixed(1)}</strong>
                      {bpmDiff != null && Math.abs(bpmDiff) >= 0.5 && (
                        <span className="bpm-diff">
                          ({bpmDiff > 0 ? `+${bpmDiff.toFixed(1)}` : bpmDiff.toFixed(1)})
                        </span>
                      )}
                    </span>
                  )}
                </div>
              )}
              <span className="chip mono">4/4 拍子 (4小節/段)</span>
              <span className="chip mono">{bars.length} 小節</span>
              <button
                type="button"
                className="chip chip-btn chord-help-btn"
                onClick={() => setLegendOpen(true)}
                title="コードの色分け・和声機能・ケーデンスの凡例を開く"
              >
                <span className="chord-help-q">?</span> 凡例
              </button>
            </div>

          <div className="chord-sheet-controls">
            <label className="chord-autoscroll-toggle">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              <span>追従スクロール</span>
            </label>

            <button
              type="button"
              className={`chord-play-btn${playing ? " is-playing" : ""}`}
              onClick={onTogglePlay}
              title={playing ? "一時停止 (Space)" : "再生 (Space)"}
            >
              {playing ? "⏸ 一時停止" : "▶ 再生"}
            </button>

            <div className="chord-sheet-time mono">
              {formatTimePrecise(currentTime)} / {formatTimePrecise(duration)}
            </div>
          </div>
        </div>

        {/* Lead Sheet Grid (4 Bars per System) */}
        {bars.length === 0 ? (
          <div className="chord-sheet-empty">
            <p className="empty-icon">🎼</p>
            <h3>コード解析データがありません</h3>
            <p className="muted">
              この曲のステム音源からコードを解析するには、ターミナルで以下を実行してください：
            </p>
            <pre className="mono chord-cli-cmd">
              uv run python bin/analyze-chords.py {song?.slug ?? "<slug>"}
            </pre>
          </div>
        ) : (
          <div className="lead-sheet">
            {systems.map((sysBars, sysIdx) => {
              const systemStartBar = sysBars[0]?.bar_number ?? (sysIdx * BARS_PER_SYSTEM + 1);

              return (
                <div key={`sys-${sysIdx}`} className="lead-system">
                  {/* Left System Line Number */}
                  <div className="lead-system-num mono" title={`Measure ${systemStartBar}`}>
                    {systemStartBar}
                  </div>

                  {/* 4 Bars Row */}
                  <div className="lead-system-bars">
                    {sysBars.map((b) => {
                      const isCurrentBar = b.bar_number === activeBarNum;
                      const cadenceInfo = harmonicAnalysis.barCadences.get(b.bar_number);
                      const barDur = b.end - b.start;
                      const barBpm = barDur > 0.1 ? Math.round(((60.0 * (b.beats || 4)) / barDur) * 10) / 10 : null;

                      return (
                        <div
                          key={`bar-${b.bar_number}`}
                          ref={isCurrentBar ? activeBarRef : null}
                          className={`lead-bar${isCurrentBar ? " is-current-bar" : ""}${cadenceInfo ? ` has-${cadenceInfo.className}` : (b.cadence ? ` has-${b.cadence}` : "")}`}
                        >
                          <div className="lead-bar-header">
                            <div className="lead-bar-header-left">
                              <span
                                className="lead-bar-idx mono"
                                title={`小節 #${b.bar_number} (${formatTimePrecise(b.start)} - ${formatTimePrecise(b.end)})${barBpm ? ` [♩ ${barBpm} BPM]` : ""}`}
                              >
                                {b.bar_number}
                              </span>
                              {isCurrentBar && barBpm && (
                                <span className="lead-bar-live-tag mono" title={`この小節のテンポ: ${barBpm} BPM`}>
                                  ♩{barBpm}
                                </span>
                              )}
                              {cadenceInfo ? (
                                <span
                                  className={`lead-cadence-badge ${cadenceInfo.className}`}
                                  title={cadenceInfo.title}
                                >
                                  {cadenceInfo.badgeText}
                                </span>
                              ) : (
                                <>
                                  {b.cadence === "2-5-1" && (
                                    <span className="lead-cadence-badge cadence-251" title="Ⅱ-Ⅴ-Ⅰ Cadence (ツーファイブワン進行)">
                                      Ⅱ-Ⅴ-Ⅰ
                                    </span>
                                  )}
                                  {b.cadence === "5-1" && (
                                    <span className="lead-cadence-badge cadence-51" title="Dominant Motion (Ⅴ ➔ Ⅰ 解決)">
                                      Ⅴ➔Ⅰ
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                            <span className="lead-bar-time mono">
                              {formatTimePrecise(b.start)}
                            </span>
                          </div>

                          {/* Chords inside this measure (width proportional to beat count) */}
                          <div className="lead-bar-body">
                            {b.chords.map((c, cIdx) => {
                              const chordKey = `${b.bar_number}-${c.start}`;
                              const isCurrentChord = chordKey === activeChordKey || (isCurrentBar && b.chords.length === 1);
                              const transposed = transposeChord(c.chord, pitch);
                              const chordInfo = harmonicAnalysis.chordMap.get(chordKey);
                              const isNc = c.chord === "N.C." || c.chord === "--" || c.chord === "X";
                              const flexRatio = Math.max(1, c.beats);

                              const isSecDom = chordInfo?.harmonicRole === "secondary-dominant";
                              const isSubV = chordInfo?.harmonicRole === "sub-v";
                              const isRelatedTwo = chordInfo?.harmonicRole === "related-two";
                              const isDom = chordInfo?.harmonicRole === "dominant" || (!isNc && c.is_dominant);
                              const isDiatonic = !isNc && chordInfo ? chordInfo.isDiatonic : false;
                              const isNonDiatonic = !isNc && chordInfo ? (!chordInfo.isDiatonic && !isSecDom && !isSubV && !isRelatedTwo) : false;

                              // Compose tooltip
                              const tooltip = !isNc && chordInfo
                                ? `${chordInfo.description} (${c.beats}拍, ${formatTimePrecise(c.start)}) — クリックでシーク`
                                : `${transposed} (${c.beats}拍, ${formatTimePrecise(c.start)}) — クリックでシーク`;

                              return (
                                <button
                                  key={`ch-${cIdx}-${c.start}`}
                                  type="button"
                                  style={{ flex: flexRatio }}
                                  className={`lead-chord-btn${isCurrentChord ? " is-active-chord" : ""}${isNc ? " is-nc" : ""}${isDiatonic ? " is-diatonic" : ""}${isDom ? " is-dominant" : ""}${isSecDom ? " is-sec-dominant" : ""}${isSubV ? " is-sub-v" : ""}${isRelatedTwo ? " is-related-two" : ""}${isNonDiatonic ? " is-nondiatonic" : ""}${chordInfo?.resolvesToNext ? " is-resolving" : ""}`}
                                  onClick={() => onSeek(c.start)}
                                  title={tooltip}
                                >
                                  <ChordSymbolDisplay chord={transposed} />
                                  <div className="lead-chord-sub">
                                    {chordInfo?.roman && !isNc && (
                                      <span
                                        className={`lead-chord-degree mono${
                                          isSecDom
                                            ? " is-sec-dom"
                                            : isSubV
                                            ? " is-sub-v"
                                            : isDom
                                            ? " is-dom"
                                            : isRelatedTwo
                                            ? " is-rel-two"
                                            : chordInfo.isDiatonic
                                            ? " is-dia"
                                            : " is-nd"
                                        }`}
                                      >
                                        {chordInfo.roman}
                                      </span>
                                    )}
                                    {chordInfo?.resolvesToNext && chordInfo.resolutionLabel && (
                                      <span
                                        className={`lead-chord-motion-arrow mono${
                                          isSecDom
                                            ? " arrow-sec-dom"
                                            : isSubV
                                            ? " arrow-sub-v"
                                            : " arrow-dom"
                                        }`}
                                        title={chordInfo.description}
                                      >
                                        {chordInfo.resolutionLabel}
                                      </span>
                                    )}
                                    {b.chords.length > 1 && (
                                      <span className="lead-chord-beats mono">
                                        {c.beats}拍
                                      </span>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    {/* Fill empty cells if last system has fewer than 4 bars */}
                    {sysBars.length < BARS_PER_SYSTEM &&
                      Array.from({ length: BARS_PER_SYSTEM - sysBars.length }).map((_, emptyIdx) => (
                        <div key={`empty-${emptyIdx}`} className="lead-bar is-empty" />
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>

    {legendOpen && <ChordLegendModal onClose={() => setLegendOpen(false)} />}
  </>
  );
}

/** Rich Help / Theory Legend Modal explaining Harmonic Roles, Colors, Badges and Notations */
function ChordLegendModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="🎼 コード譜の凡例と和声機能ガイド"
      sub="色分け・度数表記・ケーデンスの意味"
      onClose={onClose}
      className="chord-legend-modal-card"
    >
      <div className="chord-legend-modal-content">
        <section className="legend-modal-sec">
          <h4 className="legend-sec-title">🎨 コードの色分け（和声機能）</h4>
          <div className="legend-card-grid">
            <div className="legend-card is-diatonic">
              <div className="legend-card-header">
                <span className="legend-dot dot-diatonic" />
                <strong>ダイアトニックコード</strong>
                <span className="legend-card-badge">Ⅰ, ⅱ, ⅲ, Ⅳ, Ⅴ, ⅵ, ⅶ°</span>
              </div>
              <p className="legend-card-desc">
                キー（調）の音階構成音で作られる基本和音。楽曲の土台となる自然で安定した響きです。
              </p>
              <div className="legend-card-example">
                例: Key C における <code>C (Ⅰ)</code>, <code>Dm (ⅱ)</code>, <code>Em (ⅲ)</code>, <code>F (Ⅳ)</code>, <code>Am (ⅵ)</code>
              </div>
            </div>

            <div className="legend-card is-dominant">
              <div className="legend-card-header">
                <span className="legend-dot dot-dominant" />
                <strong>プライマリドミナント (Ⅴ)</strong>
                <span className="legend-card-badge">Ⅴ, Ⅴ7</span>
              </div>
              <p className="legend-card-desc">
                主調の第5度和音。トニック（Ⅰ）へ強く引き寄せられる解決感（完全5度下降）を持ちます。
              </p>
              <div className="legend-card-example">
                例: Key C における <code>G7 (Ⅴ7) ➔ C (Ⅰ)</code>
              </div>
            </div>

            <div className="legend-card is-sec-dominant">
              <div className="legend-card-header">
                <span className="legend-dot dot-secdom" />
                <strong>セカンダリードミナント (Ⅴ/x)</strong>
                <span className="legend-card-badge">Ⅴ/ⅵ, Ⅴ/Ⅴ, Ⅴ/ⅱ, Ⅴ/Ⅳ, Ⅴ/ⅲ</span>
              </div>
              <p className="legend-card-desc">
                ダイアトニックコード（ⅱ, ⅲ, Ⅳ, Ⅴ, ⅵなど）に一時的に向かう副ドミナント。分数度数と解決先（<code>➔ ⅵ</code> 等）を表示します。
              </p>
              <div className="legend-card-example">
                例: Key C における <code>E7 (Ⅴ7/vi) ➔ Am (ⅵ)</code>, <code>A7 (Ⅴ7/ii) ➔ Dm (ⅱ)</code>, <code>D7 (Ⅴ7/V) ➔ G (Ⅴ)</code>
              </div>
            </div>

            <div className="legend-card is-sub-v">
              <div className="legend-card-header">
                <span className="legend-dot dot-subv" />
                <strong>裏コード / 代理ドミナント (SubV)</strong>
                <span className="legend-card-badge">SubV/Ⅰ, SubV/ⅵ, SubV/ⅱ</span>
              </div>
              <p className="legend-card-desc">
                解決先コードの半音上から下降解決するドミナント7th。同じトライトーン（3全音）を共有する代理コードです。
              </p>
              <div className="legend-card-example">
                例: Key C における <code>D♭7 (SubV/Ⅰ) ➔ C (Ⅰ)</code>, <code>B♭7 (SubV/ⅵ) ➔ Am (ⅵ)</code>
              </div>
            </div>

            <div className="legend-card is-related-two">
              <div className="legend-card-header">
                <span className="legend-dot dot-reltwo" />
                <strong>関連II (Related II: ⅱ/x)</strong>
                <span className="legend-card-badge">ⅱ/x, ⅱø/x</span>
              </div>
              <p className="legend-card-desc">
                セカンダリードミナントに先行してツーファイブを形成する「II」和音です。
              </p>
              <div className="legend-card-example">
                例: Key C における <code>Bm7(♭5) (iiø/vi) ➔ E7 (V/vi) ➔ Am (vi)</code>
              </div>
            </div>

            <div className="legend-card is-nondiatonic">
              <div className="legend-card-header">
                <span className="legend-dot dot-nondiatonic" />
                <strong>非ダイアトニック / 借用和音</strong>
                <span className="legend-card-badge">Non-Diatonic</span>
              </div>
              <p className="legend-card-desc">
                同主短調や他の旋法（モード）から一時的に借用されたコード（モーダルインターチェンジ、サブドミナントマイナー等）です。
              </p>
              <div className="legend-card-example">
                例: Key C における <code>Fm (ⅳm)</code>, <code>A♭ (♭Ⅵ)</code>, <code>B♭ (♭Ⅶ)</code>
              </div>
            </div>
          </div>
        </section>

        <section className="legend-modal-sec">
          <h4 className="legend-sec-title">🏷️ 小節のケーデンス（終止・進行）バッジ</h4>
          <div className="legend-badge-table">
            <div className="legend-badge-row">
              <span className="lead-cadence-badge cadence-251">Ⅱ-Ⅴ-Ⅰ</span>
              <div className="legend-badge-info">
                <strong>Ⅱ-Ⅴ-Ⅰ ケーデンス</strong>: ポップス・ジャズにおける王道の主和音終止進行
              </div>
            </div>
            <div className="legend-badge-row">
              <span className="lead-cadence-badge cadence-51">Ⅴ➔Ⅰ</span>
              <div className="legend-badge-info">
                <strong>ドミナントモーション</strong>: Ⅴ(7) から主和音 Ⅰ への完全5度下降解決
              </div>
            </div>
            <div className="legend-badge-row">
              <span className="lead-cadence-badge cadence-sec-51">Ⅴ/ⅵ➔ⅵ</span>
              <div className="legend-badge-info">
                <strong>セカンダリードミナント解決</strong>: 副調の主音（ⅵやⅤなど）への強い推進力
              </div>
            </div>
            <div className="legend-badge-row">
              <span className="lead-cadence-badge cadence-sec-251">Ⅱ-Ⅴ/ⅵ</span>
              <div className="legend-badge-info">
                <strong>セカンダリー・ツーファイブ</strong>: 目的コードへ向かう一時的な Ⅱ-Ⅴ 進行
              </div>
            </div>
            <div className="legend-badge-row">
              <span className="lead-cadence-badge cadence-sub-v">SubV➔Ⅰ</span>
              <div className="legend-badge-info">
                <strong>裏コード解決</strong>: 半音上のドミナントからベースが半音下降して解決
              </div>
            </div>
            <div className="legend-badge-row">
              <span className="lead-cadence-badge cadence-cycle">Ⅴ➔Ⅴ</span>
              <div className="legend-badge-info">
                <strong>ドミナント連鎖（Cycle of 5ths）</strong>: ドミナントコードが5度下降で連続する進行
              </div>
            </div>
          </div>
        </section>

        <section className="legend-modal-sec">
          <h4 className="legend-sec-title">📐 リードシートコード表記法</h4>
          <div className="legend-lead-notation-grid">
            <div><code>Δ7</code> = Major 7th (CMaj7)</div>
            <div><code>-7</code> = Minor 7th (Dm7)</div>
            <div><code>ø7</code> = Half-Diminished (Bm7♭5)</div>
            <div><code>°</code> = Diminished (Bdim)</div>
            <div><code>+</code> = Augmented (Caug)</div>
            <div><code>-Δ7</code> = Minor Major 7th (CmMaj7)</div>
          </div>
        </section>
      </div>
    </Modal>
  );
}
