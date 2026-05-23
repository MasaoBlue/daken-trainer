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
        "version": 6,
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
        "scrOriginWallMs": null,
        "phoenixWan": false,
        "chartScale": "linear",
        "scrResetMs": 500,
        "appMode": "free",
        "constantThresholdRatio": 0.30
    })
}

pub fn default_records() -> Value {
    json!({
        "version": 2,
        "challengeRecords": [],
        "drillRecords": [],
        "rapidPressRecords": [],
        "constantRecords": [],
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

    // v1 -> v2: add phoenixWan flag
    if version < 2 {
        value["version"] = json!(2);
        if let Some(val_obj) = value.as_object_mut() {
            if !val_obj.contains_key("phoenixWan") {
                val_obj.insert("phoenixWan".to_string(), json!(false));
            }
        }
    }

    // v2 -> v3: add chartScale
    if version < 3 {
        value["version"] = json!(3);
        if let Some(val_obj) = value.as_object_mut() {
            if !val_obj.contains_key("chartScale") {
                val_obj.insert("chartScale".to_string(), json!("linear"));
            }
        }
    }

    // v3 -> v4: add scrResetMs
    if version < 4 {
        value["version"] = json!(4);
        if let Some(val_obj) = value.as_object_mut() {
            if !val_obj.contains_key("scrResetMs") {
                val_obj.insert("scrResetMs".to_string(), json!(500));
            }
        }
    }

    // v4 -> v5: add appMode
    if version < 5 {
        value["version"] = json!(5);
        if let Some(val_obj) = value.as_object_mut() {
            if !val_obj.contains_key("appMode") {
                val_obj.insert("appMode".to_string(), json!("free"));
            }
        }
    }

    // v5 -> v6: add constantThresholdRatio
    if version < 6 {
        value["version"] = json!(6);
        if let Some(val_obj) = value.as_object_mut() {
            if !val_obj.contains_key("constantThresholdRatio") {
                val_obj.insert("constantThresholdRatio".to_string(), json!(0.30));
            }
        }
    }

    // Future migrations: v6 -> v7, etc.

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

    // v1 -> v2: add constantRecords
    if version < 2 {
        value["version"] = json!(2);
        if let Some(val_obj) = value.as_object_mut() {
            if !val_obj.contains_key("constantRecords") {
                val_obj.insert("constantRecords".to_string(), json!([]));
            }
        }
    }

    value
}
