use gilrs::{Axis, EventType};
use rodio::{Decoder, OutputStream, Sink, Source};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// clap.mp3 をコンパイル時にバイナリ埋め込み
static CLAP_MP3: &[u8] = include_bytes!("../assets/clap.mp3");

// フロントエンドから play_clap コマンド経由で使うグローバル送信端
static AUDIO_TX: OnceLock<mpsc::SyncSender<f32>> = OnceLock::new();

// ---- 音再生 (専用スレッド1本、スレッド増殖なし) ---------------------------

fn spawn_audio_thread() -> mpsc::SyncSender<f32> {
    let (tx, rx) = mpsc::sync_channel::<f32>(64);
    std::thread::spawn(move || {
        let Ok((_stream, handle)) = OutputStream::try_default() else {
            return;
        };
        for _freq in rx {
            let Ok(sink) = Sink::try_new(&handle) else {
                continue;
            };
            // 静的バイト列から毎回デコードして再生（0.3秒で打ち切り）
            if let Ok(source) = Decoder::new(Cursor::new(CLAP_MP3)) {
                sink.append(source.take_duration(Duration::from_millis(300)));
                sink.detach();
            }
        }
    });
    tx
}

// ---- イベント型 ------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
enum InputEvent {
    ButtonDown { source: String, id: String, t: f64 },
    ButtonUp   { source: String, id: String, t: f64 },
    AxisMove   { source: String, id: String, direction: i8, value: f32, t: f64 },
}

// ---- キーボードリスナー (Windows RawInput 直接実装) -----------------------
//
// multiinput 0.1.0 には VecDeque の無制限成長・ハンドルリークが確認されたため
// windows クレートで WM_INPUT を直接受け取る hidden window 方式に置き換え。
// イベントはメッセージループで処理するため外部キューへの蓄積がない。

#[cfg(windows)]
mod raw_keyboard {
    use super::*;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::{
        GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT,
        RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEKEYBOARD,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage,
        RegisterClassW, CS_HREDRAW, CS_VREDRAW, MSG, WM_DESTROY, WM_INPUT, WNDCLASSW,
        WS_OVERLAPPEDWINDOW,
    };

    // WM_INPUT RI_KEY flags
    const RI_KEY_MAKE:  u16 = 0x00; // key down
    const RI_KEY_BREAK: u16 = 0x01; // key up

    // スレッド間でコールバックに渡すためグローバルに持つ
    static mut CALLBACK: Option<Box<dyn Fn(u16, bool) + Send + Sync>> = None;

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_DESTROY {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        if msg == WM_INPUT {
            let mut size: u32 = 0;
            GetRawInputData(
                HRAWINPUT(lparam.0 as *mut _),
                RID_INPUT,
                None,
                &mut size,
                std::mem::size_of::<RAWINPUTHEADER>() as u32,
            );
            if size > 0 {
                let mut buf = vec![0u8; size as usize];
                let read = GetRawInputData(
                    HRAWINPUT(lparam.0 as *mut _),
                    RID_INPUT,
                    Some(buf.as_mut_ptr() as *mut _),
                    &mut size,
                    std::mem::size_of::<RAWINPUTHEADER>() as u32,
                );
                if read == size {
                    let raw = &*(buf.as_ptr() as *const RAWINPUT);
                    if raw.header.dwType == RIM_TYPEKEYBOARD.0 {
                        let kb = &raw.data.keyboard;
                        let vkey  = kb.VKey;
                        let flags = kb.Flags;
                        let is_down = (flags & RI_KEY_BREAK) == RI_KEY_MAKE;
                        if let Some(ref cb) = *(&raw const CALLBACK) {
                            cb(vkey, is_down);
                        }
                    }
                }
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub fn start(app: AppHandle, epoch: Instant, _audio_tx: mpsc::SyncSender<f32>) {
        std::thread::spawn(move || unsafe {
            // コールバックをグローバルに設定
            CALLBACK = Some(Box::new(move |vkey: u16, is_down: bool| {
                let t = epoch.elapsed().as_secs_f64() * 1000.0;
                let id = vkey_name(vkey);
                if is_down {
                    let _ = app.emit("input-event", InputEvent::ButtonDown {
                        source: "keyboard".into(), id, t,
                    });
                } else {
                    let _ = app.emit("input-event", InputEvent::ButtonUp {
                        source: "keyboard".into(), id, t,
                    });
                }
            }));

            let hinstance = GetModuleHandleW(None).unwrap();
            let hinstance_opt: windows::Win32::Foundation::HINSTANCE = hinstance.into();
            let class_name: Vec<u16> = "RawInputWindow\0".encode_utf16().collect();

            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinstance_opt,
                lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
                ..Default::default()
            };
            RegisterClassW(&wc);

            let win_title: Vec<u16> = "RawInput\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                Default::default(),
                windows::core::PCWSTR(class_name.as_ptr()),
                windows::core::PCWSTR(win_title.as_ptr()),
                WS_OVERLAPPEDWINDOW,
                0, 0, 0, 0,
                None, None,
                Some(hinstance_opt),
                None,
            ).unwrap();

            // キーボードデバイスを登録 (RIDEV_INPUTSINK = フォーカス不要)
            let rid = RAWINPUTDEVICE {
                usUsagePage: 0x01, // Generic Desktop
                usUsage:     0x06, // Keyboard
                dwFlags:     RIDEV_INPUTSINK,
                hwndTarget:  hwnd,
            };
            RegisterRawInputDevices(
                std::slice::from_ref(&rid),
                std::mem::size_of::<RAWINPUTDEVICE>() as u32,
            ).unwrap();

            // メッセージループ (ブロッキング、イベントが来たときだけ処理)
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }
        });
    }

