//! Explainable, rule-based + statistical anomaly detection. Findings are *signals to look at*,
//! never verdicts: wording stays neutral and nothing is ever auto-classified as malware.
use crate::monitor::model::*;
use crate::settings::AnomalySettings;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};

#[derive(Serialize, Clone, Debug)]
pub struct Anomaly {
    pub id: u64,
    pub ts: u64,
    pub pid: u32,
    pub name: String,
    pub kind: String,
    pub severity: String, // info | warn | critical
    pub title: String,
    pub detail: String,
    pub metric: String,
    pub value: f64,
    pub threshold: f64,
    pub dismissed: bool,
}

pub struct DetCtx<'a> {
    pub now_ms: u64,
    pub dt_s: f64,
    pub ncpu: f64,
    pub mem_total: u64,
    pub rows: &'a [Row],
    pub procs: &'a HashMap<u32, ProcStatic>,
    pub added: &'a [u32],
    pub cfg: &'a AnomalySettings,
    pub self_pid: u32,
}

#[derive(Default)]
struct PidState {
    cpu_crit_s: f64,
    cpu_warn_s: f64,
    mem_crit_s: f64,
    mem_warn_s: f64,
    net_hi_s: f64,
    zombie_s: f64,
    n: u32,
    mean: f64,
    var: f64,
    prev_cpu: f64,
    thr_mean: f64,
    mem_win: VecDeque<(f64, f64)>,
    last_mem_push: f64,
}

#[derive(Default)]
pub struct Detector {
    states: HashMap<u32, PidState>,
    cooldown: HashMap<(u32, &'static str), u64>,
    spawns: HashMap<u32, VecDeque<u64>>,
    next_id: u64,
    t: f64,
}

const COOLDOWN_MS: u64 = 5 * 60_000;

/// Least-squares slope and R² of y over x.
pub fn linreg(pts: &[(f64, f64)]) -> (f64, f64) {
    let n = pts.len() as f64;
    if pts.len() < 3 {
        return (0.0, 0.0);
    }
    let (sx, sy): (f64, f64) = pts.iter().fold((0.0, 0.0), |a, p| (a.0 + p.0, a.1 + p.1));
    let (mx, my) = (sx / n, sy / n);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for (x, y) in pts {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) * (x - mx);
        syy += (y - my) * (y - my);
    }
    if sxx == 0.0 || syy == 0.0 {
        return (0.0, 0.0);
    }
    (sxy / sxx, (sxy * sxy) / (sxx * syy))
}

fn suspicious_location(exe: &str) -> bool {
    let l = exe.to_lowercase().replace('\\', "/");
    ["/tmp/", "/private/tmp/", "/dev/shm/", "/downloads/", "/appdata/local/temp/", "/windows/temp/"]
        .iter()
        .any(|p| l.contains(p))
}

impl Detector {
    pub fn forget(&mut self, pid: u32) {
        self.states.remove(&pid);
        self.spawns.remove(&pid);
    }

    #[allow(clippy::too_many_arguments)]
    fn emit(&mut self, cx: &DetCtx, out: &mut Vec<Anomaly>, pid: u32, kind: &'static str, sev: &str, title: String, detail: String, metric: &str, value: f64, threshold: f64) {
        let key = (pid, kind);
        if let Some(&t) = self.cooldown.get(&key) {
            if cx.now_ms.saturating_sub(t) < COOLDOWN_MS {
                return;
            }
        }
        self.cooldown.insert(key, cx.now_ms);
        self.next_id += 1;
        let name = cx.procs.get(&pid).map(|p| p.name.clone()).unwrap_or_default();
        out.push(Anomaly { id: self.next_id, ts: cx.now_ms, pid, name, kind: kind.into(), severity: sev.into(), title, detail, metric: metric.into(), value, threshold, dismissed: false });
    }

