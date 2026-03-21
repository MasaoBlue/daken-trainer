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

// ---- 設定型 ----------------------------------------------------------------

export interface AppConfig {
  version: number;
  keyConfig: KeyConfig;
  bpm: number;
  greenNum: number;
  gridMode: GridMode;
  metronome: {
    on: boolean;
    div: 4 | 8;
    vol: number;
  };
  side: "1P" | "2P";
  clapOn: boolean;
  scrOriginWallMs: number | null;
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
  dailyCounts: Record<string, DailyCount>;
}
