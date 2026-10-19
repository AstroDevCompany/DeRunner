mod ai;
mod anomaly;
mod commands;
mod control;
mod error;
mod monitor;
mod platform;
mod redact;
mod report;
mod rules;
mod settings;
mod state;
mod store;
mod thresholds;
mod tracking;
mod tray;
mod update;

use parking_lot::{Mutex, RwLock};
use state::{AppState, Shared};
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        tray::toggle_main(app);
                    }
                })
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let settings = settings::Settings::load(&config_dir);
            let store = store::Store::open(&data_dir.join("derunner.db")).map_err(|e| e.to_string())?;
            let _ = store.prune(monitor::model::now_ms().saturating_sub(settings.session_retention_days as u64 * 86_400_000));

            let st = Arc::new(AppState {
                settings: RwLock::new(settings.clone()),
                config_dir,
                shared: Arc::new(Shared::new()),
                store,
                ai_tasks: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                update_cache: Mutex::new(None),
            });
            app.manage(st.clone());

            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    let _ = apply_vibrancy(&win, NSVisualEffectMaterial::Sidebar, Some(NSVisualEffectState::Active), Some(14.0));
                }
                #[cfg(target_os = "windows")]
                {
                    let _ = window_vibrancy::apply_mica(&win, None).or_else(|_| window_vibrancy::apply_acrylic(&win, Some((18, 18, 18, 120))));
                }
                let _ = &win;
            }
            commands::apply_settings(&handle, &settings);
            tray::setup(&handle)?;
            // Failsafe: if the UI never reports ready (load failure), still reveal the window.
            if !std::env::args().any(|a| a == "--hidden") {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    if h.get_webview_window("main").is_some_and(|w| !w.is_visible().unwrap_or(false)) {
                        eprintln!("[derunner] UI did not signal ready; showing window anyway");
                        tray::show_main(&h);
                    }
                });
            }
            monitor::sampler::spawn(handle.clone(), st.clone());

            // Delayed, off-the-hot-path update check.
            if settings.update.auto_check {
                let h = handle.clone();
                let st2 = st.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                    let day = 86_400_000u64;
                    if monitor::model::now_ms().saturating_sub(st2.settings.read().update.last_check) < day {
                        return;
                    }
                    if let Ok(info) = update::check(env!("CARGO_PKG_VERSION")).await {
                        *st2.update_cache.lock() = Some(info.clone());
                        {
                            let mut s = st2.settings.write();
                            s.update.last_check = monitor::model::now_ms();
                            let _ = s.save(&st2.config_dir);
                        }
                        if info.available {
                            let _ = h.emit("update-available", &info);
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window.app_handle().state::<Arc<AppState>>().settings.read().close_to_tray;
                if close_to_tray {
                    api.prevent_close();
                    tray::hide_main(window.app_handle());
                } else {
                    tray::quit(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_ready,
            commands::get_settings,
            commands::set_settings,
            commands::get_launch_at_login,
            commands::set_launch_at_login,
            commands::quit_app,
            commands::hide_window,
            commands::open_external,
            commands::export_text,
            commands::subscribe,
            commands::set_visible,
            commands::set_paused,
            commands::get_history,
            commands::process_details,
            commands::process_signature,
            commands::process_open_files,
            commands::process_connections,
            commands::list_listeners,
            commands::terminate_process,
            commands::suspend_process,
            commands::resume_process,
            commands::relaunch_process,
            commands::set_process_priority,
            commands::get_process_priority,
            commands::focus_process_window,
            commands::sessions_start,
            commands::sessions_stop,
            commands::sessions_active,
            commands::sessions_list,
            commands::session_get,
            commands::session_series,
            commands::session_delete,
            commands::session_markdown,
            commands::session_ai_report,
            commands::anomalies_list,
            commands::anomaly_dismiss,
            commands::rules_log,
            commands::ai_status,
            commands::ai_set_key,
            commands::ai_clear_key,
            commands::ai_models,
            commands::ai_context_preview,
            commands::ai_chat,
            commands::ai_cancel,
            commands::check_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building DeRunner");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => tray::show_main(app),
        RunEvent::ExitRequested { .. } => {
            if let Some(st) = app.try_state::<Arc<AppState>>() {
                let _ = st.shared.tracking.lock().stop_all(&st.store, monitor::model::now_ms());
                st.shared.net.set_enabled(false);
            }
        }
        _ => {
            let _ = app;
        }
    });
}
