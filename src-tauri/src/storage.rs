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
        "keyConfig": {},
        "bpm": 150,
        "greenNum": 1000,
        "gridMode": "time",
        "metronome": {
            "on": false,
            "div": 4,
            "vol": 0.5
        },
        "side": "1P",
        "clapOn": true,
        "scrOriginWallMs": null
    })
}

pub fn default_records() -> Value {
    json!({
        "version": 1,
        "challengeRecords": [],
        "drillRecords": [],
        "rapidPressRecords": [],
        "dailyCounts": {}
    })
}

/// Migrate config from older versions to the current version.
/// Currently version 1 is the latest, so this is a no-op.
pub fn migrate_config(mut value: Value) -> Value {
    let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);

    // v0 (no version field) -> v1
    if version < 1 {
        value["version"] = json!(1);
        // Ensure all required fields exist with defaults
        let defaults = default_config();
        if let (Some(val_obj), Some(def_obj)) = (value.as_object_mut(), defaults.as_object()) {
            for (key, def_val) in def_obj {
                if !val_obj.contains_key(key) {
                    val_obj.insert(key.clone(), def_val.clone());
                }
            }
        }
    }

    // Future migrations: v1 -> v2, v2 -> v3, etc.

    value
}

/// Migrate records from older versions to the current version.
pub fn migrate_records(mut value: Value) -> Value {
    let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);

    if version < 1 {
        value["version"] = json!(1);
        let defaults = default_records();
        if let (Some(val_obj), Some(def_obj)) = (value.as_object_mut(), defaults.as_object()) {
            for (key, def_val) in def_obj {
                if !val_obj.contains_key(key) {
                    val_obj.insert(key.clone(), def_val.clone());
                }
            }
        }
    }

    value
}
