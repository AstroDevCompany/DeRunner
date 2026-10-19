use super::*;

pub fn capabilities() -> Capabilities {
    Capabilities {
        os: "macos",
        suspend: true,
        priority: true,
        focus_window: true,
        signature: true,
        open_files: true,
        connections: true,
        per_process_network: true,
        threads: true,
        per_process_network_note: "",
    }
}

pub fn proc_path(pid: u32) -> Option<String> {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr() as *mut _, buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

pub fn thread_count(pid: u32) -> u32 {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
    let n = unsafe {
        libc::proc_pidinfo(pid as i32, libc::PROC_PIDTASKINFO, 0, &mut info as *mut _ as *mut _, size)
    };
    if n == size {
        info.pti_threadnum.max(0) as u32
    } else {
        0
    }
}

/// `open` on an already-running app activates it and raises its windows without any Automation prompt.
pub fn focus_window(_pid: u32, app_path: Option<&str>) -> AppResult<()> {
    let path = app_path.ok_or_else(|| AppError::Unsupported("This process has no window of its own (not an app bundle).".into()))?;
    let ok = std::process::Command::new("/usr/bin/open")
        .arg(path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok { Ok(()) } else { Err(AppError::Other("Could not bring the app to the foreground.".into())) }
}

pub fn signature(path: &str) -> SignatureInfo {
    let mut info = SignatureInfo { supported: true, ..Default::default() };
    let Some((_, err, _)) = run_capture("/usr/bin/codesign", &["-dvv", path]) else {
        info.note = Some("codesign unavailable".into());
        return info;
    };
    if err.contains("not signed at all") {
        return info;
    }
    info.signed = true;
    for line in err.lines() {
        if let Some(v) = line.strip_prefix("Identifier=") {
            info.identifier = Some(v.into());
        } else if let Some(v) = line.strip_prefix("TeamIdentifier=") {
            if v != "not set" {
                info.team_id = Some(v.into());
            }
        } else if let Some(v) = line.strip_prefix("Authority=") {
            info.authority.push(v.into());
        } else if line.starts_with("Signature=adhoc") {
            info.note = Some("Ad-hoc signature (no developer identity)".into());
        }
    }
    info.valid = run_capture("/usr/bin/codesign", &["--verify", "--strict", path]).map(|(_, _, ok)| ok);
    if let Some((_, e, _)) = run_capture("/usr/sbin/spctl", &["--assess", "--type", "execute", "-vv", path]) {
        if e.contains("Notarized Developer ID") {
            info.notarized = Some(true);
        } else if e.contains("source=") {
            info.notarized = Some(false);
        }
    }
    info
}

fn parse_lsof_files(out: &str) -> Vec<OpenFile> {
    let (mut fd, mut kind, mut res) = (String::new(), String::new(), vec![]);
    for l in out.lines() {
        let (tag, val) = l.split_at(1.min(l.len()));
        match tag {
            "f" => {
                fd = val.into();
                kind.clear();
            }
            "t" => kind = val.into(),
            "n" => res.push(OpenFile { fd: fd.clone(), kind: kind.clone(), name: val.into() }),
            _ => {}
        }
    }
    res
}

pub fn open_files(pid: u32) -> Vec<OpenFile> {
    run_capture("/usr/sbin/lsof", &["-nP", "-p", &pid.to_string(), "-F", "ftn"])
        .map(|(o, _, _)| parse_lsof_files(&o))
        .unwrap_or_default()
}

fn parse_lsof_conns(out: &str) -> Vec<Conn> {
    let (mut pid, mut cmd, mut proto, mut res) = (0u32, String::new(), String::new(), vec![]);
    let mut cur: Option<Conn> = None;
    let push = |c: &mut Option<Conn>, res: &mut Vec<Conn>| {
        if let Some(c) = c.take() {
            res.push(c);
        }
    };
    for l in out.lines() {
        if l.is_empty() {
            continue;
        }
        let (tag, val) = l.split_at(1);
        match tag {
            "p" => {
                push(&mut cur, &mut res);
                pid = val.parse().unwrap_or(0);
            }
            "c" => cmd = val.into(),
            "f" => {
                push(&mut cur, &mut res);
                cur = Some(Conn { pid, process: cmd.clone(), ..Default::default() });
            }
            "P" => proto = val.into(),
            "n" => {
                if let Some(c) = cur.as_mut() {
                    c.proto = proto.clone();
                    match val.split_once("->") {
                        Some((l, r)) => {
                            c.local = l.into();
                            c.remote = r.into();
                        }
                        None => c.local = val.into(),
                    }
                }
            }
            "T" => {
                if let (Some(c), Some(st)) = (cur.as_mut(), val.strip_prefix("ST=")) {
                    c.state = st.into();
                }
            }
            _ => {}
        }
    }
    push(&mut cur, &mut res);
    res.retain(|c| !c.local.is_empty());
    res
}

pub fn connections(pid: u32) -> Vec<Conn> {
    run_capture("/usr/sbin/lsof", &["-nP", "-i", "-a", "-p", &pid.to_string(), "-F", "pcfPnT"])
        .map(|(o, _, _)| parse_lsof_conns(&o))
        .unwrap_or_default()
}

pub fn listeners() -> Vec<Conn> {
    let mut all = vec![];
    for args in [
        vec!["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcfPnT"],
        vec!["-nP", "-iUDP", "-F", "pcfPnT"],
    ] {
        if let Some((o, _, _)) = run_capture("/usr/sbin/lsof", &args) {
            all.extend(parse_lsof_conns(&o));
        }
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lsof_conn_parse() {
        let out = "p42\ncnode\nf23\nPTCP\nn*:3000\nTST=LISTEN\nf24\nPTCP\nn127.0.0.1:3000->127.0.0.1:5555\nTST=ESTABLISHED\n";
        let c = parse_lsof_conns(out);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].state, "LISTEN");
        assert_eq!(c[1].remote, "127.0.0.1:5555");
        assert_eq!(c[1].pid, 42);
    }
}
