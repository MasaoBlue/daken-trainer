// ---- 入力イベント型 --------------------------------------------------------

export type InputEvent =
  | { kind: "ButtonDown"; source: string; id: string; t: number }
  | { kind: "ButtonUp";   source: string; id: string; t: number }
  | { kind: "AxisMove";   source: string; id: string; direction: number; value: number; t: number };

export interface Binding {
  source: string;
  id: string;
  direction?: number;
}

export type KeyConfig = Record<string, Binding | null>;

export interface Span {
  start: number;
  end: number | null;
  direction?: number;
  rustT?: number;
}

export interface Channel {
  id: string;
  source: string;
  kind: "button" | "axis";
  spans: Span[];
}

export interface LaneDef {
  id: string;
  label: string;
  w: number;
  noteColor: string;
  axisColorPos?: string;
  axisColorNeg?: string;
}

export type GridMode = "time" | "bpm" | "scr";

export type PlaybackMode = "live" | "paused" | "playing";

export interface ScrInfo {
  count: number;
  intervalMs: number | null;
  estimatedBpm: number | null;
  offsetMs: number | null;
  noteDivision: string | null;
  avgIntervalMs: number | null;
  avgNoteDivision: string | null;
}

export interface IntervalEntry {
  ms: number;
  dir: number;
}

export type ChallengeState = "idle" | "ready" | "running" | "done";

export interface ChallengeResult {
  count: number;
  duration: number;
  avgMs: number | null;
  noteDivision: string | null;
}

// ---- ドリルモード型 --------------------------------------------------------

export type DrillState = "idle" | "ready" | "countdown" | "running" | "done";

export interface DrillResult {
  date: string;
  duration: number;
  completedChains: number;
  failedChains: number;
}

// ---- 連打モード型 ----------------------------------------------------------

export type RapidPressState = "idle" | "ready" | "running" | "done";

export interface RapidPressResult {
  date: string;
  duration: number;
  pressCount: number;
  keyLabel: string;
}

// ---- Constant モード型 ----------------------------------------------------

export type ConstantState = "idle" | "ready" | "running" | "done";

export interface ConstantResult {
  date: string;
  bpm: number;
  noteDivision: 8 | 12 | 16 | 24 | 32;
  targetIntervalMs: number;
  targetCount: number | null;     // null = 無限モード
  achievedCount: number;          // 成功した枚数
  success: boolean;               // targetCount を達成したか
  endReason: "success" | "deviation" | "timeout"; // 終了理由
  failedIntervalMs: number | null; // 失敗した interval (deviation 時のみ)
  failedDeviationMs: number | null; // target からのズレ (符号: + 遅すぎ / - 速すぎ)
  avgIntervalMs: number | null;   // 成功 interval の平均
}

// ---- 設定型 ----------------------------------------------------------------

export type AppMode = "free" | "challenge" | "drill" | "constant";

export interface AppConfig {
  version: number;
  input: {
    keyConfig: KeyConfig;
    phoenixWan: boolean;
  };
  display: {
    side: "1P" | "2P";
    greenNum: number;
    gridMode: GridMode;
    // BPM / Scratch基点 グリッド時の補助線間隔 (4=4分, 8=8分, 16=16分)
    gridSubdivision: 4 | 8 | 16;
    chartScale: "log" | "linear";
  };
  tempo: {
    bpm: number;
    metronome: {
      on: boolean;
      div: 4 | 8;
      vol: number;
    };
  };
  scratch: {
    clapOn: boolean;
    resetMs: number; // 連皿しきい値 (ms)。500/400/300 から選択
  };
  modes: {
    current: AppMode;
    // 各モード固有設定 (将来拡張枠として常設)
    challenge: Record<string, never>;
    constant: {
      thresholdRatio: number; // 許容比率 (0.10〜0.50、0.10刻み)
    };
    drill: Record<string, never>;
  };
}

// ---- 記録型 ----------------------------------------------------------------

export interface ChallengeRecord {
  date: string;
  duration: number;
  scratchCount: number;
  avgIntervalMs: number | null;
  bpm: number;
  noteDivision: string | null;
}

export interface DailyCount {
  totalScratches: number;
  totalKeyPresses: number;
}

export interface AppRecords {
  version: number;
  challengeRecords: ChallengeRecord[];
  drillRecords: DrillResult[];
  rapidPressRecords: RapidPressResult[];
  constantRecords: ConstantResult[];
  dailyCounts: Record<string, DailyCount>;
}
