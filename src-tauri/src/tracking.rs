//! Tracking sessions: manual or timed detailed telemetry recording for selected processes.
use crate::anomaly::Anomaly;
use crate::error::AppResult;
use crate::monitor::model::*;
use crate::report::{self, Agg, TargetInput};
use crate::store::{EventRow, SampleRow, Store, TargetMeta};
use crate::thresholds::{level, Level};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

const MAX_EVENTS: usize = 2000;
const MAX_SESSION_MS: u64 = 6 * 3600 * 1000;
const FLUSH_MS: u64 = 10_000;

struct TargetRun {
    meta: TargetMeta,
    alive: bool,
    members: HashSet<u32>,
    series: Vec<Agg>,
    cpu_lvl: Level,
    mem_lvl: Level,
    last_status: u8,
}

struct Active {
    id: i64,
    name: String,
    started: u64,
    ends: Option<u64>,
    include_children: bool,
    targets: Vec<TargetRun>,
    events: Vec<EventRow>,
    flushed_events: usize,
    pending: Vec<SampleRow>,
    last_flush: u64,
}

pub struct TickCtx<'a> {
    pub now_ms: u64,
    pub rows: &'a HashMap<u32, Row>,
    pub procs: &'a HashMap<u32, ProcStatic>,
    pub children: &'a HashMap<u32, Vec<u32>>,
    pub ncpu: u32,
    pub mem_total: u64,
}

pub struct Finished {
    pub id: i64,
    pub status: String,
}

#[derive(Serialize, Clone)]
pub struct ActiveInfo {
    pub id: i64,
    pub name: String,
    pub started_at: u64,
    pub ends_at: Option<u64>,
    pub include_children: bool,
    pub targets: Vec<ActiveTarget>,
}
#[derive(Serialize, Clone)]
pub struct ActiveTarget {
    pub pid: u32,
    pub name: String,
    pub alive: bool,
}

#[derive(Default)]
pub struct Manager {
    active: Vec<Active>,
    ncpu: u32,
    mem_total: u64,
}

fn ev(t: u64, pid: u32, kind: &str, sev: &str, msg: String) -> EventRow {
    EventRow { t, pid, kind: kind.into(), severity: sev.into(), message: msg }
}

impl Active {
    fn push(&mut self, e: EventRow) {
        if self.events.len() < MAX_EVENTS {
            self.events.push(e);
        }
    }

    fn flush(&mut self, store: &Store, now: u64) {
        let _ = store.insert_samples(self.id, &self.pending);
        self.pending.clear();
        let _ = store.insert_events(self.id, &self.events[self.flushed_events..]);
        self.flushed_events = self.events.len();
        self.last_flush = now;
    }
}

impl Manager {
    pub fn has_active(&self) -> bool {
        !self.active.is_empty()
    }

    pub fn active(&self) -> Vec<ActiveInfo> {
        self.active
            .iter()
            .map(|a| ActiveInfo {
                id: a.id,
                name: a.name.clone(),
                started_at: a.started,
                ends_at: a.ends,
                include_children: a.include_children,
                targets: a.targets.iter().map(|t| ActiveTarget { pid: t.meta.pid, name: t.meta.name.clone(), alive: t.alive }).collect(),
            })
            .collect()
    }

    pub fn start(&mut self, store: &Store, name: String, targets: Vec<TargetMeta>, include_children: bool, limit_s: Option<u64>, now: u64) -> AppResult<i64> {
        let id = store.create_session(&name, now, limit_s, include_children, &targets)?;
        let mut a = Active {
            id,
            name,
            started: now,
            ends: limit_s.map(|s| now + s * 1000),
            include_children,
            targets: targets
                .into_iter()
                .map(|meta| TargetRun { meta, alive: true, members: HashSet::new(), series: vec![], cpu_lvl: Level::Normal, mem_lvl: Level::Normal, last_status: ST_RUN })
                .collect(),
            events: vec![],
            flushed_events: 0,
            pending: vec![],
            last_flush: now,
        };
        let msg = match limit_s {
            Some(s) => format!("Session started (auto-stops after {}s)", s),
            None => "Session started (manual)".into(),
        };
        a.push(ev(now, 0, "session", "info", msg));
        self.active.push(a);
        Ok(id)
    }

