//! Builds the assistant's system prompt + a compact, redacted telemetry snapshot.
use crate::redact;
use crate::state::AppState;
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug, Default)]
pub struct ContextReq {
    pub pid: Option<u32>,
    pub session_id: Option<i64>,
}

pub const PERSONA: &str = "You are the assistant built into DeRunner, a process manager and inspector. \
You explain what processes are and why they use CPU, memory, disk or network, using ONLY the telemetry provided plus well-established OS knowledge. \
Be concise and concrete. Distinguish facts from the telemetry from your inference, and say when you are unsure. \
An unusual pattern is a signal to investigate, never proof of malware; do not call something malicious without strong evidence. \
You cannot act on the machine: suggest actions (terminate, suspend, lower priority, start a tracking session) for the user to perform in DeRunner, and warn when an action is risky. \
Format with short paragraphs or bullet lists; use Markdown.";

fn fmt_mb(b: u64) -> String {
    format!("{:.0} MB", b as f64 / 1_048_576.0)
}

pub fn build(st: &AppState, req: &ContextReq, redact_on: bool) -> String {
    let sh = &st.shared;
    let sys = sh.sys.read().clone();
    let procs = sh.procs.read();
    let rows = sh.rows.read();
    let ncpu = sys.cores.max(1) as f32;
    let rp = |s: &str| if redact_on { redact::home_to_tilde(s) } else { s.to_string() };

    let mut out = String::new();
    out += &format!(
        "## Machine\n- CPU {:.0}% over {} logical cores, load {:.2}/{:.2}/{:.2}\n- Memory {} / {} used, swap {} / {}\n- {} processes, uptime {}h\n",
        sys.cpu, sys.cores, sys.load[0], sys.load[1], sys.load[2], fmt_mb(sys.mem_used), fmt_mb(sys.mem_total), fmt_mb(sys.swap_used), fmt_mb(sys.swap_total), sys.procs, sys.uptime / 3600
    );
    let mut by_cpu: Vec<_> = rows.values().collect();
    by_cpu.sort_by(|a, b| b.cpu_raw().partial_cmp(&a.cpu_raw()).unwrap());
    out += "\n## Top CPU\n";
    for r in by_cpu.iter().take(8) {
        if let Some(p) = procs.get(&r.pid()) {
            out += &format!("- {} (pid {}): {:.1}% of machine, {}\n", p.name, p.pid, r.cpu_raw() / ncpu, fmt_mb(r.mem()));
        }
    }
    by_cpu.sort_by_key(|r| std::cmp::Reverse(r.mem()));
    out += "\n## Top memory\n";
    for r in by_cpu.iter().take(8) {
        if let Some(p) = procs.get(&r.pid()) {
            out += &format!("- {} (pid {}): {}, CPU {:.1}%\n", p.name, p.pid, fmt_mb(r.mem()), r.cpu_raw() / ncpu);
        }
    }
    let an = sh.anomalies.lock();
    let recent: Vec<_> = an.iter().filter(|a| !a.dismissed).take(8).collect();
    if !recent.is_empty() {
        out += "\n## Recent anomaly signals (heuristic, not verdicts)\n";
        for a in recent {
            out += &format!("- [{}] {} (pid {}): {}\n", a.severity, a.title, a.pid, a.detail);
        }
    }
    drop(an);

    if let Some(pid) = req.pid {
        if let Some(p) = procs.get(&pid) {
            out += &format!("\n## Selected process: {} (pid {})\n", p.name, pid);
            if let Some(e) = &p.exe {
                out += &format!("- Executable: {}\n", rp(e));
            }
            if !p.cmd.is_empty() {
                let args = if redact_on { redact::cmd_args(&p.cmd) } else { p.cmd.clone() };
                let joined: String = args.join(" ");
                out += &format!("- Command line: {}\n", rp(&joined.chars().take(600).collect::<String>()));
            }
            out += &format!("- User: {}\n", p.user.clone().unwrap_or_else(|| "?".into()));
            if let Some(par) = procs.get(&p.ppid) {
                out += &format!("- Parent: {} (pid {})\n", par.name, par.pid);
            }
            let kids = procs.values().filter(|c| c.ppid == pid).count();
            out += &format!("- Child processes: {kids}\n");
            if let Some(r) = rows.get(&pid) {
                out += &format!(
                    "- Now: CPU {:.1}% of machine, memory {}, threads {}, disk R/W {}/{} KB/s, net in/out {}/{} KB/s, status code {}\n",
                    r.cpu_raw() / ncpu, fmt_mb(r.mem()), r.threads(), r.disk_r() / 1024, r.disk_w() / 1024, r.net_rx() / 1024, r.net_tx() / 1024, r.status()
                );
            }
            let h = sh.history.read().series(pid, "hi");
            if h.t.len() > 5 {
                let n = h.t.len() as f32;
                let avg = h.cpu.iter().sum::<f32>() / n / ncpu;
                let max = h.cpu.iter().cloned().fold(0.0, f32::max) / ncpu;
                out += &format!(
                    "- Last {} s: CPU avg {:.1}% / max {:.1}%, memory {} → {}\n",
                    h.t.last().unwrap() - h.t[0], avg, max, fmt_mb(h.mem[0] as u64 * 1024), fmt_mb(*h.mem.last().unwrap() as u64 * 1024)
                );
            }
        }
    }
    if let Some(id) = req.session_id {
        if let Ok(d) = st.store.get_session(id) {
            if let Some(r) = d.report {
                out += &format!("\n## Tracking session report (JSON)\n{}\n", serde_json::to_string(&r).unwrap_or_default().chars().take(8000).collect::<String>());
            }
        }
    }
    out
}
