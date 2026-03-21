import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DrillState, DrillResult } from "../types";

interface DrillModeProps {
  onScratchReset: (cb: (finalCount: number, firstDir: number) => void) => void;
  offScratchReset: (cb: (finalCount: number, firstDir: number) => void) => void;
  onScratchChange: (cb: (count: number, dir: number) => void) => void;
  offScratchChange: (cb: (count: number, dir: number) => void) => void;
  onComplete: (result: DrillResult) => void;
}

interface Problem {
  dir: "push" | "pull";
  chainLength: number; // 1~16
}

const DURATIONS = [10, 20, 30, 60] as const;
const COUNTDOWN_SEC = 3;

function randomProblem(): Problem {
  return {
    dir: Math.random() < 0.5 ? "push" : "pull",
    chainLength: Math.floor(Math.random() * 16) + 1,
  };
}

export default function DrillMode({
  onScratchReset,
  offScratchReset,
  onScratchChange,
  offScratchChange,
  onComplete,
}: DrillModeProps) {
  const [state, setState] = useState<DrillState>("idle");
  const stateRef = useRef<DrillState>("idle");
  const [duration, setDuration] = useState(30);
  const durationRef = useRef(30);

  // カウントダウン
  const [countdownLeft, setCountdownLeft] = useState(COUNTDOWN_SEC);
  const countdownStartRef = useRef(0);

  // タイマー
  const [timeLeft, setTimeLeft] = useState(0);
  const startTimeRef = useRef(0);

  // スコア
  const completedRef = useRef(0);
  const failedRef = useRef(0);
  const [completed, setCompleted] = useState(0);
  const [failed, setFailed] = useState(0);

  // 現在の問題
  const [problem, setProblem] = useState<Problem | null>(null);
  const problemRef = useRef<Problem | null>(null);

  // 現在のスクラッチ数（表示用）
  const [currentCount, setCurrentCount] = useState(0);
  const currentCountRef = useRef(0);

  // チェイン追跡
  const chainActiveRef = useRef(false);
  const chainFirstDirRef = useRef(0);
  const chainFailedRef = useRef(false);
  const [currentFailed, setCurrentFailed] = useState(false);

  const [result, setResult] = useState<DrillResult | null>(null);

  // 次の問題を出す
  const nextProblem = useCallback(() => {
    const p = randomProblem();
    problemRef.current = p;
    setProblem(p);
    currentCountRef.current = 0;
    setCurrentCount(0);
    chainActiveRef.current = false;
    chainFailedRef.current = false;
    setCurrentFailed(false);
  }, []);

  // カウントダウンタイマー
  useEffect(() => {
    if (stateRef.current !== "countdown") return;
    const interval = setInterval(() => {
      const elapsed = (performance.now() - countdownStartRef.current) / 1000;
      const remaining = COUNTDOWN_SEC - elapsed;
      if (remaining <= 0) {
        clearInterval(interval);
        stateRef.current = "running";
        setState("running");
        startTimeRef.current = performance.now();
        setTimeLeft(durationRef.current);
        nextProblem();
      } else {
        setCountdownLeft(remaining);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [state, nextProblem]);

  // ランニングタイマー
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
        const r: DrillResult = {
          date: new Date().toISOString(),
          duration: durationRef.current,
          completedChains: completedRef.current,
          failedChains: failedRef.current,
        };
        setResult(r);
        onComplete(r);
      } else {
        setTimeLeft(remaining);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [state, onComplete]);

  // スクラッチ方向変化
  const handleScratchChange = useCallback((count: number, dir: number) => {
    if (stateRef.current !== "running") return;
    const p = problemRef.current;
    if (!p) return;

    if (!chainActiveRef.current && count === 1) {
      chainActiveRef.current = true;
      chainFirstDirRef.current = dir;
      chainFailedRef.current = false;
      const expectedDir = p.dir === "push" ? 1 : -1;
      if (dir !== expectedDir) {
        chainFailedRef.current = true;
        failedRef.current += 1;
        setFailed(failedRef.current);
        setCurrentFailed(true);
      }
    }

    currentCountRef.current = count;
    setCurrentCount(count);

    if (chainActiveRef.current && count > p.chainLength) {
      if (!chainFailedRef.current) {
        chainFailedRef.current = true;
        failedRef.current += 1;
        setFailed(failedRef.current);
        setCurrentFailed(true);
      }
    }
  }, []);

  // スクラッチリセット
  const handleScratchReset = useCallback((finalCount: number, _firstDir: number) => {
    if (stateRef.current !== "running") return;
    if (!chainActiveRef.current) return;
    const p = problemRef.current;
    if (!p) return;

    if (chainFailedRef.current) {
      // 既に失敗済み
    } else if (finalCount !== p.chainLength) {
      failedRef.current += 1;
      setFailed(failedRef.current);
    } else {
      completedRef.current += 1;
      setCompleted(completedRef.current);
    }

    chainActiveRef.current = false;
    chainFailedRef.current = false;

    if (stateRef.current === "running") {
      nextProblem();
    }
  }, [nextProblem]);

  // コールバック登録
  useEffect(() => {
    onScratchReset(handleScratchReset);
    onScratchChange(handleScratchChange);
    return () => {
      offScratchReset(handleScratchReset);
      offScratchChange(handleScratchChange);
    };
  }, [handleScratchReset, handleScratchChange, onScratchReset, offScratchReset, onScratchChange, offScratchChange]);

  // 秒数選択
  const selectDuration = (d: number) => {
    setDuration(d);
    durationRef.current = d;
    stateRef.current = "ready";
    setState("ready");
    completedRef.current = 0;
    failedRef.current = 0;
    setCompleted(0);
    setFailed(0);
    setResult(null);
    setProblem(null);
    problemRef.current = null;
    currentCountRef.current = 0;
    setCurrentCount(0);
    chainActiveRef.current = false;
    chainFailedRef.current = false;
    setCurrentFailed(false);
  };

  // START押下 → カウントダウン開始
  const startCountdown = () => {
    countdownStartRef.current = performance.now();
    setCountdownLeft(COUNTDOWN_SEC);
    stateRef.current = "countdown";
    setState("countdown");
  };

  const resetToIdle = () => {
    stateRef.current = "idle";
    setState("idle");
  };

  // 問題の色判定
  const getCountColor = () => {
    if (!problem || state !== "running") return "text-zinc-700";
    if (currentFailed) return "text-red-400";
    if (currentCount === 0) return "text-zinc-500";
    if (currentCount < problem.chainLength) return "text-blue-400";
    if (currentCount === problem.chainLength) return "text-green-400";
    return "text-red-400";
  };

  const getDirColor = () => {
    if (!problem || state !== "running") return "text-zinc-700";
    if (currentFailed) return "text-red-400";
    return problem.dir === "push" ? "text-green-400" : "text-orange-400";
  };

  const isActive = state === "running" || state === "countdown" || state === "ready";

  return (
    <Card className={`h-fit shrink-0 w-[160px] ${state === "running" ? "border-purple-500/50 shadow-[0_0_8px_rgba(168,85,247,0.2)]" : ""}`}>
      <CardHeader className="pb-2 pt-3 px-3">
        <CardTitle className="text-xs text-muted-foreground">Drill</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 flex flex-col gap-2 items-center">
        {/* 時間選択（常時表示） */}
        <div className="grid grid-cols-4 gap-1 w-full">
          {DURATIONS.map(d => (
            <Button
              key={d}
              size="sm"
              variant={state !== "idle" && duration === d ? "default" : "outline"}
              className={`text-xs px-1 h-7 ${state === "done" && duration === d ? "border-primary text-primary" : ""}`}
              disabled={state === "running" || state === "countdown"}
              onClick={() => selectDuration(d)}
            >
              {d === 60 ? "1m" : `${d}s`}
            </Button>
          ))}
        </div>

        {/* タイマー表示 */}
        <div className={`font-mono text-3xl font-bold tabular-nums text-center w-full ${
          state === "running" ? "text-purple-400"
            : state === "countdown" ? "text-purple-400"
            : state === "ready" ? "text-zinc-500"
            : state === "done" ? "text-zinc-500"
            : "text-zinc-700"
        }`}>
          {state === "countdown"
            ? Math.ceil(countdownLeft)
            : state === "running"
            ? timeLeft.toFixed(1)
            : state === "ready"
            ? `${duration}.0`
            : state === "done"
            ? "0.0"
            : "0.0"}
        </div>

        {/* 問題表示エリア（高さ確保） */}
        <div className="text-center w-full">
          <span className={`text-3xl font-bold ${state === "running" && problem ? getDirColor() : "text-zinc-700"}`}>
            {state === "running" && problem
              ? (problem.dir === "push" ? "↶ 押し" : "↷ 引き")
              : "— —"}
          </span>
        </div>

        {/* 目標回数 & 現在回数 */}
        <div className="flex items-baseline justify-center gap-2 w-full">
          <span className={`font-mono text-4xl font-bold tabular-nums ${
            state === "running" && problem ? "text-zinc-300" : "text-zinc-700"
          }`}>
            {state === "running" && problem ? problem.chainLength : "—"}
          </span>
          <span className="text-xs text-muted-foreground">連</span>
          <span className={`font-mono text-4xl font-bold tabular-nums ${
            state === "running" ? getCountColor() : "text-zinc-700"
          }`}>
            {state === "running" ? currentCount : "—"}
          </span>
        </div>

        {/* 成功/失敗カウント */}
        <div className="flex gap-4 w-full justify-center">
          <div className="text-center">
            <span className="text-[10px] text-muted-foreground">成功</span>
            <div className={`font-mono text-2xl font-bold tabular-nums ${
              isActive || state === "done" ? "text-blue-400" : "text-zinc-700"
            }`}>
              {isActive || state === "done" ? completed : "—"}
            </div>
          </div>
          <div className="text-center">
            <span className="text-[10px] text-muted-foreground">失敗</span>
            <div className={`font-mono text-2xl font-bold tabular-nums ${
              isActive || state === "done" ? "text-red-400" : "text-zinc-700"
            }`}>
              {isActive || state === "done" ? failed : "—"}
            </div>
          </div>
        </div>

        {/* 操作ボタン */}
        {state === "idle" && (
          <div className="text-xs text-muted-foreground">秒数を選択</div>
        )}
        {state === "ready" && (
          <>
            <Button size="sm" className="w-full text-xs" onClick={startCountdown}>
              START
            </Button>
            <Button size="sm" variant="ghost" className="text-xs" onClick={resetToIdle}>
              キャンセル
            </Button>
          </>
        )}
        {state === "countdown" && (
          <Button size="sm" variant="ghost" className="text-xs" onClick={resetToIdle}>
            キャンセル
          </Button>
        )}
        {state === "running" && (
          <Button size="sm" variant="ghost" className="text-xs" onClick={resetToIdle}>
            リセット
          </Button>
        )}
        {state === "done" && result && (
          <div className="text-center w-full">
            <div className="text-base font-bold text-purple-400">FINISH!</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
