use gilrs::{Axis, Button, EventType, Gilrs};
use rodio::{OutputStream, Sink, Source};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ---- 音再生 (専用スレッド1本、スレッド増殖なし) ---------------------------

fn spawn_audio_thread() -> mpsc::SyncSender<f32> {
    let (tx, rx) = mpsc::sync_channel::<f32>(64);
    std::thread::spawn(move || {
        let Ok((_stream, handle)) = OutputStream::try_default() else {
            return;
        };
        let Ok(sink) = Sink::try_new(&handle) else {
            return;
        };
        for freq in rx {
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

    // Virtual-Key codes
    const VK_A: u16 = 0x41;
    const VK_Q: u16 = 0x51;
    const VK_W: u16 = 0x57;
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
                        if let Some(cb) = &CALLBACK {
                            cb(vkey, is_down);
                        }
                    }
                }
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub fn start(app: AppHandle, epoch: Instant, audio_tx: mpsc::SyncSender<f32>) {
        let key_freqs: HashMap<u16, f32> = [
            (VK_A, 440.0),
            (VK_Q, 330.0),
            (VK_W, 550.0),
        ]
        .into();

        std::thread::spawn(move || unsafe {
            // コールバックをグローバルに設定
            CALLBACK = Some(Box::new(move |vkey: u16, is_down: bool| {
                let t = epoch.elapsed().as_secs_f64() * 1000.0;
                let id = vkey_name(vkey);
                if is_down {
                    if let Some(&freq) = key_freqs.get(&vkey) {
                        let _ = audio_tx.try_send(freq);
                    }
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
            VK_A => "A".into(),
            VK_Q => "Q".into(),
            VK_W => "W".into(),
            _ => format!("VK_{:02X}", vkey),
        }
    }
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

    // axis ごとの前回 value を記録（直前との差分で方向判定）
    let mut prev_axis: HashMap<Axis, f32> = HashMap::new();

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
                        let _ = app.emit("input-event", InputEvent::ButtonDown {
                            source: "gamepad".into(),
                            id: format!("{:?}", btn),
                            t,
                        });
                    }
                    EventType::ButtonReleased(btn, _) => {
                        let _ = app.emit("input-event", InputEvent::ButtonUp {
                            source: "gamepad".into(),
                            id: format!("{:?}", btn),
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

                        // 方向を delta の符号で決める（0 に近い場合は直前の方向を維持）
                        let direction: i8 = if delta > 0.01 { 1 } else if delta < -0.01 { -1 } else { 0 };
                        if direction != 0 {
                            let _ = audio_tx.try_send(if direction > 0 { 600.0 } else { 500.0 });
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let epoch    = Instant::now();
    let audio_tx = spawn_audio_thread();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(move |app| {
            #[cfg(windows)]
            raw_keyboard::start(app.handle().clone(), epoch, audio_tx.clone());
            start_gamepad_listener(app.handle().clone(), epoch, audio_tx);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
