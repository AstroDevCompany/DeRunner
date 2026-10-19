//! Persistent priority rules. Matching is O(new processes) per tick plus a light 30 s drift sweep.
use crate::monitor::model::*;
use crate::platform;
use crate::settings::PriorityRule;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Clone, Debug)]
pub struct RuleEvent {
    pub ts: u64,
    pub rule_id: String,
    pub rule_name: String,
    pub pid: u32,
    pub name: String,
    pub priority: String,
    pub ok: bool,
    pub error: Option<String>,
}

struct Compiled {
    rule: PriorityRule,
    re: Regex,
}

#[derive(Default)]
pub struct Engine {
    sig: String,
    compiled: Vec<Compiled>,
    last_sweep: u64,
    failed: HashSet<(String, u32)>,
    applied: HashSet<(String, u32, u64)>,
}

pub fn glob_to_regex(g: &str) -> String {
    let mut s = String::from("(?i)^");
    for c in g.chars() {
        match c {
            '*' => s.push_str(".*"),
            '?' => s.push('.'),
            c => s.push_str(&regex::escape(&c.to_string())),
        }
    }
    s.push('$');
    s
}

pub fn compile(rule: &PriorityRule) -> Option<Regex> {
    let pat = if rule.mode == "regex" { format!("(?i){}", rule.pattern) } else { glob_to_regex(&rule.pattern) };
    Regex::new(&pat).ok()
}

pub fn target_of(rule: &PriorityRule, p: &ProcStatic) -> String {
    match rule.target.as_str() {
        "path" => p.exe.clone().unwrap_or_default(),
        "cmd" => p.cmd.join(" "),
        _ => p.name.clone(),
    }
}

pub fn matches(rule: &PriorityRule, re: &Regex, p: &ProcStatic) -> bool {
    let t = target_of(rule, p);
    !t.is_empty() && re.is_match(&t)
}

impl Engine {
    pub fn has_enabled(rules: &[PriorityRule]) -> bool {
        rules.iter().any(|r| r.enabled)
    }

    pub fn on_tick(&mut self, now: u64, rules: &[PriorityRule], procs: &HashMap<u32, ProcStatic>, added: &[u32], self_pid: u32) -> Vec<RuleEvent> {
        let sig = serde_json::to_string(rules).unwrap_or_default();
        let mut sweep = now.saturating_sub(self.last_sweep) >= 30_000;
        if sig != self.sig {
            self.sig = sig;
            self.compiled = rules.iter().filter(|r| r.enabled).filter_map(|r| compile(r).map(|re| Compiled { rule: r.clone(), re })).collect();
            self.failed.clear();
            self.applied.clear();
            sweep = true;
        }
        if self.compiled.is_empty() {
            return vec![];
        }
        let mut events = vec![];
        let candidates: Vec<u32> = if sweep { procs.keys().copied().collect() } else { added.to_vec() };
        if sweep {
            self.last_sweep = now;
        }
        for pid in candidates {
            if pid <= 1 || pid == self_pid {
                continue;
            }
            let Some(p) = procs.get(&pid) else { continue };
            // First matching rule wins (rules are ordered).
            let Some(c) = self.compiled.iter().find(|c| matches(&c.rule, &c.re, p)) else { continue };
            let key = (c.rule.id.clone(), pid);
            if self.failed.contains(&key) {
                continue;
            }
            let current = platform::get_priority(pid).and_then(|i| i.level);
            if current.as_deref() == Some(c.rule.priority.as_str()) {
                continue;
            }
            let res = platform::set_priority(pid, &c.rule.priority);
            let ok = res.is_ok();
            if !ok {
                self.failed.insert(key.clone());
            }
            // Report each (rule, pid, start) once on success to avoid log spam on drift re-application.
            if !ok || self.applied.insert((c.rule.id.clone(), pid, p.start)) || sweep {
                events.push(RuleEvent {
                    ts: now,
                    rule_id: c.rule.id.clone(),
                    rule_name: c.rule.name.clone(),
                    pid,
                    name: p.name.clone(),
                    priority: c.rule.priority.clone(),
                    ok,
                    error: res.err().map(|e| e.to_string()),
                });
            }
        }
        if self.applied.len() > 5000 {
            self.applied.clear();
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule(target: &str, mode: &str, pat: &str) -> PriorityRule {
        PriorityRule { id: "r".into(), name: "r".into(), target: target.into(), mode: mode.into(), pattern: pat.into(), priority: "low".into(), enabled: true }
    }
    fn p(name: &str, exe: &str) -> ProcStatic {
        ProcStatic { name: name.into(), exe: Some(exe.into()), ..Default::default() }
    }
    #[test]
    fn glob_matches_case_insensitively() {
        let r = rule("name", "glob", "chrome*");
        let re = compile(&r).unwrap();
        assert!(matches(&r, &re, &p("Chrome Helper", "/x")));
        assert!(!matches(&r, &re, &p("firefox", "/x")));
    }
    #[test]
    fn path_and_regex() {
        let r = rule("path", "glob", "/Applications/*/Contents/*");
        assert!(matches(&r, &compile(&r).unwrap(), &p("x", "/Applications/Foo.app/Contents/MacOS/x")));
        let r2 = rule("name", "regex", r"^node(\d+)?$");
        assert!(matches(&r2, &compile(&r2).unwrap(), &p("node18", "")));
    }
}
