//! The single sampler thread. Adaptive cadence: fast when the window is visible, slow (or parked)
//! otherwise, and only awake in the background when something needs it (sessions, rules, alerts).
use super::history::Sample;
use super::model::*;
use super::netio::NetTop;
use crate::anomaly::{DetCtx, Detector};
use crate::platform;
use crate::rules;
use crate::state::AppState;
use crate::tracking::TickCtx;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, RefreshKind, System, UpdateKind, Users};
use tauri::{AppHandle, Emitter};

enum Mode {
    Active(u64),
    Background(u64),
    Parked,
}

fn mode(st: &AppState) -> Mode {
    let sh = &st.shared;
    let s = st.settings.read();
    let session = sh.tracking.lock().has_active();
    let ui = sh.visible.load(Ordering::Relaxed) && !sh.paused.load(Ordering::Relaxed) && sh.channel.lock().is_some();
    if ui {
        Mode::Active(if session { s.refresh_ms.min(1000) } else { s.refresh_ms })
    } else if session {
        Mode::Background(1000)
    } else if crate::rules::Engine::has_enabled(&s.rules) || (s.background_alerts && s.anomaly.enabled) {
        Mode::Background(5000)
    } else {
        Mode::Parked
    }
}

fn status_code(s: ProcessStatus) -> u8 {
    match s {
        ProcessStatus::Run => ST_RUN,
        ProcessStatus::Sleep => ST_SLEEP,
        ProcessStatus::Stop => ST_STOP,
        ProcessStatus::Zombie => ST_ZOMBIE,
        ProcessStatus::Idle => ST_IDLE,
        _ => ST_OTHER,
    }
}

pub fn spawn(app: AppHandle, st: Arc<AppState>) {
    std::thread::Builder::new()
        .name("derunner-sampler".into())
        .spawn(move || run(app, st))
        .expect("spawn sampler");
}

