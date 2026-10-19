//! Deterministic session reports. Always available offline; the AI narrative builds on top of this.
use crate::anomaly::linreg;
use crate::store::{EventRow, TargetMeta};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default)]
pub struct Agg {
    pub t: u64,
    pub cpu: f32, // raw sum (100 = one core)
    pub mem: u64,
    pub dr: u64,
    pub dw: u64,
    pub nr: u64,
    pub nw: u64,
    pub thr: u32,
    pub n: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Stats {
    pub min: f64,
    pub avg: f64,
    pub p95: f64,
    pub max: f64,
    pub last: f64,
    pub peak_at_s: f64,
    pub slope_per_min: f64,
    pub over_70_s: f64,
    pub over_90_s: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Finding {
    pub severity: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TargetReport {
    pub pid: u32,
    pub name: String,
    pub samples: usize,
    pub duration_s: f64,
    pub exited: bool,
    /// % of whole-machine CPU
    pub cpu: Stats,
    pub mem_mb: Stats,
    pub mem_pct: Stats,
    /// MB/s
    pub disk_read: Stats,
    pub disk_write: Stats,
    /// KB/s
    pub net_rx: Stats,
    pub net_tx: Stats,
    pub threads_max: u32,
    pub procs_max: u32,
    pub findings: Vec<Finding>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Report {
    pub name: String,
    pub started_at: u64,
    pub ended_at: u64,
    pub duration_s: f64,
    pub status: String,
    pub ncpu: u32,
    pub mem_total: u64,
    pub targets: Vec<TargetReport>,
    pub events: Vec<EventRow>,
    pub findings: Vec<Finding>,
}

pub struct TargetInput<'a> {
    pub meta: &'a TargetMeta,
    pub series: &'a [Agg],
    pub exited: bool,
}

fn rel(ms: f64) -> String {
    let s = (ms / 1000.0).max(0.0) as u64;
    format!("{:02}:{:02}", s / 60, s % 60)
}

fn stats(vals: &[f64], ts: &[u64], t0: u64, thresholds: Option<(f64, f64)>) -> Stats {
    if vals.is_empty() {
        return Stats::default();
    }
    let n = vals.len() as f64;
    let mut sorted = vals.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let (mut max, mut max_i) = (f64::MIN, 0);
    for (i, v) in vals.iter().enumerate() {
        if *v > max {
            max = *v;
            max_i = i;
        }
    }
    let pts: Vec<(f64, f64)> = ts.iter().zip(vals).map(|(t, v)| ((*t as f64 - t0 as f64) / 60_000.0, *v)).collect();
    let (slope, _) = linreg(&pts);
    let (mut o70, mut o90) = (0.0, 0.0);
    if let Some((a, b)) = thresholds {
        for i in 0..vals.len() {
            let dt = if i + 1 < ts.len() { ((ts[i + 1] - ts[i]) as f64 / 1000.0).min(10.0) } else { 1.0 };
            if vals[i] > b {
                o90 += dt;
            }
            if vals[i] >= a {
                o70 += dt;
            }
        }
    }
    Stats {
        min: sorted[0],
        avg: vals.iter().sum::<f64>() / n,
        p95: sorted[((sorted.len() as f64 * 0.95).ceil() as usize).clamp(1, sorted.len()) - 1],
        max,
        last: *vals.last().unwrap(),
        peak_at_s: (ts[max_i].saturating_sub(t0)) as f64 / 1000.0,
        slope_per_min: slope,
        over_70_s: o70,
        over_90_s: o90,
    }
}

fn fnd(sev: &str, text: String) -> Finding {
    Finding { severity: sev.into(), text }
}

#[allow(clippy::too_many_arguments)]
pub fn build(name: &str, started: u64, ended: u64, status: &str, ncpu: u32, mem_total: u64, targets: &[TargetInput], events: &[EventRow]) -> Report {
    let ncpu_f = ncpu.max(1) as f64;
    let mut trs = vec![];
    let mut overall = vec![];
    for t in targets {
        let s = t.series;
        let ts: Vec<u64> = s.iter().map(|a| a.t).collect();
        let t0 = started;
        let cpu: Vec<f64> = s.iter().map(|a| a.cpu as f64 / ncpu_f).collect();
        let mem: Vec<f64> = s.iter().map(|a| a.mem as f64 / 1_048_576.0).collect();
        let mem_pct: Vec<f64> = s.iter().map(|a| if mem_total > 0 { a.mem as f64 / mem_total as f64 * 100.0 } else { 0.0 }).collect();
        let col = |f: fn(&Agg) -> u64, div: f64| -> Vec<f64> { s.iter().map(|a| f(a) as f64 / div).collect() };
        let cpu_s = stats(&cpu, &ts, t0, Some((70.0, 90.0)));
        let mem_s = stats(&mem, &ts, t0, None);
        let memp_s = stats(&mem_pct, &ts, t0, Some((70.0, 90.0)));
        let dr = stats(&col(|a| a.dr, 1_048_576.0), &ts, t0, None);
        let dw = stats(&col(|a| a.dw, 1_048_576.0), &ts, t0, None);
        let nr = stats(&col(|a| a.nr, 1024.0), &ts, t0, None);
        let nt = stats(&col(|a| a.nw, 1024.0), &ts, t0, None);
        let duration = s.last().map(|l| (l.t.saturating_sub(s[0].t)) as f64 / 1000.0).unwrap_or(0.0);
        let mut f: Vec<Finding> = vec![];

        if cpu_s.over_90_s >= 5.0 {
            f.push(fnd("critical", format!("CPU was above 90% of the machine for {:.0}s (peak {:.0}% at {}).", cpu_s.over_90_s, cpu_s.max, rel(cpu_s.peak_at_s * 1000.0))));
        } else if cpu_s.over_70_s >= 10.0 {
            f.push(fnd("warn", format!("CPU was at or above 70% for {:.0}s (peak {:.0}% at {}).", cpu_s.over_70_s, cpu_s.max, rel(cpu_s.peak_at_s * 1000.0))));
        } else {
            f.push(fnd("info", format!("CPU averaged {:.1}% of the machine (p95 {:.1}%, peak {:.1}% at {}).", cpu_s.avg, cpu_s.p95, cpu_s.max, rel(cpu_s.peak_at_s * 1000.0))));
        }
        if memp_s.over_90_s >= 5.0 {
            f.push(fnd("critical", format!("Memory exceeded 90% of RAM for {:.0}s (peak {:.0} MB).", memp_s.over_90_s, mem_s.max)));
        } else if memp_s.over_70_s >= 10.0 {
            f.push(fnd("warn", format!("Memory was at or above 70% of RAM for {:.0}s (peak {:.0} MB).", memp_s.over_70_s, mem_s.max)));
        }
        if s.len() >= 10 {
            let pts: Vec<(f64, f64)> = ts.iter().zip(&mem).map(|(t, v)| ((*t as f64 - t0 as f64) / 60_000.0, *v)).collect();
            let (slope, r2) = linreg(&pts);
            let grown = mem.last().unwrap() - mem[0];
            if slope > 10.0 && r2 > 0.85 && grown > 50.0 {
                f.push(fnd("warn", format!("Memory grew steadily by {:.0} MB (~{:.0} MB/min, R²={:.2}). This is consistent with a leak or an unbounded cache; confirm by watching whether it plateaus.", grown, slope, r2)));
            } else {
                f.push(fnd("info", format!("Memory went from {:.0} MB to {:.0} MB (peak {:.0} MB).", mem[0], mem.last().unwrap(), mem_s.max)));
            }
        }
        // Spikes: contiguous runs above mean + 3σ (and meaningfully high).
        if cpu.len() >= 20 {
            let mean = cpu_s.avg;
            let sd = (cpu.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / cpu.len() as f64).sqrt();
            let limit = (mean + 3.0 * sd).max(15.0);
            let mut spikes = vec![];
            let mut in_run = false;
            for (i, v) in cpu.iter().enumerate() {
                if *v > limit && !in_run {
                    spikes.push((ts[i].saturating_sub(t0), *v));
                    in_run = true;
                } else if *v <= limit {
                    in_run = false;
                }
            }
            if !spikes.is_empty() {
                let list: Vec<String> = spikes.iter().take(3).map(|(t, v)| format!("{} ({:.0}%)", rel(*t as f64), v)).collect();
                f.push(fnd("info", format!("{} CPU spike(s) well above baseline, e.g. at {}.", spikes.len(), list.join(", "))));
            }
        }
        if dw.max > 50.0 || dr.max > 50.0 {
            f.push(fnd("info", format!("Heavy disk I/O: peak read {:.0} MB/s, peak write {:.0} MB/s.", dr.max, dw.max)));
        }
        if nr.max + nt.max > 5_000.0 {
            f.push(fnd("info", format!("Significant network activity: peak in {:.0} KB/s, peak out {:.0} KB/s.", nr.max, nt.max)));
        }
        let thr_max = s.iter().map(|a| a.thr).max().unwrap_or(0);
        if let (Some(first), true) = (s.first(), thr_max > 0) {
            if thr_max as f64 > 2.0 * first.thr.max(1) as f64 + 50.0 {
                f.push(fnd("warn", format!("Thread count grew from {} to {}.", first.thr, thr_max)));
            }
        }
        if t.exited {
            f.push(fnd("info", "The process exited during the session.".into()));
        }
        for x in &f {
            if x.severity != "info" {
                overall.push(fnd(&x.severity, format!("{}: {}", t.meta.name, x.text)));
            }
        }
        trs.push(TargetReport {
            pid: t.meta.pid,
            name: t.meta.name.clone(),
            samples: s.len(),
            duration_s: duration,
            exited: t.exited,
            cpu: cpu_s,
            mem_mb: mem_s,
            mem_pct: memp_s,
            disk_read: dr,
            disk_write: dw,
            net_rx: nr,
            net_tx: nt,
            threads_max: thr_max,
            procs_max: s.iter().map(|a| a.n).max().unwrap_or(0),
            findings: f,
        });
    }
    if overall.is_empty() {
        overall.push(fnd("info", "No sustained high usage or leak-like growth detected in this session.".into()));
    }
    let mut ev = events.to_vec();
    ev.truncate(300);
    Report {
        name: name.into(),
        started_at: started,
        ended_at: ended,
        duration_s: (ended.saturating_sub(started)) as f64 / 1000.0,
        status: status.into(),
        ncpu,
        mem_total,
        targets: trs,
        events: ev,
        findings: overall,
    }
}

pub fn markdown(r: &Report, ai: Option<&str>) -> String {
    let mut m = String::new();
    m += &format!("# DeRunner tracking report: {}\n\n", r.name);
    m += &format!("- Duration: {:.0}s ({})\n- Machine: {} logical CPUs, {:.1} GB RAM\n\n", r.duration_s, r.status, r.ncpu, r.mem_total as f64 / 1e9);
    m += "## Summary\n\n";
    for f in &r.findings {
        m += &format!("- **{}**: {}\n", f.severity, f.text);
    }
    for t in &r.targets {
        m += &format!("\n## {} (pid {})\n\n| Metric | Min | Avg | p95 | Max |\n|---|---|---|---|---|\n", t.name, t.pid);
        let row = |n: &str, s: &Stats, u: &str| format!("| {n} | {:.1}{u} | {:.1}{u} | {:.1}{u} | {:.1}{u} |\n", s.min, s.avg, s.p95, s.max);
        m += &row("CPU (machine %)", &t.cpu, "%");
        m += &row("Memory", &t.mem_mb, " MB");
        m += &row("Disk read", &t.disk_read, " MB/s");
        m += &row("Disk write", &t.disk_write, " MB/s");
        m += &row("Net in", &t.net_rx, " KB/s");
        m += &row("Net out", &t.net_tx, " KB/s");
        m += "\n";
        for f in &t.findings {
            m += &format!("- {}\n", f.text);
        }
    }
    if !r.events.is_empty() {
        m += "\n## Events\n\n";
        for e in r.events.iter().take(100) {
            m += &format!("- `{}` [{}] {}\n", rel(e.t.saturating_sub(r.started_at) as f64), e.severity, e.message);
        }
    }
    if let Some(a) = ai {
        m += "\n## AI analysis\n\n";
        m += a;
        m += "\n\n_AI-generated; verify before acting. Anomalies are signals, not verdicts._\n";
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leak_detected() {
        let meta = TargetMeta { pid: 1, name: "leaky".into(), start: 0 };
        let series: Vec<Agg> = (0..120u64).map(|i| Agg { t: i * 1000, cpu: 10.0, mem: (200 + i * 5) * 1_048_576, n: 1, ..Default::default() }).collect();
        let r = build("t", 0, 120_000, "completed", 4, 16 << 30, &[TargetInput { meta: &meta, series: &series, exited: false }], &[]);
        assert!(r.findings.iter().any(|f| f.severity == "warn" && f.text.contains("grew steadily")), "{:?}", r.findings);
    }
    #[test]
    fn sustained_cpu_flagged() {
        let meta = TargetMeta { pid: 1, name: "burn".into(), start: 0 };
        let series: Vec<Agg> = (0..60u64).map(|i| Agg { t: i * 1000, cpu: 380.0, mem: 1 << 28, n: 1, ..Default::default() }).collect();
        let r = build("t", 0, 60_000, "completed", 4, 16 << 30, &[TargetInput { meta: &meta, series: &series, exited: false }], &[]);
        assert_eq!(r.targets[0].findings[0].severity, "critical");
    }
}
