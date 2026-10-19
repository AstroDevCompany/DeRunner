use super::*;
use ::windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM};
use ::windows::Win32::System::Threading::*;
use ::windows::Win32::UI::WindowsAndMessaging::*;
use std::ffi::c_void;

#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(h: *mut c_void) -> i32;
    fn NtResumeProcess(h: *mut c_void) -> i32;
}

pub fn capabilities() -> Capabilities {
    Capabilities {
        os: "windows",
        suspend: true,
        priority: true,
        focus_window: true,
        signature: true,
        open_files: false,
        connections: true,
        per_process_network: false,
        threads: false,
        per_process_network_note: "Per-process network needs ETW; system totals are shown.",
    }
}

fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> AppResult<HANDLE> {
    unsafe { OpenProcess(access, false, pid) }
        .map_err(|_| AppError::PermissionDenied("Access denied. Try running DeRunner as Administrator.".into()))
}

pub fn proc_path(_pid: u32) -> Option<String> {
    None
}
pub fn thread_count(_pid: u32) -> u32 {
    0
}
pub fn is_alive(pid: u32) -> bool {
    open(pid, PROCESS_QUERY_LIMITED_INFORMATION).map(|h| unsafe { let _ = CloseHandle(h); }).is_ok()
}

pub fn suspend(pid: u32) -> AppResult<()> {
    let h = open(pid, PROCESS_SUSPEND_RESUME)?;
    unsafe {
        let r = NtSuspendProcess(h.0);
        let _ = CloseHandle(h);
        if r < 0 { return Err(AppError::Other("Suspend failed".into())); }
    }
    Ok(())
}
pub fn resume(pid: u32) -> AppResult<()> {
    let h = open(pid, PROCESS_SUSPEND_RESUME)?;
    unsafe {
        let r = NtResumeProcess(h.0);
        let _ = CloseHandle(h);
        if r < 0 { return Err(AppError::Other("Resume failed".into())); }
    }
    Ok(())
}
pub fn terminate(pid: u32, force: bool) -> AppResult<()> {
    let p = pid.to_string();
    let args: Vec<&str> = if force { vec!["/PID", &p, "/F"] } else { vec!["/PID", &p] };
    match run_capture("taskkill", &args) {
        Some((_, _, true)) => Ok(()),
        Some((o, e, false)) => Err(AppError::PermissionDenied(format!("{}{}", o.trim(), e.trim()))),
        None => Err(AppError::Other("taskkill unavailable".into())),
    }
}

fn class_of(level: &str) -> AppResult<PROCESS_CREATION_FLAGS> {
    Ok(match level {
        "low" => IDLE_PRIORITY_CLASS,
        "below_normal" => BELOW_NORMAL_PRIORITY_CLASS,
        "normal" => NORMAL_PRIORITY_CLASS,
        "above_normal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "high" => HIGH_PRIORITY_CLASS,
        o => return Err(AppError::Invalid(format!("unknown priority '{o}'"))),
    })
}

pub fn set_priority(pid: u32, level: &str) -> AppResult<()> {
    let class = class_of(level)?;
    let h = open(pid, PROCESS_SET_INFORMATION)?;
    let r = unsafe { SetPriorityClass(h, class) };
    unsafe { let _ = CloseHandle(h); }
    r.map_err(|_| AppError::PermissionDenied("Could not change priority (access denied).".into()))
}

pub fn get_priority(pid: u32) -> Option<PriorityInfo> {
    let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    let c = unsafe { GetPriorityClass(h) };
    unsafe { let _ = CloseHandle(h); }
    let (level, raw) = match PROCESS_CREATION_FLAGS(c) {
        IDLE_PRIORITY_CLASS => ("low", "Idle"),
        BELOW_NORMAL_PRIORITY_CLASS => ("below_normal", "Below normal"),
        NORMAL_PRIORITY_CLASS => ("normal", "Normal"),
        ABOVE_NORMAL_PRIORITY_CLASS => ("above_normal", "Above normal"),
        HIGH_PRIORITY_CLASS => ("high", "High"),
        REALTIME_PRIORITY_CLASS => ("high", "Realtime"),
        _ => return None,
    };
    Some(PriorityInfo { level: Some(level.into()), raw: raw.into() })
}

struct Find { pid: u32, hwnd: Option<HWND> }
unsafe extern "system" fn enum_cb(hwnd: HWND, lp: LPARAM) -> BOOL {
    let f = &mut *(lp.0 as *mut Find);
    let mut p = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut p));
    if p == f.pid && IsWindowVisible(hwnd).as_bool() && GetWindow(hwnd, GW_OWNER).map(|o| o.0.is_null()).unwrap_or(true) {
        f.hwnd = Some(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}

pub fn focus_window(pid: u32, _app: Option<&str>) -> AppResult<()> {
    let mut f = Find { pid, hwnd: None };
    unsafe { let _ = EnumWindows(Some(enum_cb), LPARAM(&mut f as *mut _ as isize)); }
    let Some(h) = f.hwnd else { return Err(AppError::NotFound("No visible window found for this process.".into())) };
    unsafe {
        if IsIconic(h).as_bool() { let _ = ShowWindow(h, SW_RESTORE); }
        let _ = SetForegroundWindow(h);
    }
    Ok(())
}

pub fn signature(path: &str) -> SignatureInfo {
    let mut info = SignatureInfo { supported: true, ..Default::default() };
    let script = format!(
        "$s=Get-AuthenticodeSignature -LiteralPath '{}'; \"$($s.Status)|$($s.SignerCertificate.Subject)\"",
        path.replace('\'', "''")
    );
    if let Some((o, _, _)) = run_capture("powershell", &["-NoProfile", "-NonInteractive", "-Command", &script]) {
        let line = o.trim();
        let (status, subject) = line.split_once('|').unwrap_or((line, ""));
        info.signed = status != "NotSigned" && status != "UnknownError";
        info.valid = Some(status == "Valid");
        if !subject.is_empty() { info.authority.push(subject.into()); }
    }
    info
}

pub fn open_files(_pid: u32) -> Vec<OpenFile> {
    vec![]
}

fn netstat() -> Vec<Conn> {
    let Some((out, _, _)) = run_capture("netstat", &["-ano"]) else { return vec![] };
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            match f.as_slice() {
                [p @ ("TCP" | "UDP"), local, remote, state, pid] if *p == "TCP" => Some(Conn { pid: pid.parse().ok()?, proto: "TCP".into(), local: local.to_string(), remote: remote.to_string(), state: state.to_string(), process: String::new() }),
                ["UDP", local, remote, pid] => Some(Conn { pid: pid.parse().ok()?, proto: "UDP".into(), local: local.to_string(), remote: remote.to_string(), state: String::new(), process: String::new() }),
                _ => None,
            }
        })
        .collect()
}

pub fn connections(pid: u32) -> Vec<Conn> {
    netstat().into_iter().filter(|c| c.pid == pid).collect()
}
pub fn listeners() -> Vec<Conn> {
    netstat().into_iter().filter(|c| c.state == "LISTENING" || c.proto == "UDP").collect()
}

pub fn spawn_detached(cmd: &mut std::process::Command) -> std::io::Result<u32> {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0000_0008 | 0x0000_0200).spawn().map(|c| c.id())
}
