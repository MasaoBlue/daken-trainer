import type { LaneDef } from "./types";

// ---- Canvas定数 -----------------------------------------------------------

export const CANVAS_H = 600;
export const HEADER_H = 40;
export const AXIS_TIMEOUT = 150;
export const SCR_RESET_MS = 500;
export const SPAN_RETAIN = 600000;
export const CHART_BAR_W = 10;
export const CHART_W = 570;
export const CHART_H = 160;
export const CHART_PAD_L = 30;
export const GREEN_NUM_DEFAULT = 1000;

// ---- localStorageキー（マイグレーション用に残す） -------------------------

export const STORAGE_KEY = "daken-trainer-keyconfig";
export const BPM_STORAGE_KEY = "daken-trainer-bpm";
export const SCR_ORIGIN_STORAGE_KEY = "daken-trainer-scr-origin";
export const GRID_MODE_STORAGE_KEY = "daken-trainer-grid-mode";
export const METRO_ON_KEY = "daken-trainer-metro-on";
export const METRO_DIV_KEY = "daken-trainer-metro-div";
export const METRO_VOL_KEY = "daken-trainer-metro-vol";
export const SIDE_KEY = "daken-trainer-side";
export const CLAP_ON_KEY = "daken-trainer-clap-on";
export const GREEN_NUM_STORAGE_KEY = "daken-trainer-green-num";

// ---- レーン定義 -----------------------------------------------------------

export const LANE_DEFS: LaneDef[] = [
  { id: "SCR",  label: "Scratch", w: 90,  noteColor: "#4f8", axisColorPos: "#4f8", axisColorNeg: "#fa4" },
  { id: "KEY1", label: "1",   w: 52,  noteColor: "#eee" },
  { id: "KEY2", label: "2",   w: 40,  noteColor: "#48f" },
  { id: "KEY3", label: "3",   w: 52,  noteColor: "#eee" },
  { id: "KEY4", label: "4",   w: 40,  noteColor: "#48f" },
  { id: "KEY5", label: "5",   w: 52,  noteColor: "#eee" },
  { id: "KEY6", label: "6",   w: 40,  noteColor: "#48f" },
  { id: "KEY7", label: "7",   w: 52,  noteColor: "#eee" },
];

// ---- キーコンフィグUI定義 --------------------------------------------------

export const KEY_DEFS = [
  { id: "KEY1", label: "1", black: false },
  { id: "KEY2", label: "2", black: true  },
  { id: "KEY3", label: "3", black: false },
  { id: "KEY4", label: "4", black: true  },
  { id: "KEY5", label: "5", black: false },
  { id: "KEY6", label: "6", black: true  },
  { id: "KEY7", label: "7", black: false },
];
