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

  // Find active bar and active chord
  const { activeBarNum, activeChordKey } = useMemo(() => {
    if (!bars || bars.length === 0) return { activeBarNum: null, activeChordKey: null };
    for (const b of bars) {
      if (currentTime >= b.start && currentTime < b.end) {
        let chKey: string | null = null;
        for (const c of b.chords) {
          if (currentTime >= c.start && currentTime < c.end) {
            chKey = `${b.bar_number}-${c.start}`;
            break;
          }
        }
        return { activeBarNum: b.bar_number, activeChordKey: chKey };
      }
    }
    return { activeBarNum: null, activeChordKey: null };
  }, [bars, currentTime]);

  // Auto-scroll to active bar
  useEffect(() => {
    if (autoScroll && activeBarRef.current && containerRef.current) {
      activeBarRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [activeBarNum, autoScroll]);

  const displayKey = useMemo(() => {
    if (!chordsData?.key) return null;
    return transposeChord(chordsData.key, pitch);
  }, [chordsData?.key, pitch]);

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
              <span className="chip mono" title="Tempo">
                ♩ {Math.round(chordsData.bpm)} BPM
              </span>
            )}
            <span className="chip mono">4/4 拍子 (4小節/段)</span>
            <span className="chip mono">{bars.length} 小節</span>
            {displayKey && (
              <>
                <span className="chip chip-diatonic" title="キーの音階に含まれるコード (Ⅰ, ⅱ, ⅲ, Ⅳ, Ⅴ, ⅵ, ⅶ°)">
                  <span className="legend-dot dot-diatonic" /> ダイアトニック
                </span>
                <span className="chip chip-dominant" title="主調のドミナント (Ⅴ, Ⅴ7)">
                  <span className="legend-dot dot-dominant" /> ドミナント (Ⅴ)
                </span>
                <span className="chip chip-secdom" title="副ドミナント (Ⅴ/ⅵ, Ⅴ/Ⅴ, Ⅴ/ⅱ, Ⅴ/Ⅳ, Ⅴ/ⅲ など)">
                  <span className="legend-dot dot-secdom" /> セカンダリードミナント (Ⅴ/x)
                </span>
                <span className="chip chip-subv" title="裏コード / 代理ドミナント (SubV/Ⅰ, SubV/ⅵ など)">
                  <span className="legend-dot dot-subv" /> 裏コード (SubV)
                </span>
                <span className="chip chip-nondiatonic" title="キー外の借用コード・モーダルインターチェンジ">
                  <span className="legend-dot dot-nondiatonic" /> 借用・非ダイアトニック
                </span>
              </>
            )}
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

                      return (
                        <div
                          key={`bar-${b.bar_number}`}
                          ref={isCurrentBar ? activeBarRef : null}
                          className={`lead-bar${isCurrentBar ? " is-current-bar" : ""}${cadenceInfo ? ` has-${cadenceInfo.className}` : (b.cadence ? ` has-${b.cadence}` : "")}`}
                        >
                          <div className="lead-bar-header">
                            <div className="lead-bar-header-left">
                              <span className="lead-bar-idx mono">
                                {b.bar_number}
                              </span>
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
                                        className="lead-chord-res-badge mono"
                                        title={chordInfo.description}
                                      >
                                        {chordInfo.resolutionLabel}
                                      </span>
                                    )}
                                    {c.role && !chordInfo?.secondaryRoman && (
                                      <span className="lead-chord-role mono">{c.role}</span>
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
  );
}
