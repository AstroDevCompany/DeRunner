use super::*;
use std::collections::HashMap;

pub fn capabilities() -> Capabilities {
    Capabilities {
        os: "linux",
        suspend: true,
        priority: true,
        focus_window: true,
        signature: true,
        open_files: true,
        connections: true,
        per_process_network: false,
        threads: true,
        per_process_network_note: "Per-process network usage needs eBPF/netlink accounting on Linux; system totals are shown.",
    }
}

pub fn proc_path(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|p| p.to_string_lossy().into_owned())
}

pub fn thread_count(pid: u32) -> u32 {
    std::fs::read_dir(format!("/proc/{pid}/task")).map(|d| d.count() as u32).unwrap_or(0)
}

pub fn focus_window(pid: u32, _app: Option<&str>) -> AppResult<()> {
    let found = run_capture("xdotool", &["search", "--onlyvisible", "--pid", &pid.to_string()])
        .map(|(o, _, ok)| (o, ok));
    match found {
        Some((o, true)) if !o.trim().is_empty() => {
            let id = o.lines().next().unwrap_or("").trim().to_string();
            run_capture("xdotool", &["windowactivate", &id]);
            Ok(())
        }
        Some(_) => Err(AppError::NotFound("No visible window found for this process.".into())),
        None => Err(AppError::Unsupported("Focusing windows needs `xdotool` (X11). Not available on Wayland.".into())),
    }
}

pub fn signature(path: &str) -> SignatureInfo {
    let mut info = SignatureInfo { supported: true, ..Default::default() };
    let owner = run_capture("dpkg", &["-S", path])
        .filter(|(_, _, ok)| *ok)
        .map(|(o, _, _)| o)
        .or_else(|| run_capture("rpm", &["-qf", path]).filter(|(_, _, ok)| *ok).map(|(o, _, _)| o));
    match owner {
        Some(o) => info.note = Some(format!("Installed by package: {}", o.lines().next().unwrap_or("").trim())),
        None => info.note = Some("Not owned by a system package (no signature model on Linux).".into()),
    }
    info
}

pub fn open_files(pid: u32) -> Vec<OpenFile> {
    let Ok(rd) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return vec![] };
    rd.flatten()
        .filter_map(|e| {
            let t = std::fs::read_link(e.path()).ok()?.to_string_lossy().into_owned();
            let kind = if t.starts_with("socket:") { "SOCK" } else if t.starts_with("pipe:") { "PIPE" } else if t.starts_with("anon_inode:") { "ANON" } else { "REG" };
            Some(OpenFile { fd: e.file_name().to_string_lossy().into_owned(), kind: kind.into(), name: t })
        })
        .collect()
}

fn hex_addr(s: &str, v6: bool) -> String {
    let Some((a, p)) = s.split_once(':') else { return s.into() };
    let port = u16::from_str_radix(p, 16).unwrap_or(0);
    if v6 {
        format!("[{}]:{port}", a.to_lowercase())
    } else {
        let n = u32::from_str_radix(a, 16).unwrap_or(0).to_le_bytes();
        format!("{}.{}.{}.{}:{port}", n[0], n[1], n[2], n[3])
    }
}

fn tcp_state(code: &str) -> &'static str {
    match code {
        "01" => "ESTABLISHED", "02" => "SYN_SENT", "03" => "SYN_RECV", "04" => "FIN_WAIT1",
        "05" => "FIN_WAIT2", "06" => "TIME_WAIT", "07" => "CLOSE", "08" => "CLOSE_WAIT",
        "09" => "LAST_ACK", "0A" => "LISTEN", "0B" => "CLOSING", _ => "",
    }
}

fn socket_table() -> HashMap<String, Conn> {
    let mut m = HashMap::new();
    for (file, proto, v6) in [("tcp", "TCP", false), ("tcp6", "TCP", true), ("udp", "UDP", false), ("udp6", "UDP", true)] {
        let Ok(txt) = std::fs::read_to_string(format!("/proc/net/{file}")) else { continue };
        for l in txt.lines().skip(1) {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 10 {
                continue;
            }
            m.insert(
                f[9].to_string(),
                Conn {
                    proto: proto.into(),
                    local: hex_addr(f[1], v6),
                    remote: hex_addr(f[2], v6),
                    state: if proto == "TCP" { tcp_state(f[3]).into() } else { String::new() },
                    ..Default::default()
                },
            );
        }
    }
    m
}

pub fn connections(pid: u32) -> Vec<Conn> {
    let table = socket_table();
    let Ok(rd) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return vec![] };
    rd.flatten()
        .filter_map(|e| {
            let t = std::fs::read_link(e.path()).ok()?.to_string_lossy().into_owned();
            let inode = t.strip_prefix("socket:[")?.strip_suffix(']')?.to_string();
            let mut c = table.get(&inode)?.clone();
            c.pid = pid;
            Some(c)
        })
        .collect()
}

pub fn listeners() -> Vec<Conn> {
    let mut res = vec![];
    if let Some((out, _, true)) = run_capture("ss", &["-H", "-ltunp"]) {
        for l in out.lines() {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 5 {
                continue;
            }
            let pid = l.split("pid=").nth(1).and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next()).and_then(|s| s.parse().ok()).unwrap_or(0);
            res.push(Conn { pid, proto: f[0].to_uppercase(), local: f[4].into(), remote: String::new(), state: "LISTEN".into(), process: String::new() });
        }
    }
    res
}
