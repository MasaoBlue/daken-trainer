use gilrs::{Axis, Button, EventType, Gilrs};
use multiinput::{KeyId, RawEvent, RawInputManager, State};
use rodio::{OutputStream, Sink, Source};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ---- 音再生 ----------------------------------------------------------------
// スレッドを毎回立てず、専用スレッドに周波数を送るだけにする

fn spawn_audio_thread() -> mpsc::SyncSender<f32> {
    // バッファ 64 個。溢れたら古いリクエストは捨てる (sync_channel で send がノンブロッキングに近い)
    let (tx, rx) = mpsc::sync_channel::<f32>(64);

    std::thread::spawn(move || {
        // OutputStream はスレッドローカルで一度だけ確保
        let Ok((_stream, handle)) = OutputStream::try_default() else {
            eprintln!("audio: OutputStream init failed");
            return;
        };
        let Ok(sink) = Sink::try_new(&handle) else {
            eprintln!("audio: Sink init failed");
            return;
        };

        for freq in rx {
            // キューが溜まりすぎている場合は古いものを破棄して追いつく
            if sink.len() > 4 {
                sink.clear();
            }
            let source = rodio::source::SineWave::new(freq)
                .take_duration(Duration::from_millis(200))
                .amplify(0.4);
            sink.append(source);
        }
    });

    tx
}

// ---- イベント型 (フロントエンドに送信) ------------------------------------

#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
enum InputEvent {
    ButtonDown {
        source: String,
        id: String,
        t: f64,
    },
    ButtonUp {
        source: String,
        id: String,
        t: f64,
    },
    AxisMove {
        source: String,
        id: String,
        direction: i8,
        value: f32,
        t: f64,
    },
}

// ---- キーボードリスナー ----------------------------------------------------

fn start_keyboard_listener(app: AppHandle, epoch: Instant, audio_tx: mpsc::SyncSender<f32>) {
    let key_freqs: HashMap<KeyId, f32> = [
        (KeyId::A, 440.0),
        (KeyId::Q, 330.0),
        (KeyId::W, 550.0),
    ]
    .into();

    std::thread::spawn(move || {
        let Ok(mut manager) = RawInputManager::new() else {
            eprintln!("RawInputManager init failed");
            return;
        };
        manager.register_devices(multiinput::DeviceType::Keyboards);

        loop {
            if let Some(event) = manager.get_event() {
                let t = epoch.elapsed().as_secs_f64() * 1000.0;
                match event {
                    RawEvent::KeyboardEvent(_, key_id, State::Pressed) => {
                        if let Some(&freq) = key_freqs.get(&key_id) {
                            let _ = audio_tx.try_send(freq);
                        }
                        let _ = app.emit(
                            "input-event",
                            InputEvent::ButtonDown {
                                source: "keyboard".into(),
                                id: format!("{:?}", key_id),
                                t,
                            },
                        );
                    }
                    RawEvent::KeyboardEvent(_, key_id, State::Released) => {
                        let _ = app.emit(
                            "input-event",
                            InputEvent::ButtonUp {
                                source: "keyboard".into(),
                                id: format!("{:?}", key_id),
                                t,
                            },
                        );
                    }
                    _ => {}
                }
            }
        }
    });
}

// ---- ゲームパッドリスナー --------------------------------------------------

fn start_gamepad_listener(app: AppHandle, epoch: Instant, audio_tx: mpsc::SyncSender<f32>) {
    let button_freqs: HashMap<Button, f32> = [
        (Button::South,        261.6),
        (Button::East,         293.7),
        (Button::North,        329.6),
        (Button::West,         349.2),
        (Button::LeftTrigger,  392.0),
        (Button::RightTrigger, 440.0),
        (Button::Select,       493.9),
    ]
    .into();

    let mut prev_axis: HashMap<Axis, f32> = HashMap::new();
    const AXIS_DEAD: f32 = 0.02;

    std::thread::spawn(move || {
        let Ok(mut gilrs) = Gilrs::new() else {
            eprintln!("gilrs init failed");
            return;
        };

        loop {
            while let Some(gilrs::Event { event, .. }) = gilrs.next_event() {
                let t = epoch.elapsed().as_secs_f64() * 1000.0;

                match event {
                    EventType::ButtonPressed(btn, _) => {
                        if let Some(&freq) = button_freqs.get(&btn) {
                            let _ = audio_tx.try_send(freq);
                        }
                        let _ = app.emit(
                            "input-event",
                            InputEvent::ButtonDown {
                                source: "gamepad".into(),
                                id: format!("{:?}", btn),
                                t,
                            },
                        );
                    }
                    EventType::ButtonReleased(btn, _) => {
                        let _ = app.emit(
                            "input-event",
                            InputEvent::ButtonUp {
                                source: "gamepad".into(),
                                id: format!("{:?}", btn),
                                t,
                            },
                        );
                    }
                    EventType::AxisChanged(axis, value, _) => {
                        let prev = *prev_axis.get(&axis).unwrap_or(&0.0);
                        let delta = value - prev;
                        if delta.abs() > AXIS_DEAD {
                            let direction: i8 = if delta > 0.0 { 1 } else { -1 };
                            let freq = if direction > 0 { 600.0 } else { 500.0 };
                            let _ = audio_tx.try_send(freq);
                            let _ = app.emit(
                                "input-event",
                                InputEvent::AxisMove {
                                    source: "gamepad".into(),
                                    id: format!("{:?}", axis),
                                    direction,
                                    value,
                                    t,
                                },
                            );
                        }
                        prev_axis.insert(axis, value);
                    }
                    _ => {}
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    });
}

// ---- Tauri エントリポイント ------------------------------------------------

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let epoch = Instant::now();
    let audio_tx = spawn_audio_thread();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(move |app| {
            start_keyboard_listener(app.handle().clone(), epoch, audio_tx.clone());
            start_gamepad_listener(app.handle().clone(), epoch, audio_tx);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
