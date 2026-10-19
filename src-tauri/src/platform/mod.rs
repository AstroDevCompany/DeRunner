//! Platform abstraction. Shared logic lives here; OS specifics in `unix`, `macos`, `linux`, `windows`.
//! Every capability is reported through `capabilities()` so the UI can hide unsupported controls.
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::process::{Command, Stdio};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[derive(Serialize, Clone, Debug)]
pub struct Capabilities {
    pub os: &'static str,
    pub suspend: bool,
    pub priority: bool,
    pub focus_window: bool,
    pub signature: bool,
    pub open_files: bool,
    pub connections: bool,
    pub per_process_network: bool,
    pub threads: bool,
    pub per_process_network_note: &'static str,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct PriorityInfo {
    pub level: Option<String>,
    /// nice value on unix, priority class name on Windows
    pub raw: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SignatureInfo {
    pub supported: bool,
    pub signed: bool,
    pub valid: Option<bool>,
    pub notarized: Option<bool>,
    pub identifier: Option<String>,
    pub team_id: Option<String>,
    pub authority: Vec<String>,
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct OpenFile {
    pub fd: String,
    pub kind: String,
    pub name: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Conn {
    pub pid: u32,
    pub process: String,
    pub proto: String,
    pub local: String,
    pub remote: String,
    pub state: String,
}

/// Runs a command, returning stdout+stderr on success of *spawning* (exit status is ignored).
pub fn run_capture(cmd: &str, args: &[&str]) -> Option<(String, String, bool)> {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().ok()?;
    Some((
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.success(),
    ))
}

pub fn level_to_nice(level: &str) -> AppResult<i32> {
    Ok(match level {
        "low" => 19,
        "below_normal" => 10,
        "normal" => 0,
        "above_normal" => -5,
        "high" => -10,
        other => return Err(AppError::Invalid(format!("unknown priority '{other}'"))),
    })
}

pub fn nice_to_level(n: i32) -> &'static str {
    match n {
        15..=40 => "low",
        5..=14 => "below_normal",
        -2..=4 => "normal",
        -7..=-3 => "above_normal",
        _ => "high",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nice_roundtrip() {
        for l in ["low", "below_normal", "normal", "above_normal", "high"] {
            assert_eq!(nice_to_level(level_to_nice(l).unwrap()), l);
        }
    }
}
