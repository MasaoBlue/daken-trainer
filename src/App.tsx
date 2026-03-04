import { useEffect, useRef, useState } from "react";
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
import { Play, ChevronsRight, Settings } from "lucide-react";
import "./App.css";

// ---- 型定義 ----------------------------------------------------------------

type InputEvent =
  | { kind: "ButtonDown"; source: string; id: string; t: number }
  | { kind: "ButtonUp";   source: string; id: string; t: number }
  | { kind: "AxisMove";   source: string; id: string; direction: number; value: number; t: number };

interface Binding {
  source: string;
  id: string;
  direction?: number;
}

type KeyConfig = Record<string, Binding | null>;

interface Span {
  start: number;
  end: number | null;
  direction?: number;
  rustT?: number;
}

interface Channel {
  id: string;
  source: string;
  kind: "button" | "axis";
  spans: Span[];
}

// ---- 定数 ------------------------------------------------------------------

const CANVAS_H          = 600;
const HEADER_H          = 40;
const GREEN_NUM_STORAGE_KEY = "daken-trainer-green-num";
const GREEN_NUM_DEFAULT     = 1000;
const AXIS_TIMEOUT      = 150;
const SCR_RESET_MS      = 500;
const SPAN_RETAIN       = 600000;
const INTERVAL_HISTORY  = 200; // 棒グラフに表示する直近N枚分
const CHART_W           = 570; // 棒グラフ固定幅 (px)
const CHART_H           = 160; // 棒グラフ固定高さ (px)

// ---- ストレージキー ---------------------------------------------------------

const STORAGE_KEY            = "daken-trainer-keyconfig";
const BPM_STORAGE_KEY        = "daken-trainer-bpm";
const SCR_ORIGIN_STORAGE_KEY = "daken-trainer-scr-origin";
const GRID_MODE_STORAGE_KEY  = "daken-trainer-grid-mode";
const METRO_ON_KEY           = "daken-trainer-metro-on";
const METRO_DIV_KEY          = "daken-trainer-metro-div";
const METRO_VOL_KEY          = "daken-trainer-metro-vol";
const SIDE_KEY               = "daken-trainer-side";

// ---- キーコンフィグ ユーティリティ -----------------------------------------

function loadConfig(): KeyConfig {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"); } catch { return {}; }
}
function saveConfig(cfg: KeyConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

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

// ---- レーン定義 -------------------------------------------------------------

interface LaneDef {
  id: string;
  label: string;
  w: number;
  noteColor: string;
  axisColorPos?: string;
  axisColorNeg?: string;
}

const LANE_DEFS: LaneDef[] = [
  { id: "SCR",  label: "Scratch", w: 90,  noteColor: "#4f8", axisColorPos: "#4f8", axisColorNeg: "#fa4" },
  { id: "KEY1", label: "1",   w: 52,  noteColor: "#eee" },
  { id: "KEY2", label: "2",   w: 40,  noteColor: "#48f" },
  { id: "KEY3", label: "3",   w: 52,  noteColor: "#eee" },
  { id: "KEY4", label: "4",   w: 40,  noteColor: "#48f" },
  { id: "KEY5", label: "5",   w: 52,  noteColor: "#eee" },
  { id: "KEY6", label: "6",   w: 40,  noteColor: "#48f" },
  { id: "KEY7", label: "7",   w: 52,  noteColor: "#eee" },
];

// ---- Canvas 描画 -----------------------------------------------------------

type GridMode = "time" | "bpm" | "scr";

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
  scrLastOriginMs: number,
  scrLastInputMs: number,
  laneDefs: LaneDef[],
  timeWindow: number,
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
      const startMarkerBottom = Math.min(drawBottom, BODY_BOTTOM);
      const startMarkerTop    = Math.max(startMarkerBottom - TICK_H, HEADER_H);
      if (startMarkerBottom > startMarkerTop) {
        ctx.fillStyle = color; ctx.fillRect(lx, startMarkerTop, lw, startMarkerBottom - startMarkerTop);
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
  } else if (gridMode === "bpm") {
    const beatMs = 60000 / bpm;
    const firstBeat = Math.ceil((viewNowMs - timeWindow) / beatMs) * beatMs;
    let beatIdx = Math.round(firstBeat / beatMs);
    for (let g = firstBeat; g <= viewNowMs; g += beatMs, beatIdx++) {
      const y = Math.round(tToY(g));
      if (y < HEADER_H || y > BODY_BOTTOM) continue;
      const isMeasure = beatIdx % 4 === 0;
      ctx.strokeStyle = isMeasure ? "#aaa" : "#484848";
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      if (isMeasure) {
        ctx.fillStyle = "#999"; ctx.font = "10px monospace";
        ctx.fillText(`${Math.round(beatIdx / 4 + 1)}`, 2, y - 2);
      }
    }
  } else if (gridMode === "scr" && isFinite(scrLastOriginMs)) {
    const origin = scrLastOriginMs;
    const beatMs = 60000 / bpm;
    const rangeStart = viewNowMs - timeWindow;
    const firstBeatOffset = Math.ceil((rangeStart - origin) / beatMs);
    const scrGridEnd = isFinite(scrLastInputMs) ? scrLastInputMs : viewNowMs;
    for (let i = firstBeatOffset; ; i++) {
      const g = origin + i * beatMs;
      if (g > viewNowMs) break;
      if (g < origin) continue;
      if (g > scrGridEnd) continue;
      const y = Math.round(tToY(g));
      if (y < HEADER_H || y > BODY_BOTTOM) continue;
      const isMeasure = i % 4 === 0;
      ctx.strokeStyle = isMeasure ? "#aaf" : "#446";
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      if (isMeasure) {
        ctx.fillStyle = "#99b"; ctx.font = "10px monospace";
        ctx.fillText(`${Math.floor(i / 4) + 1}`, 2, y - 2);
      }
    }
  }
  ctx.restore();

}