    pub fn on_tick(&mut self, cx: &DetCtx) -> Vec<Anomaly> {
        let mut out = vec![];
        if !cx.cfg.enabled {
            return out;
        }
        self.t += cx.dt_s;
        let allow: Vec<String> = cx.cfg.allowlist.iter().map(|s| s.to_lowercase()).collect();
        let (crit_s, warn_s) = (cx.cfg.sustained_critical_s as f64, cx.cfg.sustained_warn_s as f64);

        for r in cx.rows {
            let pid = r.pid();
            if pid <= 1 || pid == cx.self_pid {
                continue;
            }
            let Some(p) = cx.procs.get(&pid) else { continue };
            if allow.contains(&p.name.to_lowercase()) {
                continue;
            }
            let cpu = r.cpu_raw() as f64 / cx.ncpu.max(1.0);
            let mem_pct = if cx.mem_total > 0 { r.mem() as f64 / cx.mem_total as f64 * 100.0 } else { 0.0 };
            let net = (r.net_rx() + r.net_tx()) as f64;
            let dt = cx.dt_s;
            let t = self.t;

            let s = self.states.entry(pid).or_default();
            s.cpu_crit_s = if cpu > 90.0 { s.cpu_crit_s + dt } else { 0.0 };
            s.cpu_warn_s = if cpu >= 70.0 { s.cpu_warn_s + dt } else { 0.0 };
            s.mem_crit_s = if mem_pct > 90.0 { s.mem_crit_s + dt } else { 0.0 };
            s.mem_warn_s = if mem_pct >= 70.0 { s.mem_warn_s + dt } else { 0.0 };
            s.net_hi_s = if net > 20e6 { s.net_hi_s + dt } else { 0.0 };
            s.zombie_s = if r.status() == ST_ZOMBIE { s.zombie_s + dt } else { 0.0 };

            // Spike vs. EWMA baseline (checked before the baseline absorbs the sample).
            let spike = s.n > 30 && cpu > 25.0 && cpu > s.mean + 4.0 * s.var.sqrt().max(2.0) && s.prev_cpu < cpu * 0.5;
            let (mean, std) = (s.mean, s.var.sqrt());
            if s.n == 0 {
                s.mean = cpu;
            } else {
                let d = cpu - s.mean;
                s.mean += 0.05 * d;
                s.var = 0.95 * (s.var + 0.05 * d * d);
            }
            s.n += 1;
            s.prev_cpu = cpu;

            let thr = r.threads() as f64;
            let thr_surge = s.n > 10 && thr > 100.0 && s.thr_mean > 0.0 && thr > 2.0 * s.thr_mean + 50.0;
            s.thr_mean = if s.thr_mean == 0.0 { thr } else { s.thr_mean + 0.05 * (thr - s.thr_mean) };

            let mb = r.mem() as f64 / 1_048_576.0;
            let mut leak: Option<(f64, f64, f64)> = None;
            if t - s.last_mem_push >= 5.0 {
                s.last_mem_push = t;
                s.mem_win.push_back((t, mb));
                if s.mem_win.len() > 120 {
                    s.mem_win.pop_front();
                }
                if s.mem_win.len() >= 36 {
                    let pts: Vec<(f64, f64)> = s.mem_win.iter().cloned().collect();
                    let (slope, r2) = linreg(&pts);
                    let grown = pts.last().unwrap().1 - pts[0].1;
                    let per_min = slope * 60.0;
                    if per_min > 10.0 && r2 > 0.9 && mb > 300.0 && grown > 100.0 {
                        leak = Some((per_min, grown, r2));
                    }
                }
            }
            let (cc, cw, mc, mw, nh, zs) = (s.cpu_crit_s, s.cpu_warn_s, s.mem_crit_s, s.mem_warn_s, s.net_hi_s, s.zombie_s);

            if cc >= crit_s {
                self.emit(cx, &mut out, pid, "cpu_critical", "critical", format!("{} has used over 90% CPU for {:.0}s", p.name, cc),
                    "Sustained very high CPU. Common causes: a busy loop, heavy compile/render/encode, indexing, or a stuck task. Check what it was asked to do before deciding to stop it.".into(), "cpu_pct", cpu, 90.0);
            } else if cw >= warn_s {
                self.emit(cx, &mut out, pid, "cpu_warn", "warn", format!("{} has used over 70% CPU for {:.0}s", p.name, cw),
                    "Elevated sustained CPU. Often normal for active work (builds, video, games); worth a look if you are not doing anything demanding.".into(), "cpu_pct", cpu, 70.0);
            }
            if mc >= crit_s {
                self.emit(cx, &mut out, pid, "mem_critical", "critical", format!("{} is holding over 90% of RAM", p.name),
                    "Very high memory share. The system may start swapping and slow down. Could be a large legitimate workload or a leak.".into(), "mem_pct", mem_pct, 90.0);
            } else if mw >= warn_s {
                self.emit(cx, &mut out, pid, "mem_warn", "warn", format!("{} is holding over 70% of RAM", p.name),
                    "High memory share for a single process; can be normal for large datasets, VMs or browsers.".into(), "mem_pct", mem_pct, 70.0);
            }
            if spike {
                self.emit(cx, &mut out, pid, "cpu_spike", "info", format!("{} CPU jumped to {:.0}%", p.name, cpu),
                    format!("Well above its recent baseline (~{:.0}% ± {:.0}). Short bursts are typical when an app wakes, syncs or compiles.", mean, std), "cpu_pct", cpu, mean + 4.0 * std);
            }
            if let Some((per_min, grown, r2)) = leak {
                self.emit(cx, &mut out, pid, "mem_growth", "warn", format!("{} memory keeps growing (+{:.0} MB/min)", p.name, per_min),
                    format!("Memory rose steadily by ~{:.0} MB over the last few minutes (fit R²={:.2}). This pattern can indicate a leak, or simply a cache/file loading in; watch whether it plateaus.", grown, r2), "mem_mb_per_min", per_min, 10.0);
            }
            if thr_surge {
                self.emit(cx, &mut out, pid, "thread_surge", "warn", format!("{} thread count jumped to {}", p.name, thr as u32),
                    "Thread count more than doubled versus its baseline. Can be a worker pool spinning up, or runaway thread creation.".into(), "threads", thr, s_thr(thr));
            }
            if nh >= 5.0 {
                self.emit(cx, &mut out, pid, "net_burst", "info", format!("{} is moving >20 MB/s over the network", p.name),
                    "Sustained high network throughput. Typical for downloads, backups, syncing or streaming.".into(), "net_Bps", net, 20e6);
            }
            if zs >= 30.0 {
                self.emit(cx, &mut out, pid, "zombie", "info", format!("{} is a zombie process", p.name),
                    "The process finished but its parent has not collected its exit status. Harmless unless they accumulate; the parent may need restarting.".into(), "seconds", zs, 30.0);
            }
        }

        // Spawn tracking + location heuristics on newly seen processes.
        let now = cx.now_ms;
        for &pid in cx.added {
            let Some(p) = cx.procs.get(&pid) else { continue };
            if allow.contains(&p.name.to_lowercase()) {
                continue;
            }
            let q = self.spawns.entry(p.ppid).or_default();
            q.push_back(now);
            while q.front().is_some_and(|&t| now - t > 10_000) {
                q.pop_front();
            }
            let n = q.len();
            if n >= 25 && p.ppid > 1 {
                let parent = cx.procs.get(&p.ppid).map(|x| x.name.clone()).unwrap_or_else(|| format!("pid {}", p.ppid));
                self.emit(cx, &mut out, p.ppid, "child_storm", "warn", format!("{parent} started {n} processes in 10 s"),
                    "A burst of child processes. Normal for build tools and shells running scripts; unusual for an otherwise idle app.".into(), "spawns_10s", n as f64, 25.0);
            }
            if let Some(exe) = &p.exe {
                if suspicious_location(exe) {
                    self.emit(cx, &mut out, pid, "odd_location", "info", format!("{} is running from a temporary or Downloads location", p.name),
                        format!("Path: {exe}. Installers, updaters and dev tools often run from here; it is also somewhere programs are rarely run from permanently. Not a verdict, just worth a glance."), "path", 0.0, 0.0);
                }
            }
        }

        if self.cooldown.len() > 4000 {
            let cutoff = cx.now_ms.saturating_sub(COOLDOWN_MS);
            self.cooldown.retain(|_, &mut t| t > cutoff);
        }
        out
    }
}