    /// Records a user/system action against any session that tracks `pid`.
    pub fn log_pid_event(&mut self, pid: u32, kind: &str, sev: &str, msg: &str, now: u64) {
        for a in &mut self.active {
            if a.targets.iter().any(|t| t.members.contains(&pid) || t.meta.pid == pid) {
                a.push(ev(now, pid, kind, sev, msg.to_string()));
            }
        }
    }

    pub fn note_anomaly(&mut self, an: &Anomaly) {
        for a in &mut self.active {
            if a.targets.iter().any(|t| t.members.contains(&an.pid)) {
                let sev = an.severity.clone();
                a.push(ev(an.ts, an.pid, "anomaly", &sev, format!("{} ({})", an.title, an.kind)));
            }
        }
    }

    pub fn on_tick(&mut self, store: &Store, cx: &TickCtx) -> Vec<Finished> {
        self.ncpu = cx.ncpu;
        self.mem_total = cx.mem_total;
        let mut done = vec![];
        let mut i = 0;
        while i < self.active.len() {
            let finish: Option<&str> = {
                let a = &mut self.active[i];
                Self::tick_one(a, cx);
                if cx.now_ms.saturating_sub(a.last_flush) >= FLUSH_MS {
                    a.flush(store, cx.now_ms);
                }
                if a.targets.iter().all(|t| !t.alive) {
                    Some("exited")
                } else if a.ends.is_some_and(|e| cx.now_ms >= e) || cx.now_ms.saturating_sub(a.started) > MAX_SESSION_MS {
                    Some("completed")
                } else {
                    None
                }
            };
            match finish {
                Some(status) => {
                    let a = self.active.remove(i);
                    done.push(Self::finish(store, a, status, cx.now_ms, cx.ncpu, cx.mem_total));
                }
                None => i += 1,
            }
        }
        done
    }

    pub fn stop(&mut self, store: &Store, id: i64, now: u64) -> Option<Finished> {
        let idx = self.active.iter().position(|a| a.id == id)?;
        let a = self.active.remove(idx);
        Some(Self::finish(store, a, "stopped", now, self.ncpu.max(1), self.mem_total))
    }

    pub fn stop_all(&mut self, store: &Store, now: u64) -> Vec<Finished> {
        let ids: Vec<i64> = self.active.iter().map(|a| a.id).collect();
        ids.into_iter().filter_map(|id| self.stop(store, id, now)).collect()
    }

