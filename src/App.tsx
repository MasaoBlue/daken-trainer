import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Play, ChevronsRight, Settings } from "lucide-react";
import "./App.css";

import type {
  InputEvent, Binding, KeyConfig, Channel, LaneDef,
  GridMode, ScrInfo, IntervalEntry, ChallengeState,
  AppConfig, AppMode, AppRecords, ChallengeRecord, DrillResult, RapidPressResult, ConstantResult,
} from "./types";
import {
  CANVAS_H, HEADER_H, AXIS_TIMEOUT, SCR_INPUT_DEDUP_MS, SCR_RESET_MS, SPAN_RETAIN,
  CHART_BAR_W, CHART_W, CHART_H, CHART_PAD_L, GREEN_NUM_DEFAULT,
  LANE_DEFS, KEY_DEFS,
} from "./constants";
import { nearestNoteDivision, noteColor } from "./lib/noteUtils";
import {
  readConfig, writeConfig, readRecords, writeRecords, exportRecords,
} from "./lib/storage";
import DrillMode from "./components/DrillMode";
import ConstantMode from "./components/ConstantMode";
import RecordsView from "./components/RecordsView";

// ---- キーコンフィグ ユーティリティ -----------------------------------------

function resolveChannel(
  cfg: KeyConfig,
  ev: InputEvent,
): { laneId: string; kind: "button" | "axis"; direction?: number } | null {
  for (const [laneId, binding] of Object.entries(cfg)) {
    if (!binding) continue;
    if (binding.source !== ev.source || binding.id !== ev.id) continue;
    if (ev.kind === "AxisMove" && binding.direction !== undefined && binding.direction !== ev.direction) continue;
    if (laneId === "SCR_POS") return { laneId: "SCR", kind: "axis", direction:  1 };
    if (laneId === "SCR_NEG") return { laneId: "SCR", kind: "axis", direction: -1 };
    return { laneId, kind: "button" };
  }
  return null;
}

function bindingLabel(b: Binding | null | undefined): string {
  if (!b) return "—";
  const dir = b.direction === 1 ? "+" : b.direction === -1 ? "−" : "";
  return `${b.id}${dir}`;
}

// ---- レーン定義 (constants.tsからimport) ------------------------------------

// ---- Canvas 描画 -----------------------------------------------------------

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  channels: Channel[],
  viewNowMs: number,
  realNowMs: number,
  isLive: boolean,
  width: number,
  scrCount: number,
  gridMode: GridMode,
  bpm: number,
  scrSessions: ReadonlyArray<{ originMs: number; lastInputMs: number }>,
  laneDefs: LaneDef[],
  timeWindow: number,
  challengeRange: { startMs: number; endMs: number } | null,
  activeLaneId: string | null,
  gridSub: 4 | 8 | 16,
) {
  ctx.clearRect(0, 0, width, CANVAS_H);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, width, CANVAS_H);
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, width, HEADER_H);

  const BODY_BOTTOM = CANVAS_H - 1;
  const msPerPx = timeWindow / (BODY_BOTTOM - HEADER_H);
  const tToY = (t: number) => HEADER_H + (viewNowMs - t) / msPerPx;

  let xOffset = 0;
  for (const lane of laneDefs) {
    const x = xOffset;
    xOffset += lane.w;

    // アクティブ中のスパンがあればヘッダーを薄く着色
    const ch = channels.find((c) => c.id === lane.id);
    const activeSpan = ch?.spans.find(s => s.end === null);
    if (activeSpan) {
      const activeColor = activeSpan.direction !== undefined && activeSpan.direction < 0
        ? (lane.axisColorNeg ?? lane.noteColor)
        : (activeSpan.direction !== undefined ? (lane.axisColorPos ?? lane.noteColor) : lane.noteColor);
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = activeColor;
      ctx.fillRect(x, 0, lane.w, HEADER_H);
      ctx.restore();
    }

    // 集計対象レーンの太線インジケータ
    if (activeLaneId && lane.id === activeLaneId) {
      ctx.fillStyle = "#0cf";
      ctx.fillRect(x, 0, lane.w, 3);
    }

    ctx.strokeStyle = "#333"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + lane.w, HEADER_H); ctx.lineTo(x + lane.w, CANVAS_H); ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = "#ccc"; ctx.font = "bold 11px monospace";
    ctx.fillText(lane.label, x + lane.w / 2, HEADER_H - 4);
    if (lane.id === "SCR" && scrCount > 0) {
      ctx.fillStyle = "#ff0"; ctx.font = "bold 14px monospace";
      ctx.fillText(String(scrCount), x + lane.w / 2, HEADER_H - 20);
    }
    ctx.textAlign = "left";
    if (!ch) continue;
    const pad = Math.max(2, Math.floor(lane.w * 0.06));
    const TICK_H = 5;
    for (const span of ch.spans) {
      const activeEnd = isLive ? realNowMs : viewNowMs;
      const yTop    = span.end !== null ? tToY(span.end) : tToY(activeEnd);
      const yBottom = tToY(span.start);
      if (yTop > BODY_BOTTOM || yBottom < HEADER_H) continue;
      const drawTop    = Math.max(yTop,    HEADER_H);
      const drawBottom = Math.min(yBottom, BODY_BOTTOM);
      const color = ch.kind === "button"
        ? lane.noteColor
        : ((span.direction ?? 1) > 0 ? (lane.axisColorPos ?? lane.noteColor) : (lane.axisColorNeg ?? lane.noteColor));
      const lx = x + pad, lw = lane.w - pad * 2;
      const bodyTop    = Math.max(drawTop, HEADER_H);
      const bodyBottom = Math.min(drawBottom - TICK_H, BODY_BOTTOM);
      if (bodyBottom > bodyTop) {
        ctx.globalAlpha = 0.12; ctx.fillStyle = color;
        ctx.fillRect(lx + 1, bodyTop, lw - 2, bodyBottom - bodyTop);
        ctx.globalAlpha = 1.0;
      }
      // start marker (note の下端): yBottom が BODY_BOTTOM を超えたら描画しない
      // (画面下端で marker が貼り付いて見える残像を防ぐ)
      if (yBottom <= BODY_BOTTOM) {
        const startMarkerBottom = yBottom;
        const startMarkerTop    = Math.max(startMarkerBottom - TICK_H, HEADER_H);
        if (startMarkerBottom > startMarkerTop) {
          ctx.fillStyle = color; ctx.fillRect(lx, startMarkerTop, lw, startMarkerBottom - startMarkerTop);
        }
      }
      if (span.end !== null) {
        const endMarkerTop    = Math.max(drawTop, HEADER_H);
        const endMarkerBottom = Math.min(drawTop + 3, BODY_BOTTOM);
        if (endMarkerBottom > endMarkerTop) {
          ctx.globalAlpha = 0.06; ctx.fillStyle = color;
          ctx.fillRect(lx + 1, endMarkerTop, lw - 2, endMarkerBottom - endMarkerTop);
          ctx.globalAlpha = 1.0;
        }
      }
    }
  }

  // グリッド線をレーンの手前に描画
  ctx.strokeStyle = "#484848";
  ctx.lineWidth = 1;
  ctx.save();
  ctx.translate(0, 0.5);
  if (gridMode === "time") {
    const gridStep = 500;
    const firstGrid = Math.ceil((viewNowMs - timeWindow) / gridStep) * gridStep;
    for (let g = firstGrid; g <= viewNowMs; g += gridStep) {
      const y = Math.round(tToY(g));
      if (y < HEADER_H || y > BODY_BOTTOM) continue;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      ctx.fillStyle = "#777"; ctx.font = "10px monospace";
      ctx.fillText(`${(g / 1000).toFixed(1)}s`, 2, y - 2);
    }
  } else if (gridMode === "bpm" && bpm > 0 && (gridSub === 4 || gridSub === 8 || gridSub === 16)) {
    const beatMs = 60000 / bpm;
    const subPerBeat = gridSub / 4;       // 4分=1, 8分=2, 16分=4
    const subPerMeasure = subPerBeat * 4; // 1小節分の sub 個数
    const subMs = beatMs / subPerBeat;
    const firstSub = Math.ceil((viewNowMs - timeWindow) / subMs) * subMs;
    let subIdx = Math.round(firstSub / subMs);
    for (let g = firstSub; g <= viewNowMs; g += subMs, subIdx++) {
      const y = Math.round(tToY(g));
      if (y < HEADER_H || y > BODY_BOTTOM) continue;
      const isMeasure = subIdx % subPerMeasure === 0;
      const isBeat    = subIdx % subPerBeat === 0;
      // 小節線 > 拍線 > 補助線 の順で濃さを変える
      ctx.strokeStyle = isMeasure ? "#ddd" : isBeat ? "#666" : "#404040";
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      if (isMeasure) {
        ctx.fillStyle = "#ccc"; ctx.font = "10px monospace";
        ctx.fillText(`${Math.round(subIdx / subPerMeasure + 1)}`, 2, y - 2);
      }
    }
  } else if (gridMode === "scr" && scrSessions.length > 0 && bpm > 0 && (gridSub === 4 || gridSub === 8 || gridSub === 16)) {
    // 各セッションごとに小節線を描画 (スクロールで過去に戻っても当時のグリッドが見える)
    const beatMs = 60000 / bpm;
    const subPerBeat = gridSub / 4;
    const subPerMeasure = subPerBeat * 4;
    const subMs = beatMs / subPerBeat;
    const rangeStart = viewNowMs - timeWindow;
    for (let si = 0; si < scrSessions.length; si++) {
      const session = scrSessions[si];
      const next    = scrSessions[si + 1];
      const origin = session.originMs;
      if (!isFinite(origin)) continue;
      // 最後の入力から 1 秒間は描画継続。
      // ただし次のセッションが既に始まっていれば、その origin より前で打ち切る
      // (前セッションの grid が新セッション領域に被さるのを防ぐ)。
      const tailEnd = session.lastInputMs + 1000;
      const scrGridEnd = next ? Math.min(tailEnd, next.originMs) : tailEnd;
      // セッションが view 範囲外なら skip
      if (scrGridEnd < rangeStart) continue;
      if (origin > viewNowMs) continue;
      const firstSubOffset = Math.ceil((rangeStart - origin) / subMs);
      for (let i = firstSubOffset; ; i++) {
        const g = origin + i * subMs;
        if (g > viewNowMs) break;
        if (g < origin) continue;
        if (g > scrGridEnd) break;
        const y = Math.round(tToY(g));
        if (y < HEADER_H || y > BODY_BOTTOM) continue;
        const isMeasure = i % subPerMeasure === 0;
        const isBeat    = i % subPerBeat === 0;
        ctx.strokeStyle = isMeasure ? "#ddf" : isBeat ? "#668" : "#446";
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
        if (isMeasure) {
          ctx.fillStyle = "#ccd"; ctx.font = "10px monospace";
          ctx.fillText(`${Math.floor(i / subPerMeasure) + 1}`, 2, y - 2);
        }
      }
    }
  }
  ctx.restore();

  // チャレンジ範囲インジケータ（SCRレーンの左端に表示）
  if (challengeRange) {
    const BODY_BOTTOM = CANVAS_H - 1;
    const msPerPx = timeWindow / (BODY_BOTTOM - HEADER_H);
    const crToY = (t: number) => HEADER_H + (viewNowMs - t) / msPerPx;
    const yStart = crToY(challengeRange.startMs);
    const yEnd   = crToY(challengeRange.endMs);
    const clampTop    = Math.max(HEADER_H, Math.min(yEnd, yStart));
    const clampBottom = Math.min(BODY_BOTTOM, Math.max(yEnd, yStart));
    if (clampBottom > HEADER_H && clampTop < BODY_BOTTOM) {
      // SCRレーンの位置を取得
      let scrX = 0;
      const scrLane = laneDefs.find(l => l.id === "SCR");
      for (const lane of laneDefs) {
        if (lane.id === "SCR") break;
        scrX += lane.w;
      }
      const scrRight = laneDefs[laneDefs.length - 1].id === "SCR";
      const lx = scrRight ? scrX + (scrLane?.w ?? 0) - 4 : scrX + 1;
      ctx.fillStyle = "#0cf";
      ctx.globalAlpha = 0.9;
      ctx.fillRect(lx, clampTop, 3, clampBottom - clampTop);
      ctx.globalAlpha = 1.0;
    }
  }
}

