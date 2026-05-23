import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { ConstantState, ConstantResult } from "../types";

interface ConstantModeProps {
  onScratchInterval: (cb: (intervalMs: number, dir: number) => void) => void;
  offScratchInterval: (cb: (intervalMs: number, dir: number) => void) => void;
  setScrResetMs: (ms: number | null) => void;
  onComplete: (result: ConstantResult) => void;
  bpm: number;
}

const NOTE_DIVS = [4, 8, 16, 32] as const;
type NoteDiv = (typeof NOTE_DIVS)[number];
const THRESHOLD_RATIO = 0.30; // ±30% を許容

function noteDivLabel(d: NoteDiv): string {
  return `${d}分`;
}

export default function ConstantMode({
  onScratchInterval,
  offScratchInterval,
  setScrResetMs,
  onComplete,
  bpm,
}: ConstantModeProps) {
  const [state, setState] = useState<ConstantState>("idle");
  const stateRef = useRef<ConstantState>("idle");

  const [noteDiv, setNoteDiv] = useState<NoteDiv>(16);
  const noteDivRef = useRef<NoteDiv>(16);

  const [useTarget, setUseTarget] = useState(false);
  const useTargetRef = useRef(false);
  const [targetCount, setTargetCount] = useState(50);
  const [targetCountText, setTargetCountText] = useState("50");
  const targetCountRef = useRef(50);

  // 現在 BPM を ref で持ち続ける
  const bpmRef = useRef(bpm);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);

  // 達成カウント・平均
  const achievedRef = useRef(0);
  const [achieved, setAchieved] = useState(0);
  const intervalsRef = useRef<number[]>([]);
  const [lastInterval, setLastInterval] = useState<number | null>(null);

  const [result, setResult] = useState<ConstantResult | null>(null);

  const targetIntervalMs = () => 60000 / bpmRef.current / (noteDivRef.current / 4);

  const stop = useCallback((failedIntervalMs: number | null, failedDeviationMs: number | null, success: boolean) => {
    stateRef.current = "done";
    setState("done");
    setScrResetMs(null); // 既定値に戻す

    const target = targetIntervalMs();
    const avg = intervalsRef.current.length > 0
      ? Math.round(intervalsRef.current.reduce((s, v) => s + v, 0) / intervalsRef.current.length)
      : null;

    const r: ConstantResult = {
      date: new Date().toISOString(),
      bpm: bpmRef.current,
      noteDivision: noteDivRef.current,
      targetIntervalMs: Math.round(target),
      targetCount: useTargetRef.current ? targetCountRef.current : null,
      achievedCount: achievedRef.current,
      success,
      failedIntervalMs,
      failedDeviationMs,
      avgIntervalMs: avg,
    };
    setResult(r);
    onComplete(r);
  }, [onComplete, setScrResetMs]);

  // interval 受信ハンドラ
  const onInterval = useCallback((intervalMs: number, _dir: number) => {
    if (stateRef.current !== "ready" && stateRef.current !== "running") return;
    if (stateRef.current === "ready") {
      stateRef.current = "running";
      setState("running");
    }

    const target = targetIntervalMs();
    const deviation = intervalMs - target;
    const ratio = Math.abs(deviation) / target;

    setLastInterval(intervalMs);

    if (ratio > THRESHOLD_RATIO) {
      // 失敗
      stop(intervalMs, Math.round(deviation), false);
      return;
    }

    // 成功 interval
    achievedRef.current += 1;
    setAchieved(achievedRef.current);
    intervalsRef.current.push(intervalMs);

    if (useTargetRef.current && achievedRef.current >= targetCountRef.current) {
      stop(null, null, true);
    }
  }, [stop]);

  useEffect(() => {
    onScratchInterval(onInterval);
    return () => offScratchInterval(onInterval);
  }, [onScratchInterval, offScratchInterval, onInterval]);

  const start = () => {
    achievedRef.current = 0;
    setAchieved(0);
    intervalsRef.current = [];
    setLastInterval(null);
    setResult(null);
    stateRef.current = "ready";
    setState("ready");
    // slow tempo でも SCR_RESET で中断されないよう、reset 閾値を target*2 + 余裕に設定
    const target = targetIntervalMs();
    setScrResetMs(Math.max(500, Math.round(target * 2.5)));
  };

  const reset = () => {
    stateRef.current = "idle";
    setState("idle");
    achievedRef.current = 0;
    setAchieved(0);
    intervalsRef.current = [];
    setLastInterval(null);
    setResult(null);
    setScrResetMs(null);
  };

  const target = targetIntervalMs();
  const targetStr = `${target.toFixed(1)}ms`;

  return (
    <Card className={`h-fit shrink-0 w-[200px] ${state === "running" ? "border-blue-500/50 shadow-[0_0_8px_rgba(59,130,246,0.2)]" : ""}`}>
      <CardHeader className="pb-2 pt-3 px-3">
        <CardTitle className="text-xs text-muted-foreground">Constant</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 flex flex-col gap-2">
        {/* 音符選択 */}
        <div className="flex gap-1">
          {NOTE_DIVS.map(d => (
            <Button
              key={d}
              size="sm"
              variant={noteDiv === d ? "default" : "outline"}
              className="text-[10px] h-7 px-2 flex-1"
              disabled={state === "ready" || state === "running"}
              onClick={() => {
                setNoteDiv(d);
                noteDivRef.current = d;
              }}
            >
              {noteDivLabel(d)}
            </Button>
          ))}
        </div>

        {/* 目標枚数 */}
        <div className="flex items-center gap-2 border-t border-border pt-2">
          <Checkbox
            id="constant-use-target"
            checked={useTarget}
            disabled={state === "ready" || state === "running"}
            onCheckedChange={(checked) => {
              const on = !!checked;
              setUseTarget(on);
              useTargetRef.current = on;
            }}
          />
          <Label htmlFor="constant-use-target" className="text-xs cursor-pointer">目標</Label>
          <input
            type="number"
            min={1}
            max={9999}
            value={targetCountText}
            disabled={!useTarget || state === "ready" || state === "running"}
            onChange={(e) => {
              setTargetCountText(e.target.value);
              const v = parseInt(e.target.value);
              if (!isNaN(v) && v >= 1) {
                setTargetCount(v);
                targetCountRef.current = v;
              }
            }}
            onBlur={(e) => {
              const v = parseInt(e.target.value);
              const resolved = (!isNaN(v) && v >= 1) ? Math.min(9999, v) : 50;
              setTargetCount(resolved);
              targetCountRef.current = resolved;
              setTargetCountText(String(resolved));
            }}
            className="w-14 bg-input border border-border text-foreground font-mono text-xs px-1.5 py-0.5 rounded disabled:opacity-50"
          />
          <span className="text-xs text-muted-foreground">枚</span>
        </div>

        {/* Start/Reset */}
        {state === "idle" || state === "done" ? (
          <Button size="sm" variant="default" className="text-xs h-7" onClick={start}>
            Start
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={reset}>
            Reset
          </Button>
        )}

        {/* 進行中表示 */}
        {(state === "ready" || state === "running") && (
          <div className="flex flex-col gap-1 border-t border-border pt-2">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">目標</span>
              <span className="tabular-nums">{targetStr}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">連続</span>
              <span className="text-sm font-bold tabular-nums text-yellow-300">
                {achieved}{useTarget ? ` / ${targetCount}` : ""}
              </span>
            </div>
            {lastInterval !== null && (
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">直前</span>
                <span className="tabular-nums">{lastInterval}ms</span>
              </div>
            )}
            {state === "ready" && (
              <span className="text-xs text-muted-foreground animate-pulse text-center">入力で開始</span>
            )}
          </div>
        )}

        {/* 結果表示 */}
        {state === "done" && result && (
          <div className="flex flex-col gap-1 border-t border-border pt-2">
            {result.success ? (
              <div className="text-sm font-bold text-green-400 text-center">CLEAR!</div>
            ) : (
              <div className="text-sm font-bold text-red-400 text-center">FAILED</div>
            )}
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">音符</span>
              <span className="tabular-nums">{noteDivLabel(result.noteDivision)} ({result.targetIntervalMs}ms)</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">達成</span>
              <span className="tabular-nums text-yellow-300">{result.achievedCount}枚</span>
            </div>
            {result.avgIntervalMs !== null && (
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">平均</span>
                <span className="tabular-nums">{result.avgIntervalMs}ms</span>
              </div>
            )}
            {!result.success && result.failedIntervalMs !== null && result.failedDeviationMs !== null && (
              <div className="flex flex-col gap-0.5 mt-1 pt-1 border-t border-border">
                <span className="text-[10px] text-muted-foreground">失敗時</span>
                <span className="text-xs tabular-nums">
                  {result.failedIntervalMs}ms
                  <span className={result.failedDeviationMs > 0 ? "text-orange-400 ml-2" : "text-cyan-400 ml-2"}>
                    ({result.failedDeviationMs > 0 ? "+" : ""}{result.failedDeviationMs}ms / {result.failedDeviationMs > 0 ? "遅" : "速"})
                  </span>
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
