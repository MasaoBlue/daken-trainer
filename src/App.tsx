import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

// ---- 型定義 ----------------------------------------------------------------

type InputEvent =
  | { kind: "ButtonDown"; source: string; id: string; t: number }
  | { kind: "ButtonUp";   source: string; id: string; t: number }
  | { kind: "AxisMove";   source: string; id: string; direction: number; value: number; t: number };

// キーコンフィグ: 入力ソースとレーンの対応
interface Binding {
  source: string;     // "keyboard" | "gamepad"
  id: string;         // ボタンID or axisID
  direction?: number; // axisの場合: 1=正方向(時計), -1=負方向(反時計)
}

// レーンID ("SCR_POS" | "SCR_NEG" | "KEY1"〜"KEY7") → Binding
type KeyConfig = Record<string, Binding | null>;

interface Span {
  start: number;        // JS 基準ミリ秒 (描画に使う)
  end: number | null;
  direction?: number;
  rustT?: number;       // ButtonDown 時の Rust タイムスタンプ (持続時間計算用)
}

interface Channel {
  id: string;
  source: string;
  kind: "button" | "axis";
  spans: Span[];
}

// ---- 定数 ------------------------------------------------------------------

const CANVAS_H          = 700;
const HEADER_H          = 40;
const TIME_WINDOW       = 3000;   // ms: 表示する時間幅
const AXIS_TIMEOUT      = 150;    // ms: axis 停止判定
const SPAN_RETAIN       = 60000;  // ms: 過去1分のスパンを保持（スクロール用）

// ---- キーコンフィグ ユーティリティ ----------------------------------------

const STORAGE_KEY = "scratch-trainer-keyconfig";

function loadConfig(): KeyConfig {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"); } catch { return {}; }
}

function saveConfig(cfg: KeyConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

// 入力イベントを keyConfig に照合してレーン情報を返す
// マッチしない場合は null（無視）
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
  return null; // 未割り当て → 無視
}

function bindingLabel(b: Binding | null | undefined): string {
  if (!b) return "—";
  const dir = b.direction === 1 ? "+" : b.direction === -1 ? "−" : "";
  return `${b.id}${dir}`;
}

// ---- レーンレイアウト定義 --------------------------------------------------
// IIDX風レイアウト: SCR / 1 / 2 / 3 / 4 / 5 / 6 / 7
// channel.id がここの id と一致した場合、そのレーン設定を使う。
// 一致しないチャンネルはデフォルト設定でレーン追加される。

interface LaneDef {
  id: string;           // チャンネルID（source:id の id 部分）
  label: string;        // ヘッダ表示名
  w: number;            // レーン幅(px)
  // ボタン用オブジェクト色
  noteColor: string;
  // axis用オブジェクト色 (正方向 / 負方向)。ボタンの場合は noteColor を使う
  axisColorPos?: string;
  axisColorNeg?: string;
}

// 後で設定画面から変更可能にする想定。現在は定数で管理。
const LANE_DEFS: LaneDef[] = [
  { id: "SCR",    label: "SCR", w: 90,  noteColor: "#4f8", axisColorPos: "#4f8", axisColorNeg: "#fa4" },
  { id: "KEY1",   label: "1",   w: 52,  noteColor: "#eee" },
  { id: "KEY2",   label: "2",   w: 40,  noteColor: "#48f" },
  { id: "KEY3",   label: "3",   w: 52,  noteColor: "#eee" },
  { id: "KEY4",   label: "4",   w: 40,  noteColor: "#48f" },
  { id: "KEY5",   label: "5",   w: 52,  noteColor: "#eee" },
  { id: "KEY6",   label: "6",   w: 40,  noteColor: "#48f" },
  { id: "KEY7",   label: "7",   w: 52,  noteColor: "#eee" },
];


