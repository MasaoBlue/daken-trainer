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