    fn vkey_name(vkey: u16) -> String {
        match vkey {
            0x08 => "BS".into(),
            0x09 => "Tab".into(),
            0x0D => "Enter".into(),
            0x10 => "Shift".into(),
            0x11 => "Ctrl".into(),
            0x12 => "Alt".into(),
            0x1B => "Esc".into(),
            0x20 => "Space".into(),
            0x21 => "PgUp".into(),
            0x22 => "PgDn".into(),
            0x23 => "End".into(),
            0x24 => "Home".into(),
            0x25 => "←".into(),
            0x26 => "↑".into(),
            0x27 => "→".into(),
            0x28 => "↓".into(),
            0x2E => "Del".into(),
            0x30..=0x39 => ((b'0' + (vkey - 0x30) as u8) as char).to_string(),
            0x41..=0x5A => ((b'A' + (vkey - 0x41) as u8) as char).to_string(),
            0x60..=0x69 => format!("Num{}", vkey - 0x60),
            0x70..=0x87 => format!("F{}", vkey - 0x6F),
            0xBA => ";".into(),
            0xBB => "=".into(),
            0xBC => ",".into(),
            0xBD => "-".into(),
            0xBE => ".".into(),
            0xBF => "/".into(),
            0xC0 => "`".into(),
            0xDB => "[".into(),
            0xDC => "\\".into(),
            0xDD => "]".into(),
            0xDE => "'".into(),
            _ => format!("VK_{:02X}", vkey),
        }
    }
}

// ---- ゲームパッドリスナー --------------------------------------------------

fn gamepad_button_name(btn: gilrs::Button) -> String {
    match btn {
        gilrs::Button::South        => "Button1".into(),
        gilrs::Button::East         => "Button2".into(),
        gilrs::Button::West         => "Button3".into(),
        gilrs::Button::North        => "Button4".into(),
        gilrs::Button::LeftTrigger  => "L1".into(),
        gilrs::Button::RightTrigger => "R1".into(),
        gilrs::Button::LeftTrigger2 => "L2".into(),
        gilrs::Button::RightTrigger2 => "R2".into(),
        gilrs::Button::Select       => "Select".into(),
        gilrs::Button::Start        => "Start".into(),
        gilrs::Button::LeftThumb    => "L3".into(),
        gilrs::Button::RightThumb   => "R3".into(),
        gilrs::Button::DPadUp       => "↑".into(),
        gilrs::Button::DPadDown     => "↓".into(),
        gilrs::Button::DPadLeft     => "←".into(),
        gilrs::Button::DPadRight    => "→".into(),
        gilrs::Button::Mode         => "Mode".into(),
        _                           => format!("{:?}", btn),
    }
}

fn start_gamepad_listener(app: AppHandle, epoch: Instant) {
    // axis ごとの前回 value を記録
    let mut prev_axis: HashMap<Axis, f32> = HashMap::new();

    std::thread::spawn(move || {
        let Ok(mut gilrs) = gilrs::GilrsBuilder::new()
            .with_default_filters(false)
            .build()
        else {
            eprintln!("gilrs init failed");
            return;
        };
        loop {
            while let Some(gilrs::Event { event, .. }) = gilrs.next_event() {
                let t = epoch.elapsed().as_secs_f64() * 1000.0;
                match event {
                    EventType::ButtonPressed(btn, _) => {
                        let _ = app.emit("input-event", InputEvent::ButtonDown {
                            source: "gamepad".into(),
                            id: gamepad_button_name(btn),
                            t,
                        });
                    }
                    EventType::ButtonReleased(btn, _) => {
                        let _ = app.emit("input-event", InputEvent::ButtonUp {
                            source: "gamepad".into(),
                            id: gamepad_button_name(btn),
                            t,
                        });
                    }
                    EventType::AxisChanged(axis, value, _) => {
                        let prev = *prev_axis.get(&axis).unwrap_or(&value);
                        prev_axis.insert(axis, value);

                        // ラップアラウンド補正: 直前との差分を -1.0〜+1.0 に収める
                        let raw_delta = value - prev;
                        let delta = if raw_delta > 1.0 {
                            raw_delta - 2.0
                        } else if raw_delta < -1.0 {
                            raw_delta + 2.0
                        } else {
                            raw_delta
                        };

                        // 方向を delta の符号で決める
                        let direction: i8 = if delta > 0.005 { 1 } else if delta < -0.005 { -1 } else { 0 };
                        if direction != 0 {
                            let _ = app.emit("input-event", InputEvent::AxisMove {
                                source: "gamepad".into(),
                                id: format!("{:?}", axis),
                                direction,
                                value,
                                t,
                            });
                        }
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

// フロントエンドから SCR 方向変化時に呼ぶ: clap 音を再生
#[tauri::command]
fn play_clap() {
    if let Some(tx) = AUDIO_TX.get() {
        let _ = tx.try_send(1.0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let epoch    = Instant::now();
    let audio_tx = spawn_audio_thread();
    // グローバル送信端に登録
    let _ = AUDIO_TX.set(audio_tx.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, play_clap])
        .setup(move |app| {
            #[cfg(windows)]
            raw_keyboard::start(app.handle().clone(), epoch, audio_tx.clone());
            start_gamepad_listener(app.handle().clone(), epoch);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
