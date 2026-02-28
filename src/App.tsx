import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

// ---- 型定義 ----------------------------------------------------------------

type InputEvent =
  | { kind: "ButtonDown"; source: string; id: string; t: number }
  | { kind: "ButtonUp";   source: string; id: string; t: number }
  | { kind: "AxisMove";   source: string; id: string; direction: number; value: number; t: number };

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

const CANVAS_H          = 800;
const COL_W             = 60;
const HEADER_H          = 40;
const TIME_WINDOW       = 3000;   // ms: 表示する時間幅
const AXIS_TIMEOUT      = 150;    // ms: axis 停止判定
const SPAN_RETAIN       = 60000;  // ms: 過去1分のスパンを保持（スクロール用）

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

  channels.forEach((ch, ci) => {
    const x = ci * COL_W;

    // 区切り線
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + COL_W, HEADER_H);
    ctx.lineTo(x + COL_W, CANVAS_H);
    ctx.stroke();

    // ヘッダ
    ctx.fillStyle = ch.source === "keyboard" ? "#8ef" : "#fe8";
    ctx.font = "bold 11px monospace";
    ctx.fillText(ch.id.slice(0, 7), x + 4, HEADER_H - 8);
    ctx.fillStyle = "#666";
    ctx.font = "9px monospace";
    ctx.fillText(ch.source.slice(0, 3), x + 4, HEADER_H - 18);

    // スパン
    for (const span of ch.spans) {
      // アクティブスパン(end===null)の上端:
      //   ライブ中 → realNowMs（常に上端に張り付く）
      //   スクロール中 → viewNowMs（画面の現在時刻まで）
      const activeEnd = isLive ? realNowMs : viewNowMs;
      const yTop    = span.end !== null ? tToY(span.end) : tToY(activeEnd);
      const yBottom = tToY(span.start);

      // 完全に画面外はスキップ
      if (yTop > BODY_BOTTOM || yBottom < HEADER_H) continue;

      // 画面内にクリップ
      const drawTop    = Math.max(yTop,    HEADER_H);
      const drawBottom = Math.min(yBottom, BODY_BOTTOM);
      const h          = Math.max(drawBottom - drawTop, 3);

      ctx.fillStyle = ch.kind === "button"
        ? (ch.source === "keyboard" ? "#4af" : "#fa4")
        : ((span.direction ?? 1) > 0 ? "#4f8" : "#f84");

      ctx.fillRect(x + 4, drawTop, COL_W - 8, h);

      if (span.end === null && isLive) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 4, drawTop, COL_W - 8, h);
      }
    }
  });

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

      if (ev.kind === "ButtonDown") {
        const ch = getOrCreateChannel(ev.source, ev.id, "button");
        const last = ch.spans.at(-1);
        if (!last || last.end !== null) {
          ch.spans.push({ start: nowJs, end: null, rustT: ev.t });
        }
      } else if (ev.kind === "ButtonUp") {
        const ch = getOrCreateChannel(ev.source, ev.id, "button");
        const last = ch.spans.at(-1);
        if (last && last.end === null) {
          const holdMs = last.rustT !== undefined ? ev.t - last.rustT : 0;
          last.end = last.start + holdMs;
        }
      } else if (ev.kind === "AxisMove") {
        const ch = getOrCreateChannel(ev.source, ev.id, "axis");
        const key = `${ev.source}:${ev.id}`;
        axisLastRef.current.set(key, nowJs);
        const last = ch.spans.at(-1);
        if (!last || last.end !== null) {
          ch.spans.push({ start: nowJs, end: null, direction: ev.direction });
        } else if (last.direction !== ev.direction) {
          last.end = nowJs;
          ch.spans.push({ start: nowJs, end: null, direction: ev.direction });
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

      const maxOff = Math.max(0, nowMs - TIME_WINDOW);

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

  const width = Math.min(Math.max(channelCount * COL_W, 400), 500);

  const btnBase: React.CSSProperties = {
    padding: "6px 14px",
    border: "none",
    borderRadius: 4,
    fontFamily: "monospace",
    fontWeight: "bold",
    cursor: "pointer",
  };

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
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
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
      </div>

      {channelCount === 0 && (
        <p style={{ color: "#555", marginTop: 12 }}>入力を待っています…</p>
      )}
    </main>
  );
}
