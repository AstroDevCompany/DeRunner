use super::*;

fn errno_to_err(what: &str) -> AppError {
    let e = std::io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::EPERM) | Some(libc::EACCES) => AppError::PermissionDenied(format!(
            "Not permitted to {what} this process. It belongs to another user or is protected; try running DeRunner with elevated privileges."
        )),
        Some(libc::ESRCH) => AppError::NotFound("That process no longer exists.".into()),
        _ => AppError::Other(format!("{what}: {e}")),
    }
}

fn signal(pid: u32, sig: i32, what: &str) -> AppResult<()> {
    if unsafe { libc::kill(pid as i32, sig) } == 0 {
        Ok(())
    } else {
        Err(errno_to_err(what))
    }
}

pub fn suspend(pid: u32) -> AppResult<()> {
    signal(pid, libc::SIGSTOP, "suspend")
}
pub fn resume(pid: u32) -> AppResult<()> {
    signal(pid, libc::SIGCONT, "resume")
}
pub fn terminate(pid: u32, force: bool) -> AppResult<()> {
    signal(pid, if force { libc::SIGKILL } else { libc::SIGTERM }, "terminate")
}
pub fn is_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 || *errno() == libc::EPERM }
}

#[cfg(target_os = "macos")]
unsafe fn errno() -> *mut i32 {
    libc::__error()
}
#[cfg(not(target_os = "macos"))]
unsafe fn errno() -> *mut i32 {
    libc::__errno_location()
}

pub fn set_priority(pid: u32, level: &str) -> AppResult<()> {
    let nice = level_to_nice(level)?;
    let r = unsafe { libc::setpriority(libc::PRIO_PROCESS as _, pid as _, nice) };
    if r == 0 {
        Ok(())
    } else {
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::EPERM) | Some(libc::EACCES) => Err(AppError::PermissionDenied(
                "Unprivileged users may only lower a process's priority. Raising it (including restoring it after lowering) needs administrator rights, or the process belongs to another user.".into(),
            )),
            _ => Err(errno_to_err("change the priority of")),
        }
    }
}

pub fn get_priority(pid: u32) -> Option<PriorityInfo> {
    unsafe {
        *errno() = 0;
        let n = libc::getpriority(libc::PRIO_PROCESS as _, pid as _);
        if n == -1 && *errno() != 0 {
            return None;
        }
        Some(PriorityInfo { level: Some(nice_to_level(n).into()), raw: n.to_string() })
    }
}

pub fn spawn_detached(cmd: &mut std::process::Command) -> std::io::Result<u32> {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|c| c.id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn state(pid: u32) -> String {
        let o = Command::new("ps").args(["-o", "state=", "-p", &pid.to_string()]).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    #[test]
    fn suspend_resume_priority_terminate_roundtrip() {
        let mut child = Command::new("sleep").arg("60").stdin(Stdio::null()).spawn().unwrap();
        let pid = child.id();
        suspend(pid).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(state(pid).starts_with('T'), "expected stopped, got {}", state(pid));
        resume(pid).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!state(pid).starts_with('T'));

        set_priority(pid, "below_normal").unwrap();
        assert_eq!(get_priority(pid).unwrap().raw, "10");
        set_priority(pid, "low").unwrap();
        assert_eq!(get_priority(pid).unwrap().level.as_deref(), Some("low"));
        // Raising above the starting nice needs privileges: must surface a typed error, not panic.
        assert!(matches!(set_priority(pid, "high"), Err(AppError::PermissionDenied(_))) || get_priority(pid).unwrap().level.as_deref() == Some("high"));

        assert!(is_alive(pid));
        terminate(pid, false).unwrap();
        let _ = child.wait();
        assert!(!is_alive(pid) || state(pid).starts_with('Z'));
        assert!(matches!(terminate(pid, true), Err(AppError::NotFound(_)) | Err(AppError::PermissionDenied(_)) | Ok(())));
    }
}
