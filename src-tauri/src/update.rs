//! Version check against a remotely hosted JSON manifest:
//! `{ "latest": "0.1.0", "windows": "<url>", "macos": "<url>", "linux": "<url>" }`
//! An empty/missing platform URL means "no download published yet".
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

// TODO(release): confirm this is the final manifest location before shipping.
pub const UPDATE_MANIFEST_URL: &str = "https://raw.githubusercontent.com/AstroDevCompany/MintFlow-Releases/refs/heads/main/derunner.json";

#[derive(Deserialize, Default, Debug)]
pub struct Manifest {
    pub latest: String,
    #[serde(default)]
    pub windows: Option<String>,
    #[serde(default)]
    pub macos: Option<String>,
    #[serde(default)]
    pub linux: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub download_url: Option<String>,
    pub platform: &'static str,
    pub checked_at: u64,
}

pub fn platform_key() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn parse_ver(s: &str) -> AppResult<semver::Version> {
    semver::Version::parse(s.trim().trim_start_matches('v')).map_err(|e| AppError::Invalid(format!("bad version '{s}': {e}")))
}

pub fn evaluate(m: &Manifest, current: &str, platform: &'static str, now: u64) -> AppResult<UpdateInfo> {
    let latest = parse_ver(&m.latest)?;
    let cur = parse_ver(current)?;
    let url = match platform {
        "macos" => &m.macos,
        "windows" => &m.windows,
        _ => &m.linux,
    }
    .as_ref()
    .map(|s| s.trim().to_string())
    .filter(|s| s.starts_with("https://") || s.starts_with("http://"));
    Ok(UpdateInfo { current: cur.to_string(), latest: latest.to_string(), available: latest > cur, download_url: url, platform, checked_at: now })
}

pub async fn check(current: &str) -> AppResult<UpdateInfo> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).user_agent(format!("DeRunner/{current}")).build()?;
    let resp = client.get(UPDATE_MANIFEST_URL).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!("Update server returned {}", resp.status())));
    }
    let m: Manifest = serde_json::from_slice(&resp.bytes().await?).map_err(|e| AppError::Invalid(format!("Malformed update manifest: {e}")))?;
    evaluate(&m, current, platform_key(), crate::monitor::model::now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn m(latest: &str, mac: &str) -> Manifest {
        Manifest { latest: latest.into(), macos: Some(mac.into()), windows: Some(String::new()), linux: None }
    }
    #[test]
    fn newer_available_with_url() {
        let i = evaluate(&m("0.2.0", "https://x/y.dmg"), "0.1.0", "macos", 0).unwrap();
        assert!(i.available);
        assert_eq!(i.download_url.as_deref(), Some("https://x/y.dmg"));
    }
    #[test]
    fn same_or_older_not_available_and_v_prefix_ok() {
        assert!(!evaluate(&m("v0.1.0", ""), "0.1.0", "macos", 0).unwrap().available);
        assert!(!evaluate(&m("0.0.9", ""), "0.1.0", "macos", 0).unwrap().available);
    }
    #[test]
    fn empty_url_means_unpublished() {
        let i = evaluate(&m("0.3.0", "https://a/b"), "0.1.0", "windows", 0).unwrap();
        assert!(i.available && i.download_url.is_none());
    }
    #[test]
    fn parses_spec_manifest_and_rejects_garbage() {
        let ok: Manifest = serde_json::from_str(r#"{"latest":"0.1.0","windows":"","macos":""}"#).unwrap();
        assert_eq!(ok.latest, "0.1.0");
        assert!(evaluate(&Manifest { latest: "nope".into(), ..Default::default() }, "0.1.0", "macos", 0).is_err());
    }
}