// ---- 棒グラフ Canvas 描画 ---------------------------------------------------

interface IntervalEntry { ms: number; dir: number; }

// Y軸ラベル幅（左余白）
const CHART_PAD_L = 30;

function drawBarChart(
  ctx: CanvasRenderingContext2D,
  intervals: IntervalEntry[],
  bpm: number,
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, h);

  // 音符区分: 4〜32の全整数（5分・7分などのタプレットも含む）
  const ALL_DIVS = Array.from({ length: 29 }, (_, i) => i + 4); // 4〜32
  const LABELED_DIVS = new Set([4, 8, 12, 16, 24, 32]); // 5,6,7は除去
  // 4分=グレー(遅い) → 32分=赤(速い)
  const NOTE_COLOR = (d: number): string => {
    const t = (d - 4) / (32 - 4); // 0.0(4分/グレー) 〜 1.0(32分/赤)
    const r = Math.round(80  + t * 175); // 80  → 255
    const g = Math.round(80  - t * 60);  // 80  → 20
    const b = Math.round(80  - t * 60);  // 80  → 20
    return `rgb(${r},${g},${b})`;
  };
  const beatMs = bpm > 0 ? 60000 / bpm : 0;
  const noteRefMs = ALL_DIVS.map(d => ({ d, ms: beatMs > 0 ? beatMs / (d / 4) : 0 }));
  // 上=速い(小さいms=32分)、下=遅い(大きいms=4分)
  // ALL_DIVS=[4,5,...,32] → noteRefMs[0]=d4(大きいms遅い), noteRefMs.at(-1)=d32(小さいms速い)
  // minMs=上端=速い=小さいms=32分のms*0.5
  // maxMs=下端=遅い=大きいms=4分のms*1.5
  const lastMs = noteRefMs.at(-1)?.ms ?? 0;
  const minMs = lastMs > 0 ? lastMs * 0.5 : 10;
  const maxMs = noteRefMs[0]?.ms > 0 ? noteRefMs[0].ms * 1.5
    : (intervals.length > 0 ? Math.max(...intervals.map(e => e.ms)) * 1.5 : 1000);

  // レイアウト
  // 上: PAD_T, 下: PAD_B(X軸ラベル), 左: CHART_PAD_L(Y軸ラベル)
  const PAD_T = 4;
  const PAD_B = 14;
  const plotX = CHART_PAD_L;      // バー描画開始X
  const plotW = w - CHART_PAD_L;  // バー描画幅
  const plotH = h - PAD_T - PAD_B; // バー描画高さ

  // 対数スケール: 上=速い(小さいms=4分)、下=遅い(大きいms=32分)
  const msToY = (ms: number) => {
    const clamped = Math.max(minMs, Math.min(maxMs, ms));
    const ratio = (Math.log(clamped) - Math.log(minMs)) / (Math.log(maxMs) - Math.log(minMs));
    return PAD_T + Math.round(ratio * plotH); // ratioが大きい(遅い)ほど下
  };

  // バー幅: intervals数に応じて可変、最小2px、最大10px
  // 右端が最新。左から並べ、足りない分は右端まで詰めない（左余白なし、左から順に配置）
  const count = intervals.length;
  const barW = count > 0 ? Math.max(1, Math.min(10, Math.floor(plotW / count))) : 8;
  // バーが足りない場合は左詰め（右にスペースが余る）
  // バーが多い場合は右端まで使う（INTERVAL_HISTORY以上になることはないが念のため）

  // Y軸リファレンスライン（ラベル付きのみ描画）
  for (const { d, ms } of noteRefMs) {
    if (ms <= 0) continue;
    const isLabeled = LABELED_DIVS.has(d);
    if (!isLabeled) continue;
    const y = msToY(ms);
    if (y < PAD_T || y > PAD_T + plotH) continue;
    const color = NOTE_COLOR(d);
    // ライン（バー描画エリアのみ）
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.globalAlpha = 1.0;
    ctx.setLineDash([]);
    // ラベル（左側）- アウトライン付きで視認性向上
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "right";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.strokeText(`${d}`, plotX - 6, y + 4);
    ctx.fillStyle = color;
    ctx.fillText(`${d}`, plotX - 6, y + 4);
    ctx.textAlign = "left";
    ctx.lineJoin = "miter";
  }

  if (count === 0) return;

  // バー描画（左から並べる、最新が右端）
  // 棒の色: 縦方向グラデーション（上=32分色(赤), 下=4分色(グレー)）+ 下端に方向インジケータ
  const DIR_INDICATOR_H = Math.max(1, Math.floor(barW * 0.4)); // 上端の方向色の高さ
  // 左詰めで配置（右端は固定幅内に収まる）
  for (let i = 0; i < count; i++) {
    const { ms, dir } = intervals[i];
    const x = plotX + i * barW;
    const yTop = Math.max(PAD_T, msToY(ms));
    const yBottom = PAD_T + plotH;
    const barH = yBottom - yTop;
    if (barH <= 0) continue;

    // 縦グラデーション: 下=グレー(4分/遅い) → 上(バー先端)=赤系(32分に近いほど赤)
    const barDiv = Math.max(4, Math.min(32,
      Math.round(4 * (60000 / (bpm > 0 ? bpm : 138)) / ms)
    ));
    const grad = ctx.createLinearGradient(0, yTop, 0, yBottom);
    grad.addColorStop(0, NOTE_COLOR(barDiv)); // 上端(バー先端)=そのmsの色
    grad.addColorStop(1, NOTE_COLOR(4));      // 下端=4分=グレー
    const dirColor = dir > 0 ? "#4f8" : "#fa4";

    const bx = x, bw = barW - 1;
    if (i === 0) {
      // 1本目: 縦幅100%・軸線
      ctx.fillStyle = dirColor;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(bx, PAD_T, bw, plotH);
      ctx.globalAlpha = 1.0;
    } else {
      // 上端: 方向インジケータ
      ctx.fillStyle = dirColor;
      ctx.fillRect(bx, yTop, bw, DIR_INDICATOR_H);
      ctx.fillStyle = grad;
      ctx.fillRect(bx, yTop + DIR_INDICATOR_H, bw, barH - DIR_INDICATOR_H);
    }
  }

  // X軸ラベル（枚数）: 100以下は1,10,20...50、100超えは50単位
  ctx.fillStyle = "#666";
  ctx.font = "9px monospace";
  ctx.textAlign = "center";
  const tickStep = count > 100 ? 50 : 10;
  const tickList = [1];
  for (let n = tickStep; n <= count; n += tickStep) tickList.push(n);
  for (const n of tickList) {
    if (n > count) break;
    const idx = n - 1;
    const x = plotX + idx * barW + barW / 2;
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD_T + plotH); ctx.lineTo(x, PAD_T + plotH + 3); ctx.stroke();
    ctx.fillText(String(n), x, h - 2);
  }
}

