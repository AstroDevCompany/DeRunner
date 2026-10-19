use crate::anomaly::Anomaly;
use crate::monitor::{history::HistoryStore, model::*, netio::NetTop};
use crate::rules::RuleEvent;
use crate::settings::Settings;
use crate::store::Store;
use crate::tracking;
use parking_lot::{Condvar, Mutex, RwLock};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;

pub struct Shared {
    pub visible: AtomicBool,
    pub paused: AtomicBool,
    pub force_full: AtomicBool,
    pub channel: Mutex<Option<Channel<Snapshot>>>,
    pub procs: RwLock<HashMap<u32, ProcStatic>>,
    pub rows: RwLock<HashMap<u32, Row>>,
    pub sys: RwLock<SysStats>,
    pub history: RwLock<HistoryStore>,
    pub anomalies: Mutex<VecDeque<Anomaly>>,
    pub rules_log: Mutex<VecDeque<RuleEvent>>,
    pub tracking: Mutex<tracking::Manager>,
    pub net: NetTop,
    wake: (Mutex<bool>, Condvar),
}

impl Shared {
    pub fn new() -> Self {
        Self {
            visible: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            force_full: AtomicBool::new(true),
            channel: Mutex::new(None),
            procs: RwLock::new(HashMap::new()),
            rows: RwLock::new(HashMap::new()),
            sys: RwLock::new(SysStats::default()),
            history: RwLock::new(HistoryStore::default()),
            anomalies: Mutex::new(VecDeque::new()),
            rules_log: Mutex::new(VecDeque::new()),
            tracking: Mutex::new(tracking::Manager::default()),
            net: NetTop::default(),
            wake: (Mutex::new(false), Condvar::new()),
        }
    }

    /// Wakes the sampler so it re-evaluates its cadence immediately.
    pub fn poke(&self) {
        *self.wake.0.lock() = true;
        self.wake.1.notify_all();
    }

    /// Sleeps up to `dur`; returns true if woken early by `poke`.
    pub fn wait(&self, dur: Duration) -> bool {
        let mut g = self.wake.0.lock();
        if !*g {
            self.wake.1.wait_for(&mut g, dur);
        }
        std::mem::replace(&mut *g, false)
    }
}

pub struct AppState {
    pub settings: RwLock<Settings>,
    pub config_dir: PathBuf,
    pub shared: Arc<Shared>,
    pub store: Store,
    pub ai_tasks: Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>,
    pub next_id: AtomicU64,
    pub update_cache: Mutex<Option<crate::update::UpdateInfo>>,
}