// ---- 棒グラフ Canvas 描画 ---------------------------------------------------

// Constant モードのみ target+許容ライン情報を返す
function computeConstantInfo(
  appMode: "free" | "challenge" | "drill" | "constant",
  bpm: number,
  constantNoteDiv: 8 | 12 | 16 | 24 | 32,
  thresholdRatio: number,
): { targetMs: number; lowerMs: number; upperMs: number } | null {
  if (appMode !== "constant" || bpm <= 0) return null;
  const targetMs = 60000 / bpm / (constantNoteDiv / 4);
  return {
    targetMs,
    lowerMs: targetMs * (1 - thresholdRatio),
    upperMs: targetMs * (1 + thresholdRatio),
  };
}

// 現在の linear モード Y軸 range を決定する
// - Constant モード時: 許容比率 (±X%) に合わせて zoom (threshold ラインがハミ出ないよう
//   許容幅の +15% を表示)
// - それ以外: 1ms 〜 (scrResetMs - 1)
function computeLinRange(
  constantInfo: { targetMs: number; lowerMs: number; upperMs: number } | null,
  scrResetMs: number,
): { minMs: number; maxMs: number } {
  if (constantInfo !== null) {
    const halfThresholdMs = constantInfo.targetMs - constantInfo.lowerMs; // = target * ratio
    const halfRange = halfThresholdMs * 1.3; // ±30% の余白を持たせて threshold ラインの外側も見える
    return {
      minMs: Math.max(1, Math.round(constantInfo.targetMs - halfRange)),
      maxMs: Math.round(constantInfo.targetMs + halfRange),
    };
  }
  return { minMs: 1, maxMs: Math.max(2, scrResetMs - 1) };
}

// 横スクロール時もY軸ラベルが見えるよう、スクロール領域の外に固定overlayで描画する
function drawYAxisLabels(
  ctx: CanvasRenderingContext2D,
  h: number,
  bpm: number,
  scaleMode: "log" | "linear",
  linRange: { minMs: number; maxMs: number },
  constantInfo: { targetMs: number; lowerMs: number; upperMs: number } | null,
) {
  const w = CHART_PAD_L;
  // 背景: バーや線が overlay 領域の裏に来ても透けないようマスク
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, h);

  const PAD_T = 4;
  const PAD_B = 18;
  const plotH = h - PAD_T - PAD_B;
  const plotX = CHART_PAD_L;

  // Y軸ティック (ラベルの右、軸エッジ手前まで短い横線)
  const TICK_LEN = 4;
  const drawYTick = (y: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX - TICK_LEN, y);
    ctx.lineTo(plotX, y);
    ctx.stroke();
  };

  if (scaleMode === "linear") {
    const linMinMs = linRange.minMs;
    const linMaxMs = linRange.maxMs;
    const msToY = (ms: number) => {
      const clamped = Math.max(linMinMs, Math.min(linMaxMs, ms));
      const ratio = (clamped - linMinMs) / (linMaxMs - linMinMs);
      return PAD_T + Math.round(ratio * plotH);
    };
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "right";
    const drawLabel = (ms: number, color: string, useDecimal: boolean) => {
      const y = msToY(ms);
      if (y < PAD_T || y > PAD_T + plotH) return;
      const text = useDecimal ? ms.toFixed(1) : `${Math.round(ms)}`;
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.strokeText(text, plotX - 6, y + 4);
      ctx.fillStyle = color;
      ctx.fillText(text, plotX - 6, y + 4);
      drawYTick(y, color);
    };
    if (constantInfo) {
      // Constant モード: 上下限 (オレンジ) と目標 (黄) のみ、小数表示
      drawLabel(constantInfo.lowerMs, "#f64", true);
      drawLabel(constantInfo.upperMs, "#f64", true);
      drawLabel(constantInfo.targetMs, "#ff3", true);
    } else {
      // 通常 linear: 適応的 tick、整数表示
      const TICK_STEP_MS = pickTickStep(linMaxMs - linMinMs);
      const TICK_COLOR = "#888";
      const firstTick = Math.ceil(linMinMs / TICK_STEP_MS) * TICK_STEP_MS;
      for (let ms = firstTick; ms <= linMaxMs; ms += TICK_STEP_MS) {
        drawLabel(ms, TICK_COLOR, false);
      }
    }
    // 単位 (ms): Y軸の最下端 (X軸ラベルと同じ高さ) に表示
    ctx.font = "bold 11px monospace";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeText("ms", plotX - 6, h - 6);
    ctx.fillStyle = "#aaa";
    ctx.fillText("ms", plotX - 6, h - 6);
    ctx.textAlign = "left";
    ctx.lineJoin = "miter";
  } else {
    const ALL_DIVS = Array.from({ length: 29 }, (_, i) => i + 4);
    const LABELED_DIVS = new Set([4, 8, 12, 16, 24, 32]);
    const beatMs = bpm > 0 ? 60000 / bpm : 0;
    const noteRefMs = ALL_DIVS.map(d => ({ d, ms: beatMs > 0 ? beatMs / (d / 4) : 0 }));
    const lastMs = noteRefMs.at(-1)?.ms ?? 0;
    const logMinMs = lastMs > 0 ? lastMs * 0.5 : 10;
    const logMaxMs = noteRefMs[0]?.ms > 0 ? noteRefMs[0].ms * 1.5 : 1000;
    const msToY = (ms: number) => {
      const clamped = Math.max(logMinMs, Math.min(logMaxMs, ms));
      const ratio = (Math.log(clamped) - Math.log(logMinMs)) / (Math.log(logMaxMs) - Math.log(logMinMs));
      return PAD_T + Math.round(ratio * plotH);
    };
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "right";
    for (const { d, ms } of noteRefMs) {
      if (ms <= 0) continue;
      if (!LABELED_DIVS.has(d)) continue;
      const y = msToY(ms);
      if (y < PAD_T || y > PAD_T + plotH) continue;
      // log: 線・ラベル・ティックすべて NOTE_COLOR(d) で統一
      const color = noteColor(d);
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.strokeText(`${d}`, plotX - 6, y + 4);
      ctx.fillStyle = color;
      ctx.fillText(`${d}`, plotX - 6, y + 4);
      drawYTick(y, color);
    }
    ctx.textAlign = "left";
    ctx.lineJoin = "miter";
  }
}

// linear モードで使う Y軸 tick の刻み幅をレンジから決定 (5〜8 本になるよう)
function pickTickStep(rangeMs: number): number {
  if (rangeMs <= 50) return 10;
  if (rangeMs <= 120) return 20;
  if (rangeMs <= 250) return 50;
  return 100;
}

function drawBarChart(
  ctx: CanvasRenderingContext2D,
  intervals: IntervalEntry[],
  bpm: number,
  w: number,
  h: number,
  challengeBarRange: { startIdx: number; endIdx: number } | null,
  scaleMode: "log" | "linear",
  linRange: { minMs: number; maxMs: number },
  constantInfo: { targetMs: number; lowerMs: number; upperMs: number } | null,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, h);

  // 音符区分: 4〜32の全整数（5分・7分などのタプレットも含む）
  const ALL_DIVS = Array.from({ length: 29 }, (_, i) => i + 4); // 4〜32
  const LABELED_DIVS = new Set([4, 8, 12, 16, 24, 32]); // 5,6,7は除去
  const NOTE_COLOR = noteColor;
  const beatMs = bpm > 0 ? 60000 / bpm : 0;
  const noteRefMs = ALL_DIVS.map(d => ({ d, ms: beatMs > 0 ? beatMs / (d / 4) : 0 }));
  // 上=速い(小さいms=32分)、下=遅い(大きいms=4分)
  // log: BPMから動的に min/max を決定 (32分*0.5 〜 4分*1.5)
  // linear: 呼び出し側から指定された linRange を使用
  const lastMs = noteRefMs.at(-1)?.ms ?? 0;
  const logMinMs = lastMs > 0 ? lastMs * 0.5 : 10;
  const logMaxMs = noteRefMs[0]?.ms > 0 ? noteRefMs[0].ms * 1.5
    : (intervals.length > 0 ? Math.max(...intervals.map(e => e.ms)) * 1.5 : 1000);
  const linMinMs = linRange.minMs;
  const linMaxMs = linRange.maxMs;

  // レイアウト
  // 上: PAD_T, 下: PAD_B(X軸ラベル), 左: CHART_PAD_L(Y軸ラベル)
  const PAD_T = 4;
  const PAD_B = 18;
  const plotX = CHART_PAD_L;      // バー描画開始X
  const plotH = h - PAD_T - PAD_B; // バー描画高さ

  // モードに応じた msToY: 上=速い(小さいms)、下=遅い(大きいms)
  const msToY = (ms: number) => {
    if (scaleMode === "linear") {
      const clamped = Math.max(linMinMs, Math.min(linMaxMs, ms));
      const ratio = (clamped - linMinMs) / (linMaxMs - linMinMs);
      return PAD_T + Math.round(ratio * plotH);
    }
    const clamped = Math.max(logMinMs, Math.min(logMaxMs, ms));
    const ratio = (Math.log(clamped) - Math.log(logMinMs)) / (Math.log(logMaxMs) - Math.log(logMinMs));
    return PAD_T + Math.round(ratio * plotH);
  };

  const count = intervals.length;
  const barW = CHART_BAR_W;

  // Y軸リファレンスライン (ラベルは drawYAxisLabels に分離)
  if (scaleMode === "linear") {
    if (constantInfo === null) {
      // 通常 linear: tick はレンジに応じて適応的に
      const TICK_STEP_MS = pickTickStep(linMaxMs - linMinMs);
      const TICK_COLOR = "#888";
      const firstTick = Math.ceil(linMinMs / TICK_STEP_MS) * TICK_STEP_MS;
      for (let ms = firstTick; ms <= linMaxMs; ms += TICK_STEP_MS) {
        const y = msToY(ms);
        if (y < PAD_T || y > PAD_T + plotH) continue;
        ctx.strokeStyle = TICK_COLOR;
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.globalAlpha = 1.0;
        ctx.setLineDash([]);
      }
    }
    // Constant モード時の通常 tick は省略 (上下限+目標の 3 本のみ描画)
  } else {
    // log: 音符区分リファレンスライン (lineのみ)
    for (const { d, ms } of noteRefMs) {
      if (ms <= 0) continue;
      const isLabeled = LABELED_DIVS.has(d);
      if (!isLabeled) continue;
      const y = msToY(ms);
      if (y < PAD_T || y > PAD_T + plotH) continue;
      ctx.strokeStyle = NOTE_COLOR(d);
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.globalAlpha = 1.0;
      ctx.setLineDash([]);
    }
  }

  // Constant モード: 上限 / 目標 / 下限 の 3 本
  if (constantInfo) {
    const drawLine = (ms: number, color: string, dash: number[]) => {
      const y = msToY(ms);
      if (y < PAD_T || y > PAD_T + plotH) return;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.globalAlpha = 1.0;
      ctx.setLineDash([]);
    };
    // 上下限: オレンジ点線
    drawLine(constantInfo.lowerMs, "#f64", [6, 4]);
    drawLine(constantInfo.upperMs, "#f64", [6, 4]);
    // 目標: 黄色実線 (一目で目立つように)
    drawLine(constantInfo.targetMs, "#ff3", []);
  }

  // グラフ最下端 (X軸) のベースライン
  ctx.strokeStyle = "#888";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX, PAD_T + plotH + 0.5);
  ctx.lineTo(w, PAD_T + plotH + 0.5);
  ctx.stroke();

  // バー描画（左から並べる、最新が右端）
  // 棒の色: グラデーションは「グラフ全高基準で固定」
  // 上端(PAD_T)=32分色(赤)、下端(yBottom)=4分色(グレー)
  // → 同じ高さのピクセルは常に同じ色。短いバーは下側のグレー寄りだけ表示され、
  //    長いバーほど上部の赤い領域までグラデが伸びる
  const DIR_INDICATOR_H = Math.max(1, Math.floor(barW * 0.4)); // 上端の方向色の高さ
  const yBottomAll = PAD_T + plotH;
  const barGrad = ctx.createLinearGradient(0, PAD_T, 0, yBottomAll);
  barGrad.addColorStop(0, NOTE_COLOR(32));   // 上端=32分の赤
  barGrad.addColorStop(1, "rgb(80,80,80)"); // 下端=ダークグレー
  // 左詰めで配置（右端は固定幅内に収まる）
  for (let i = 0; i < count; i++) {
    const { ms, dir } = intervals[i];
    const x = plotX + i * barW;
    const yBottom = yBottomAll;
    const yTop = Math.min(Math.max(PAD_T, msToY(ms)), yBottom - DIR_INDICATOR_H);
    const barH = yBottom - yTop;
    const dirColor = dir > 0 ? "#fa4" : "#4f8";

    const bx = x, bw = barW - 1;
    if (ms === 0) {
      // 1枚目（intervalなし）: 縦幅100%・方向色のみ
      ctx.fillStyle = dirColor;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(bx, PAD_T, bw, plotH);
      ctx.globalAlpha = 1.0;
    } else {
      // 上端: 方向インジケータ
      ctx.fillStyle = dirColor;
      ctx.fillRect(bx, yTop, bw, DIR_INDICATOR_H);
      ctx.fillStyle = barGrad;
      ctx.fillRect(bx, yTop + DIR_INDICATOR_H, bw, barH - DIR_INDICATOR_H);
    }
  }

  // X軸ラベル（枚数）: 1, 10, 20, 30...
  ctx.fillStyle = "#aaa";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "center";
  const tickStep = 10;
  const tickList = [1];
  for (let n = tickStep; n <= count; n += tickStep) tickList.push(n);
  for (const n of tickList) {
    if (n > count) break;
    const idx = n - 1;
    const x = plotX + idx * barW + barW / 2;
    ctx.strokeStyle = "#666";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD_T + plotH); ctx.lineTo(x, PAD_T + plotH + 4); ctx.stroke();
    ctx.fillText(String(n), x, h - 3);
  }

  // チャレンジ範囲インジケータ（棒の下端に横線）
  if (challengeBarRange && count > 0 && challengeBarRange.endIdx > challengeBarRange.startIdx) {
    const si = Math.max(0, challengeBarRange.startIdx);
    const ei = Math.min(count, challengeBarRange.endIdx);
    if (ei > si) {
      const x1 = plotX + si * barW;
      const x2 = plotX + (ei - 1) * barW + barW;
      const ly = PAD_T + plotH - 1;
      ctx.fillStyle = "#0cf";
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x1, ly, x2 - x1, 2);
      ctx.globalAlpha = 1.0;
    }
  }
}