fn run(app: AppHandle, st: Arc<AppState>) {
    let sh = st.shared.clone();
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::everything()),
    );
    let users = Users::new_with_refreshed_list();
    let mut nets = Networks::new_with_refreshed_list();
    // Hot path: only what changes every tick. exe/cmd/user are fetched once, for new pids only
    // (retrying them for every unreadable system process each tick was the dominant cost).
    let kind = ProcessRefreshKind::nothing().with_cpu().with_memory().with_disk_usage();
    let static_kind = ProcessRefreshKind::nothing().with_exe(UpdateKind::Always).with_cmd(UpdateKind::Always).with_user(UpdateKind::Always);
    let mut thr_cache: HashMap<u32, u32> = HashMap::new();
    let mut tick_no: u64 = 0;

    let mut known: HashMap<u32, u64> = HashMap::new();
    let mut detector = Detector::default();
    let mut engine = rules::Engine::default();
    let mut last = Instant::now();
    let mut parked = true;
    let mut last_status = String::new();
    let self_pid = std::process::id();

    loop {
        let interval = match mode(&st) {
            Mode::Parked => {
                if !parked {
                    sh.net.set_enabled(false);
                    crate::tray::set_status(&app, None);
                }
                parked = true;
                sh.wait(Duration::from_secs(60));
                continue;
            }
            Mode::Active(ms) | Mode::Background(ms) => ms,
        };

        let want_net = {
            let s = st.settings.read();
            s.per_process_network
                && NetTop::supported()
                && ((sh.visible.load(Ordering::Relaxed) && !sh.paused.load(Ordering::Relaxed)) || sh.tracking.lock().has_active())
        };
        sh.net.set_enabled(want_net);

        if parked {
            // Warm-up: CPU usage is a delta, so take a baseline sample before the first real tick.
            sys.refresh_cpu_usage();
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
            nets.refresh(true);
            std::thread::sleep(Duration::from_millis(350));
            parked = false;
            last = Instant::now() - Duration::from_millis(300);
        } else {
            let el = last.elapsed();
            if el < Duration::from_millis(interval) {
                sh.wait(Duration::from_millis(interval) - el);
            }
            let el = last.elapsed();
            if el < Duration::from_millis(300) {
                std::thread::sleep(Duration::from_millis(300) - el);
            }
        }

        // ---------------- one tick ----------------
        let now_i = Instant::now();
        let dt = now_i.duration_since(last).as_secs_f64().max(0.05);
        last = now_i;
        let now = now_ms();

        sys.refresh_cpu_usage();
        sys.refresh_memory();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        nets.refresh(true);

        tick_no += 1;
        // Resolve static info for processes we have not seen before.
        let fresh: Vec<sysinfo::Pid> = sys
            .processes()
            .iter()
            .filter(|(pid, p)| known.get(&pid.as_u32()) != Some(&p.start_time()))
            .map(|(pid, _)| *pid)
            .collect();
        if !fresh.is_empty() {
            sys.refresh_processes_specifics(ProcessesToUpdate::Some(&fresh), false, static_kind);
        }

        let ncpu = sys.cpus().len().max(1);
        let net_map = if sh.net.is_running() { Some(sh.net.snapshot()) } else { None };

        let mut rows: Vec<Row> = Vec::with_capacity(sys.processes().len());
        let mut added: Vec<ProcStatic> = vec![];
        let mut seen: HashSet<u32> = HashSet::with_capacity(sys.processes().len());
        let mut reused: Vec<u32> = vec![];
        let (mut dr_total, mut dw_total) = (0u64, 0u64);

        for (pid, p) in sys.processes() {
            if p.thread_kind().is_some() {
                continue;
            }
            let id = pid.as_u32();
            let start = p.start_time();
            seen.insert(id);
            match known.get(&id) {
                Some(&s) if s == start => {}
                prev => {
                    if prev.is_some() {
                        reused.push(id);
                    }
                    let mut exe = p.exe().map(|e| e.to_string_lossy().into_owned());
                    if exe.is_none() {
                        exe = platform::proc_path(id);
                    }
                    let name = match (&exe, cfg!(target_os = "linux")) {
                        (Some(e), false) => std::path::Path::new(e).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.name().to_string_lossy().into_owned()),
                        _ => p.name().to_string_lossy().into_owned(),
                    };
                    let (app_name, app_path) = exe.as_deref().and_then(app_bundle).map(|(a, b)| (Some(a), Some(b))).unwrap_or((None, None));
                    let mut cmd: Vec<String> = p.cmd().iter().map(|c| c.to_string_lossy().into_owned()).collect();
                    for c in cmd.iter_mut() {
                        if c.len() > 4096 {
                            c.truncate(4096);
                        }
                    }
                    cmd.truncate(256);
                    added.push(ProcStatic {
                        pid: id,
                        ppid: p.parent().map(|x| x.as_u32()).unwrap_or(0),
                        name,
                        exe,
                        cmd,
                        user: p.user_id().and_then(|u| users.get_user_by_id(u)).map(|u| u.name().to_string()),
                        start,
                        app: app_name,
                        app_path,
                    });
                }
            }
            let du = p.disk_usage();
            let dr = (du.read_bytes as f64 / dt) as u64;
            let dw = (du.written_bytes as f64 / dt) as u64;
            dr_total += dr;
            dw_total += dw;
            let (nr, nt) = net_map.as_ref().and_then(|m| m.get(&id).copied()).unwrap_or((0, 0));
            #[cfg(target_os = "linux")]
            let threads = p.tasks().map(|t| t.len() as u32).unwrap_or(1);
            #[cfg(not(target_os = "linux"))]
            let threads = {
                // Thread counts change slowly: refresh a quarter of processes per tick.
                if tick_no % 4 == (id as u64) % 4 || !thr_cache.contains_key(&id) {
                    let t = platform::thread_count(id);
                    thr_cache.insert(id, t);
                    t
                } else {
                    thr_cache[&id]
                }
            };
            rows.push(Row(id, p.cpu_usage(), p.memory(), dr, dw, nr, nt, threads, status_code(p.status())));
        }

        let removed: Vec<u32> = known.keys().copied().filter(|k| !seen.contains(k)).chain(reused.iter().copied()).collect();
        for r in &removed {
            known.remove(r);
            thr_cache.remove(r);
        }
        for a in &added {
            known.insert(a.pid, a.start);
        }

        // System-wide stats.
        let (mut rx, mut tx) = (0u64, 0u64);
        for (name, d) in nets.iter() {
            if name.starts_with("lo") {
                continue;
            }
            rx += d.received();
            tx += d.transmitted();
        }
        let la = System::load_average();
        let sysstats = SysStats {
            cpu: sys.global_cpu_usage(),
            per_core: sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
            cores: ncpu as u32,
            mem_used: sys.used_memory(),
            mem_total: sys.total_memory(),
            swap_used: sys.used_swap(),
            swap_total: sys.total_swap(),
            disk_r: dr_total,
            disk_w: dw_total,
            net_rx: (rx as f64 / dt) as u64,
            net_tx: (tx as f64 / dt) as u64,
            load: [la.one, la.five, la.fifteen],
            procs: rows.len() as u32,
            uptime: System::uptime(),
        };
        let added_pids: Vec<u32> = added.iter().map(|a| a.pid).collect();

        // Shared state (procs first: other subsystems read it).
        {
            let mut procs = sh.procs.write();
            for r in &removed {
                procs.remove(r);
            }
            for a in &added {
                procs.insert(a.pid, a.clone());
            }
        }
        {
            let procs = sh.procs.read();
            let mut hist = sh.history.write();
            for r in &removed {
                if !procs.contains_key(r) {
                    hist.remove(*r);
                }
            }
            let t = (now / 1000) as u32;
            for r in &rows {
                if let Some(p) = procs.get(&r.pid()) {
                    hist.push(r.pid(), p.start, Sample { t, cpu: r.cpu_raw(), mem: (r.mem() / 1024).min(u32::MAX as u64) as u32, dr: r.disk_r().min(u32::MAX as u64) as u32, dw: r.disk_w().min(u32::MAX as u64) as u32, nr: r.net_rx().min(u32::MAX as u64) as u32, nw: r.net_tx().min(u32::MAX as u64) as u32 });
                }
            }
        }
        for r in &removed {
            detector.forget(*r);
        }
        let row_map: HashMap<u32, Row> = rows.iter().map(|r| (r.pid(), *r)).collect();
        *sh.sys.write() = sysstats.clone();

        let settings = st.settings.read().clone();
        let procs = sh.procs.read();

        // Anomalies.
        let found = detector.on_tick(&DetCtx { now_ms: now, dt_s: dt, ncpu: ncpu as f64, mem_total: sysstats.mem_total, rows: &rows, procs: &procs, added: &added_pids, cfg: &settings.anomaly, self_pid });
        if !found.is_empty() {
            let visible = sh.visible.load(Ordering::Relaxed);
            let mut trk = sh.tracking.lock();
            let mut list = sh.anomalies.lock();
            for a in found {
                trk.note_anomaly(&a);
                let _ = app.emit("anomaly", &a);
                if settings.notifications && !visible && a.severity != "info" {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app.notification().builder().title(format!("DeRunner: {}", a.title)).body(a.detail.chars().take(140).collect::<String>()).show();
                }
                list.push_front(a);
                list.truncate(500);
            }
        }

        // Priority rules.
        let evs = engine.on_tick(now, &settings.rules, &procs, &added_pids, self_pid);
        if !evs.is_empty() {
            let mut log = sh.rules_log.lock();
            let mut trk = sh.tracking.lock();
            for e in evs {
                if e.ok {
                    trk.log_pid_event(e.pid, "priority", "info", &format!("Rule '{}' set priority to {}", e.rule_name, e.priority), now);
                }
                let _ = app.emit("rule-applied", &e);
                log.push_front(e);
                log.truncate(200);
            }
        }

        // Tracking sessions.
        let finished = {
            let mut trk = sh.tracking.lock();
            if trk.has_active() {
                let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
                for p in procs.values() {
                    children.entry(p.ppid).or_default().push(p.pid);
                }
                trk.on_tick(&st.store, &TickCtx { now_ms: now, rows: &row_map, procs: &procs, children: &children, ncpu: ncpu as u32, mem_total: sysstats.mem_total })
            } else {
                vec![]
            }
        };
        drop(procs);
        if !finished.is_empty() {
            for f in &finished {
                let _ = app.emit("session-finished", serde_json::json!({ "id": f.id, "status": f.status }));
                if settings.ai.auto_report {
                    crate::ai::spawn_report(app.clone(), f.id);
                }
            }
            let _ = app.emit("sessions-changed", ());
            crate::tray::refresh_menu(&app);
        }

        // Stream to the UI.
        if sh.visible.load(Ordering::Relaxed) && !sh.paused.load(Ordering::Relaxed) {
            let full = sh.force_full.swap(false, Ordering::AcqRel);
            let mut chan = sh.channel.lock();
            if let Some(ch) = chan.as_ref() {
                let (added_out, removed_out) = if full { (sh.procs.read().values().cloned().collect(), vec![]) } else { (added, removed) };
                let snap = Snapshot { ts: now, sys: sysstats.clone(), full, added: added_out, removed: removed_out, rows: rows.clone(), net_supported: sh.net.is_running() };
                if ch.send(snap).is_err() {
                    *chan = None;
                }
            }
        }
        *sh.rows.write() = row_map;

        // Tray status text, only touched when it changes.
        if settings.tray_show_cpu {
            let mem = if sysstats.mem_total > 0 { sysstats.mem_used as f64 / sysstats.mem_total as f64 * 100.0 } else { 0.0 };
            let text = format!("{:.0}%", sysstats.cpu);
            let tip = format!("DeRunner · CPU {:.0}% · Memory {:.0}%", sysstats.cpu, mem);
            let key = format!("{text}|{tip}");
            if key != last_status {
                crate::tray::set_status(&app, Some((&text, &tip)));
                last_status = key;
            }
        } else if !last_status.is_empty() {
            crate::tray::set_status(&app, None);
            last_status.clear();
        }
    }
}