// ---- Canvas 描画 -----------------------------------------------------------

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  channels: Channel[],
  viewNowMs: number,   // 描画の「現在」（スクロール中は過去の時刻）
  realNowMs: number,   // 実際の現在時刻（アクティブスパンの上端計算に使う）
  isLive: boolean,
  width: number,
) {
  ctx.clearRect(0, 0, width, CANVAS_H);

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, width, CANVAS_H);
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, width, HEADER_H);

  // 現在時刻 (viewNowMs) = 上端 (HEADER_H)、古いほど下
  const BODY_BOTTOM = CANVAS_H - 1;
  const msPerPx = TIME_WINDOW / (BODY_BOTTOM - HEADER_H);
  const tToY = (t: number) => HEADER_H + (viewNowMs - t) / msPerPx;

  // 時間グリッド (500ms ごと)
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  const gridStep = 500;
  const firstGrid = Math.ceil((viewNowMs - TIME_WINDOW) / gridStep) * gridStep;
  for (let g = firstGrid; g <= viewNowMs; g += gridStep) {
    const y = tToY(g);
    if (y < HEADER_H || y > BODY_BOTTOM) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillStyle = "#555";
    ctx.font = "10px monospace";
    ctx.fillText(`${(g / 1000).toFixed(1)}s`, 2, y - 2);
  }

  // LANE_DEFS 全レーンを常に描画（入力がなくても表示）
  // チャンネルが存在する場合はスパンも描画する
  let xOffset = 0;
  for (const lane of LANE_DEFS) {
    const x = xOffset;
    xOffset += lane.w;

    // 区切り線
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + lane.w, HEADER_H);
    ctx.lineTo(x + lane.w, CANVAS_H);
    ctx.stroke();

    // ヘッダ
    ctx.fillStyle = "#ccc";
    ctx.font = "bold 11px monospace";
    ctx.fillText(lane.label, x + 4, HEADER_H - 6);

    // このレーンに対応するチャンネルを検索
    const ch = channels.find((c) => c.id === lane.id);
    if (!ch) continue;

    // スパン描画
    const pad = Math.max(2, Math.floor(lane.w * 0.06));
    const TICK_H = 5; // 押し始め・押し終わりのマーカー高さ(px)

    for (const span of ch.spans) {
      const activeEnd = isLive ? realNowMs : viewNowMs;
      const yTop    = span.end !== null ? tToY(span.end) : tToY(activeEnd);
      const yBottom = tToY(span.start);

      if (yTop > BODY_BOTTOM || yBottom < HEADER_H) continue;

      const drawTop    = Math.max(yTop,    HEADER_H);
      const drawBottom = Math.min(yBottom, BODY_BOTTOM);

      // メインカラー決定
      const color = ch.kind === "button"
        ? lane.noteColor
        : ((span.direction ?? 1) > 0
          ? (lane.axisColorPos ?? lane.noteColor)
          : (lane.axisColorNeg ?? lane.noteColor));

      const lx = x + pad;
      const lw = lane.w - pad * 2;

      // --- 1. 押しっぱなし中の胴体部分（左右1px短く、半透明）---
      const bodyTop    = Math.max(drawTop,    HEADER_H);
      const bodyBottom = Math.min(drawBottom - TICK_H, BODY_BOTTOM); // 押し始めマーカー分を除く
      if (bodyBottom > bodyTop) {
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = color;
        ctx.fillRect(lx + 1, bodyTop, lw - 2, bodyBottom - bodyTop);
        ctx.globalAlpha = 1.0;
      }

      // --- 2. 押し始めマーカー（下端 TICK_H px、フル色）---
      const startMarkerBottom = Math.min(drawBottom, BODY_BOTTOM);
      const startMarkerTop    = Math.max(startMarkerBottom - TICK_H, HEADER_H);
      if (startMarkerBottom > startMarkerTop) {
        ctx.fillStyle = color;
        ctx.fillRect(lx, startMarkerTop, lw, startMarkerBottom - startMarkerTop);
      }

      // --- 3. 押し終わりマーカー（上端 3px、胴体と同幅、中間の濃さ）--- 終了済みスパンのみ
      if (span.end !== null) {
        const endMarkerTop    = Math.max(drawTop, HEADER_H);
        const endMarkerBottom = Math.min(drawTop + 3, BODY_BOTTOM);
        if (endMarkerBottom > endMarkerTop) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = color;
          ctx.fillRect(lx + 1, endMarkerTop, lw - 2, endMarkerBottom - endMarkerTop);
          ctx.globalAlpha = 1.0;
        }
      }
    }
  }

  // 現在時刻ライン
  ctx.strokeStyle = isLive ? "#f44" : "#f80";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H);
  ctx.lineTo(width, HEADER_H);
  ctx.stroke();
}

// ---- メインコンポーネント --------------------------------------------------

