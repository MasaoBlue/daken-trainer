import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RapidPressState, RapidPressResult } from "../types";

interface RapidPressModeProps {
  // キー入力コールバック登録（ButtonDownイベント時に laneId を通知）
  onKeyDown: (cb: (laneId: string) => void) => void;
  offKeyDown: (cb: (laneId: string) => void) => void;
  // 記録保存
  onComplete: (result: RapidPressResult) => void;
}

const DURATIONS = [1, 5, 10, 20, 30, 60] as const;
const TARGET_KEYS = [
  { id: "ANY", label: "全キー" },
  { id: "KEY1", label: "1" },
  { id: "KEY2", label: "2" },
  { id: "KEY3", label: "3" },
  { id: "KEY4", label: "4" },
  { id: "KEY5", label: "5" },
  { id: "KEY6", label: "6" },
  { id: "KEY7", label: "7" },
];

export default function RapidPressMode({
  onKeyDown,
  offKeyDown,
  onComplete,
}: RapidPressModeProps) {
  const [state, setState] = useState<RapidPressState>("idle");
  const stateRef = useRef<RapidPressState>("idle");
  const [duration, setDuration] = useState(10);
  const durationRef = useRef(10);
  const [targetKey, setTargetKey] = useState("ANY");
  const targetKeyRef = useRef("ANY");
  const [timeLeft, setTimeLeft] = useState(0);
  const startTimeRef = useRef(0);
  const countRef = useRef(0);
  const [count, setCount] = useState(0);
  const [result, setResult] = useState<RapidPressResult | null>(null);

  // タイマーループ
  useEffect(() => {
    if (stateRef.current !== "running") return;
    const interval = setInterval(() => {
      const elapsed = (performance.now() - startTimeRef.current) / 1000;
      const remaining = durationRef.current - elapsed;
      if (remaining <= 0) {
        setTimeLeft(0);
        stateRef.current = "done";
        setState("done");
        clearInterval(interval);
        const r: RapidPressResult = {
          date: new Date().toISOString(),
          duration: durationRef.current,
          pressCount: countRef.current,
          keyLabel: targetKeyRef.current === "ANY" ? "全キー" : `KEY${targetKeyRef.current.replace("KEY", "")}`,
        };
        setResult(r);
        onComplete(r);
      } else {
        setTimeLeft(remaining);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [state, onComplete]);

  // キー入力ハンドラ
  const handleKeyDown = useCallback((laneId: string) => {
    // SCRは対象外
    if (laneId === "SCR") return;

    if (stateRef.current === "ready") {
      // ターゲットキーチェック
      if (targetKeyRef.current !== "ANY" && laneId !== targetKeyRef.current) return;
      stateRef.current = "running";
      setState("running");
      startTimeRef.current = performance.now();
      setTimeLeft(durationRef.current);
      countRef.current = 1;
      setCount(1);
    } else if (stateRef.current === "running") {
      if (targetKeyRef.current !== "ANY" && laneId !== targetKeyRef.current) return;
      countRef.current += 1;
      setCount(countRef.current);
    }
  }, []);

  useEffect(() => {
    onKeyDown(handleKeyDown);
    return () => offKeyDown(handleKeyDown);
  }, [handleKeyDown, onKeyDown, offKeyDown]);

  const startReady = (d: number) => {
    setDuration(d);
    durationRef.current = d;
    stateRef.current = "ready";
    setState("ready");
    countRef.current = 0;
    setCount(0);
    setResult(null);
  };

  return (
    <Card className={`h-fit shrink-0 w-[160px] ${state === "running" ? "border-cyan-500/50 shadow-[0_0_8px_rgba(6,182,212,0.2)]" : ""}`}>
      <CardHeader className="pb-2 pt-3 px-3">
        <CardTitle className="text-xs text-muted-foreground">Rapid Press</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 flex flex-col gap-2 items-center">
        {/* ターゲットキー選択 */}
        <div className="flex flex-wrap gap-1 w-full">
          {TARGET_KEYS.map(k => (
            <Button
              key={k.id}
              size="sm"
              variant={targetKey === k.id ? "default" : "outline"}
              className="text-xs px-1.5 h-6"
              disabled={state === "running"}
              onClick={() => { setTargetKey(k.id); targetKeyRef.current = k.id; }}
            >
              {k.label}
            </Button>
          ))}
        </div>

        {/* 時間選択 */}
        <div className="grid grid-cols-3 gap-1 w-full">
          {DURATIONS.map(d => (
            <Button
              key={d}
              size="sm"
              variant={state !== "idle" && duration === d && state !== "done" ? "default" : "outline"}
              className={`text-xs px-1 h-7 ${state === "done" && duration === d ? "border-primary text-primary" : ""}`}
              disabled={state === "running"}
              onClick={() => startReady(d)}
            >
              {d === 60 ? "1m" : `${d}s`}
            </Button>
          ))}
        </div>

        {/* タイマー */}
        <div className={`font-mono text-3xl font-bold tabular-nums text-center w-full ${
          state === "running" ? "text-cyan-400"
            : state === "ready" ? "text-zinc-500"
            : state === "done" ? "text-zinc-500"
            : "text-zinc-700"
        }`}>
          {state === "running"
            ? timeLeft.toFixed(2)
            : state === "ready"
            ? `${duration}.00`
            : state === "done"
            ? "0.00"
            : "0.00"}
        </div>

        {/* カウント */}
        <div className="text-center w-full">
          <span className="text-[10px] text-muted-foreground">Presses</span>
          <div className={`font-mono text-3xl font-bold tabular-nums ${
            state === "running" ? "text-cyan-300"
              : state === "done" ? "text-cyan-300"
              : "text-zinc-700"
          }`}>
            {state === "running" || state === "done"
              ? (state === "done" && result ? result.pressCount : count)
              : "—"}
          </div>
        </div>

        {/* 操作 */}
        {state === "ready" && (
          <>
            <span className="text-xs text-muted-foreground animate-pulse">
              キーで開始
            </span>
            <Button
              size="sm" variant="ghost"
              className="text-xs"
              onClick={() => { stateRef.current = "idle"; setState("idle"); }}
            >
              キャンセル
            </Button>
          </>
        )}
        {state === "running" && (
          <Button
            size="sm" variant="ghost"
            className="text-xs"
            onClick={() => { stateRef.current = "idle"; setState("idle"); }}
          >
            リセット
          </Button>
        )}
        {state === "done" && result && (
          <div className="text-center flex flex-col gap-1 w-full">
            <div className="text-base font-bold text-green-400">FINISH!</div>
            <span className="text-xs text-zinc-400">
              {(result.pressCount / duration).toFixed(1)} 回/秒
            </span>
            <a
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                `${duration === 60 ? "1m" : `${duration}s`}で${result.pressCount}回キーを叩いたよ！`
                + `\n${(result.pressCount / duration).toFixed(1)} 回/秒`
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
  );
}
