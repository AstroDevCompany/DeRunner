use crate::ai::{self, context::ContextReq, ChatMsg};
use crate::anomaly::Anomaly;
use crate::control;
use crate::error::{AppError, AppResult};
use crate::monitor::history::Series;
use crate::monitor::model::*;
use crate::platform::{self, Capabilities, Conn, OpenFile, PriorityInfo, SignatureInfo};
use crate::redact;
use crate::report;
use crate::rules::RuleEvent;
use crate::settings::Settings;
use crate::state::AppState;
use crate::store::{SampleRow, SessionDetail, SessionMeta, TargetMeta};
use crate::tracking::ActiveInfo;
use crate::update::{self, UpdateInfo};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

type S<'a> = State<'a, Arc<AppState>>;

// ---------------------------------------------------------------- app / settings

#[derive(Serialize)]
pub struct AppInfo {
    version: &'static str,
    os: &'static str,
    arch: &'static str,
    hostname: Option<String>,
    os_version: Option<String>,
    capabilities: Capabilities,
    net_supported: bool,
    manifest_url: &'static str,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        hostname: System::host_name(),
        os_version: System::long_os_version(),
        capabilities: platform::capabilities(),
        net_supported: crate::monitor::netio::NetTop::supported(),
        manifest_url: update::UPDATE_MANIFEST_URL,
    }
}

/// Called by the UI after first paint (avoids a white flash). Autostart launches stay hidden in the tray.
#[tauri::command]
pub fn app_ready(app: AppHandle) {
    eprintln!("[derunner] app_ready from UI");
    if std::env::args().any(|a| a == "--hidden") {
        return;
    }
    crate::tray::show_main(&app);
}

#[tauri::command]
pub fn get_settings(st: S) -> Settings {
    st.settings.read().clone()
}

pub fn apply_settings(app: &AppHandle, s: &Settings) {
    if let Some(w) = app.get_webview_window("main") {
        let theme = match s.theme.as_str() {
            "light" => Some(tauri::Theme::Light),
            "dark" => Some(tauri::Theme::Dark),
            _ => None,
        };
        let _ = w.set_theme(theme);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(if s.show_in_dock { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
    }
    register_shortcut(app, s.global_shortcut.as_deref());
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        st.shared.poke();
    }
}

pub fn register_shortcut(app: &AppHandle, accel: Option<&str>) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if let Some(a) = accel.filter(|a| !a.is_empty()) {
        let _ = gs.register(a);
    }
}

#[tauri::command]
pub fn set_settings(app: AppHandle, st: S, settings: Settings) -> AppResult<()> {
    let mut s = settings;
    s.refresh_ms = s.refresh_ms.clamp(500, 10_000);
    s.save(&st.config_dir)?;
    *st.settings.write() = s.clone();
    apply_settings(&app, &s);
    crate::tray::refresh_menu(&app);
    Ok(())
}

#[tauri::command]
pub fn get_launch_at_login(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn set_launch_at_login(app: AppHandle, enabled: bool) -> AppResult<()> {
    let al = app.autolaunch();
    (if enabled { al.enable() } else { al.disable() }).map_err(|e| AppError::Other(e.to_string()))?;
    crate::tray::refresh_menu(&app);
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    crate::tray::quit(&app);
}

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    crate::tray::hide_main(&app);
}