// ---- 音符区分ヘルパー -------------------------------------------------------

// BPMと間隔msから最も近い音符区分を返す（4〜32の全整数）
function nearestNoteDivision(intervalMs: number, bpm: number): string {
  const beatMs = 60000 / bpm;
  let best = 4, bestDiff = Infinity;
  for (let d = 4; d <= 32; d++) {
    const noteMs = beatMs / (d / 4);
    const diff = Math.abs(intervalMs - noteMs);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return `${best}分`;
}

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

  // グリッド設定
  const [gridMode, setGridMode] = useState<GridMode>(() => {
    const v = localStorage.getItem(GRID_MODE_STORAGE_KEY);
    return (v === "bpm" || v === "scr") ? v : "time";
  });
  const gridModeRef = useRef<GridMode>((() => {
    const v = localStorage.getItem(GRID_MODE_STORAGE_KEY);
    return (v === "bpm" || v === "scr") ? v : "time";
  })());
  const [bpm, setBpm] = useState(() => {
    const v = parseInt(localStorage.getItem(BPM_STORAGE_KEY) ?? "150");
    return isNaN(v) ? 150 : v;
  });
  const bpmRef = useRef((() => {
    const v = parseInt(localStorage.getItem(BPM_STORAGE_KEY) ?? "150");
    return isNaN(v) ? 150 : v;
  })());
  const [bpmText, setBpmText] = useState(() => {
    const v = parseInt(localStorage.getItem(BPM_STORAGE_KEY) ?? "150");
    return String(isNaN(v) ? 150 : v);
  });

  // 緑数字
  const [_greenNum, setGreenNum] = useState(() => {
    const v = parseInt(localStorage.getItem(GREEN_NUM_STORAGE_KEY) ?? String(GREEN_NUM_DEFAULT));
    return isNaN(v) ? GREEN_NUM_DEFAULT : Math.max(100, Math.min(3000, v));
  });
  const greenNumRef = useRef((() => {
    const v = parseInt(localStorage.getItem(GREEN_NUM_STORAGE_KEY) ?? String(GREEN_NUM_DEFAULT));
    return isNaN(v) ? GREEN_NUM_DEFAULT : Math.max(100, Math.min(3000, v));
  })());
  const [greenNumText, setGreenNumText] = useState(() => {
    const v = parseInt(localStorage.getItem(GREEN_NUM_STORAGE_KEY) ?? String(GREEN_NUM_DEFAULT));
    return String(isNaN(v) ? GREEN_NUM_DEFAULT : Math.max(100, Math.min(3000, v)));
  });

  // メトロノーム
  const [metroOn, setMetroOn] = useState(() => localStorage.getItem(METRO_ON_KEY) === "1");
  const metroOnRef = useRef(localStorage.getItem(METRO_ON_KEY) === "1");
  const [metroDiv, setMetroDiv] = useState<4 | 8>(() => localStorage.getItem(METRO_DIV_KEY) === "8" ? 8 : 4);
  const metroDivRef = useRef<4 | 8>(localStorage.getItem(METRO_DIV_KEY) === "8" ? 8 : 4);
  const [metroVol, setMetroVol] = useState(() => {
    const v = parseFloat(localStorage.getItem(METRO_VOL_KEY) ?? "0.5");
    return isNaN(v) ? 0.5 : Math.max(0, Math.min(1, v));
  });
  const metroVolRef = useRef((() => {
    const v = parseFloat(localStorage.getItem(METRO_VOL_KEY) ?? "0.5");
    return isNaN(v) ? 0.5 : Math.max(0, Math.min(1, v));
  })());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const metroNextBeatRef = useRef<number | null>(null);

  // 1P / 2P
  const [side, setSide] = useState<"1P" | "2P">(() =>
    localStorage.getItem(SIDE_KEY) === "2P" ? "2P" : "1P"
  );
  const sideRef = useRef<"1P" | "2P">(
    localStorage.getItem(SIDE_KEY) === "2P" ? "2P" : "1P"
  );

  // SCR カウント・情報
  const [_scrCount, setScrCount] = useState(0);
  const scrCountRef     = useRef(0);
  const scrLastTimeRef  = useRef<number>(-Infinity);
  const scrLastDirRef   = useRef<number>(0);

  interface ScrInfo {
    count: number;
    intervalMs: number | null;
    estimatedBpm: number | null;
    offsetMs: number | null;
    noteDivision: string | null;
  }
  const [scrInfo, setScrInfo] = useState<ScrInfo>({
    count: 0, intervalMs: null, estimatedBpm: null, offsetMs: null, noteDivision: null,
  });
  const [scrActive, setScrActive] = useState(false);
  const scrIntervalHistRef  = useRef<number[]>([]);
  const scrPrevDirTimeRef   = useRef<number | null>(null);
  const scrOriginRef        = useRef<number>(-Infinity);
  const scrLastOriginRef    = useRef<number>((() => {
    const saved = parseFloat(localStorage.getItem(SCR_ORIGIN_STORAGE_KEY) ?? "");
    if (!isFinite(saved)) return -Infinity;
    return -(Date.now() - saved);
  })());

  // 棒グラフ用: 直近INTERVAL_HISTORY件の間隔履歴
  const intervalHistoryRef = useRef<IntervalEntry[]>([]);
  const chartCanvasRef = useRef<HTMLCanvasElement>(null);
  const chartCtxRef    = useRef<CanvasRenderingContext2D | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartWidthRef = useRef(CHART_W);
  const [chartTooltip, setChartTooltip] = useState<{ x: number; y: number; entry: IntervalEntry; idx: number } | null>(null);

  // チャレンジモード
  type ChallengeState = "idle" | "ready" | "running" | "done";
  const [challengeState, setChallengeState] = useState<ChallengeState>("idle");
  const challengeStateRef = useRef<ChallengeState>("idle");
  const [challengeDuration, setChallengeDuration] = useState(30);
  const challengeDurationRef = useRef(30);
  const challengeStartRef = useRef(0);
  const challengeScrCountRef = useRef(0);
  const [challengeScrCount, setChallengeScrCount] = useState(0);
  const [challengeTimeLeft, setChallengeTimeLeft] = useState(0);
  const challengeIntervalsRef = useRef<IntervalEntry[]>([]);
  const [challengeResult, setChallengeResult] = useState<{
    count: number; duration: number; avgMs: number | null;
    noteDivision: string | null; isNewBest: boolean;
  } | null>(null);

  // キーコンフィグ
  const [keyConfig, setKeyConfig] = useState<KeyConfig>(loadConfig);
  const keyConfigRef    = useRef<KeyConfig>(loadConfig());
  const [showConfig, setShowConfig] = useState(false);
  const [assigningTarget, setAssigningTarget] = useState<string | null>(null);
  const assigningRef    = useRef<string | null>(null);

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
        saveConfig(newCfg);
        // 同じボタンの再割り当てができるよう assigningTarget はリセットしない
        return;
      }

      const resolved = resolveChannel(keyConfigRef.current, ev);
      if (resolved === null) return;

      // SCR 方向変化処理（ButtonDown / AxisMove 共通）
      const handleScrDirectionChange = (dir: number) => {
        if (dir === scrLastDirRef.current) return;
        scrLastDirRef.current = dir;
        const prevTime = scrLastTimeRef.current;
        scrLastTimeRef.current = nowJs;
        if (scrCountRef.current === 0) {
          scrOriginRef.current = nowJs;
          scrLastOriginRef.current = nowJs;
          const wallNow = Date.now() - performance.now() + nowJs + startRef.current;
          localStorage.setItem(SCR_ORIGIN_STORAGE_KEY, String(wallNow));
          scrIntervalHistRef.current = [];
          scrPrevDirTimeRef.current = nowJs;
          intervalHistoryRef.current = [];
        }
        scrCountRef.current += 1;
        setScrCount(scrCountRef.current);
        invoke("play_clap").catch(() => {});

        // チャレンジモード: スクラッチカウント
        if (challengeStateRef.current === "ready") {
          challengeStateRef.current = "running";
          setChallengeState("running");
          challengeStartRef.current = nowJs;
          challengeScrCountRef.current = 1;
          setChallengeScrCount(1);
          challengeIntervalsRef.current = [];
        } else if (challengeStateRef.current === "running") {
          challengeScrCountRef.current += 1;
          setChallengeScrCount(challengeScrCountRef.current);
        }

        let intervalMs: number | null = null;
        let estimatedBpm: number | null = null;
        let offsetMs: number | null = null;
        let noteDivision: string | null = null;

        if (scrPrevDirTimeRef.current !== null && isFinite(prevTime)) {
          intervalMs = Math.floor(nowJs - scrPrevDirTimeRef.current);

          // 棒グラフ履歴を更新
          intervalHistoryRef.current = [
            ...intervalHistoryRef.current.slice(-(INTERVAL_HISTORY - 1)),
            { ms: intervalMs, dir },
          ];
          // チャレンジモード: インターバル記録
          if (challengeStateRef.current === "running") {
            challengeIntervalsRef.current.push({ ms: intervalMs, dir });
          }

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
          }
        }
        scrPrevDirTimeRef.current = nowJs;
        setScrInfo({ count: scrCountRef.current, intervalMs, estimatedBpm, offsetMs, noteDivision });
        setScrActive(true);
      };

      if (ev.kind === "ButtonDown") {
        const ch = getOrCreateChannel(ev.source, resolved.laneId, resolved.kind);
        const last = ch.spans.at(-1);
        if (resolved.kind === "axis" && last && last.end === null && last.direction !== resolved.direction) {
          last.end = nowJs;
          ch.spans.push({ start: nowJs, end: null, rustT: ev.t, direction: resolved.direction });
        } else if (!last || last.end !== null) {
          ch.spans.push({ start: nowJs, end: null, rustT: ev.t, direction: resolved.direction });
        }
        if (resolved.laneId === "SCR" && resolved.direction !== undefined) {
          handleScrDirectionChange(resolved.direction);
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
        axisLastRef.current.set(key, nowJs);
        const last = ch.spans.at(-1);
        const dir = resolved.direction ?? ev.direction;
        if (!last || last.end !== null) {
          ch.spans.push({ start: nowJs, end: null, direction: dir });
        } else if (last.direction !== dir) {
          last.end = nowJs;
          ch.spans.push({ start: nowJs, end: null, direction: dir });
        }
        if (resolved.laneId === "SCR") handleScrDirectionChange(dir);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [getOrCreateChannel]);

  useEffect(() => {
    if (canvasRef.current) ctxRef.current = canvasRef.current.getContext("2d");
    if (chartCanvasRef.current) chartCtxRef.current = chartCanvasRef.current.getContext("2d");
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
          if (chartCanvasRef.current) {
            chartCanvasRef.current.width = w;
            if (chartCtxRef.current) {
              drawBarChart(chartCtxRef.current, intervalHistoryRef.current, bpmRef.current, w, CHART_H);
            }
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

      if (scrCountRef.current > 0 && nowMs - scrLastTimeRef.current > SCR_RESET_MS) {
        scrCountRef.current = 0;
        scrLastDirRef.current = 0;
        scrOriginRef.current = -Infinity;
        scrPrevDirTimeRef.current = null;
        scrIntervalHistRef.current = [];
        setScrCount(0);
        setScrActive(false);
      }

      const cutoff = nowMs - SPAN_RETAIN;
      for (const ch of channelsRef.current) {
        if (ch.spans.length > 0 && (ch.spans[0].end ?? nowMs) < cutoff) {
          ch.spans = ch.spans.filter((s) => (s.end ?? nowMs) > cutoff);
        }
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
        drawTimeline(ctxRef.current, channelsRef.current, viewNowMs, nowMs, pb.mode === "live",
          canvasRef.current.width, scrCountRef.current, gridModeRef.current, bpmRef.current,
          scrLastOriginRef.current, scrLastTimeRef.current, orderedLanes,
          greenNumRef.current * 1000 / 600);
      }
      if (chartCtxRef.current) {
        drawBarChart(chartCtxRef.current, intervalHistoryRef.current, bpmRef.current, chartWidthRef.current, CHART_H);
      }
      // チャレンジモード: タイマー更新
      if (challengeStateRef.current === "running") {
        const elapsed = (nowMs - challengeStartRef.current) / 1000;
        const remaining = challengeDurationRef.current - elapsed;
        if (remaining <= 0) {
          challengeStateRef.current = "done";
          setChallengeState("done");
          setChallengeTimeLeft(0);
          const intervals = challengeIntervalsRef.current;
          const avgMs = intervals.length > 0
            ? Math.round(intervals.reduce((s, e) => s + e.ms, 0) / intervals.length)
            : null;
          const nd = avgMs !== null && bpmRef.current > 0
            ? nearestNoteDivision(avgMs, bpmRef.current) : null;
          const cnt = challengeScrCountRef.current;
          const dur = challengeDurationRef.current;
          const bestKey = `scratch-trainer-challenge-best-${dur}`;
          const prevBest = parseInt(localStorage.getItem(bestKey) ?? "0");
          const isNewBest = cnt > prevBest;
          if (isNewBest) localStorage.setItem(bestKey, String(cnt));
          setChallengeResult({ count: cnt, duration: dur, avgMs, noteDivision: nd, isNewBest });
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
    keyConfigRef.current = newCfg; setKeyConfig(newCfg); saveConfig(newCfg);
  };
  const clearAll = () => {
    const newCfg: KeyConfig = {};
    keyConfigRef.current = newCfg; setKeyConfig(newCfg); saveConfig(newCfg);
    assigningRef.current = null; setAssigningTarget(null);
  };
  const closeConfig = () => { assigningRef.current = null; setAssigningTarget(null); setShowConfig(false); };

  const KEY_DEFS = [
    { id: "KEY1", label: "1", black: false }, { id: "KEY2", label: "2", black: true  },
    { id: "KEY3", label: "3", black: false }, { id: "KEY4", label: "4", black: true  },
    { id: "KEY5", label: "5", black: false }, { id: "KEY6", label: "6", black: true  },
    { id: "KEY7", label: "7", black: false },
  ];

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

      {/* メイン行: チャレンジ + canvas + スライダー + 設定パネル */}
      <div className="flex items-start gap-2 overflow-x-auto">

        {/* チャレンジモード */}
        <Card className={`h-fit shrink-0 w-[160px] ${challengeState === "running" ? "border-orange-500/50 shadow-[0_0_8px_rgba(255,165,0,0.2)]" : ""}`}>
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
                  variant={challengeState !== "idle" && challengeDuration === d ? "default" : "outline"}
                  className="text-xs px-1 h-7"
                  disabled={challengeState === "running"}
                  onClick={() => {
                    setChallengeDuration(d);
                    challengeDurationRef.current = d;
                    challengeStateRef.current = "ready";
                    setChallengeState("ready");
                    challengeScrCountRef.current = 0;
                    setChallengeScrCount(0);
                    setChallengeResult(null);
                  }}
                >
                  {d === 60 ? "1m" : `${d}s`}
                </Button>
              ))}
            </div>

            {/* タイマー表示（ready / running） */}
            {(challengeState === "ready" || challengeState === "running") && (
              <div className={`font-mono text-3xl font-bold tabular-nums text-center w-full ${
                challengeState === "ready" ? "text-zinc-500" : "text-orange-400"
              }`}>
                {challengeState === "ready"
                  ? `${challengeDuration}.00`
                  : challengeTimeLeft.toFixed(2)
                }
              </div>
            )}

            {/* READY: スクラッチで開始プロンプト */}
            {challengeState === "ready" && (
              <>
                <span className="text-xs text-muted-foreground animate-pulse">
                  スクラッチで開始
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

            {/* RUNNING: スクラッチ回数 */}
            {challengeState === "running" && (
              <div className="text-center w-full">
                <span className="text-[10px] text-muted-foreground">Scratches</span>
                <div className="font-mono text-3xl font-bold tabular-nums text-yellow-300">
                  {challengeScrCount}
                </div>
              </div>
            )}

            {/* DONE: 結果表示 */}
            {challengeState === "done" && challengeResult && (
              <div className="text-center flex flex-col gap-1 w-full">
                <div className="text-base font-bold text-green-400">FINISH!</div>
                <div className="font-mono text-3xl font-bold tabular-nums text-yellow-300">
                  {challengeResult.count}
                </div>
                <span className="text-[10px] text-muted-foreground">scratches</span>
                {challengeResult.avgMs !== null && (
                  <span className="text-xs text-zinc-400">
                    Avg: {challengeResult.avgMs}ms
                    {challengeResult.noteDivision && ` (${challengeResult.noteDivision})`}
                  </span>
                )}
                {challengeResult.isNewBest && (
                  <span className="text-xs text-green-400 font-bold animate-pulse">
                    NEW BEST!
                  </span>
                )}
                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                    `${challengeResult.duration === 60 ? "1m" : `${challengeResult.duration}s`}で${challengeResult.count}回スクラッチした！`
                    + (challengeResult.avgMs !== null
                      ? `\nAvg: ${challengeResult.avgMs}ms` + (challengeResult.noteDivision ? ` (${challengeResult.noteDivision})` : "")
                      : "")
                  )}&hashtags=${encodeURIComponent("daken_trainer")}`}
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
        <div className="flex flex-col gap-2 shrink-0">
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
                localStorage.setItem(SIDE_KEY, s);
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
                    localStorage.setItem(GREEN_NUM_STORAGE_KEY, String(v));
                  }
                }}
                onBlur={e => {
                  const v = parseInt(e.target.value);
                  const resolved = (!isNaN(v) && v >= 100 && v <= 3000) ? v : GREEN_NUM_DEFAULT;
                  setGreenNum(resolved); greenNumRef.current = resolved;
                  setGreenNumText(String(resolved));
                  localStorage.setItem(GREEN_NUM_STORAGE_KEY, String(resolved));
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
                localStorage.setItem(GRID_MODE_STORAGE_KEY, m);
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
                    localStorage.setItem(BPM_STORAGE_KEY, String(v));
                  }
                }}
                onBlur={e => {
                  const v = parseInt(e.target.value);
                  const resolved = (!isNaN(v) && v >= 1 && v <= 999) ? v : 150;
                  setBpm(resolved); bpmRef.current = resolved;
                  setBpmText(String(resolved));
                  metroNextBeatRef.current = null;
                  localStorage.setItem(BPM_STORAGE_KEY, String(resolved));
                }}
                className="w-16 bg-input border border-border text-foreground font-mono text-sm px-1.5 py-0.5 rounded"
              />
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
                    localStorage.setItem(METRO_ON_KEY, on ? "1" : "0");
                    if (on && !audioCtxRef.current) audioCtxRef.current = new AudioContext();
                    if (on && audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
                  }}
                />
                <Label htmlFor="metro-on" className={`text-xs cursor-pointer ${metroOn ? "text-primary" : "text-muted-foreground"}`}>
                  {metroOn ? "ON" : "OFF"}
                </Label>
              </div>
              <RadioGroup
                value={String(metroDiv)}
                onValueChange={(v) => {
                  const d = Number(v) as 4 | 8;
                  setMetroDiv(d); metroDivRef.current = d;
                  metroNextBeatRef.current = null;
                  localStorage.setItem(METRO_DIV_KEY, v);
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
                    localStorage.setItem(METRO_VOL_KEY, String(v));
                  }}
                  className="w-20"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* SCR 情報パネル */}
        <Card className="h-fit min-w-24">
          <CardHeader className="pb-2 pt-3 px-3">
            <CardTitle className="text-xs text-muted-foreground">Scratch Info</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">連続枚数</span>
              <span className={`text-right text-lg font-bold tabular-nums ${scrInfo.count > 0 ? "text-yellow-300" : "text-muted"}`}>
                {scrInfo.count > 0 ? scrInfo.count : "—"}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">間隔</span>
              <span className={`text-right text-sm tabular-nums ${scrActive ? "text-white" : "text-zinc-400"}`}>
                {scrInfo.intervalMs !== null ? `${scrInfo.intervalMs}ms` : "—"}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">音符</span>
              <span className={`text-right text-sm tabular-nums ${scrActive ? "text-cyan-200" : "text-cyan-700"}`}>
                {scrInfo.noteDivision ?? "—"}
              </span>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>


      {/* 棒グラフ (Canvas) */}
      <Card className="w-full">
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-xs text-muted-foreground">Scratch Speed</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3" ref={chartContainerRef}>
          <div className="relative">
            <canvas
              ref={chartCanvasRef}
              width={CHART_W}
              height={CHART_H}
              className="block"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const cw = chartWidthRef.current;
                const intervals = intervalHistoryRef.current;
                if (intervals.length === 0) return;
                const plotW = cw - CHART_PAD_L;
                const barW = Math.max(1, Math.min(10, Math.floor(plotW / intervals.length)));
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
                <span style={{ color: chartTooltip.entry.dir > 0 ? "#4f8" : "#fa4" }} className="ml-2">
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
        </CardContent>
      </Card>

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

          <div className="flex justify-between mt-1">
            <Button variant="secondary" size="sm" onClick={clearAll}>全クリア</Button>
            <Button variant="outline" size="sm" onClick={closeConfig}>閉じる</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