fn s_thr(t: f64) -> f64 {
    t / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, name: &str) -> ProcStatic {
        ProcStatic { pid, ppid: 1, name: name.into(), start: 1, ..Default::default() }
    }

    #[test]
    fn linreg_perfect_line() {
        let pts: Vec<(f64, f64)> = (0..10).map(|i| (i as f64, 2.0 * i as f64 + 1.0)).collect();
        let (m, r2) = linreg(&pts);
        assert!((m - 2.0).abs() < 1e-9 && (r2 - 1.0).abs() < 1e-9);
    }

    #[test]
    fn sustained_cpu_fires_once_then_cools_down() {
        let mut d = Detector::default();
        let mut procs = HashMap::new();
        procs.insert(5, proc(5, "burner"));
        let cfg = AnomalySettings::default();
        let rows = [Row(5, 95.0, 1000, 0, 0, 0, 0, 1, ST_RUN)];
        let mut found = 0;
        for i in 0..30u64 {
            let cx = DetCtx { now_ms: i * 1000, dt_s: 1.0, ncpu: 1.0, mem_total: 1 << 34, rows: &rows, procs: &procs, added: &[], cfg: &cfg, self_pid: 999 };
            found += d.on_tick(&cx).iter().filter(|a| a.kind == "cpu_critical").count();
        }
        assert_eq!(found, 1);
    }

    #[test]
    fn allowlist_suppresses() {
        let mut d = Detector::default();
        let mut procs = HashMap::new();
        procs.insert(5, proc(5, "Burner"));
        let cfg = AnomalySettings { allowlist: vec!["burner".into()], ..Default::default() };
        let rows = [Row(5, 99.0, 1000, 0, 0, 0, 0, 1, ST_RUN)];
        for i in 0..40u64 {
            let cx = DetCtx { now_ms: i * 1000, dt_s: 1.0, ncpu: 1.0, mem_total: 1 << 34, rows: &rows, procs: &procs, added: &[], cfg: &cfg, self_pid: 999 };
            assert!(d.on_tick(&cx).is_empty());
        }
    }
}
