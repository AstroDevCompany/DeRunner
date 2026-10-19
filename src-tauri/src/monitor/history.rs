//! Bounded per-process history. Two tiers: ~1 s resolution for 10 min, 10 s resolution for 1 h.
use serde::Serialize;
use std::collections::{HashMap, VecDeque};

pub const HI_CAP: usize = 600;
pub const LO_CAP: usize = 360;
const LO_GROUP: usize = 10;

#[derive(Clone, Copy, Debug, Default)]
pub struct Sample {
    pub t: u32,   // epoch seconds
    pub cpu: f32, // raw (100 = one core)
    pub mem: u32, // KiB
    pub dr: u32,
    pub dw: u32,
    pub nr: u32,
    pub nw: u32,
}

#[derive(Default)]
pub struct ProcHistory {
    pub start: u64,
    hi: VecDeque<Sample>,
    lo: VecDeque<Sample>,
    since_lo: usize,
}

#[derive(Serialize, Default, Debug)]
pub struct Series {
    pub t: Vec<u32>,
    pub cpu: Vec<f32>,
    pub mem: Vec<u32>,
    pub dr: Vec<u32>,
    pub dw: Vec<u32>,
    pub nr: Vec<u32>,
    pub nw: Vec<u32>,
}

impl Series {
    fn from<'a>(it: impl Iterator<Item = &'a Sample>) -> Self {
        let mut s = Series::default();
        for x in it {
            s.t.push(x.t);
            s.cpu.push(x.cpu);
            s.mem.push(x.mem);
            s.dr.push(x.dr);
            s.dw.push(x.dw);
            s.nr.push(x.nr);
            s.nw.push(x.nw);
        }
        s
    }
}

impl ProcHistory {
    pub fn push(&mut self, s: Sample) {
        if self.hi.len() == HI_CAP {
            self.hi.pop_front();
        }
        self.hi.push_back(s);
        self.since_lo += 1;
        if self.since_lo >= LO_GROUP {
            self.since_lo = 0;
            let n = LO_GROUP.min(self.hi.len());
            let tail = self.hi.iter().rev().take(n);
            let (mut cpu, mut dr, mut dw, mut nr, mut nw) = (0f64, 0u64, 0u64, 0u64, 0u64);
            for x in tail {
                cpu += x.cpu as f64;
                dr += x.dr as u64;
                dw += x.dw as u64;
                nr += x.nr as u64;
                nw += x.nw as u64;
            }
            let k = n.max(1) as u64;
            if self.lo.len() == LO_CAP {
                self.lo.pop_front();
            }
            self.lo.push_back(Sample {
                t: s.t,
                cpu: (cpu / k as f64) as f32,
                mem: s.mem,
                dr: (dr / k) as u32,
                dw: (dw / k) as u32,
                nr: (nr / k) as u32,
                nw: (nw / k) as u32,
            });
        }
    }
}

#[derive(Default)]
pub struct HistoryStore {
    map: HashMap<u32, ProcHistory>,
}

impl HistoryStore {
    pub fn push(&mut self, pid: u32, start: u64, s: Sample) {
        let h = self.map.entry(pid).or_default();
        if h.start != start {
            *h = ProcHistory { start, ..Default::default() };
        }
        h.push(s);
    }
    pub fn remove(&mut self, pid: u32) {
        self.map.remove(&pid);
    }
    /// `tier`: "hi" (10 min, 1 s) or "lo" (1 h, 10 s).
    pub fn series(&self, pid: u32, tier: &str) -> Series {
        match self.map.get(&pid) {
            None => Series::default(),
            Some(h) if tier == "lo" => Series::from(h.lo.iter()),
            Some(h) => Series::from(h.hi.iter()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_and_reset_on_pid_reuse() {
        let mut st = HistoryStore::default();
        for i in 0..(HI_CAP as u32 + 50) {
            st.push(7, 100, Sample { t: i, ..Default::default() });
        }
        assert_eq!(st.series(7, "hi").t.len(), HI_CAP);
        assert!(!st.series(7, "lo").t.is_empty());
        st.push(7, 999, Sample { t: 1, ..Default::default() });
        assert_eq!(st.series(7, "hi").t.len(), 1);
    }
}
