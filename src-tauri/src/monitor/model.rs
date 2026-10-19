use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default)]
pub struct ProcStatic {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub exe: Option<String>,
    pub cmd: Vec<String>,
    pub user: Option<String>,
    /// Unix epoch seconds. (pid, start) identifies a process even after pid reuse.
    pub start: u64,
    /// Display name of the enclosing `.app` bundle, if any.
    pub app: Option<String>,
    pub app_path: Option<String>,
}

/// Compact dynamic row, serialised as an array:
/// `[pid, cpu_raw, mem_bytes, disk_read_Bps, disk_write_Bps, net_rx_Bps, net_tx_Bps, threads, status]`
/// `cpu_raw` is Activity-Monitor style (100 = one full core).
#[derive(Serialize, Clone, Copy, Debug, Default)]
pub struct Row(pub u32, pub f32, pub u64, pub u64, pub u64, pub u64, pub u64, pub u32, pub u8);

impl Row {
    pub fn pid(&self) -> u32 { self.0 }
    pub fn cpu_raw(&self) -> f32 { self.1 }
    pub fn mem(&self) -> u64 { self.2 }
    pub fn disk_r(&self) -> u64 { self.3 }
    pub fn disk_w(&self) -> u64 { self.4 }
    pub fn net_rx(&self) -> u64 { self.5 }
    pub fn net_tx(&self) -> u64 { self.6 }
    pub fn threads(&self) -> u32 { self.7 }
    pub fn status(&self) -> u8 { self.8 }
}

pub const ST_RUN: u8 = 0;
pub const ST_SLEEP: u8 = 1;
pub const ST_STOP: u8 = 2;
pub const ST_ZOMBIE: u8 = 3;
pub const ST_IDLE: u8 = 4;
pub const ST_OTHER: u8 = 5;

#[derive(Serialize, Clone, Debug, Default)]
pub struct SysStats {
    /// Whole-machine CPU 0..=100.
    pub cpu: f32,
    pub per_core: Vec<f32>,
    pub cores: u32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub disk_r: u64,
    pub disk_w: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub load: [f64; 3],
    pub procs: u32,
    pub uptime: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Snapshot {
    pub ts: u64,
    pub sys: SysStats,
    pub full: bool,
    pub added: Vec<ProcStatic>,
    pub removed: Vec<u32>,
    pub rows: Vec<Row>,
    pub net_supported: bool,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Splits `/Applications/Foo.app/Contents/MacOS/x` into ("Foo", "/Applications/Foo.app").
pub fn app_bundle(exe: &str) -> Option<(String, String)> {
    let idx = exe.find(".app/").or_else(|| exe.strip_suffix(".app").map(|s| s.len()))?;
    let path = &exe[..idx + 4];
    let name = std::path::Path::new(path).file_stem()?.to_string_lossy().to_string();
    Some((name, path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundle() {
        let (n, p) = app_bundle("/Applications/Google Chrome.app/Contents/Frameworks/X.app/Contents/MacOS/h").unwrap();
        assert_eq!(n, "Google Chrome");
        assert_eq!(p, "/Applications/Google Chrome.app");
        assert!(app_bundle("/usr/bin/ls").is_none());
    }
}
