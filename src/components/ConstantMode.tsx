import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { ConstantState, ConstantResult } from "../types";

interface ConstantModeProps {
  // 任意レーンの最初の入力を検出 (ready→running 遷移用)
  onAnyInput: (cb: (laneId: string, nowJs: number) => void) => void;
  offAnyInput: (cb: (laneId: string, nowJs: number) => void) => void;
  // graphLane の interval / session reset 通知
  onGraphLaneInterval: (cb: (intervalMs: number, dir: number) => void) => void;
  offGraphLaneInterval: (cb: (intervalMs: number, dir: number) => void) => void;
  onGraphLaneReset: (cb: (finalCount: number) => void) => void;
  offGraphLaneReset: (cb: (finalCount: number) => void) => void;
  // 検出されたレーンに graphLane を切り替える
  switchGraphLane: (laneId: string) => void;
  setScrResetMs: (ms: number | null) => void;
  onComplete: (result: ConstantResult) => void;
  onNoteDivChange?: (div: 8 | 12 | 16 | 24 | 32) => void;
  onThresholdRatioChange?: (ratio: number) => void;
  initialThresholdRatio?: number;
  bpm: number;
}

const NOTE_DIVS = [8, 12, 16, 24, 32] as const;
type NoteDiv = (typeof NOTE_DIVS)[number];
const THRESHOLD_RATIOS = [0.10, 0.20, 0.30, 0.40, 0.50] as const;

function noteDivLabel(d: NoteDiv): string {
  return `${d}分`;
}