#[tauri::command]
pub fn open_external(url: String) -> AppResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err(AppError::Invalid("Only http(s) links can be opened.".into()));
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub fn export_text(app: AppHandle, filename: String, content: String) -> AppResult<String> {
    let dir = app.path().download_dir().map_err(|e| AppError::Other(e.to_string()))?;
    let safe: String = filename.chars().map(|c| if c.is_alphanumeric() || "-_. ".contains(c) { c } else { '_' }).collect();
    let path = dir.join(safe);
    std::fs::write(&path, content)?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------- monitoring

#[tauri::command]
pub fn subscribe(st: S, channel: Channel<Snapshot>) {
    *st.shared.channel.lock() = Some(channel);
    st.shared.force_full.store(true, Ordering::Release);
    st.shared.poke();
}

#[tauri::command]
pub fn set_visible(st: S, visible: bool) {
    st.shared.visible.store(visible, Ordering::Relaxed);
    if visible {
        st.shared.force_full.store(true, Ordering::Release);
    }
    st.shared.poke();
}

#[tauri::command]
pub fn set_paused(app: AppHandle, st: S, paused: bool) {
    st.shared.paused.store(paused, Ordering::Relaxed);
    st.shared.poke();
    crate::tray::refresh_menu(&app);
}

#[tauri::command]
pub fn get_history(st: S, pid: u32, tier: String) -> Series {
    st.shared.history.read().series(pid, &tier)
}

#[derive(Serialize)]
pub struct Relative {
    pid: u32,
    name: String,
}

#[derive(Serialize)]
pub struct Details {
    pid: u32,
    ppid: u32,
    name: String,
    exe: Option<String>,
    cwd: Option<String>,
    cmd: Vec<String>,
    env: Vec<(String, String)>,
    user: Option<String>,
    start: u64,
    app: Option<String>,
    app_path: Option<String>,
    priority: Option<PriorityInfo>,
    parents: Vec<Relative>,
    children: Vec<Relative>,
    protected: bool,
    redacted: bool,
}

#[tauri::command]
pub async fn process_details(st: S<'_>, pid: u32, reveal: bool) -> AppResult<Details> {
    let stat = st.shared.procs.read().get(&pid).cloned().ok_or_else(|| AppError::NotFound("That process is no longer running.".into()))?;
    let (parents, children) = {
        let procs = st.shared.procs.read();
        let mut parents = vec![];
        let mut cur = stat.ppid;
        while cur > 0 && parents.len() < 12 {
            match procs.get(&cur) {
                Some(p) => {
                    parents.push(Relative { pid: p.pid, name: p.name.clone() });
                    if p.ppid == cur {
                        break;
                    }
                    cur = p.ppid;
                }
                None => break,
            }
        }
        let mut children: Vec<Relative> = procs.values().filter(|p| p.ppid == pid).map(|p| Relative { pid: p.pid, name: p.name.clone() }).collect();
        children.sort_by_key(|c| c.pid);
        (parents, children)
    };
    let (cwd, env) = tauri::async_runtime::spawn_blocking(move || {
        let mut sys = System::new();
        let sp = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[sp]), true, ProcessRefreshKind::nothing().with_cwd(sysinfo::UpdateKind::Always).with_environ(sysinfo::UpdateKind::Always));
        match sys.process(sp) {
            Some(p) => (p.cwd().map(|c| c.to_string_lossy().into_owned()), p.environ().iter().map(|e| e.to_string_lossy().into_owned()).collect::<Vec<_>>()),
            None => (None, vec![]),
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?;
    let redacting = !reveal;
    Ok(Details {
        pid,
        ppid: stat.ppid,
        protected: control::is_protected(&stat.name),
        priority: platform::get_priority(pid),
        cmd: if redacting { redact::cmd_args(&stat.cmd) } else { stat.cmd.clone() },
        env: redact::env(&env, reveal),
        cwd,
        name: stat.name,
        exe: stat.exe,
        user: stat.user,
        start: stat.start,
        app: stat.app,
        app_path: stat.app_path,
        parents,
        children,
        redacted: redacting,
    })
}

#[tauri::command]
pub async fn process_signature(st: S<'_>, pid: u32) -> AppResult<SignatureInfo> {
    let p = st.shared.procs.read().get(&pid).cloned().ok_or_else(|| AppError::NotFound("That process is no longer running.".into()))?;
    let path = p.app_path.clone().or(p.exe.clone()).ok_or_else(|| AppError::Unsupported("Executable path unknown.".into()))?;
    tauri::async_runtime::spawn_blocking(move || platform::signature(&path)).await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn process_open_files(pid: u32) -> AppResult<Vec<OpenFile>> {
    tauri::async_runtime::spawn_blocking(move || platform::open_files(pid)).await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn process_connections(st: S<'_>, pid: u32) -> AppResult<Vec<Conn>> {
    let name = st.shared.procs.read().get(&pid).map(|p| p.name.clone()).unwrap_or_default();
    let mut v = tauri::async_runtime::spawn_blocking(move || platform::connections(pid)).await.map_err(|e| AppError::Other(e.to_string()))?;
    for c in &mut v {
        c.process = name.clone();
    }
    Ok(v)
}

#[tauri::command]
pub async fn list_listeners(st: S<'_>) -> AppResult<Vec<Conn>> {
    let mut v = tauri::async_runtime::spawn_blocking(platform::listeners).await.map_err(|e| AppError::Other(e.to_string()))?;
    let procs = st.shared.procs.read();
    for c in &mut v {
        if let Some(p) = procs.get(&c.pid) {
            c.process = p.name.clone();
        }
    }
    Ok(v)
}

// ---------------------------------------------------------------- controls

fn log_action(st: &AppState, pid: u32, kind: &str, msg: &str) {
    st.shared.tracking.lock().log_pid_event(pid, kind, "info", msg, now_ms());
}

#[tauri::command]
pub fn terminate_process(st: S, pid: u32, start: Option<u64>, force: bool, tree: bool, allow_protected: bool) -> AppResult<u32> {
    log_action(&st, pid, "terminate", if force { "Force-terminated by user" } else { "Terminate requested by user" });
    control::terminate(&st.shared, pid, start, force, tree, allow_protected)
}

#[tauri::command]
pub fn suspend_process(st: S, pid: u32, start: Option<u64>, allow_protected: bool) -> AppResult<()> {
    control::suspend(&st.shared, pid, start, allow_protected)?;
    log_action(&st, pid, "suspend", "Suspended by user");
    Ok(())
}

#[tauri::command]
pub fn resume_process(st: S, pid: u32, start: Option<u64>) -> AppResult<()> {
    control::resume(&st.shared, pid, start)?;
    log_action(&st, pid, "resume", "Resumed by user");
    Ok(())
}

#[tauri::command]
pub async fn relaunch_process(st: S<'_>, pid: u32, start: Option<u64>) -> AppResult<u32> {
    let sh = st.shared.clone();
    tauri::async_runtime::spawn_blocking(move || control::relaunch(&sh, pid, start)).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn set_process_priority(st: S, pid: u32, start: Option<u64>, level: String) -> AppResult<()> {
    control::check_target(&st.shared, pid, start, false)?;
    platform::set_priority(pid, &level)?;
    log_action(&st, pid, "priority", &format!("Priority set to {level} by user"));
    Ok(())
}

#[tauri::command]
pub fn get_process_priority(pid: u32) -> Option<PriorityInfo> {
    platform::get_priority(pid)
}

#[tauri::command]
pub fn focus_process_window(st: S, pid: u32) -> AppResult<()> {
    let app_path = st.shared.procs.read().get(&pid).and_then(|p| p.app_path.clone());
    platform::focus_window(pid, app_path.as_deref())
}

// ---------------------------------------------------------------- sessions

#[derive(Deserialize)]
pub struct TargetReq {
    pid: u32,
    start: Option<u64>,
}

fn emit_sessions(app: &AppHandle) {
    let _ = app.emit("sessions-changed", ());
    crate::tray::refresh_menu(app);
}

#[tauri::command]
pub fn sessions_start(app: AppHandle, st: S, targets: Vec<TargetReq>, include_children: bool, limit_s: Option<u64>, name: Option<String>) -> AppResult<i64> {
    if targets.is_empty() {
        return Err(AppError::Invalid("Select at least one process to track.".into()));
    }
    let metas: Vec<TargetMeta> = {
        let procs = st.shared.procs.read();
        targets
            .iter()
            .map(|t| {
                let p = procs.get(&t.pid).ok_or_else(|| AppError::NotFound("A selected process is no longer running.".into()))?;
                Ok(TargetMeta { pid: p.pid, name: p.name.clone(), start: t.start.unwrap_or(p.start) })
            })
            .collect::<AppResult<Vec<_>>>()?
    };
    let label = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| match metas.as_slice() {
        [one] => one.name.clone(),
        many => format!("{} +{}", many[0].name, many.len() - 1),
    });
    let id = st.shared.tracking.lock().start(&st.store, label, metas, include_children, limit_s, now_ms())?;
    st.shared.poke();
    emit_sessions(&app);
    Ok(id)
}

#[tauri::command]
pub fn sessions_stop(app: AppHandle, st: S, id: i64) -> AppResult<()> {
    let fin = st.shared.tracking.lock().stop(&st.store, id, now_ms());
    if let Some(f) = fin {
        let _ = app.emit("session-finished", serde_json::json!({ "id": f.id, "status": f.status }));
        if st.settings.read().ai.auto_report {
            ai::spawn_report(app.clone(), f.id);
        }
    }
    st.shared.poke();
    emit_sessions(&app);
    Ok(())
}

#[tauri::command]
pub fn sessions_active(st: S) -> Vec<ActiveInfo> {
    st.shared.tracking.lock().active()
}

#[tauri::command]
pub fn sessions_list(st: S) -> AppResult<Vec<SessionMeta>> {
    st.store.list_sessions()
}

#[tauri::command]
pub fn session_get(st: S, id: i64) -> AppResult<SessionDetail> {
    st.store.get_session(id)
}

#[tauri::command]
pub fn session_series(st: S, id: i64, pid: u32) -> AppResult<Vec<SampleRow>> {
    st.store.samples(id, pid, 600)
}

#[tauri::command]
pub fn session_delete(app: AppHandle, st: S, id: i64) -> AppResult<()> {
    st.store.delete_session(id)?;
    emit_sessions(&app);
    Ok(())
}

#[tauri::command]
pub fn session_markdown(st: S, id: i64) -> AppResult<String> {
    let d = st.store.get_session(id)?;
    let rep: report::Report = serde_json::from_value(d.report.ok_or_else(|| AppError::Invalid("No report yet.".into()))?)?;
    Ok(report::markdown(&rep, d.ai_report.as_deref()))
}

#[tauri::command]
pub async fn session_ai_report(app: AppHandle, id: i64) -> AppResult<String> {
    ai::report::generate(&app, id).await
}

// ---------------------------------------------------------------- anomalies & rules

#[tauri::command]
pub fn anomalies_list(st: S) -> Vec<Anomaly> {
    st.shared.anomalies.lock().iter().cloned().collect()
}

#[tauri::command]
pub fn anomaly_dismiss(st: S, id: Option<u64>) {
    let mut l = st.shared.anomalies.lock();
    for a in l.iter_mut() {
        if id.is_none() || Some(a.id) == id {
            a.dismissed = true;
        }
    }
}

#[tauri::command]
pub fn rules_log(st: S) -> Vec<RuleEvent> {
    st.shared.rules_log.lock().iter().cloned().collect()
}

// ---------------------------------------------------------------- AI

#[derive(Serialize)]
pub struct ProviderStatus {
    kind: String,
    has_key: bool,
}

#[tauri::command]
pub async fn ai_status() -> Vec<ProviderStatus> {
    tauri::async_runtime::spawn_blocking(|| ai::KINDS.iter().map(|k| ProviderStatus { kind: k.to_string(), has_key: ai::get_key(k).is_some() }).collect())
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn ai_set_key(kind: String, key: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || ai::set_key(&kind, key.trim())).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn ai_clear_key(kind: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || ai::clear_key(&kind)).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn ai_models(st: S<'_>, kind: String, base_url: Option<String>) -> AppResult<Vec<String>> {
    let st2 = st.inner().clone();
    let mut r = tauri::async_runtime::spawn_blocking(move || ai::resolve(&st2.settings.read(), Some(&kind), false)).await.map_err(|e| AppError::Other(e.to_string()))??;
    if let Some(u) = base_url.filter(|u| !u.trim().is_empty()) {
        r.base_url = u.trim_end_matches('/').to_string();
    }
    ai::providers::list_models(&r).await
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AiEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

#[tauri::command]
pub async fn ai_context_preview(st: S<'_>, context: ContextReq) -> AppResult<String> {
    let redact_on = st.settings.read().ai.redact;
    Ok(ai::context::build(&st, &context, redact_on))
}

#[tauri::command]
pub async fn ai_chat(st: S<'_>, provider: Option<String>, messages: Vec<ChatMsg>, context: ContextReq, on_event: Channel<AiEvent>) -> AppResult<u64> {
    let state = st.inner().clone();
    let st2 = state.clone();
    let prov = provider.clone();
    let r = tauri::async_runtime::spawn_blocking(move || ai::resolve(&st2.settings.read(), prov.as_deref(), true)).await.map_err(|e| AppError::Other(e.to_string()))??;
    let redact_on = state.settings.read().ai.redact;
    let system = format!("{}\n\n# Live telemetry snapshot\n{}", ai::context::PERSONA, ai::context::build(&state, &context, redact_on));
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let history: Vec<ChatMsg> = messages.into_iter().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect();
    let st3 = state.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let ch = on_event.clone();
        let res = ai::providers::stream_chat(&r, &system, &history, |t| {
            let _ = ch.send(AiEvent::Delta { text: t });
        })
        .await;
        let _ = on_event.send(match res {
            Ok(()) => AiEvent::Done,
            Err(e) => AiEvent::Error { message: e.to_string() },
        });
        st3.ai_tasks.lock().remove(&id);
    });
    state.ai_tasks.lock().insert(id, handle);
    Ok(id)
}

#[tauri::command]
pub fn ai_cancel(st: S, id: u64) {
    if let Some(h) = st.ai_tasks.lock().remove(&id) {
        h.abort();
    }
}

// ---------------------------------------------------------------- updates

#[tauri::command]
pub async fn check_update(app: AppHandle, st: S<'_>) -> AppResult<UpdateInfo> {
    let info = update::check(env!("CARGO_PKG_VERSION")).await?;
    *st.update_cache.lock() = Some(info.clone());
    {
        let mut s = st.settings.write();
        s.update.last_check = now_ms();
        let _ = s.save(&st.config_dir);
    }
    if info.available {
        let _ = app.emit("update-available", &info);
    }
    Ok(info)
}