// ---- 音符区分ヘルパー (lib/noteUtils.tsからimport) -------------------------

// ---- メインコンポーネント --------------------------------------------------

export default function App() {
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const ctxRef          = useRef<CanvasRenderingContext2D | null>(null);
  const channelsRef     = useRef<Channel[]>([]);
  const axisLastRef     = useRef<Map<string, number>>(new Map());
  const rafRef          = useRef<number>(0);
  const startRef        = useRef<number>(performance.now());

  type PlaybackMode = "live" | "paused" | "playing";
  const playbackRef = useRef<{ mode: PlaybackMode; viewMs: number; startedAt: number }>({
    mode: "live", viewMs: 0, startedAt: 0,
  });
  const dragRef  = useRef<{ startY: number; startViewMs: number } | null>(null);
  const pausedMaxMsRef = useRef<number | null>(null); // paused中に固定するスライダーmax
  const sliderRef = useRef<HTMLInputElement>(null);

  const [_channelCount, setChannelCount] = useState(0);
  const [mode, setMode] = useState<PlaybackMode>("live");

  // 設定値の state/ref は最初ハードコードのデフォルトで初期化。
  // 起動直後の useEffect で config.json から読み込んだ値で上書きされる。
  // グリッド設定
  const [gridMode, setGridMode] = useState<GridMode>("time");
  const gridModeRef = useRef<GridMode>("time");
  // bpm/scr モード時の補助線間隔 (4分/8分/16分)
  const [gridSub, setGridSub] = useState<4 | 8 | 16>(4);
  const gridSubRef = useRef<4 | 8 | 16>(4);
  const [bpm, setBpm] = useState(150);
  const bpmRef = useRef(150);
  const [bpmText, setBpmText] = useState("150");

  // 緑数字
  const [_greenNum, setGreenNum] = useState(GREEN_NUM_DEFAULT);
  const greenNumRef = useRef(GREEN_NUM_DEFAULT);
  const [greenNumText, setGreenNumText] = useState(String(GREEN_NUM_DEFAULT));

  // クラップ音 (発火タイミングは handleScrInput の入力判定 1 箇所に集約)
  const [clapOn, setClapOn] = useState(true);
  const clapOnRef = useRef(true);

  // メトロノーム
  const [metroOn, setMetroOn] = useState(false);
  const metroOnRef = useRef(false);
  const [metroDiv, setMetroDiv] = useState<4 | 8>(4);
  const metroDivRef = useRef<4 | 8>(4);
  const [metroVol, setMetroVol] = useState(0.5);
  const metroVolRef = useRef(0.5);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const metroNextBeatRef = useRef<number | null>(null);

  // 1P / 2P
  const [side, setSide] = useState<"1P" | "2P">("1P");
  const sideRef = useRef<"1P" | "2P">("1P");

  // SCR カウント・情報
  const [_scrCount, setScrCount] = useState(0);
  const scrCountRef     = useRef(0);
  const scrLastTimeRef  = useRef<number>(-Infinity);
  const scrLastDirRef   = useRef<number>(0);
  const scrLastEventTimeRef = useRef<number>(-Infinity); // SCRイベント毎に更新（カウント関係なく）

  const [scrInfo, setScrInfo] = useState<ScrInfo>({
    count: 0, intervalMs: null, estimatedBpm: null, offsetMs: null, noteDivision: null,
    avgIntervalMs: null, avgNoteDivision: null,
  });
  const [scrActive, setScrActive] = useState(false);
  const scrIntervalHistRef  = useRef<number[]>([]);
  const scrPrevDirTimeRef   = useRef<number | null>(null);
  const scrOriginRef        = useRef<number>(-Infinity);
  // gridMode === "scr" 時の offsetMs 計算用。アプリ起動時は -Infinity、
  // 最初のスクラッチ (count 0→1) でセッション基点が設定される。
  const scrLastOriginRef    = useRef<number>(-Infinity);
  // SCR セッション履歴: 過去にスクラッチした各 run の origin/lastInput を保持し、
  // スクロールで過去に戻ったときも当時の小節線が描画されるように使う
  const scrSessionsRef      = useRef<Array<{ originMs: number; lastInputMs: number }>>([]);

  // 棒グラフ用: 直近INTERVAL_HISTORY件の間隔履歴
  const intervalHistoryRef = useRef<IntervalEntry[]>([]);
  const chartCanvasRef = useRef<HTMLCanvasElement>(null);
  const chartCtxRef    = useRef<CanvasRenderingContext2D | null>(null);
  const axisCanvasRef  = useRef<HTMLCanvasElement>(null);
  const axisCtxRef     = useRef<CanvasRenderingContext2D | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartWidthRef = useRef(CHART_W);
  const [chartTooltip, setChartTooltip] = useState<{ x: number; y: number; entry: IntervalEntry; idx: number } | null>(null);

  // チャレンジモード
  const [challengeState, setChallengeState] = useState<ChallengeState>("idle");
  const challengeStateRef = useRef<ChallengeState>("idle");
  const [challengeDuration, setChallengeDuration] = useState(30);
  const challengeDurationRef = useRef(30);
  const challengeStartRef = useRef(0);
  const challengeScrCountRef = useRef(0);
  const [challengeScrCount, setChallengeScrCount] = useState(0);
  const [challengeTimeLeft, setChallengeTimeLeft] = useState(0);
  const challengeIntervalsRef = useRef<IntervalEntry[]>([]);
  const challengeBarStartIdx = useRef(0);  // チャレンジ開始時のintervalHistory長
  const challengeBarEndIdx = useRef(0);    // チャレンジ終了時のintervalHistory長
  const challengeEndRef = useRef(0);       // チャレンジ終了時刻(nowMs)
  const [challengeResult, setChallengeResult] = useState<{
    count: number; duration: number; avgMs: number | null;
    noteDivision: string | null;
  } | null>(null);

  // キーコンフィグ (config 読み込みまでは空、async useEffect で上書き)
  const [keyConfig, setKeyConfig] = useState<KeyConfig>({});
  const keyConfigRef    = useRef<KeyConfig>({});
  const [showConfig, setShowConfig] = useState(false);
  const [assigningTarget, setAssigningTarget] = useState<string | null>(null);
  const assigningRef    = useRef<string | null>(null);

  // PHOENIX WAN モード (axis 判定方式の切り替え)
  const [phoenixWan, setPhoenixWan] = useState(false);

  // チャートスケール (log / linear)
  const [chartScale, setChartScale] = useState<"log" | "linear">("linear");
  const chartScaleRef = useRef<"log" | "linear">("linear");

  // ---- モードタブ ----
  const [appMode, setAppMode] = useState<AppMode>("free");
  const appModeRef = useRef<AppMode>("free");
  useEffect(() => { appModeRef.current = appMode; }, [appMode]);

  // Constant モードの選択中音符 (Y軸 range 計算用、ConstantMode からコールバックで受け取る)
  const constantNoteDivRef = useRef<8 | 12 | 16 | 24 | 32>(16);

  // Constant モードの許容比率 (0.10〜0.50)
  const [constantThresholdRatio, setConstantThresholdRatio] = useState<number>(0.30);
  const constantThresholdRatioRef = useRef<number>(0.30);

  // チャレンジモード: 入力種別自動判別（"scr" | "key" | null=未確定）
  type ChallengeInputType = "scr" | "key" | null;
  const [challengeInputType, setChallengeInputType] = useState<ChallengeInputType>(null);
  const challengeInputTypeRef = useRef<ChallengeInputType>(null);
  // 連打モード用カウント（チャレンジ統合版）
  const challengeKeyCountRef = useRef(0);
  const [challengeKeyCount, setChallengeKeyCount] = useState(0);
  const [_challengeKeyLabel, setChallengeKeyLabel] = useState("");
  const challengeKeyLabelRef = useRef("");

  // ---- 設定・記録の永続化 ----
  const [_appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [appRecords, setAppRecords] = useState<AppRecords | null>(null);
  const appRecordsRef = useRef<AppRecords | null>(null);
  const configLoadedRef = useRef(false);

  // 日別カウント（メモリ内蓄積用）
  const dailyScratchCountRef = useRef(0);
  const dailyKeyPressCountRef = useRef(0);
  const lastFlushRef = useRef(Date.now());

  // 起動時: 設定ファイル読み込み
  useEffect(() => {
    if (configLoadedRef.current) return;
    configLoadedRef.current = true;
    (async () => {
      try {
        const config = await readConfig();
        setAppConfig(config);
        // 設定値をstateとrefに反映 (config が source of truth)
        const cfgKey = config.input.keyConfig ?? {};
        keyConfigRef.current = cfgKey;
        setKeyConfig(cfgKey);
        bpmRef.current = config.tempo.bpm;
        setBpm(config.tempo.bpm);
        setBpmText(String(config.tempo.bpm));
        greenNumRef.current = config.display.greenNum;
        setGreenNum(config.display.greenNum);
        setGreenNumText(String(config.display.greenNum));
        gridModeRef.current = config.display.gridMode;
        setGridMode(config.display.gridMode);
        // 旧 config.json に gridSubdivision が無いケースのフォールバック (undefined → 4)
        const gs = config.display.gridSubdivision ?? 4;
        gridSubRef.current = gs;
        setGridSub(gs);
        metroOnRef.current = config.tempo.metronome.on;
        setMetroOn(config.tempo.metronome.on);
        metroDivRef.current = config.tempo.metronome.div;
        setMetroDiv(config.tempo.metronome.div);
        metroVolRef.current = config.tempo.metronome.vol;
        setMetroVol(config.tempo.metronome.vol);
        sideRef.current = config.display.side;
        setSide(config.display.side);
        clapOnRef.current = config.scratch.clapOn;
        setClapOn(config.scratch.clapOn);
        setPhoenixWan(config.input.phoenixWan);
        invoke("set_phoenix_wan_mode", { enabled: config.input.phoenixWan }).catch(console.error);
        chartScaleRef.current = config.display.chartScale;
        setChartScale(config.display.chartScale);
        scrResetMsBaseRef.current = config.scratch.resetMs;
        setScrResetMsBase(config.scratch.resetMs);
        scrResetMsRef.current = config.scratch.resetMs;
        // Drill は一旦非表示にしているため drill 保存値は free に戻す
        setAppMode(config.modes.current === "drill" ? "free" : config.modes.current);
        setConstantThresholdRatio(config.modes.constant.thresholdRatio);
        constantThresholdRatioRef.current = config.modes.constant.thresholdRatio;
        if (config.tempo.metronome.on && !audioCtxRef.current) {
          audioCtxRef.current = new AudioContext();
          if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
        }
      } catch (err) {
        console.error("Config load failed:", err);
      }
      // 記録読み込み
      try {
        const records = await readRecords();
        setAppRecords(records);
        appRecordsRef.current = records;
      } catch (err) {
        console.error("Records load failed:", err);
      }
    })();
  }, []);

  // 設定を保存するヘルパー (グループ単位で部分更新)。
  // 例: updateConfig("tempo", { bpm: 200 }) で tempo セクションだけマージ保存。
  type ConfigSection = "input" | "display" | "tempo" | "scratch" | "modes";
  const updateConfig = useCallback(<K extends ConfigSection>(
    section: K,
    partial: Partial<AppConfig[K]>,
  ) => {
    setAppConfig(prev => {
      if (!prev) return prev;
      const updated: AppConfig = {
        ...prev,
        [section]: { ...prev[section], ...partial },
      };
      writeConfig(updated).catch(console.error);
      return updated;
    });
  }, []);

  // 記録を保存するヘルパー
  const saveRecords = useCallback((updater: (prev: AppRecords) => AppRecords) => {
    setAppRecords(prev => {
      const base = prev ?? { version: 2, challengeRecords: [], drillRecords: [], rapidPressRecords: [], constantRecords: [], dailyCounts: {} };
      const updated = updater(base);
      appRecordsRef.current = updated;
      writeRecords(updated).catch(console.error);
      return updated;
    });
  }, []);

  // 日別カウントのflush
  const flushDailyCounts = useCallback(() => {
    if (dailyScratchCountRef.current === 0 && dailyKeyPressCountRef.current === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const scrDelta = dailyScratchCountRef.current;
    const keyDelta = dailyKeyPressCountRef.current;
    dailyScratchCountRef.current = 0;
    dailyKeyPressCountRef.current = 0;
    lastFlushRef.current = Date.now();
    saveRecords(prev => {
      const dc = { ...prev.dailyCounts };
      const existing = dc[today] ?? { totalScratches: 0, totalKeyPresses: 0 };
      dc[today] = {
        totalScratches: existing.totalScratches + scrDelta,
        totalKeyPresses: existing.totalKeyPresses + keyDelta,
      };
      return { ...prev, dailyCounts: dc };
    });
  }, [saveRecords]);

  // 30秒ごと + visibilitychangeでflush
  useEffect(() => {
    const interval = setInterval(flushDailyCounts, 30000);
    const onVisChange = () => { if (document.hidden) flushDailyCounts(); };
    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisChange);
      flushDailyCounts();
    };
  }, [flushDailyCounts]);

  // ---- ドリルモード・連打モード用コールバックシステム ----
  const scratchResetCallbacks = useRef<Set<(finalCount: number, firstDir: number) => void>>(new Set());
  const scratchChangeCallbacks = useRef<Set<(count: number, dir: number) => void>>(new Set());
  const scratchIntervalCallbacks = useRef<Set<(intervalMs: number, dir: number) => void>>(new Set());
  const keyDownCallbacks = useRef<Set<(laneId: string) => void>>(new Set());
  const scrFirstDirRef = useRef(0);

  // 連皿しきい値 (基本値、ユーザ設定。500/400/300)
  const [scrResetMsBase, setScrResetMsBase] = useState<number>(SCR_RESET_MS);
  const scrResetMsBaseRef = useRef<number>(SCR_RESET_MS);
  // SCR_RESET_MS 動的上書き用 (Constant モードで slow tempo を扱えるよう、target*2.5 等に上書き)
  const scrResetMsRef = useRef<number>(SCR_RESET_MS);
  const setScrResetMs = useCallback((ms: number | null) => {
    scrResetMsRef.current = ms ?? scrResetMsBaseRef.current;
  }, []);

  // scale / bpm / appMode / しきい値 が変わったら Y軸ラベル overlay を再描画
  useEffect(() => {
    if (axisCtxRef.current) {
      const ci = computeConstantInfo(appMode, bpm, constantNoteDivRef.current, constantThresholdRatio);
      const linRange = computeLinRange(ci, scrResetMsBase);
      drawYAxisLabels(axisCtxRef.current, CHART_H, bpm, chartScale, linRange, ci);
    }
  }, [chartScale, bpm, appMode, scrResetMsBase, constantThresholdRatio]);

  const onScratchReset = useCallback((cb: (finalCount: number, firstDir: number) => void) => {
    scratchResetCallbacks.current.add(cb);
  }, []);
  const offScratchReset = useCallback((cb: (finalCount: number, firstDir: number) => void) => {
    scratchResetCallbacks.current.delete(cb);
  }, []);
  const onScratchChange = useCallback((cb: (count: number, dir: number) => void) => {
    scratchChangeCallbacks.current.add(cb);
  }, []);
  const offScratchChange = useCallback((cb: (count: number, dir: number) => void) => {
    scratchChangeCallbacks.current.delete(cb);
  }, []);
  const onScratchInterval = useCallback((cb: (intervalMs: number, dir: number) => void) => {
    scratchIntervalCallbacks.current.add(cb);
  }, []);
  const offScratchInterval = useCallback((cb: (intervalMs: number, dir: number) => void) => {
    scratchIntervalCallbacks.current.delete(cb);
  }, []);

  // ---- 記録完了ハンドラ ----
  const handleChallengeComplete = useCallback((record: ChallengeRecord) => {
    saveRecords(prev => ({
      ...prev,
      challengeRecords: [...prev.challengeRecords, record],
    }));
  }, [saveRecords]);

  const handleDrillComplete = useCallback((result: DrillResult) => {
    saveRecords(prev => ({
      ...prev,
      drillRecords: [...prev.drillRecords, result],
    }));
  }, [saveRecords]);

  const handleRapidPressComplete = useCallback((result: RapidPressResult) => {
    saveRecords(prev => ({
      ...prev,
      rapidPressRecords: [...prev.rapidPressRecords, result],
    }));
  }, [saveRecords]);

  const handleConstantComplete = useCallback((result: ConstantResult) => {
    saveRecords(prev => ({
      ...prev,
      constantRecords: [...prev.constantRecords, result],
    }));
  }, [saveRecords]);

  const handleExportRecords = useCallback(async () => {
    try {
      // AppDataDirのrecords.jsonを取得してデスクトップに保存
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dir = await invoke<string>("get_app_data_dir");
      const exportPath = `${dir}records_export_${timestamp}.json`;
      await exportRecords(exportPath);
      alert(`記録をエクスポートしました:\n${exportPath}`);
    } catch (err) {
      alert(`エクスポートに失敗しました: ${err}`);
    }
  }, []);

  // チャンネル取得/作成
  const getOrCreateChannel = useRef((source: string, id: string, kind: "button" | "axis"): Channel => {
    const key = `${source}:${id}`;
    let ch = channelsRef.current.find((c) => `${c.source}:${c.id}` === key);
    if (!ch) {
      ch = { id, source, kind, spans: [] };
      channelsRef.current.push(ch);
      setChannelCount(channelsRef.current.length);
    }
    return ch;
  }).current;

  // イベント受信
  useEffect(() => {
    const unlisten = listen<InputEvent>("input-event", (e) => {
      const ev = e.payload;
      const nowJs = performance.now() - startRef.current;

      if (assigningRef.current !== null) {
        if (ev.kind === "ButtonUp") return;
        const target = assigningRef.current;
        const binding: Binding = ev.kind === "AxisMove"
          ? { source: ev.source, id: ev.id, direction: ev.direction }
          : { source: ev.source, id: ev.id };
        const newCfg = { ...keyConfigRef.current, [target]: binding };
        keyConfigRef.current = newCfg;
        setKeyConfig(newCfg);
        updateConfig("input", { keyConfig: newCfg });
        // 同じボタンの再割り当てができるよう assigningTarget はリセットしない
        return;
      }

      const resolved = resolveChannel(keyConfigRef.current, ev);
      if (resolved === null) return;

      // SCR 入力処理 (AxisMove / ButtonDown 共通の単一エントリポイント)。
      //
      //   1. 入力判定 (この関数内のみで実施):
      //      - 方向が変わった → 新規入力
      //      - 同方向だが前回イベントから SCR_INPUT_DEDUP_MS 以上経過 → 新規入力
      //      - それ以外 → 同一スクラッチ継続 (何もしない)
      //   2. 新規入力と判定されたら、レーンスパン / クラップ音 / カウント・履歴・
      //      callback / チャレンジモード処理を全てまとめて発火する。
      //
      // 「入力判定が通ったら全 downstream が確実に動く」状態を保証することで、
      // 「音は鳴るのに描画が出ない」「カウントは増えないのに span だけ生える」
      // といった不整合を構造的に防ぐ。
      const handleScrInput = (
        ch: Channel,
        dir: number,
        rustT: number | undefined,
      ) => {
        // === 入力判定 ===
        const gap = nowJs - scrLastEventTimeRef.current;
        const isNewInput = (dir !== scrLastDirRef.current) || (gap >= SCR_INPUT_DEDUP_MS);
        // 継続判定用 (フィルタ可否によらず last event 時刻は更新)
        scrLastEventTimeRef.current = nowJs;
        if (!isNewInput) return;

        scrLastDirRef.current = dir;
        const prevTime = scrLastTimeRef.current;
        scrLastTimeRef.current = nowJs;

        // === レーンスパン: 既存を閉じて新規を push ===
        const last = ch.spans.at(-1);
        if (last && last.end === null) last.end = nowJs;
        ch.spans.push({ start: nowJs, end: null, direction: dir, rustT });

        // === クラップ音 ===
        if (clapOnRef.current) invoke("play_clap").catch(() => {});

        // === カウント・履歴・コールバック・チャレンジモード ===
        if (scrCountRef.current === 0) {
          scrOriginRef.current = nowJs;
          scrLastOriginRef.current = nowJs;
          scrIntervalHistRef.current = [];
          scrPrevDirTimeRef.current = nowJs;
          // 新しい SCR セッションを履歴に追加
          scrSessionsRef.current.push({ originMs: nowJs, lastInputMs: nowJs });
          if (challengeStateRef.current !== "running") {
            intervalHistoryRef.current = [{ ms: 0, dir }];
            challengeBarStartIdx.current = 0;
            challengeBarEndIdx.current = 0;
          } else {
            intervalHistoryRef.current = [...intervalHistoryRef.current, { ms: 0, dir }];
          }
        }
        // 現セッションの lastInputMs を更新
        const curSession = scrSessionsRef.current.at(-1);
        if (curSession) curSession.lastInputMs = nowJs;
        scrCountRef.current += 1;
        setScrCount(scrCountRef.current);
        // 日別カウント
        dailyScratchCountRef.current += 1;
        // 最初のスクラッチ方向を記録
        if (scrCountRef.current === 1) scrFirstDirRef.current = dir;
        // コールバック通知
        for (const cb of scratchChangeCallbacks.current) cb(scrCountRef.current, dir);

        // チャレンジモード: スクラッチカウント
        const addedDummy = scrCountRef.current === 1; // ダミーを追加した直後
        if (challengeStateRef.current === "ready") {
          // 最初の入力がスクラッチ → スクラッチチャレンジ
          challengeInputTypeRef.current = "scr";
          setChallengeInputType("scr");
          challengeStateRef.current = "running";
          setChallengeState("running");
          challengeStartRef.current = nowJs;
          challengeScrCountRef.current = 1;
          setChallengeScrCount(1);
          challengeIntervalsRef.current = [];
          challengeBarStartIdx.current = addedDummy
            ? intervalHistoryRef.current.length - 1
            : intervalHistoryRef.current.length;
        } else if (challengeStateRef.current === "running" && challengeInputTypeRef.current === "scr") {
          challengeScrCountRef.current += 1;
          setChallengeScrCount(challengeScrCountRef.current);
        }

        let intervalMs: number | null = null;
        let estimatedBpm: number | null = null;
        let offsetMs: number | null = null;
        let noteDivision: string | null = null;
        let avgIntervalMs: number | null = null;
        let avgNoteDivision: string | null = null;

        if (scrCountRef.current >= 2 && scrPrevDirTimeRef.current !== null && isFinite(prevTime)) {
          intervalMs = Math.floor(nowJs - scrPrevDirTimeRef.current);

          // 棒グラフ履歴を更新
          intervalHistoryRef.current = [
            ...intervalHistoryRef.current,
            { ms: intervalMs, dir },
          ];
          // チャレンジモード: インターバル記録
          if (challengeStateRef.current === "running") {
            challengeIntervalsRef.current.push({ ms: intervalMs, dir });
          }

          // 連続スクラッチ中の interval を蓄積し、平均を算出
          scrIntervalHistRef.current.push(intervalMs);
          const sum = scrIntervalHistRef.current.reduce((s, v) => s + v, 0);
          avgIntervalMs = Math.round(sum / scrIntervalHistRef.current.length);

          // Constant モード等向け interval コールバック通知
          for (const cb of scratchIntervalCallbacks.current) cb(intervalMs, dir);

          const elapsedMs = nowJs - scrOriginRef.current;
          if (elapsedMs > 0 && scrCountRef.current >= 2) {
            estimatedBpm = Math.floor((scrCountRef.current / 2) / (elapsedMs / 60000));
          }
          const gm = gridModeRef.current;
          const bpmVal = bpmRef.current;
          if ((gm === "bpm" || gm === "scr") && bpmVal > 0) {
            const beatMs = 60000 / bpmVal;
            const origin = gm === "scr" ? scrLastOriginRef.current : 0;
            if (isFinite(origin)) {
              const beatPhase = ((nowJs - origin) % beatMs + beatMs) % beatMs;
              const raw = beatPhase <= beatMs / 2 ? beatPhase : beatPhase - beatMs;
              offsetMs = raw >= 0 ? Math.floor(raw) : -Math.floor(-raw);
            }
          }
          // 音符区分（設定BPMを基準に判定）
          if (bpmVal > 0) {
            noteDivision = nearestNoteDivision(intervalMs, bpmVal);
            if (avgIntervalMs !== null) {
              avgNoteDivision = nearestNoteDivision(avgIntervalMs, bpmVal);
            }
          }
        }
        scrPrevDirTimeRef.current = nowJs;
        setScrInfo({ count: scrCountRef.current, intervalMs, estimatedBpm, offsetMs, noteDivision, avgIntervalMs, avgNoteDivision });
        setScrActive(true);
      };

      if (ev.kind === "ButtonDown") {
        const ch = getOrCreateChannel(ev.source, resolved.laneId, resolved.kind);
        if (resolved.laneId === "SCR" && resolved.direction !== undefined) {
          // SCR ボタン: AxisMove と同じ統一入力ハンドラに通す。
          // span push / clap / count は handleScrInput の中で全てまとめて処理する。
          handleScrInput(ch, resolved.direction, ev.t);
        } else {
          // 鍵盤など SCR 以外: 既存のスパン push ロジック
          const last = ch.spans.at(-1);
          if (resolved.kind === "axis" && last && last.end === null && last.direction !== resolved.direction) {
            last.end = nowJs;
            ch.spans.push({ start: nowJs, end: null, rustT: ev.t, direction: resolved.direction });
          } else if (!last || last.end !== null) {
            ch.spans.push({ start: nowJs, end: null, rustT: ev.t, direction: resolved.direction });
          }
        }
        // 鍵盤入力: コールバック通知 + 日別カウント + チャレンジ連打
        if (resolved.laneId.startsWith("KEY")) {
          dailyKeyPressCountRef.current += 1;
          for (const cb of keyDownCallbacks.current) cb(resolved.laneId);
          // チャレンジモード: 最初の入力がキー → 連打チャレンジ
          if (challengeStateRef.current === "ready") {
            challengeInputTypeRef.current = "key";
            setChallengeInputType("key");
            challengeStateRef.current = "running";
            setChallengeState("running");
            challengeStartRef.current = nowJs;
            challengeKeyCountRef.current = 1;
            setChallengeKeyCount(1);
            setChallengeKeyLabel(resolved.laneId);
            challengeKeyLabelRef.current = resolved.laneId;
          } else if (challengeStateRef.current === "running" && challengeInputTypeRef.current === "key" && resolved.laneId === challengeKeyLabelRef.current) {
            challengeKeyCountRef.current += 1;
            setChallengeKeyCount(challengeKeyCountRef.current);
          }
        }
      } else if (ev.kind === "ButtonUp") {
        const ch = getOrCreateChannel(ev.source, resolved.laneId, resolved.kind);
        const last = ch.spans.at(-1);
        if (last && last.end === null) {
          const holdMs = last.rustT !== undefined ? ev.t - last.rustT : 0;
          last.end = last.start + holdMs;
        }
      } else if (ev.kind === "AxisMove") {
        const ch = getOrCreateChannel(ev.source, resolved.laneId, resolved.kind);
        const key = `${ev.source}:${resolved.laneId}`;
        // AXIS_TIMEOUT 用の last event 時刻は継続/新規にかかわらず常に更新
        // (継続中に span が AXIS_TIMEOUT で閉じてしまうのを防ぐ)
        axisLastRef.current.set(key, nowJs);
        const dir = resolved.direction ?? ev.direction;
        if (resolved.laneId === "SCR") {
          // SCR: span push / clap / count は全て handleScrInput 内で判定後に発火
          handleScrInput(ch, dir, undefined);
        } else {
          // SCR 以外の axis lane (現状は無し、将来用): 既存スパンロジック
          const last = ch.spans.at(-1);
          if (!last || last.end !== null) {
            ch.spans.push({ start: nowJs, end: null, direction: dir });
          } else if (last.direction !== dir) {
            last.end = nowJs;
            ch.spans.push({ start: nowJs, end: null, direction: dir });
          }
        }
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [getOrCreateChannel]);

  useEffect(() => {
    if (canvasRef.current) ctxRef.current = canvasRef.current.getContext("2d");
    if (chartCanvasRef.current) chartCtxRef.current = chartCanvasRef.current.getContext("2d");
    if (axisCanvasRef.current) {
      axisCtxRef.current = axisCanvasRef.current.getContext("2d");
      if (axisCtxRef.current) {
        const ci = computeConstantInfo(appModeRef.current, bpmRef.current, constantNoteDivRef.current, constantThresholdRatioRef.current);
        const linRange = computeLinRange(ci, scrResetMsBaseRef.current);
        drawYAxisLabels(axisCtxRef.current, CHART_H, bpmRef.current, chartScaleRef.current, linRange, ci);
      }
    }
    if (metroOnRef.current) {
      const ac = new AudioContext();
      audioCtxRef.current = ac;
      if (ac.state === "suspended") ac.resume();
    }
    // 棒グラフコンテナの幅を監視
    const container = chartContainerRef.current;
    if (container) {
      const ro = new ResizeObserver((entries) => {
        const w = Math.floor(entries[0].contentRect.width);
        if (w > 0 && w !== chartWidthRef.current) {
          chartWidthRef.current = w;
          if (chartCanvasRef.current && chartCtxRef.current) {
            const neededW = CHART_PAD_L + intervalHistoryRef.current.length * CHART_BAR_W;
            const cw = Math.max(w, neededW);
            chartCanvasRef.current.width = cw;
            const cs = challengeStateRef.current;
            const cbr = cs === "running"
              ? { startIdx: challengeBarStartIdx.current, endIdx: intervalHistoryRef.current.length }
              : cs === "done"
              ? { startIdx: challengeBarStartIdx.current, endIdx: challengeBarEndIdx.current }
              : null;
            const ci = computeConstantInfo(appModeRef.current, bpmRef.current, constantNoteDivRef.current, constantThresholdRatioRef.current);
            const linRange = computeLinRange(ci, scrResetMsBaseRef.current);
            drawBarChart(chartCtxRef.current, intervalHistoryRef.current, bpmRef.current, cw, CHART_H, cbr, chartScaleRef.current, linRange, ci);
          }
        }
      });
      ro.observe(container);
      return () => ro.disconnect();
    }
  }, []);

  // kind: "beat1"=1拍目, "beat234"=2〜4拍目, "eighth"=8分裏
  const scheduleClick = (audioCtx: AudioContext, atTime: number, kind: "beat1" | "beat234" | "eighth", vol: number) => {
    const gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);
    const freq    = kind === "beat1" ? 880 : 440;
    const peakVol = kind === "beat1" ? vol : vol * 0.4;
    const decay   = kind === "beat1" ? 0.08 : 0.05;
    // 柔らかいアタック: 短いランプアップ後にdecay
    gainNode.gain.setValueAtTime(0, atTime);
    gainNode.gain.linearRampToValueAtTime(peakVol, atTime + 0.005);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, atTime + decay);
    const osc = audioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, atTime);
    osc.connect(gainNode);
    osc.start(atTime);
    osc.stop(atTime + decay + 0.01);
  };

  useEffect(() => {
    const loop = () => {
      const nowMs = performance.now() - startRef.current;
      const LOOKAHEAD_MS = 120;
      if (metroOnRef.current && audioCtxRef.current) {
        const ac = audioCtxRef.current;
        const bpmVal = bpmRef.current;
        if (bpmVal > 0) {
          const origin = 0;
          const beatMs = 60000 / bpmVal;
          const subDiv = metroDivRef.current;
          const subMs = beatMs / (subDiv / 4);
          const nowBeat = Math.floor((nowMs - origin) / subMs);
          if (metroNextBeatRef.current === null || metroNextBeatRef.current <= nowBeat) {
            metroNextBeatRef.current = nowBeat;
          }
          while (true) {
            const beatIdx: number = metroNextBeatRef.current!;
            const beatTimeMs = origin + beatIdx * subMs;
            if (beatTimeMs > nowMs + LOOKAHEAD_MS) break;
            if (beatTimeMs >= nowMs - 10) {
              const acTime = ac.currentTime + (beatTimeMs - nowMs) / 1000;
              if (acTime >= ac.currentTime) {
                // 4分: beatIdx=0,1,2,3... → 4拍ごとに beat1
                // 8分: beatIdx=0,1,2,...7,8... → 8拍ごとに beat1、それ以外は eighth
                const isMeasureBeat = subDiv === 8
                  ? beatIdx % 8 === 0
                  : Math.floor((beatTimeMs - origin) / beatMs + 0.01) % 4 === 0;
                const isEighth = subDiv === 8 && !isMeasureBeat;
                const kind = isMeasureBeat ? "beat1" : isEighth ? "eighth" : "beat234";
                scheduleClick(ac, acTime, kind, metroVolRef.current);
              }
            }
            metroNextBeatRef.current = beatIdx + 1;
          }
        }
      }
      if (!metroOnRef.current) metroNextBeatRef.current = null;

      axisLastRef.current.forEach((lastT, key) => {
        if (nowMs - lastT > AXIS_TIMEOUT) {
          const ch = channelsRef.current.find((c) => `${c.source}:${c.id}` === key);
          const last = ch?.spans.at(-1);
          if (last && last.end === null) last.end = lastT + AXIS_TIMEOUT / 2;
          axisLastRef.current.delete(key);
        }
      });

      // Session reset 判定は「全イベント (継続フィルタ含む) が止まってから scrResetMs 経過」で行う。
      // scrLastTimeRef (= 直近にカウントされた入力) を使うと、ゆっくり同方向回転中に
      // 継続イベントが filter され続けていても scrLastTimeRef が更新されないため、
      // 入力が来ているのに session reset が走ってしまい「一定間隔で1枚目」が再発する。
      if (scrCountRef.current > 0 && nowMs - scrLastEventTimeRef.current > scrResetMsRef.current) {
        const finalCount = scrCountRef.current;
        const firstDir = scrFirstDirRef.current;
        scrCountRef.current = 0;
        scrLastDirRef.current = 0;
        scrLastEventTimeRef.current = -Infinity;
        scrOriginRef.current = -Infinity;
        scrPrevDirTimeRef.current = null;
        scrIntervalHistRef.current = [];
        setScrCount(0);
        setScrActive(false);
        // ドリルモード用コールバック通知
        for (const cb of scratchResetCallbacks.current) cb(finalCount, firstDir);
      }

      const cutoff = nowMs - SPAN_RETAIN;
      for (const ch of channelsRef.current) {
        if (ch.spans.length > 0 && (ch.spans[0].end ?? nowMs) < cutoff) {
          ch.spans = ch.spans.filter((s) => (s.end ?? nowMs) > cutoff);
        }
      }
      // SCR セッション履歴も同じ window 内に保持
      if (scrSessionsRef.current.length > 0 && scrSessionsRef.current[0].lastInputMs < cutoff) {
        scrSessionsRef.current = scrSessionsRef.current.filter(s => s.lastInputMs >= cutoff);
      }

      const pb = playbackRef.current;
      let viewNowMs: number;
      if (pb.mode === "live") {
        viewNowMs = nowMs; pb.viewMs = nowMs;
      } else if (pb.mode === "playing") {
        viewNowMs = pb.viewMs + (nowMs - pb.startedAt);
        if (viewNowMs >= nowMs) {
          viewNowMs = nowMs; pb.mode = "live"; pb.viewMs = nowMs; setMode("live");
        }
      } else {
        viewNowMs = pb.viewMs;
      }

      if (sliderRef.current && !dragRef.current) {
        const sliderMax = pb.mode === "live" ? nowMs : (pausedMaxMsRef.current ?? nowMs);
        const minMs = Math.max(0, sliderMax - SPAN_RETAIN);
        sliderRef.current.min = String(minMs);
        sliderRef.current.max = String(sliderMax);
        sliderRef.current.value = String(viewNowMs);
      }

      if (ctxRef.current && canvasRef.current) {
        const orderedLanes = sideRef.current === "2P"
          ? [...LANE_DEFS.filter(l => l.id !== "SCR"), LANE_DEFS.find(l => l.id === "SCR")!]
          : LANE_DEFS;
        const crs = challengeStateRef.current;
        const cRange = crs === "running"
          ? { startMs: challengeStartRef.current, endMs: nowMs }
          : crs === "done"
          ? { startMs: challengeStartRef.current, endMs: challengeEndRef.current }
          : null;
        const activeLane = (challengeStateRef.current === "running" || challengeStateRef.current === "done")
          ? (challengeInputTypeRef.current === "key" ? challengeKeyLabelRef.current : challengeInputTypeRef.current === "scr" ? "SCR" : null)
          : null;
        drawTimeline(ctxRef.current, channelsRef.current, viewNowMs, nowMs, pb.mode === "live",
          canvasRef.current.width, scrCountRef.current, gridModeRef.current, bpmRef.current,
          scrSessionsRef.current, orderedLanes,
          greenNumRef.current * 1000 / 600, cRange, activeLane, gridSubRef.current);
      }
      if (chartCtxRef.current && chartCanvasRef.current) {
        const cs = challengeStateRef.current;
        const cBarRange = cs === "running"
          ? { startIdx: challengeBarStartIdx.current, endIdx: intervalHistoryRef.current.length }
          : cs === "done"
          ? { startIdx: challengeBarStartIdx.current, endIdx: challengeBarEndIdx.current }
          : null;
        // キャンバス幅をバー数に応じて拡張（コンテナ幅以上にする）
        const neededW = CHART_PAD_L + intervalHistoryRef.current.length * CHART_BAR_W;
        const cw = Math.max(chartWidthRef.current, neededW);
        if (chartCanvasRef.current.width !== cw) {
          chartCanvasRef.current.width = cw;
          // 右端に自動スクロール
          if (chartContainerRef.current) {
            chartContainerRef.current.scrollLeft = chartContainerRef.current.scrollWidth;
          }
        }
        const ci = computeConstantInfo(appModeRef.current, bpmRef.current, constantNoteDivRef.current, constantThresholdRatioRef.current);
        const linRange = computeLinRange(ci, scrResetMsBaseRef.current);
        drawBarChart(chartCtxRef.current, intervalHistoryRef.current, bpmRef.current, cw, CHART_H, cBarRange, chartScaleRef.current, linRange, ci);
      }
      // チャレンジモード: タイマー更新
      if (challengeStateRef.current === "running") {
        const elapsed = (nowMs - challengeStartRef.current) / 1000;
        const remaining = challengeDurationRef.current - elapsed;
        if (remaining <= 0) {
          challengeStateRef.current = "done";
          setChallengeState("done");
          setChallengeTimeLeft(0);
          challengeEndRef.current = challengeStartRef.current + challengeDurationRef.current * 1000;
          challengeBarEndIdx.current = intervalHistoryRef.current.length;
          const intervals = challengeIntervalsRef.current;
          const avgMs = intervals.length > 0
            ? Math.round(intervals.reduce((s, e) => s + e.ms, 0) / intervals.length)
            : null;
          const nd = avgMs !== null && bpmRef.current > 0
            ? nearestNoteDivision(avgMs, bpmRef.current) : null;
          const dur = challengeDurationRef.current;
          if (challengeInputTypeRef.current === "key") {
            // 連打チャレンジ完了
            const cnt = challengeKeyCountRef.current;
            setChallengeResult({ count: cnt, duration: dur, avgMs: null, noteDivision: null });
            const record: RapidPressResult = {
              date: new Date().toISOString(),
              duration: dur,
              pressCount: cnt,
              keyLabel: challengeKeyLabelRef.current || "KEY",
            };
            handleRapidPressComplete(record);
          } else {
            // スクラッチチャレンジ完了
            const cnt = challengeScrCountRef.current;
            setChallengeResult({ count: cnt, duration: dur, avgMs, noteDivision: nd });
            const record: ChallengeRecord = {
              date: new Date().toISOString(),
              duration: dur,
              scratchCount: cnt,
              avgIntervalMs: avgMs,
              bpm: bpmRef.current,
              noteDivision: nd,
            };
            handleChallengeComplete(record);
          }
        } else {
          setChallengeTimeLeft(remaining);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const getMsPerPx = () => (greenNumRef.current * 1000 / 600) / (CANVAS_H - 1 - HEADER_H);
    const pause = (viewMs: number) => {
      if (pausedMaxMsRef.current === null) {
        pausedMaxMsRef.current = performance.now() - startRef.current;
      }
      const minMs = Math.max(0, (pausedMaxMsRef.current ?? 0) - SPAN_RETAIN);
      playbackRef.current = { mode: "paused", viewMs: Math.max(minMs, viewMs), startedAt: 0 };
      setMode("paused");
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const nowMs = performance.now() - startRef.current;
      const pb = playbackRef.current;
      const cur = pb.mode === "live" ? nowMs : pb.mode === "playing" ? pb.viewMs + (nowMs - pb.startedAt) : pb.viewMs;
      const next = cur + e.deltaY * getMsPerPx();
      if (next >= nowMs) {
        pausedMaxMsRef.current = null;
        playbackRef.current = { mode: "live", viewMs: nowMs, startedAt: 0 };
        setMode("live");
      } else {
        pause(next);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const nowMs = performance.now() - startRef.current;
      const pb = playbackRef.current;
      const cur = pb.mode === "live" ? nowMs : pb.mode === "playing" ? pb.viewMs + (nowMs - pb.startedAt) : pb.viewMs;
      dragRef.current = { startY: e.clientY, startViewMs: cur };
      pause(cur);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const nowMs = performance.now() - startRef.current;
      const dy = e.clientY - dragRef.current.startY;
      playbackRef.current.viewMs = Math.max(0, Math.min(dragRef.current.startViewMs + dy * getMsPerPx() * 3, nowMs));
    };
    const onMouseUp = () => { dragRef.current = null; };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const startPlaying = () => {
    const nowMs = performance.now() - startRef.current;
    const cur = playbackRef.current.mode === "paused" ? playbackRef.current.viewMs : nowMs;
    playbackRef.current = { mode: "playing", viewMs: cur, startedAt: nowMs };
    setMode("playing");
  };
  const goLive = () => {
    const nowMs = performance.now() - startRef.current;
    pausedMaxMsRef.current = null;
    playbackRef.current = { mode: "live", viewMs: nowMs, startedAt: 0 };
    setMode("live");
  };
  const onSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    const max = Number(e.target.max);
    if (max > 0 && val >= max) {
      goLive();
    } else {
      // 初めてpausedに入る瞬間にmaxを固定
      if (playbackRef.current.mode === "live") {
        pausedMaxMsRef.current = performance.now() - startRef.current;
      }
      playbackRef.current = { mode: "paused", viewMs: val, startedAt: 0 };
      setMode("paused");
    }
  };

  const width = LANE_DEFS.reduce((s, d) => s + d.w, 0);

  // キーコンフィグ操作
  const startAssigning = (target: string) => { assigningRef.current = target; setAssigningTarget(target); };
  const clearBinding = (target: string) => {
    const newCfg = { ...keyConfigRef.current, [target]: null };
    keyConfigRef.current = newCfg; setKeyConfig(newCfg);
    updateConfig("input", { keyConfig: newCfg });
  };
  const clearAll = () => {
    const newCfg: KeyConfig = {};
    keyConfigRef.current = newCfg; setKeyConfig(newCfg);
    updateConfig("input", { keyConfig: newCfg });
    assigningRef.current = null; setAssigningTarget(null);
  };
  const closeConfig = () => { assigningRef.current = null; setAssigningTarget(null); setShowConfig(false); };

  // KEY_DEFS imported from constants.ts

  return (
    <div className="min-h-screen bg-background text-foreground font-mono p-4 flex flex-col gap-4 items-center">

      {/* 操作ボタン */}
      <div className="flex gap-2 items-center">
        <Button
          variant="outline"
          onClick={startPlaying}
          disabled={mode === "live" || mode === "playing"}
        >
          <Play className="w-4 h-4" /> ここから再生
        </Button>
        <Button
          variant={mode !== "live" ? "outline" : "secondary"}
          onClick={goLive}
          disabled={mode === "live"}
        >
          <ChevronsRight className="w-4 h-4" /> ライブに戻る
        </Button>
        <Button
          variant="outline"
          onClick={() => setShowConfig(true)}
          className="ml-auto"
        >
          <Settings className="w-4 h-4" /> Key Config
        </Button>
      </div>

      {/* メイン行: モード別パネル + canvas + スライダー + 設定パネル */}
      <div className="flex items-start gap-2 overflow-x-auto">

        {/* 左カラム: モード選択ドロップダウン + モード固有カード */}
        <div className="flex flex-col gap-2 shrink-0 w-[160px]">
          {/* p-1.5: focus ring (4px outside) が overflow-x-auto 親でクリップされないように上下左右余白を確保 */}
          <div className="flex items-center gap-2 p-1.5">
            <Label className="text-xs text-muted-foreground shrink-0">Mode</Label>
            <Select
              value={appMode}
              onValueChange={(v) => {
                const m = v as AppMode;
                setAppMode(m);
                updateConfig("modes", { current: m });
              }}
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free" className="text-xs">Free</SelectItem>
                <SelectItem value="challenge" className="text-xs">Challenge</SelectItem>
                <SelectItem value="constant" className="text-xs">Constant</SelectItem>
              </SelectContent>
            </Select>
          </div>

        {/* チャレンジモード */}
        {appMode === "challenge" && (
        <Card className={`h-fit shrink-0 w-[160px] ${challengeState === "running"
          ? (challengeInputType === "key"
            ? "border-cyan-500/50 shadow-[0_0_8px_rgba(6,182,212,0.2)]"
            : "border-orange-500/50 shadow-[0_0_8px_rgba(255,165,0,0.2)]")
          : ""}`}>
          <CardHeader className="pb-2 pt-3 px-3">
            <CardTitle className="text-xs text-muted-foreground">Challenge</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 flex flex-col gap-2 items-center">
            {/* 時間選択ボタン */}
            <div className="grid grid-cols-3 gap-1 w-full">
              {([1, 5, 10, 20, 30, 60] as const).map(d => (
                <Button
                  key={d}
                  size="sm"
                  variant={challengeState !== "idle" && challengeDuration === d && challengeState !== "done" ? "default" : "outline"}
                  className={`text-xs px-1 h-7 ${challengeState === "done" && challengeDuration === d ? "border-primary text-primary" : ""}`}
                  disabled={challengeState === "running"}
                  onClick={() => {
                    setChallengeDuration(d);
                    challengeDurationRef.current = d;
                    challengeStateRef.current = "ready";
                    setChallengeState("ready");
                    challengeScrCountRef.current = 0;
                    setChallengeScrCount(0);
                    challengeKeyCountRef.current = 0;
                    setChallengeKeyCount(0);
                    challengeInputTypeRef.current = null;
                    setChallengeInputType(null);
                    setChallengeKeyLabel("");
                    challengeKeyLabelRef.current = "";
                    setChallengeResult(null);
                  }}
                >
                  {d === 60 ? "1m" : `${d}s`}
                </Button>
              ))}
            </div>

            {/* タイマー表示 */}
            <div className={`font-mono text-3xl font-bold tabular-nums text-center w-full ${
              challengeState === "running"
                ? (challengeInputType === "key" ? "text-cyan-400" : "text-orange-400")
                : challengeState === "ready" ? "text-zinc-500"
                : challengeState === "done" ? "text-zinc-500"
                : "text-zinc-700"
            }`}>
              {challengeState === "running"
                ? challengeTimeLeft.toFixed(2)
                : challengeState === "ready"
                ? `${challengeDuration}.00`
                : challengeState === "done"
                ? "0.00"
                : "0.00"}
            </div>

            {/* カウント表示（SCR/KEY自動判別） */}
            <div className="text-center w-full">
              <span className="text-[10px] text-muted-foreground">
                {challengeInputType === "key" ? "Presses" : "Scratches"}
              </span>
              <div className={`font-mono text-3xl font-bold tabular-nums ${
                challengeState === "running"
                  ? (challengeInputType === "key" ? "text-cyan-300" : "text-yellow-300")
                  : challengeState === "done"
                  ? (challengeInputType === "key" ? "text-cyan-300" : "text-yellow-300")
                  : "text-zinc-700"
              }`}>
                {challengeState === "running"
                  ? (challengeInputType === "key" ? challengeKeyCount : challengeScrCount)
                  : challengeState === "done" && challengeResult
                  ? challengeResult.count
                  : "—"}
              </div>
            </div>

            {/* READY: スクラッチで開始プロンプト */}
            {challengeState === "ready" && (
              <>
                <span className="text-xs text-muted-foreground animate-pulse">
                  入力で開始
                </span>
                <Button
                  size="sm" variant="ghost"
                  className="text-xs"
                  onClick={() => {
                    challengeStateRef.current = "idle";
                    setChallengeState("idle");
                  }}
                >
                  キャンセル
                </Button>
              </>
            )}

            {/* RUNNING: リセットボタン */}
            {challengeState === "running" && (
              <Button
                size="sm" variant="ghost"
                className="text-xs"
                onClick={() => {
                  challengeStateRef.current = "idle";
                  setChallengeState("idle");
                  challengeScrCountRef.current = 0;
                  setChallengeScrCount(0);
                  challengeKeyCountRef.current = 0;
                  setChallengeKeyCount(0);
                  challengeInputTypeRef.current = null;
                  setChallengeInputType(null);
                }}
              >
                リセット
              </Button>
            )}

            {/* DONE: 結果詳細 */}
            {challengeState === "done" && challengeResult && (
              <div className="text-center flex flex-col gap-1 w-full">
                <div className="text-base font-bold text-green-400">FINISH!</div>
                {challengeInputType === "key" ? (
                  <span className="text-xs text-zinc-400">
                    {(challengeResult.count / challengeResult.duration).toFixed(1)} 回/秒
                  </span>
                ) : (
                  challengeResult.avgMs !== null && (
                    <div className="flex flex-col gap-0">
                      <span className="text-xs text-zinc-400">
                        Avg: {challengeResult.avgMs}ms
                      </span>
                      {challengeResult.noteDivision && (
                        <span className="text-xs text-zinc-500">
                          (BPM{bpm} {challengeResult.noteDivision})
                        </span>
                      )}
                    </div>
                  )
                )}
                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                    challengeInputType === "key"
                      ? `${challengeResult.duration === 60 ? "1m" : `${challengeResult.duration}s`}で${challengeResult.count}回キーを叩いたよ！`
                        + `\n${(challengeResult.count / challengeResult.duration).toFixed(1)} 回/秒`
                        + "\n#daken_trainer"
                      : `${challengeResult.duration === 60 ? "1m" : `${challengeResult.duration}s`}で${challengeResult.count}回スクラッチしたよ！`
                        + (challengeResult.avgMs !== null
                          ? `\nAvg: ${challengeResult.avgMs}ms` + (challengeResult.noteDivision ? ` (BPM${bpm} ${challengeResult.noteDivision})` : "")
                          : "")
                        + "\n#daken_trainer"
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center justify-center gap-1 text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-zinc-500 transition-colors"
                >
                  Share on 𝕏
                </a>
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {/* ドリルモード */}
        {appMode === "drill" && (
          <DrillMode
            onScratchReset={onScratchReset}
            offScratchReset={offScratchReset}
            onScratchChange={onScratchChange}
            offScratchChange={offScratchChange}
            onComplete={handleDrillComplete}
          />
        )}

        {/* Constantモード */}
        {appMode === "constant" && (
          <ConstantMode
            onScratchInterval={onScratchInterval}
            offScratchInterval={offScratchInterval}
            onScratchChange={onScratchChange}
            offScratchChange={offScratchChange}
            onScratchReset={onScratchReset}
            offScratchReset={offScratchReset}
            setScrResetMs={setScrResetMs}
            onComplete={handleConstantComplete}
            onNoteDivChange={(d) => {
              constantNoteDivRef.current = d;
              if (axisCtxRef.current) {
                const ci = computeConstantInfo(appModeRef.current, bpmRef.current, d, constantThresholdRatioRef.current);
                const linRange = computeLinRange(ci, scrResetMsBaseRef.current);
                drawYAxisLabels(axisCtxRef.current, CHART_H, bpmRef.current, chartScaleRef.current, linRange, ci);
              }
            }}
            initialThresholdRatio={constantThresholdRatio}
            onThresholdRatioChange={(r) => {
              constantThresholdRatioRef.current = r;
              setConstantThresholdRatio(r);
              updateConfig("modes", { constant: { thresholdRatio: r } });
              // overlay (上下限ライン位置が変わる) を再描画
              if (axisCtxRef.current) {
                const ci = computeConstantInfo(appModeRef.current, bpmRef.current, constantNoteDivRef.current, r);
                const linRange = computeLinRange(ci, scrResetMsBaseRef.current);
                drawYAxisLabels(axisCtxRef.current, CHART_H, bpmRef.current, chartScaleRef.current, linRange, ci);
              }
            }}
            bpm={bpm}
          />
        )}

        </div>
        {/* 左カラム end */}

        {/* Canvas */}
        <canvas
          ref={canvasRef}
          width={width}
          height={CANVAS_H}
          className="block border border-border cursor-grab shrink-0"
        />

        {/* 縦スライダー */}
        <input
          ref={sliderRef}
          type="range"
          min={0}
          defaultValue={0}
          onChange={onSliderChange}
          className="cursor-pointer accent-primary shrink-0"
          style={{ writingMode: "vertical-lr", width: 28, height: CANVAS_H }}
        />

        {/* グリッド + メトロノーム設定 + SCR情報 */}
        <div className="flex flex-col gap-2 shrink-0 min-w-[180px]">
        <Card className="h-fit">
          <CardHeader className="pb-2 pt-3 px-3">
            <CardTitle className="text-xs text-muted-foreground">設定</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 flex flex-col gap-2">
            {/* 1P / 2P */}
            <RadioGroup
              value={side}
              onValueChange={(v) => {
                const s = v as "1P" | "2P";
                setSide(s); sideRef.current = s;
                updateConfig("display", { side: s });
              }}
              className="flex gap-3"
            >
              {(["1P", "2P"] as const).map(s => (
                <div key={s} className="flex items-center gap-2">
                  <RadioGroupItem value={s} id={`side-${s}`} />
                  <Label htmlFor={`side-${s}`} className="text-xs cursor-pointer">{s}</Label>
                </div>
              ))}
            </RadioGroup>

            {/* 緑数字 */}
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">緑数字</span>
              <input
                type="number"
                min={100} max={3000}
                value={greenNumText}
                onChange={e => {
                  setGreenNumText(e.target.value);
                  const v = parseInt(e.target.value);
                  if (!isNaN(v) && v >= 100 && v <= 3000) {
                    setGreenNum(v); greenNumRef.current = v;
                    updateConfig("display", { greenNum: v });
                  }
                }}
                onBlur={e => {
                  const v = parseInt(e.target.value);
                  const resolved = (!isNaN(v) && v >= 100 && v <= 3000) ? v : GREEN_NUM_DEFAULT;
                  setGreenNum(resolved); greenNumRef.current = resolved;
                  setGreenNumText(String(resolved));
                  updateConfig("display", { greenNum: resolved });
                }}
                className="w-16 bg-input border border-border text-foreground font-mono text-sm px-1.5 py-0.5 rounded"
              />
            </div>

            <div className="border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">グリッド</span>
            </div>
            <RadioGroup
              value={gridMode}
              onValueChange={(v) => {
                const m = v as GridMode;
                setGridMode(m); gridModeRef.current = m;
                updateConfig("display", { gridMode: m });
              }}
              className="flex flex-col gap-1"
            >
              {(["time", "bpm", "scr"] as GridMode[]).map(m => (
                <div key={m} className="flex items-center gap-2">
                  <RadioGroupItem value={m} id={`grid-${m}`} />
                  <Label htmlFor={`grid-${m}`} className="text-xs cursor-pointer">
                    {m === "time" ? "時間" : m === "bpm" ? "BPM" : "Scratch基点"}
                  </Label>
                </div>
              ))}
            </RadioGroup>

            {/* 補助線間隔 (BPM/Scratch基点 モード時のみ意味あり) */}
            {(gridMode === "bpm" || gridMode === "scr") && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">補助線</span>
                <Select
                  value={String(gridSub)}
                  onValueChange={(v) => {
                    const s = Number(v) as 4 | 8 | 16;
                    setGridSub(s);
                    gridSubRef.current = s;
                    updateConfig("display", { gridSubdivision: s });
                  }}
                >
                  <SelectTrigger className="h-7 w-20 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {([4, 8, 16] as const).map(d => (
                      <SelectItem key={d} value={String(d)} className="text-xs">{d}分</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* BPM（常時表示） */}
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">BPM</span>
              <input
                type="number"
                min={1} max={999}
                value={bpmText}
                onChange={e => {
                  setBpmText(e.target.value);
                  const v = parseInt(e.target.value);
                  if (!isNaN(v) && v >= 1 && v <= 999) {
                    setBpm(v); bpmRef.current = v;
                    metroNextBeatRef.current = null;
                    updateConfig("tempo", { bpm: v });
                  }
                }}
                onBlur={e => {
                  const v = parseInt(e.target.value);
                  const resolved = (!isNaN(v) && v >= 1 && v <= 999) ? v : 150;
                  setBpm(resolved); bpmRef.current = resolved;
                  setBpmText(String(resolved));
                  metroNextBeatRef.current = null;
                  updateConfig("tempo", { bpm: resolved });
                }}
                className="w-16 bg-input border border-border text-foreground font-mono text-sm px-1.5 py-0.5 rounded"
              />
            </div>

            {/* クラップ音 */}
            <div className="flex items-center gap-2 border-t border-border pt-2">
              <Checkbox
                id="clap-on"
                checked={clapOn}
                onCheckedChange={(checked) => {
                  const on = !!checked;
                  setClapOn(on); clapOnRef.current = on;
                  updateConfig("scratch", { clapOn: on });
                }}
              />
              <Label htmlFor="clap-on" className="text-xs cursor-pointer">
                クラップ音 {clapOn ? "ON" : "OFF"}
              </Label>
            </div>

            {/* メトロノーム */}
            <div className="flex flex-col gap-2 border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">メトロノーム</span>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="metro-on"
                  checked={metroOn}
                  onCheckedChange={(checked) => {
                    const on = !!checked;
                    setMetroOn(on); metroOnRef.current = on;
                    metroNextBeatRef.current = null;
                    updateConfig("tempo", { metronome: { on, div: metroDivRef.current, vol: metroVolRef.current } });
                    if (on && !audioCtxRef.current) audioCtxRef.current = new AudioContext();
                    if (on && audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
                  }}
                />
                <Label htmlFor="metro-on" className="text-xs cursor-pointer">
                  {metroOn ? "ON" : "OFF"}
                </Label>
              </div>
              <RadioGroup
                value={String(metroDiv)}
                onValueChange={(v) => {
                  const d = Number(v) as 4 | 8;
                  setMetroDiv(d); metroDivRef.current = d;
                  metroNextBeatRef.current = null;
                  updateConfig("tempo", { metronome: { on: metroOnRef.current, div: d, vol: metroVolRef.current } });
                }}
                className="flex gap-3"
              >
                {([4, 8] as const).map(d => (
                  <div key={d} className="flex items-center gap-1">
                    <RadioGroupItem value={String(d)} id={`metro-${d}`} />
                    <Label htmlFor={`metro-${d}`} className="text-xs cursor-pointer">{d}分</Label>
                  </div>
                ))}
              </RadioGroup>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">音量</span>
                <Slider
                  min={0} max={1} step={0.05}
                  value={[metroVol]}
                  onValueChange={([v]) => {
                    setMetroVol(v); metroVolRef.current = v;
                    updateConfig("tempo", { metronome: { on: metroOnRef.current, div: metroDivRef.current, vol: v } });
                  }}
                  className="w-20"
                />
              </div>
            </div>

            {/* 最大間隔 (連皿しきい値) */}
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">最大間隔</span>
              <Select
                value={String(scrResetMsBase)}
                onValueChange={(v) => {
                  const ms = parseInt(v);
                  if (![300, 400, 500].includes(ms)) return;
                  setScrResetMsBase(ms);
                  scrResetMsBaseRef.current = ms;
                  scrResetMsRef.current = ms;
                  updateConfig("scratch", { resetMs: ms });
                }}
              >
                <SelectTrigger className="h-7 w-20 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {([500, 400, 300] as const).map(ms => (
                    <SelectItem key={ms} value={String(ms)} className="text-xs">{ms}ms</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* SCR 情報パネル */}
        <Card className="h-fit min-w-24">
          <CardHeader className="pb-2 pt-3 px-3">
            <CardTitle className="text-xs text-muted-foreground">Scratch Info</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">連続枚数</span>
              <span className={`text-sm font-bold tabular-nums ${scrInfo.count > 0 ? "text-yellow-300" : "text-muted"}`}>
                {scrInfo.count > 0 ? scrInfo.count : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">間隔</span>
              <span className={`text-xs tabular-nums font-mono ${scrActive ? "text-white" : "text-zinc-400"}`}>
                <span className="inline-block w-12 text-right">{scrInfo.intervalMs !== null ? `${scrInfo.intervalMs}ms` : "—"}</span>
                <span className="inline-block w-16 text-right">{scrInfo.noteDivision ? `(${scrInfo.noteDivision})` : ""}</span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">平均間隔</span>
              <span className={`text-xs tabular-nums font-mono ${scrActive ? "text-white" : "text-zinc-400"}`}>
                <span className="inline-block w-12 text-right">{scrInfo.avgIntervalMs !== null ? `${scrInfo.avgIntervalMs}ms` : "—"}</span>
                <span className="inline-block w-16 text-right">{scrInfo.avgNoteDivision ? `(${scrInfo.avgNoteDivision})` : ""}</span>
              </span>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>


      {/* 棒グラフ (Canvas) */}
      <Card className="w-full">
        <CardHeader className="pb-1 pt-3 px-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs text-muted-foreground">Scratch Speed</CardTitle>
            <div className="flex gap-1">
              {(["linear", "log"] as const).map(s => (
                <Button
                  key={s}
                  size="sm"
                  variant={chartScale === s ? "default" : "outline"}
                  className="text-[10px] h-6 px-2"
                  onClick={() => {
                    setChartScale(s);
                    chartScaleRef.current = s;
                    updateConfig("display", { chartScale: s });
                  }}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <div className="relative">
            <div
              className="relative overflow-x-auto"
              ref={chartContainerRef}
              onWheel={(e) => {
                e.preventDefault();
                if (chartContainerRef.current) {
                  chartContainerRef.current.scrollLeft += e.deltaY;
                }
              }}
            >
              <canvas
                ref={chartCanvasRef}
                width={CHART_W}
                height={CHART_H}
                className="block mb-1"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const intervals = intervalHistoryRef.current;
                  if (intervals.length === 0) return;
                  const barW = CHART_BAR_W;
                  const barIdx = Math.floor((x - CHART_PAD_L) / barW);
                  if (barIdx >= 0 && barIdx < intervals.length) {
                    const entry = intervals[barIdx];
                    const barCenterX = CHART_PAD_L + barIdx * barW + barW / 2;
                    setChartTooltip({ x: barCenterX, y: e.clientY - rect.top - 8, entry, idx: barIdx + 1 });
                  } else {
                    setChartTooltip(null);
                  }
                }}
                onMouseLeave={() => setChartTooltip(null)}
              />
              {chartTooltip && (
                <div
                  className="pointer-events-none absolute z-10 border border-zinc-600 rounded px-2 py-1 text-xs whitespace-nowrap -translate-x-1/2"
                  style={{ left: chartTooltip.x, top: chartTooltip.y - 36, background: "rgba(20,20,20,0.95)" }}
                >
                  <span className="text-muted-foreground">#{chartTooltip.idx}</span>
                  <span style={{ color: chartTooltip.entry.dir > 0 ? "#fa4" : "#4f8" }} className="ml-2">
                    {chartTooltip.entry.dir > 0 ? "↷" : "↶"}
                  </span>
                  <span className="ml-1 text-foreground">{chartTooltip.entry.ms}ms</span>
                  {bpm > 0 && (
                    <span className="ml-2 text-cyan-300">
                      {nearestNoteDivision(chartTooltip.entry.ms, bpm)}
                    </span>
                  )}
                </div>
              )}
            </div>
            {/* Y軸ラベル overlay: 横スクロールしても常に左端に固定表示 */}
            <canvas
              ref={axisCanvasRef}
              width={CHART_PAD_L}
              height={CHART_H}
              className="absolute left-0 top-0 pointer-events-none"
            />
          </div>
        </CardContent>
      </Card>

      {/* 記録表示 */}
      <RecordsView records={appRecords} onExport={handleExportRecords} />

      {/* キーコンフィグ ダイアログ */}
      <Dialog open={showConfig} onOpenChange={(open) => { if (!open) closeConfig(); }}>
        <DialogContent className="bg-zinc-900 border-border min-w-[480px] font-mono opacity-100">
          <DialogHeader>
            <DialogTitle className="text-lg text-muted-foreground">
              Key Config
            </DialogTitle>
          </DialogHeader>

          <div className={`flex items-center gap-3 mt-2 justify-center ${side === "2P" ? "flex-row-reverse" : ""}`}>
            {/* スクラッチ円 */}
            <div className="flex flex-col items-center gap-1">
              <div className="w-[164px] h-[164px] rounded-full overflow-hidden border-2 border-border flex shrink-0">
                {(["SCR_NEG", "SCR_POS"] as const).map((target, idx) => {
                  const isAssigning = assigningTarget === target;
                  const hasBinding  = !!keyConfig[target];
                  return (
                    <div
                      key={target}
                      onClick={() => startAssigning(target)}
                      onContextMenu={(e) => { e.preventDefault(); clearBinding(target); }}
                      className={[
                        "flex flex-col items-center justify-center gap-0.5 w-1/2 h-full cursor-pointer select-none text-sm text-center",
                        idx === 0 ? "border-r border-border" : "",
                        isAssigning ? "bg-amber-950 text-primary"
                          : hasBinding ? "bg-green-950 text-green-400"
                          : "bg-card text-muted-foreground hover:bg-secondary",
                      ].join(" ")}
                      title="左クリック: 割り当て  右クリック: クリア"
                    >
                      <span className="text-2xl leading-none">{target === "SCR_NEG" ? "↶" : "↷"}</span>
                      <span className="break-all w-full text-center px-1 leading-tight min-h-[2.5rem]">{bindingLabel(keyConfig[target])}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 鍵盤 */}
            <div className="flex flex-col gap-1">
              <div className="flex gap-1 justify-center">
                {KEY_DEFS.filter(k => k.black).map(({ id, label }) => {
                  const isAssigning = assigningTarget === id;
                  const hasBinding  = !!keyConfig[id];
                  return (
                    <div
                      key={id}
                      onClick={() => startAssigning(id)}
                      onContextMenu={(e) => { e.preventDefault(); clearBinding(id); }}
                      className={[
                        "w-14 h-20 rounded flex flex-col items-center justify-center gap-0.5 cursor-pointer select-none text-sm",
                        isAssigning ? "bg-amber-950 border-2 border-primary text-primary"
                          : hasBinding ? "bg-green-950 border border-green-700 text-green-400"
                          : "bg-secondary border border-border text-muted-foreground hover:bg-accent",
                      ].join(" ")}
                      title="左クリック: 割り当て  右クリック: クリア"
                    >
                      <span className="font-bold text-base">{label}</span>
                      <span className="break-all text-center px-0.5 leading-tight min-h-[2.5rem]">{bindingLabel(keyConfig[id])}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-1">
                {KEY_DEFS.filter(k => !k.black).map(({ id, label }) => {
                  const isAssigning = assigningTarget === id;
                  const hasBinding  = !!keyConfig[id];
                  return (
                    <div
                      key={id}
                      onClick={() => startAssigning(id)}
                      onContextMenu={(e) => { e.preventDefault(); clearBinding(id); }}
                      className={[
                        "w-14 h-20 rounded flex flex-col items-center justify-center gap-0.5 cursor-pointer select-none text-sm",
                        isAssigning ? "bg-amber-950 border-2 border-primary text-primary"
                          : hasBinding ? "bg-green-950 border border-green-700 text-green-400"
                          : "bg-secondary border border-border text-muted-foreground hover:bg-accent",
                      ].join(" ")}
                      title="左クリック: 割り当て  右クリック: クリア"
                    >
                      <span className="font-bold text-base">{label}</span>
                      <span className="break-all text-center px-0.5 leading-tight min-h-[2.5rem]">{bindingLabel(keyConfig[id])}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <p className="text-sm text-muted-foreground mt-1 text-center">
            左クリック: 入力待ち &nbsp;|&nbsp; 右クリック: 割り当てクリア
          </p>

          <div className="flex items-center gap-2 mt-2 border-t border-border pt-2">
            <Checkbox
              id="phoenix-wan"
              checked={phoenixWan}
              onCheckedChange={(checked) => {
                const on = !!checked;
                setPhoenixWan(on);
                updateConfig("input", { phoenixWan: on });
                invoke("set_phoenix_wan_mode", { enabled: on }).catch(console.error);
              }}
            />
            <Label htmlFor="phoenix-wan" className="text-xs cursor-pointer">
              PHOENIXWAN (axis を線形コントローラとして扱う)
            </Label>
          </div>

          <div className="flex justify-between mt-1">
            <Button variant="secondary" size="sm" onClick={clearAll}>全クリア</Button>
            <Button variant="outline" size="sm" onClick={closeConfig}>閉じる</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