    fn tick_one(a: &mut Active, cx: &TickCtx) {
        let now = cx.now_ms;
        let include_children = a.include_children;
        let mut new_events: Vec<EventRow> = vec![];
        for t in &mut a.targets {
            if !t.alive {
                continue;
            }
            let root = t.meta.pid;
            let live = cx.procs.get(&root).is_some_and(|p| t.meta.start == 0 || p.start == t.meta.start);
            if !live {
                t.alive = false;
                t.members.clear();
                new_events.push(ev(now, root, "exit", "warn", format!("{} (pid {root}) exited", t.meta.name)));
                continue;
            }
            let mut members: HashSet<u32> = HashSet::new();
            members.insert(root);
            if include_children {
                let mut stack = vec![root];
                while let Some(p) = stack.pop() {
                    if let Some(ch) = cx.children.get(&p) {
                        for &c in ch {
                            if members.insert(c) {
                                stack.push(c);
                            }
                        }
                    }
                }
            }
            if !t.members.is_empty() {
                let spawned: Vec<u32> = members.difference(&t.members).copied().collect();
                let gone: Vec<u32> = t.members.difference(&members).copied().collect();
                let name_of = |p: u32| cx.procs.get(&p).map(|x| x.name.as_str()).unwrap_or("?").to_string();
                if spawned.len() > 8 {
                    new_events.push(ev(now, root, "child_spawn", "info", format!("{} child processes started at once", spawned.len())));
                } else {
                    for p in spawned {
                        new_events.push(ev(now, p, "child_spawn", "info", format!("Child started: {} (pid {p})", name_of(p))));
                    }
                }
                if gone.len() > 8 {
                    new_events.push(ev(now, root, "child_exit", "info", format!("{} child processes exited at once", gone.len())));
                } else {
                    for p in gone {
                        // name is no longer in procs; keep it generic.
                        new_events.push(ev(now, p, "child_exit", "info", format!("Child exited (pid {p})")));
                    }
                }
            }
            let mut g = Agg { t: now, ..Default::default() };
            for p in &members {
                if let Some(r) = cx.rows.get(p) {
                    g.cpu += r.cpu_raw();
                    g.mem += r.mem();
                    g.dr += r.disk_r();
                    g.dw += r.disk_w();
                    g.nr += r.net_rx();
                    g.nw += r.net_tx();
                    g.thr += r.threads();
                    g.n += 1;
                }
            }
            if let Some(r) = cx.rows.get(&root) {
                if r.status() != t.last_status {
                    if r.status() == ST_STOP {
                        new_events.push(ev(now, root, "suspended", "warn", format!("{} was suspended", t.meta.name)));
                    } else if t.last_status == ST_STOP {
                        new_events.push(ev(now, root, "resumed", "info", format!("{} resumed", t.meta.name)));
                    }
                    t.last_status = r.status();
                }
            }
            let cpu_l = level(g.cpu as f64 / cx.ncpu.max(1) as f64);
            let mem_l = level(if cx.mem_total > 0 { g.mem as f64 / cx.mem_total as f64 * 100.0 } else { 0.0 });
            if cpu_l != t.cpu_lvl {
                if cpu_l > t.cpu_lvl {
                    new_events.push(ev(now, root, "cpu_level", if cpu_l == Level::Critical { "critical" } else { "warn" }, format!("{} CPU entered {:?} range ({:.0}%)", t.meta.name, cpu_l, g.cpu as f64 / cx.ncpu.max(1) as f64)));
                }
                t.cpu_lvl = cpu_l;
            }
            if mem_l != t.mem_lvl {
                if mem_l > t.mem_lvl {
                    new_events.push(ev(now, root, "mem_level", if mem_l == Level::Critical { "critical" } else { "warn" }, format!("{} memory entered {:?} range ({:.0} MB)", t.meta.name, mem_l, g.mem as f64 / 1_048_576.0)));
                }
                t.mem_lvl = mem_l;
            }
            a.pending.push(SampleRow { t: now, pid: root, cpu: g.cpu, mem: g.mem, dr: g.dr, dw: g.dw, nr: g.nr, nw: g.nw, thr: g.thr, n: g.n });
            t.series.push(g);
            t.members = members;
        }
        for e in new_events {
            a.push(e);
        }
    }

    fn finish(store: &Store, mut a: Active, status: &str, now: u64, ncpu: u32, mem_total: u64) -> Finished {
        a.push(ev(now, 0, "session", "info", format!("Session {status}")));
        a.flush(store, now);
        let inputs: Vec<TargetInput> = a.targets.iter().map(|t| TargetInput { meta: &t.meta, series: &t.series, exited: !t.alive }).collect();
        let rep = report::build(&a.name, a.started, now, status, ncpu, mem_total, &inputs, &a.events);
        if let Ok(v) = serde_json::to_value(&rep) {
            let _ = store.finish_session(a.id, now, status, &v);
        }
        let _ = rep;
        Finished { id: a.id, status: status.into() }
    }
}

// Level needs ordering for "escalation" checks.
impl PartialOrd for Level {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some((*self as u8).cmp(&(*o as u8)))
    }
}
