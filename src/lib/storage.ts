import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, AppRecords } from "../types";

// ---- 設定ファイル読み書き ---------------------------------------------------

export async function readConfig(): Promise<AppConfig> {
  const json = await invoke<string>("read_config");
  return JSON.parse(json) as AppConfig;
}

export async function writeConfig(config: AppConfig): Promise<void> {
  await invoke("write_config", { json: JSON.stringify(config) });
}

// ---- 記録ファイル読み書き ---------------------------------------------------

export async function readRecords(): Promise<AppRecords> {
  const json = await invoke<string>("read_records");
  return JSON.parse(json) as AppRecords;
}

export async function writeRecords(records: AppRecords): Promise<void> {
  await invoke("write_records", { json: JSON.stringify(records) });
}

// ---- エクスポート -----------------------------------------------------------

export async function exportRecords(path: string): Promise<void> {
  await invoke("export_records", { path });
}

export async function getAppDataDir(): Promise<string> {
  return await invoke<string>("get_app_data_dir");
}

// ---- localStorageマイグレーション -------------------------------------------

export function migrateFromLocalStorage(): AppConfig | null {
  const STORAGE_KEY = "daken-trainer-keyconfig";
  const keyConfigRaw = localStorage.getItem(STORAGE_KEY);

  // localStorageに何もなければマイグレーション不要
  if (keyConfigRaw === null && localStorage.getItem("daken-trainer-bpm") === null) {
    return null;
  }

  let keyConfig = {};
  try {
    keyConfig = JSON.parse(keyConfigRaw ?? "{}");
  } catch {
    keyConfig = {};
  }

  const parseIntSafe = (key: string, def: number): number => {
    const v = parseInt(localStorage.getItem(key) ?? "");
    return isNaN(v) ? def : v;
  };
  const parseFloatSafe = (key: string, def: number): number => {
    const v = parseFloat(localStorage.getItem(key) ?? "");
    return isNaN(v) ? def : v;
  };

  const gridMode = localStorage.getItem("daken-trainer-grid-mode");
  const scrOriginRaw = localStorage.getItem("daken-trainer-scr-origin");

  const config: AppConfig = {
    version: 1,
    keyConfig,
    bpm: parseIntSafe("daken-trainer-bpm", 150),
    greenNum: Math.max(100, Math.min(3000, parseIntSafe("daken-trainer-green-num", 1000))),
    gridMode: (gridMode === "bpm" || gridMode === "scr") ? gridMode : "time",
    metronome: {
      on: localStorage.getItem("daken-trainer-metro-on") === "1",
      div: localStorage.getItem("daken-trainer-metro-div") === "8" ? 8 : 4,
      vol: Math.max(0, Math.min(1, parseFloatSafe("daken-trainer-metro-vol", 0.5))),
    },
    side: localStorage.getItem("daken-trainer-side") === "2P" ? "2P" : "1P",
    clapOn: localStorage.getItem("daken-trainer-clap-on") !== "0",
    scrOriginWallMs: scrOriginRaw ? parseFloat(scrOriginRaw) : null,
  };

  return config;
}

export function clearLocalStorage(): void {
  const keys = [
    "daken-trainer-keyconfig",
    "daken-trainer-bpm",
    "daken-trainer-scr-origin",
    "daken-trainer-grid-mode",
    "daken-trainer-metro-on",
    "daken-trainer-metro-div",
    "daken-trainer-metro-vol",
    "daken-trainer-side",
    "daken-trainer-clap-on",
    "daken-trainer-green-num",
  ];
  for (const key of keys) {
    localStorage.removeItem(key);
  }
}
