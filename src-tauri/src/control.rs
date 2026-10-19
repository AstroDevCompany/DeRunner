//! Process controls with safety rails: pid reuse checks and a protected-process guard.
use crate::error::{AppError, AppResult};
use crate::monitor::model::{app_bundle, ProcStatic};
use crate::platform;
use crate::state::Shared;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const PROTECTED: &[&str] = &[
    "kernel_task", "launchd", "windowserver", "loginwindow", "systemd", "init", "csrss.exe", "wininit.exe",
    "winlogon.exe", "services.exe", "lsass.exe", "smss.exe", "system", "securityd", "coreservicesd", "opendirectoryd",
];

pub fn is_protected(name: &str) -> bool {
    PROTECTED.contains(&name.to_lowercase().as_str())
}

/// Resolves and validates the target. Returns its static info.
pub fn check_target(sh: &Shared, pid: u32, start: Option<u64>, allow_protected: bool) -> AppResult<ProcStatic> {
    if pid <= 1 || pid == std::process::id() {
        return Err(AppError::Protected("DeRunner will not act on pid 0/1 or on itself.".into()));
    }
    let p = sh.procs.read().get(&pid).cloned().ok_or_else(|| AppError::NotFound("That process is no longer running.".into()))?;
    if let Some(s) = start {
        if s != 0 && s != p.start {
            return Err(AppError::NotFound("The process with that pid has changed (pid reused).".into()));
        }
    }
    if is_protected(&p.name) && !allow_protected {
        return Err(AppError::Protected(format!("{} is a critical system process. Acting on it can crash or log you out of the machine.", p.name)));
    }
    Ok(p)
}

/// Descendants of `pid`, deepest first (safe kill order).
pub fn descendants(procs: &HashMap<u32, ProcStatic>, pid: u32) -> Vec<u32> {
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs.values() {
        kids.entry(p.ppid).or_default().push(p.pid);
    }
    let mut order = vec![];
    let mut stack = vec![pid];
    while let Some(x) = stack.pop() {
        if let Some(c) = kids.get(&x) {
            for &k in c {
                if k != pid {
                    order.push(k);
                    stack.push(k);
                }
            }
        }
    }
    order.reverse();
    order
}

pub fn terminate(sh: &Shared, pid: u32, start: Option<u64>, force: bool, tree: bool, allow_protected: bool) -> AppResult<u32> {
    check_target(sh, pid, start, allow_protected)?;
    let mut n = 0;
    if tree {
        let procs = sh.procs.read().clone();
        for d in descendants(&procs, pid) {
            if platform::terminate(d, force).is_ok() {
                n += 1;
            }
        }
    }
    platform::terminate(pid, force)?;
    Ok(n + 1)
}

pub fn suspend(sh: &Shared, pid: u32, start: Option<u64>, allow_protected: bool) -> AppResult<()> {
    check_target(sh, pid, start, allow_protected)?;
    platform::suspend(pid)
}
pub fn resume(sh: &Shared, pid: u32, start: Option<u64>) -> AppResult<()> {
    check_target(sh, pid, start, true)?;
    platform::resume(pid)
}

fn wait_exit(pid: u32, max: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < max {
        if !platform::is_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !platform::is_alive(pid)
}

/// Terminates and starts the process again with the same executable, arguments, cwd and environment.
/// Blocking: call from `spawn_blocking`.
pub fn relaunch(sh: &Shared, pid: u32, start: Option<u64>) -> AppResult<u32> {
    let p = check_target(sh, pid, start, false)?;
    let exe = p.exe.clone().ok_or_else(|| AppError::Unsupported("The executable path is unknown, so it cannot be relaunched.".into()))?;

    // Capture everything we need *before* killing.
    let mut sys = System::new();
    let sp = Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[sp]), true, ProcessRefreshKind::everything());
    let (cwd, env, args): (Option<std::path::PathBuf>, Vec<String>, Vec<String>) = match sys.process(sp) {
        Some(proc) => (
            proc.cwd().map(|c| c.to_path_buf()),
            proc.environ().iter().map(|e| e.to_string_lossy().into_owned()).collect(),
            proc.cmd().iter().skip(1).map(|a| a.to_string_lossy().into_owned()).collect(),
        ),
        None => (None, vec![], p.cmd.iter().skip(1).cloned().collect()),
    };

    // App bundles: relaunch via LaunchServices (`open`) so the app comes up properly. Helper processes
    // inside a bundle can't be relaunched on their own.
    let bundle = app_bundle(&exe);
    let is_main_app = bundle.as_ref().is_some_and(|(_, path)| !exe[path.len()..].contains(".app/"));
    if let Some((_, _)) = &bundle {
        if !is_main_app {
            return Err(AppError::Unsupported("This is a helper process inside an app. Relaunch the main app instead.".into()));
        }
    }

    platform::terminate(pid, false)?;
    if !wait_exit(pid, Duration::from_secs(4)) {
        platform::terminate(pid, true)?;
        if !wait_exit(pid, Duration::from_secs(2)) {
            return Err(AppError::Other("The process did not exit, so it was not relaunched.".into()));
        }
    }

    #[cfg(target_os = "macos")]
    if let Some((_, path)) = bundle {
        std::process::Command::new("/usr/bin/open").arg(&path).status()?;
        return Ok(0);
    }

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    if !env.is_empty() {
        cmd.env_clear();
        for e in env {
            if let Some((k, v)) = e.split_once('=') {
                cmd.env(k, v);
            }
        }
    }
    Ok(platform::spawn_detached(&mut cmd)?)
}
