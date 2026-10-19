//! Typed settings persisted as JSON in the app config dir. Single source of truth for Rust and UI.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub theme: String, // system | light | dark
    pub reduce_transparency: bool,
    pub refresh_ms: u64,
    pub cpu_mode: String, // normalized | per_core
    pub per_process_network: bool,
    pub close_to_tray: bool,
    pub show_in_dock: bool,
    pub tray_show_cpu: bool,
    pub global_shortcut: Option<String>,
    pub notifications: bool,
    pub background_alerts: bool,
    pub disk_ref_mb_s: u32,
    pub net_ref_mbps: u32,
    pub session_retention_days: u32,
    pub anomaly: AnomalySettings,
    pub rules: Vec<PriorityRule>,
    pub ai: AiSettings,
    pub update: UpdateSettings,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AnomalySettings {
    pub enabled: bool,
    pub sustained_critical_s: u32,
    pub sustained_warn_s: u32,
    pub allowlist: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PriorityRule {
    pub id: String,
    pub name: String,
    pub target: String, // name | path | cmd
    pub mode: String,   // glob | regex
    pub pattern: String,
    pub priority: String, // low | below_normal | normal | above_normal | high
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ProviderSettings {
    pub base_url: String,
    pub model: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AiSettings {
    pub default_provider: String,
    pub providers: HashMap<String, ProviderSettings>,
    pub redact: bool,
    pub auto_report: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub last_check: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            reduce_transparency: false,
            refresh_ms: 1000,
            cpu_mode: "normalized".into(),
            per_process_network: true,
            close_to_tray: true,
            show_in_dock: true,
            tray_show_cpu: true,
            global_shortcut: None,
            notifications: true,
            background_alerts: false,
            disk_ref_mb_s: 500,
            net_ref_mbps: 1000,
            session_retention_days: 30,
            anomaly: AnomalySettings::default(),
            rules: vec![],
            ai: AiSettings::default(),
            update: UpdateSettings::default(),
        }
    }
}

impl Default for AnomalySettings {
    fn default() -> Self {
        Self { enabled: true, sustained_critical_s: 10, sustained_warn_s: 30, allowlist: vec![] }
    }
}

impl Default for AiSettings {
    fn default() -> Self {
        let mut providers = HashMap::new();
        let mut p = |k: &str, url: &str, model: &str| {
            providers.insert(k.to_string(), ProviderSettings { base_url: url.into(), model: model.into() });
        };
        p("ollama", "http://localhost:11434", "");
        p("lmstudio", "http://localhost:1234/v1", "");
        p("openai", "https://api.openai.com/v1", "");
        p("anthropic", "https://api.anthropic.com", "claude-sonnet-5-5");
        p("openrouter", "https://openrouter.ai/api/v1", "");
        Self { default_provider: "ollama".into(), providers, redact: true, auto_report: false }
    }
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self { auto_check: true, last_check: 0 }
    }
}

impl Settings {
    pub fn path(dir: &std::path::Path) -> PathBuf {
        dir.join("settings.json")
    }

    pub fn load(dir: &std::path::Path) -> Self {
        let mut s: Settings = std::fs::read(Self::path(dir))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        // Keep newly-added providers present for older files.
        for (k, v) in AiSettings::default().providers {
            s.ai.providers.entry(k).or_insert(v);
        }
        s.refresh_ms = s.refresh_ms.clamp(500, 10_000);
        s
    }

    pub fn save(&self, dir: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join("settings.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, Self::path(dir))
    }
}