export default function App() {
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const ctxRef          = useRef<CanvasRenderingContext2D | null>(null);
  const channelsRef     = useRef<Channel[]>([]);
  const axisLastRef     = useRef<Map<string, number>>(new Map());
  const rafRef          = useRef<number>(0);
  const startRef        = useRef<number>(performance.now());
  // 再生状態管理
  // mode: "live"    → viewMs = realNowMs（常に最新に追従）
  //       "paused"  → viewMs 固定（操作で一時停止）
  //       "playing" → viewMs = viewMs + (realNowMs - startedAt) で一定速度再生
  type PlaybackMode = "live" | "paused" | "playing";
  const playbackRef = useRef<{ mode: PlaybackMode; viewMs: number; startedAt: number }>({
    mode: "live", viewMs: 0, startedAt: 0,
  });
  const dragRef  = useRef<{ startY: number; startViewMs: number } | null>(null);
  const sliderRef = useRef<HTMLInputElement>(null);

  const [channelCount, setChannelCount] = useState(0);
  const [mode, setMode] = useState<PlaybackMode>("live");

  // キーコンフィグ state（ref も持つ：イベントハンドラ内から最新値参照するため）
  const [keyConfig, setKeyConfig] = useState<KeyConfig>(loadConfig);
  const keyConfigRef = useRef<KeyConfig>(loadConfig());
  const [showConfig, setShowConfig] = useState(false);
  const [assigningTarget, setAssigningTarget] = useState<string | null>(null);
  const assigningRef = useRef<string | null>(null);

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

      // コンフィグ割り当てモード: ButtonDown か AxisMove だけを受け付ける（ButtonUp は無視）
      if (assigningRef.current !== null) {
        if (ev.kind === "ButtonUp") return; // ButtonUp は無視して待ち続ける
        const target = assigningRef.current;
        const binding: Binding = ev.kind === "AxisMove"
          ? { source: ev.source, id: ev.id, direction: ev.direction }
          : { source: ev.source, id: ev.id };
        const newCfg = { ...keyConfigRef.current, [target]: binding };
        keyConfigRef.current = newCfg;
        setKeyConfig(newCfg);
        saveConfig(newCfg);
        assigningRef.current = null;
        setAssigningTarget(null);
        return;
      }

      // 通常モード: resolveChannel でレーンIDを決定（未割り当ては無視）
      const resolved = resolveChannel(keyConfigRef.current, ev);
      if (resolved === null) return;

      if (ev.kind === "ButtonDown") {
        const ch = getOrCreateChannel(ev.source, resolved.laneId, resolved.kind);
        const last = ch.spans.at(-1);
        if (resolved.kind === "axis" && last && last.end === null && last.direction !== resolved.direction) {
          // axis チャンネルで方向が変わった場合: 現在のスパンを閉じて新しい方向でスパン開始
          last.end = nowJs;
          ch.spans.push({ start: nowJs, end: null, rustT: ev.t, direction: resolved.direction });
        } else if (!last || last.end !== null) {
          ch.spans.push({ start: nowJs, end: null, rustT: ev.t, direction: resolved.direction });
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
      }
    });

    return () => { unlisten.then((f) => f()); };
  }, [getOrCreateChannel]);

  // Canvas コンテキストのキャッシュ
  useEffect(() => {
    if (canvasRef.current) {
      ctxRef.current = canvasRef.current.getContext("2d");
    }
  }, []);

  // RAF 描画ループ
  useEffect(() => {
    const loop = () => {
      const nowMs = performance.now() - startRef.current;

      // axis タイムアウト
      axisLastRef.current.forEach((lastT, key) => {
        if (nowMs - lastT > AXIS_TIMEOUT) {
          const ch = channelsRef.current.find((c) => `${c.source}:${c.id}` === key);
          const last = ch?.spans.at(-1);
          if (last && last.end === null) {
            last.end = lastT + AXIS_TIMEOUT / 2;
          }
          axisLastRef.current.delete(key);
        }
      });

      // 古いスパンを削除
      const cutoff = nowMs - SPAN_RETAIN;
      for (const ch of channelsRef.current) {
        if (ch.spans.length > 0 && (ch.spans[0].end ?? nowMs) < cutoff) {
          ch.spans = ch.spans.filter((s) => (s.end ?? nowMs) > cutoff);
        }
      }


      // 再生モードに応じて viewNowMs を計算
      const pb = playbackRef.current;
      let viewNowMs: number;
      if (pb.mode === "live") {
        viewNowMs = nowMs;
        pb.viewMs = nowMs;
      } else if (pb.mode === "playing") {
        viewNowMs = pb.viewMs + (nowMs - pb.startedAt);
        // ライブに追いついたら live に戻す
        if (viewNowMs >= nowMs) {
          viewNowMs = nowMs;
          pb.mode = "live";
          pb.viewMs = nowMs;
          setMode("live");
        }
      } else {
        // paused
        viewNowMs = pb.viewMs;
      }

      // スライダーを同期（ドラッグ中でない場合のみ）
      // min=nowMs-SPAN_RETAIN(最古), max=nowMs(最新), value=viewNowMs
      // writingMode: vertical-lr なので value=max が下端(最新)、value=min が上端(最古)
      if (sliderRef.current && !dragRef.current) {
        const minMs = Math.max(0, nowMs - SPAN_RETAIN);
        sliderRef.current.min = String(minMs);
        sliderRef.current.max = String(nowMs);
        sliderRef.current.value = String(viewNowMs);
      }

      if (ctxRef.current && canvasRef.current) {
        drawTimeline(ctxRef.current, channelsRef.current, viewNowMs, nowMs, pb.mode === "live", canvasRef.current.width);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // マウスホイール・ドラッグのイベント登録
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const msPerPx = TIME_WINDOW / (CANVAS_H - 1 - HEADER_H);

    const pause = (viewMs: number) => {
      playbackRef.current = { mode: "paused", viewMs, startedAt: 0 };
      setMode("paused");
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const nowMs = performance.now() - startRef.current;
      const pb = playbackRef.current;
      const currentView = pb.mode === "live" ? nowMs
        : pb.mode === "playing" ? pb.viewMs + (nowMs - pb.startedAt)
        : pb.viewMs;
      const newView = Math.max(TIME_WINDOW, Math.min(currentView - e.deltaY * msPerPx, nowMs));
      pause(newView);
    };

    const onMouseDown = (e: MouseEvent) => {
      const nowMs = performance.now() - startRef.current;
      const pb = playbackRef.current;
      const currentView = pb.mode === "live" ? nowMs
        : pb.mode === "playing" ? pb.viewMs + (nowMs - pb.startedAt)
        : pb.viewMs;
      dragRef.current = { startY: e.clientY, startViewMs: currentView };
      pause(currentView);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const nowMs = performance.now() - startRef.current;
      const dy = dragRef.current.startY - e.clientY; // 上ドラッグ = 過去方向
      const newView = Math.max(TIME_WINDOW, Math.min(dragRef.current.startViewMs + dy * msPerPx, nowMs));
      playbackRef.current.viewMs = newView;
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

  // ここから再生: 現在の viewMs を起点に一定速度で再生開始
  const startPlaying = () => {
    const nowMs = performance.now() - startRef.current;
    const pb = playbackRef.current;
    const currentView = pb.mode === "paused" ? pb.viewMs : nowMs;
    playbackRef.current = { mode: "playing", viewMs: currentView, startedAt: nowMs };
    setMode("playing");
  };

  // ライブに戻る: 最新時刻に即ジャンプして追従再開
  const goLive = () => {
    const nowMs = performance.now() - startRef.current;
    playbackRef.current = { mode: "live", viewMs: nowMs, startedAt: 0 };
    setMode("live");
  };

  const onSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // value が絶対時刻(viewNowMs)なのでそのまま使う
    const newView = Number(e.target.value);
    playbackRef.current = { mode: "paused", viewMs: newView, startedAt: 0 };
    setMode("paused");
  };

  // LANE_DEFS 全レーン幅の合計（固定）
  const width = LANE_DEFS.reduce((s, d) => s + d.w, 0);

  const btnBase: React.CSSProperties = {
    padding: "6px 14px",
    border: "none",
    borderRadius: 4,
    fontFamily: "monospace",
    fontWeight: "bold",
    cursor: "pointer",
  };

  // キーコンフィグ: 割り当てボタンのスタイル
  const assignBtnStyle = (target: string): React.CSSProperties => {
    const isAssigning = assigningTarget === target;
    const hasBinding = !!keyConfig[target];
    return {
      border: isAssigning ? "2px solid #f80" : hasBinding ? "2px solid #2a4" : "2px solid #555",
      background: isAssigning ? "#3a2000" : hasBinding ? "#0a2010" : "#1a1a1a",
      cursor: "pointer",
      fontFamily: "monospace",
      fontSize: 10,
      color: isAssigning ? "#f80" : hasBinding ? "#4f8" : "#888",
      display: "flex",
      flexDirection: "column" as const,
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      userSelect: "none" as const,
    };
  };

  const startAssigning = (target: string) => {
    assigningRef.current = target;
    setAssigningTarget(target);
  };

  const clearBinding = (target: string) => {
    const newCfg = { ...keyConfigRef.current, [target]: null };
    keyConfigRef.current = newCfg;
    setKeyConfig(newCfg);
    saveConfig(newCfg);
  };

  const clearAll = () => {
    const newCfg: KeyConfig = {};
    keyConfigRef.current = newCfg;
    setKeyConfig(newCfg);
    saveConfig(newCfg);
    assigningRef.current = null;
    setAssigningTarget(null);
  };

  const closeConfig = () => {
    assigningRef.current = null;
    setAssigningTarget(null);
    setShowConfig(false);
  };

  // KEY1〜KEY7のレーン定義（黒鍵/白鍵）
  const KEY_DEFS = [
    { id: "KEY1", label: "1", black: false },
    { id: "KEY2", label: "2", black: true  },
    { id: "KEY3", label: "3", black: false },
    { id: "KEY4", label: "4", black: true  },
    { id: "KEY5", label: "5", black: false },
    { id: "KEY6", label: "6", black: true  },
    { id: "KEY7", label: "7", black: false },
  ];

  return (
    <main style={{ background: "#111", minHeight: "100vh", color: "#eee", fontFamily: "monospace", padding: 16 }}>
      <h2 style={{ margin: "0 0 8px" }}>scratch-trainer — input timeline</h2>
      <p style={{ margin: "0 0 8px", color: "#888", fontSize: 12 }}>
        キーボード A/Q/W &amp; ゲームパッド ボタン/Axis を検出します（Rust RawInput/gilrs）
      </p>

      {/* canvas + 縦スライダー */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 4, overflowX: "auto" }}>
        <canvas
          ref={canvasRef}
          width={width}
          height={CANVAS_H}
          style={{ display: "block", border: "1px solid #333", cursor: "grab", flexShrink: 0 }}
        />
        {/* 縦スライダー: 上=過去、下=現在。max/valueはRAFループで直接DOM更新 */}
        <input
          ref={sliderRef}
          type="range"
          min={0}
          defaultValue={0}
          onChange={onSliderChange}
          style={{
            writingMode: "vertical-lr",
            width: 28,
            height: CANVAS_H,
            cursor: "pointer",
            accentColor: "#f80",
          }}
        />
      </div>

      {/* 操作ボタン（常時表示、状態に応じてdisabled） */}
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
        <button
          onClick={startPlaying}
          disabled={mode === "live" || mode === "playing"}
          style={{
            ...btnBase,
            background: mode === "paused" ? "#4a4" : "#333",
            color: mode === "paused" ? "#fff" : "#666",
          }}
        >
          ▶ ここから再生
        </button>
        <button
          onClick={goLive}
          disabled={mode === "live"}
          style={{
            ...btnBase,
            background: mode !== "live" ? "#f80" : "#333",
            color: mode !== "live" ? "#111" : "#666",
          }}
        >
          ⏩ ライブに戻る
        </button>
        <button
          onClick={() => setShowConfig(true)}
          style={{ ...btnBase, background: "#226", color: "#aaf", marginLeft: "auto" }}
        >
          ⚙ キーコンフィグ
        </button>
      </div>

      {channelCount === 0 && (
        <p style={{ color: "#555", marginTop: 12 }}>入力を待っています…</p>
      )}

      {/* キーコンフィグ モーダル */}
      {showConfig && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeConfig(); }}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div style={{
            background: "#1a1a1a",
            border: "1px solid #444",
            borderRadius: 8,
            padding: 24,
            minWidth: 480,
            fontFamily: "monospace",
            color: "#eee",
          }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 14, color: "#aaa" }}>
              キーコンフィグ
              {assigningTarget && (
                <span style={{ marginLeft: 12, color: "#f80", fontSize: 12 }}>
                  [{assigningTarget}] に割り当てる入力を押してください…
                </span>
              )}
            </h3>

            {/* コントローラー配置 */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>

              {/* スクラッチ円 */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 10, color: "#666" }}>SCR</span>
                <div style={{
                  width: 130, height: 130,
                  borderRadius: "50%",
                  overflow: "hidden",
                  border: "2px solid #444",
                  display: "flex",
                  flexShrink: 0,
                }}>
                  {/* 左半分: SCR_NEG (反時計回り) */}
                  <div
                    onClick={() => startAssigning("SCR_NEG")}
                    onContextMenu={(e) => { e.preventDefault(); clearBinding("SCR_NEG"); }}
                    style={{
                      ...assignBtnStyle("SCR_NEG"),
                      width: "50%", height: "100%",
                      borderRadius: 0,
                      borderRight: "1px solid #555",
                    }}
                    title="左クリック: 割り当て  右クリック: クリア"
                  >
                    <span style={{ fontSize: 16 }}>↺</span>
                    <span style={{ fontSize: 9, textAlign: "center", lineHeight: 1.2 }}>
                      {bindingLabel(keyConfig["SCR_NEG"])}
                    </span>
                  </div>
                  {/* 右半分: SCR_POS (時計回り) */}
                  <div
                    onClick={() => startAssigning("SCR_POS")}
                    onContextMenu={(e) => { e.preventDefault(); clearBinding("SCR_POS"); }}
                    style={{
                      ...assignBtnStyle("SCR_POS"),
                      width: "50%", height: "100%",
                      borderRadius: 0,
                    }}
                    title="左クリック: 割り当て  右クリック: クリア"
                  >
                    <span style={{ fontSize: 16 }}>↻</span>
                    <span style={{ fontSize: 9, textAlign: "center", lineHeight: 1.2 }}>
                      {bindingLabel(keyConfig["SCR_POS"])}
                    </span>
                  </div>
                </div>
              </div>

              {/* 鍵盤 KEY1〜KEY7: 偶数(黒鍵)を上段、奇数(白鍵)を下段に2段配置 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {/* 上段: 偶数キー(2/4/6) */}
                <div style={{ display: "flex", gap: 2, justifyContent: "center" }}>
                  {KEY_DEFS.filter(k => k.black).map(({ id, label }) => (
                    <div
                      key={id}
                      onClick={() => startAssigning(id)}
                      onContextMenu={(e) => { e.preventDefault(); clearBinding(id); }}
                      style={{ ...assignBtnStyle(id), width: 44, height: 60, borderRadius: 4 }}
                      title="左クリック: 割り当て  右クリック: クリア"
                    >
                      <span style={{ fontSize: 11, fontWeight: "bold" }}>{label}</span>
                      <span style={{ fontSize: 9, textAlign: "center", lineHeight: 1.2, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {bindingLabel(keyConfig[id])}
                      </span>
                    </div>
                  ))}
                </div>
                {/* 下段: 奇数キー(1/3/5/7) */}
                <div style={{ display: "flex", gap: 2 }}>
                  {KEY_DEFS.filter(k => !k.black).map(({ id, label }) => (
                    <div
                      key={id}
                      onClick={() => startAssigning(id)}
                      onContextMenu={(e) => { e.preventDefault(); clearBinding(id); }}
                      style={{ ...assignBtnStyle(id), width: 44, height: 60, borderRadius: 4 }}
                      title="左クリック: 割り当て  右クリック: クリア"
                    >
                      <span style={{ fontSize: 11, fontWeight: "bold" }}>{label}</span>
                      <span style={{ fontSize: 9, textAlign: "center", lineHeight: 1.2, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {bindingLabel(keyConfig[id])}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <p style={{ fontSize: 10, color: "#555", margin: "12px 0 16px" }}>
              左クリック: 入力待ち &nbsp;|&nbsp; 右クリック: 割り当てクリア
            </p>

            {/* フッターボタン */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={clearAll}
                style={{ ...btnBase, background: "#400", color: "#f88", fontSize: 12 }}
              >
                全クリア
              </button>
              <button
                onClick={closeConfig}
                style={{ ...btnBase, background: "#333", color: "#ccc", fontSize: 12 }}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
