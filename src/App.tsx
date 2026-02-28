import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

// ---- 型定義 ----------------------------------------------------------------

type InputEvent =
  | { kind: "ButtonDown"; source: string; id: string; t: number }
  | { kind: "ButtonUp";   source: string; id: string; t: number }
  | { kind: "AxisMove";   source: string; id: string; direction: number; value: number; t: number };

interface Span {
  start: number;
  end: number | null;
  direction?: number;
}

interface Channel {
  id: string;
  source: string;
  kind: "button" | "axis";
  spans: Span[];
}

// ---- 定数 ------------------------------------------------------------------

const CANVAS_H          = 600;
const COL_W             = 60;
const HEADER_H          = 40;
const TIME_WINDOW       = 3000;   // ms: 表示する時間幅
const AXIS_TIMEOUT      = 80;     // ms: axis 停止判定
const SPAN_RETAIN       = TIME_WINDOW * 2; // ms: これより古いスパンを削除

// ---- Canvas 描画 -----------------------------------------------------------

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  channels: Channel[],
  nowMs: number,
  width: number,
) {
  ctx.clearRect(0, 0, width, CANVAS_H);

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, width, CANVAS_H);
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, width, HEADER_H);

  const msPerPx = TIME_WINDOW / (CANVAS_H - HEADER_H);
  const tToY = (t: number) => HEADER_H + (nowMs - t) / msPerPx;

  // 時間グリッド
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  const gridStep = 500;
  const firstGrid = Math.floor((nowMs - TIME_WINDOW) / gridStep) * gridStep;
  for (let g = firstGrid; g <= nowMs; g += gridStep) {
    const y = tToY(g);
    if (y < HEADER_H || y > CANVAS_H) continue;
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
      const yStart = tToY(span.start);
      const yEnd   = span.end !== null ? tToY(span.end) : HEADER_H;

      if (yEnd > CANVAS_H || yStart < HEADER_H) continue;

      const top = Math.min(yStart, yEnd);
      const h   = Math.max(Math.abs(yStart - yEnd), 3);

      ctx.fillStyle = ch.kind === "button"
        ? (ch.source === "keyboard" ? "#4af" : "#fa4")
        : ((span.direction ?? 1) > 0 ? "#4f8" : "#f84");

      ctx.fillRect(x + 4, top, COL_W - 8, h);

      if (span.end === null) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 4, top, COL_W - 8, h);
      }
    }
  });

  // 現在時刻ライン
  ctx.strokeStyle = "#f44";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_H - 1);
  ctx.lineTo(width, CANVAS_H - 1);
  ctx.stroke();
}

// ---- メインコンポーネント --------------------------------------------------

export default function App() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null); // キャッシュ
  const channelsRef  = useRef<Channel[]>([]);
  const axisLastRef  = useRef<Map<string, number>>(new Map());
  const rafRef       = useRef<number>(0);
  const startRef     = useRef<number>(performance.now());

  const [channelCount, setChannelCount] = useState(0);

  // チャンネル取得/作成 (ref に持つので再レンダリングを引き起こさない)
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

      if (ev.kind === "ButtonDown") {
        const ch = getOrCreateChannel(ev.source, ev.id, "button");
        const last = ch.spans.at(-1);
        if (!last || last.end !== null) {
          ch.spans.push({ start: ev.t, end: null });
        }
      } else if (ev.kind === "ButtonUp") {
        const ch = getOrCreateChannel(ev.source, ev.id, "button");
        const last = ch.spans.at(-1);
        if (last && last.end === null) {
          last.end = ev.t;
        }
      } else if (ev.kind === "AxisMove") {
        const ch = getOrCreateChannel(ev.source, ev.id, "axis");
        const key = `${ev.source}:${ev.id}`;
        axisLastRef.current.set(key, ev.t);
        const last = ch.spans.at(-1);
        if (!last || last.end !== null) {
          ch.spans.push({ start: ev.t, end: null, direction: ev.direction });
        } else if (last.direction !== ev.direction) {
          last.end = ev.t;
          ch.spans.push({ start: ev.t, end: null, direction: ev.direction });
        }
        // 同方向継続はスパンをそのまま延ばす（何もしない）
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

      // axis タイムアウト: 停止したスパンを閉じる
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

      // 古いスパンを削除 (表示範囲の2倍より前)
      const cutoff = nowMs - SPAN_RETAIN;
      for (const ch of channelsRef.current) {
        if (ch.spans.length > 0 && (ch.spans[0].end ?? nowMs) < cutoff) {
          ch.spans = ch.spans.filter((s) => (s.end ?? nowMs) > cutoff);
        }
      }

      if (ctxRef.current && canvasRef.current) {
        drawTimeline(ctxRef.current, channelsRef.current, nowMs, canvasRef.current.width);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const width = Math.max(channelCount * COL_W, 400);

  return (
    <main style={{ background: "#111", minHeight: "100vh", color: "#eee", fontFamily: "monospace", padding: 16 }}>
      <h2 style={{ margin: "0 0 8px" }}>scratch-trainer — input timeline</h2>
      <p style={{ margin: "0 0 8px", color: "#888", fontSize: 12 }}>
        キーボード A/Q/W &amp; ゲームパッド ボタン/Axis を検出します（Rust RawInput/gilrs）
      </p>
      <div style={{ overflowX: "auto" }}>
        <canvas
          ref={canvasRef}
          width={width}
          height={CANVAS_H}
          style={{ display: "block", border: "1px solid #333" }}
        />
      </div>
      {channelCount === 0 && (
        <p style={{ color: "#555", marginTop: 12 }}>入力を待っています…</p>
      )}
    </main>
  );
}
