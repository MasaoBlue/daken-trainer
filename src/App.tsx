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

const CANVAS_H          = 600;
const COL_W             = 60;
const HEADER_H          = 40;
const TIME_WINDOW       = 3000;   // ms: 表示する時間幅
const AXIS_TIMEOUT      = 150;    // ms: axis 停止判定（連続回転中のイベント間隔より十分大きくする）
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

  // 現在時刻 (nowMs) = 上端 (HEADER_H)、古いほど下
  // tToY(nowMs) = HEADER_H、tToY(nowMs - TIME_WINDOW) = CANVAS_H - 1
  const BODY_BOTTOM = CANVAS_H - 1;
  const msPerPx = TIME_WINDOW / (BODY_BOTTOM - HEADER_H);
  const tToY = (t: number) => HEADER_H + (nowMs - t) / msPerPx;

  // 時間グリッド (500ms ごと)
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  const gridStep = 500;
  const firstGrid = Math.ceil((nowMs - TIME_WINDOW) / gridStep) * gridStep;
  for (let g = firstGrid; g <= nowMs; g += gridStep) {
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
    // tToY: 新しい時刻 → 小さい y（上）、古い時刻 → 大きい y（下）
    // span.end or nowMs (新しい) が上端、span.start (古い) が下端
    for (const span of ch.spans) {
      const yTop    = span.end !== null ? tToY(span.end) : tToY(nowMs);   // 入力終了 or 現在 = 上端
      const yBottom = tToY(span.start);                                    // 入力開始 = 下端

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

      if (span.end === null) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 4, drawTop, COL_W - 8, h);
      }
    }
  });

  // 現在時刻ライン
  ctx.strokeStyle = "#f44";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H);
  ctx.lineTo(width, HEADER_H);
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
  // ev.t は Rust 側の Instant 基準ミリ秒。JS の performance.now() とゼロ点が異なるため
  // 受信時刻 (performance.now()) をそのまま使い、ボタン Up のみ押し時間を ev.t の差分で計算する。
  useEffect(() => {
    const unlisten = listen<InputEvent>("input-event", (e) => {
      const ev = e.payload;
      // JS 基準の「今」 (IPC 遅延込みだが最速で表示できる)
      const nowJs = performance.now() - startRef.current;

      if (ev.kind === "ButtonDown") {
        const ch = getOrCreateChannel(ev.source, ev.id, "button");
        const last = ch.spans.at(-1);
        if (!last || last.end !== null) {
          // start に JS 時刻 + Rust タイムスタンプ両方を保持
          ch.spans.push({ start: nowJs, end: null, rustT: ev.t });
        }
      } else if (ev.kind === "ButtonUp") {
        const ch = getOrCreateChannel(ev.source, ev.id, "button");
        const last = ch.spans.at(-1);
        if (last && last.end === null) {
          // 押し続けた時間 (Rust 側で正確に計測) を JS 時刻に加算して end を算出
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
