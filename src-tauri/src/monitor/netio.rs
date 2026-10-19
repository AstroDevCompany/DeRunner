//! Per-process network throughput. macOS only (via `nettop`), started on demand and stopped when not needed.
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Default)]
pub struct NetTop {
    map: Arc<Mutex<HashMap<u32, (u64, u64)>>>,
    /// The currently running one-shot nettop (killed on stop so the poller exits promptly).
    current: Arc<Mutex<Option<std::process::Child>>>,
    /// Generation counter: bumping it retires any running poller thread (safe against rapid on/off/on).
    generation: Arc<std::sync::atomic::AtomicU64>,
    running: std::sync::atomic::AtomicBool,
}

impl NetTop {
    pub fn supported() -> bool {
        cfg!(target_os = "macos")
    }

    pub fn is_running(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Per-second (rx, tx) by pid from the most recent complete nettop sample.
    pub fn snapshot(&self) -> HashMap<u32, (u64, u64)> {
        self.map.lock().clone()
    }

    pub fn set_enabled(&self, on: bool) {
        if !Self::supported() {
            return;
        }
        use std::sync::atomic::Ordering::SeqCst;
        if on && !self.running.swap(true, SeqCst) {
            let _ = self.start();
        } else if !on && self.running.swap(false, SeqCst) {
            self.generation.fetch_add(1, SeqCst);
            if let Some(c) = self.current.lock().as_mut() {
                let _ = c.kill();
            }
            self.map.lock().clear();
        }
    }

    /// `nettop` in continuous mode busy-loops at >100% CPU, but a one-shot `-L 1` costs ~0.02 CPU-seconds
    /// (it waits ~5 s for data). So we run one-shot snapshots back to back and diff the cumulative
    /// counters ourselves: rates have ~5 s resolution at almost zero cost.
    #[cfg(target_os = "macos")]
    fn start(&self) -> Option<std::process::Child> {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        use std::time::Instant;
        let map = self.map.clone();
        let current = self.current.clone();
        let generation = self.generation.clone();
        let my_gen = generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let stop = move || generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen;
        std::thread::Builder::new()
            .name("nettop-poller".into())
            .spawn(move || {
                let mut prev: HashMap<u32, (u64, u64)> = HashMap::new();
                let mut prev_at: Option<Instant> = None;
                while !stop() {
                    let Ok(mut child) = Command::new("/usr/bin/nettop")
                        .args(["-P", "-L", "1", "-J", "bytes_in,bytes_out", "-x"])
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null())
                        .stdin(Stdio::null())
                        .spawn()
                    else {
                        return;
                    };
                    let Some(out) = child.stdout.take() else { return };
                    *current.lock() = Some(child);
                    let mut cur: HashMap<u32, (u64, u64)> = HashMap::new();
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        if line.starts_with(",bytes_in") {
                            continue;
                        }
                        let mut it = line.split(',');
                        let (Some(name), Some(i), Some(o)) = (it.next(), it.next(), it.next()) else { continue };
                        let Some(pid) = name.rsplit('.').next().and_then(|p| p.parse::<u32>().ok()) else { continue };
                        cur.insert(pid, (i.parse().unwrap_or(0), o.parse().unwrap_or(0)));
                    }
                    if let Some(mut c) = current.lock().take() {
                        let _ = c.wait();
                    }
                    if stop() || cur.is_empty() {
                        continue;
                    }
                    let now = Instant::now();
                    if let Some(at) = prev_at {
                        let dt = now.duration_since(at).as_secs_f64().max(0.5);
                        let rates: HashMap<u32, (u64, u64)> = cur
                            .iter()
                            .map(|(pid, (i, o))| {
                                let (pi, po) = prev.get(pid).copied().unwrap_or((*i, *o));
                                (*pid, ((i.saturating_sub(pi) as f64 / dt) as u64, (o.saturating_sub(po) as f64 / dt) as u64))
                            })
                            .collect();
                        *map.lock() = rates;
                    }
                    prev = cur;
                    prev_at = Some(now);
                }
            })
            .ok()?;
        // The poller owns its child processes; nothing to hand back.
        None
    }

    #[cfg(not(target_os = "macos"))]
    fn start(&self) -> Option<std::process::Child> {
        None
    }
}

impl Drop for NetTop {
    fn drop(&mut self) {
        self.set_enabled(false);
    }
}