export default function ConstantMode({
  onAnyInput,
  offAnyInput,
  onGraphLaneInterval,
  offGraphLaneInterval,
  onGraphLaneReset,
  offGraphLaneReset,
  switchGraphLane,
  setScrResetMs,
  onComplete,
  onNoteDivChange,
  onThresholdRatioChange,
  initialThresholdRatio = 0.30,
  bpm,
}: ConstantModeProps) {
  const [state, setState] = useState<ConstantState>("idle");
  const stateRef = useRef<ConstantState>("idle");

  const [noteDiv, setNoteDiv] = useState<NoteDiv>(16);
  const noteDivRef = useRef<NoteDiv>(16);

  const [thresholdRatio, setThresholdRatio] = useState<number>(initialThresholdRatio);
  const thresholdRatioRef = useRef<number>(initialThresholdRatio);

  const [useTarget, setUseTarget] = useState(false);
  const useTargetRef = useRef(false);
  const [targetCount, setTargetCount] = useState(16);
  const [targetCountText, setTargetCountText] = useState("16");
  const targetCountRef = useRef(16);

  // 現在 BPM を ref で持ち続ける
  const bpmRef = useRef(bpm);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);

  // マウント時 + noteDiv 変更時に親へ通知 (App.tsx でグラフ Y軸 range の計算に利用)
  // callback は意図的に deps から除外: 親が inline arrow を渡しても無限ループしないように
  useEffect(() => {
    onNoteDivChange?.(noteDiv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteDiv]);

  // マウント時 + ratio 変更時に親へ通知
  useEffect(() => {
    onThresholdRatioChange?.(thresholdRatio);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thresholdRatio]);

  // 達成カウント・平均
  const achievedRef = useRef(0);
  const [achieved, setAchieved] = useState(0);
  const intervalsRef = useRef<number[]>([]);
  const [avgInterval, setAvgInterval] = useState<number | null>(null);

  const [result, setResult] = useState<ConstantResult | null>(null);

  const targetIntervalMs = () => 60000 / bpmRef.current / (noteDivRef.current / 4);

  const stop = useCallback((endReason: "success" | "deviation" | "timeout", failedIntervalMs: number | null, failedDeviationMs: number | null) => {
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
      success: endReason === "success",
      endReason,
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

    if (ratio > thresholdRatioRef.current) {
      // 失敗 (ズレ過大)
      stop("deviation", intervalMs, Math.round(deviation));
      return;
    }

    // 成功 interval
    achievedRef.current += 1;
    setAchieved(achievedRef.current);
    intervalsRef.current.push(intervalMs);
    const sum = intervalsRef.current.reduce((s, v) => s + v, 0);
    setAvgInterval(Math.round(sum / intervalsRef.current.length));

    if (useTargetRef.current && achievedRef.current >= targetCountRef.current) {
      stop("success", null, null);
    }
  }, [stop]);

  // graphLane の入力が途切れたら timeout として停止
  const onReset = useCallback(() => {
    if (stateRef.current === "running") {
      stop("timeout", null, null);
    }
  }, [stop]);
  useEffect(() => {
    onGraphLaneReset(onReset);
    return () => offGraphLaneReset(onReset);
  }, [onGraphLaneReset, offGraphLaneReset, onReset]);

  useEffect(() => {
    onGraphLaneInterval(onInterval);
    return () => offGraphLaneInterval(onInterval);
  }, [onGraphLaneInterval, offGraphLaneInterval, onInterval]);

  const start = useCallback(() => {
    achievedRef.current = 0;
    setAchieved(0);
    intervalsRef.current = [];
    setAvgInterval(null);
    setResult(null);
    stateRef.current = "ready";
    setState("ready");
    // slow tempo でも SCR_RESET で中断されないよう、reset 閾値を target*2 + 余裕に設定
    const target = targetIntervalMs();
    setScrResetMs(Math.max(500, Math.round(target * 2.5)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setScrResetMs]);

  // ready 中に任意レーンの最初の入力が来たらそのレーンに graphLane を切替して running へ
  const onFirstInput = useCallback((laneId: string, _nowJs: number) => {
    // done 中なら自動で次の run を開始 (state は ready に戻る)
    if (stateRef.current === "done") {
      start();
    }
    if (stateRef.current === "ready") {
      switchGraphLane(laneId);
      stateRef.current = "running";
      setState("running");
      achievedRef.current = 1;
      setAchieved(1);
    }
  }, [start, switchGraphLane]);
  useEffect(() => {
    onAnyInput(onFirstInput);
    return () => offAnyInput(onFirstInput);
  }, [onAnyInput, offAnyInput, onFirstInput]);

  const reset = () => {
    stateRef.current = "idle";
    setState("idle");
    achievedRef.current = 0;
    setAchieved(0);
    intervalsRef.current = [];
    setAvgInterval(null);
    setResult(null);
    setScrResetMs(null);
  };

  // 表示用 target は state / props 直参照で常に最新を反映
  const targetForDisplay = bpm > 0 ? 60000 / bpm / (noteDiv / 4) : 0;
  const targetStr = bpm > 0 ? `${targetForDisplay.toFixed(1)}ms` : "—";

  return (
    <Card className={`h-fit shrink-0 w-[160px] ${state === "running" ? "border-blue-500/50 shadow-[0_0_8px_rgba(59,130,246,0.2)]" : ""}`}>
      <CardHeader className="pb-2 pt-3 px-3">
        <CardTitle className="text-xs text-muted-foreground">Constant</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 flex flex-col gap-2">
        {/* 間隔 */}
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">間隔</Label>
          <Select
            value={String(noteDiv)}
            disabled={state === "ready" || state === "running"}
            onValueChange={(v) => {
              const d = parseInt(v) as NoteDiv;
              if (!NOTE_DIVS.includes(d as typeof NOTE_DIVS[number])) return;
              setNoteDiv(d);
              noteDivRef.current = d;
            }}
          >
            <SelectTrigger className="h-7 w-20 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTE_DIVS.map(d => (
                <SelectItem key={d} value={String(d)} className="text-xs">{noteDivLabel(d)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 許容 */}
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">許容</Label>
          <Select
            value={String(thresholdRatio)}
            disabled={state === "ready" || state === "running"}
            onValueChange={(v) => {
              const r = parseFloat(v);
              if (isNaN(r)) return;
              setThresholdRatio(r);
              thresholdRatioRef.current = r;
            }}
          >
            <SelectTrigger className="h-7 w-20 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THRESHOLD_RATIOS.map(r => (
                <SelectItem key={r} value={String(r)} className="text-xs">±{Math.round(r * 100)}%</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 目標枚数 */}
        <div className="flex items-center gap-2">
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
              const resolved = (!isNaN(v) && v >= 1) ? Math.min(9999, v) : 16;
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

        {/* 常時表示: 枚数 / 目標 / 平均 */}
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <div className="flex justify-between">
            <span className="text-xs text-muted-foreground">枚数</span>
            <span className={`text-sm font-bold tabular-nums ${achieved > 0 ? "text-yellow-300" : "text-muted"}`}>
              {achieved > 0 ? `${achieved}${useTarget ? ` / ${targetCount}` : ""}` : "—"}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">目標</span>
            <span className="tabular-nums">{targetStr}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">平均</span>
            <span className="tabular-nums">{avgInterval !== null ? `${avgInterval}ms` : "—"}</span>
          </div>
          {state === "ready" && (
            <span className="text-xs text-muted-foreground animate-pulse text-center">入力で開始</span>
          )}
        </div>

        {/* 結果表示 */}
        {state === "done" && result && (
          <div className="flex flex-col gap-1 border-t border-border pt-2">
            {result.endReason === "success" ? (
              <div className="text-sm font-bold text-green-400 text-center">CLEAR!</div>
            ) : result.endReason === "deviation" ? (
              <div className="text-sm font-bold text-red-400 text-center">FAILED</div>
            ) : (
              <div className="text-sm font-bold text-orange-400 text-center">STOPPED</div>
            )}
            {result.endReason === "deviation" && result.failedDeviationMs !== null && (
              <div className="flex items-baseline justify-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">{result.achievedCount + 1}枚目</span>
                <span className={`text-sm font-bold tabular-nums ${
                  result.failedDeviationMs < 0 ? "text-blue-400" : "text-red-400"
                }`}>
                  {result.failedDeviationMs < 0 ? "FAST" : "SLOW"} {result.failedDeviationMs > 0 ? "+" : ""}{result.failedDeviationMs}ms
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
