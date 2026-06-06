use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

pub fn ensure_dir(dir: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())
}

pub fn read_json(path: &PathBuf) -> Result<Value, String> {
    if !path.exists() {
        return Err("not_found".to_string());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

pub fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

pub fn default_config() -> Value {
    json!({
        "version": 1,
        "input": {
            "keyConfig": {},
            "phoenixWan": false
        },
        "display": {
            "side": "1P",
            "greenNum": 1000,
            "gridMode": "time",
            "gridSubdivision": 4,
            "chartScale": "linear"
        },
        "tempo": {
            "bpm": 150,
            "metronome": {
                "on": false,
                "div": 4,
                "vol": 0.5
            }
        },
        "scratch": {
            "clapOn": true,
            "resetMs": 500
        },
        "modes": {
            "current": "free",
            "challenge": {},
            "constant": { "thresholdRatio": 0.30 },
            "drill": {}
        }
    })
}

pub fn default_records() -> Value {
    json!({
        "version": 1,
        "challengeRecords": [],
        "drillRecords": [],
        "rapidPressRecords": [],
        "constantRecords": [],
        "dailyCounts": {}
    })
}

/// 設定ファイルのマイグレーションを行う。
/// 正式リリース前なので現状は no-op。将来 v1 → v2 等が必要になったら
/// `if version < 2 { ... }` ブロックをここに追加する。
pub fn migrate_config(value: Value) -> Value {
    value
}

/// 記録ファイルのマイグレーションを行う。現状は no-op。
pub fn migrate_records(value: Value) -> Value {
    value
}
