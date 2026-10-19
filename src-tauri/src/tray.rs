use crate::state::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

const TRAY_ID: &str = "main";

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        st.shared.visible.store(true, Ordering::Relaxed);
        st.shared.poke();
    }
}

pub fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        st.shared.visible.store(false, Ordering::Relaxed);
        st.shared.poke();
    }
}

pub fn toggle_main(app: &AppHandle) {
    let visible = app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)).unwrap_or(false);
    if visible {
        hide_main(app);
    } else {
        show_main(app);
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let st = app.state::<Arc<AppState>>();
    let paused = st.shared.paused.load(Ordering::Relaxed);
    let sessions = st.shared.tracking.lock().active();
    let login = app.autolaunch().is_enabled().unwrap_or(false);

    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", "Show DeRunner", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "palette", "Command Palette…", true, Some("CmdOrCtrl+K"))?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&CheckMenuItem::with_id(app, "pause", "Pause Monitoring", true, paused, None::<&str>)?)?;
    let sub = Submenu::with_id(app, "tracking", if sessions.is_empty() { "Tracking: idle".to_string() } else { format!("● Tracking ({})", sessions.len()) }, !sessions.is_empty())?;
    for s in &sessions {
        sub.append(&MenuItem::with_id(app, format!("stop:{}", s.id), format!("Stop “{}”", s.name), true, None::<&str>)?)?;
    }
    menu.append(&sub)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?)?;
    menu.append(&MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?)?;
    menu.append(&CheckMenuItem::with_id(app, "login", "Launch at Login", true, login, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit DeRunner", true, Some("CmdOrCtrl+Q"))?)?;
    Ok(menu)
}

pub fn refresh_menu(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// `Some((title, tooltip))` shows live CPU in the menu bar (macOS) and tooltip; `None` clears it.
pub fn set_status(app: &AppHandle, status: Option<(&str, &str)>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    match status {
        Some((title, tip)) => {
            #[cfg(target_os = "macos")]
            let _ = tray.set_title(Some(title));
            #[cfg(not(target_os = "macos"))]
            let _ = title;
            let _ = tray.set_tooltip(Some(tip));
        }
        None => {
            #[cfg(target_os = "macos")]
            let _ = tray.set_title(None::<&str>);
            let _ = tray.set_tooltip(Some("DeRunner"));
        }
    }
}

pub fn quit(app: &AppHandle) {
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        let _ = st.shared.tracking.lock().stop_all(&st.store, crate::monitor::model::now_ms());
    }
    app.exit(0);
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = Image::from_bytes(include_bytes!("../icons/tray-color.png"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("DeRunner")
        .menu(&build_menu(app)?)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, ev| {
            let id = ev.id().as_ref().to_string();
            match id.as_str() {
                "show" => show_main(app),
                "palette" => {
                    show_main(app);
                    let _ = app.emit("open-palette", ());
                }
                "pause" => {
                    let st = app.state::<Arc<AppState>>();
                    let p = !st.shared.paused.load(Ordering::Relaxed);
                    st.shared.paused.store(p, Ordering::Relaxed);
                    st.shared.poke();
                    let _ = app.emit("paused-changed", p);
                    refresh_menu(app);
                }
                "settings" => {
                    show_main(app);
                    let _ = app.emit("navigate", "settings");
                }
                "update" => {
                    show_main(app);
                    let _ = app.emit("navigate", "settings/updates");
                }
                "login" => {
                    let al = app.autolaunch();
                    let on = al.is_enabled().unwrap_or(false);
                    let _ = if on { al.disable() } else { al.enable() };
                    refresh_menu(app);
                }
                "quit" => quit(app),
                other => {
                    if let Some(sid) = other.strip_prefix("stop:").and_then(|s| s.parse::<i64>().ok()) {
                        let st = app.state::<Arc<AppState>>();
                        let fin = st.shared.tracking.lock().stop(&st.store, sid, crate::monitor::model::now_ms());
                        if let Some(f) = fin {
                            let _ = app.emit("session-finished", serde_json::json!({ "id": f.id, "status": f.status }));
                            let _ = app.emit("sessions-changed", ());
                            st.shared.poke();
                            if st.settings.read().ai.auto_report {
                                crate::ai::spawn_report(app.clone(), f.id);
                            }
                        }
                        refresh_menu(app);
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                if !cfg!(target_os = "macos") {
                    toggle_main(tray.app_handle());
                }
            }
        })
        .build(app)?;
    Ok(())
}
