//! Redaction of secrets in command lines / environments / paths (UI default and AI context).
use regex::Regex;
use std::sync::OnceLock;

fn secret_key() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(pass(word|wd)?|secret|token|api[-_]?key|auth|credential|private[-_]?key|session|cookie)").unwrap())
}
fn secret_value() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(sk-[A-Za-z0-9_\-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,})").unwrap())
}

pub const MASK: &str = "••••••";

pub fn cmd_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut mask_next = false;
    for a in args {
        if mask_next {
            out.push(MASK.into());
            mask_next = false;
            continue;
        }
        if let Some(rest) = a.strip_prefix("--").or_else(|| a.strip_prefix('-')) {
            match rest.split_once('=') {
                Some((k, _)) if secret_key().is_match(k) => {
                    out.push(format!("{}={MASK}", &a[..a.len() - rest.len() + k.len()]));
                    continue;
                }
                None if secret_key().is_match(rest) => {
                    mask_next = true;
                    out.push(a.clone());
                    continue;
                }
                _ => {}
            }
        } else if let Some((k, _)) = a.split_once('=') {
            if secret_key().is_match(k) && !k.contains('/') {
                out.push(format!("{k}={MASK}"));
                continue;
            }
        }
        out.push(secret_value().replace_all(a, MASK).into_owned());
    }
    out
}

pub fn env(vars: &[String], reveal: bool) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = vars
        .iter()
        .filter_map(|e| e.split_once('='))
        .map(|(k, val)| {
            let hide = !reveal && (secret_key().is_match(k) || secret_value().is_match(val));
            (k.to_string(), if hide { MASK.into() } else { val.to_string() })
        })
        .collect();
    v.sort();
    v
}

pub fn home_to_tilde(s: &str) -> String {
    match dirs_home() {
        Some(h) if !h.is_empty() => s.replace(&h, "~"),
        _ => s.to_string(),
    }
}

pub fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(v: &[&str]) -> Vec<String> { v.iter().map(|x| x.to_string()).collect() }
    #[test]
    fn masks_flags_and_values() {
        let r = cmd_args(&s(&["tool", "--password", "hunter2", "--api-key=abc", "TOKEN=xyz", "--port", "80", "sk-abcdefghijklmnop12"]));
        assert_eq!(r[2], MASK);
        assert_eq!(r[3], format!("--api-key={MASK}"));
        assert_eq!(r[4], format!("TOKEN={MASK}"));
        assert_eq!(r[6], "80");
        assert_eq!(r[7], MASK);
    }
    #[test]
    fn env_masking() {
        let r = env(&s(&["PATH=/bin", "GITHUB_TOKEN=abc"]), false);
        let get = |k: &str| r.iter().find(|(n, _)| n == k).unwrap().1.clone();
        assert_eq!(get("PATH"), "/bin");
        assert_eq!(get("GITHUB_TOKEN"), MASK);
        assert_eq!(env(&s(&["GITHUB_TOKEN=abc"]), true)[0].1, "abc");
    }
}
