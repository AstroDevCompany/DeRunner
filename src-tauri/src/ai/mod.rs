//! Multi-provider AI. All HTTP happens in Rust so API keys never reach the webview.
pub mod context;
pub mod providers;
pub mod report;

pub use report::spawn_report;

use crate::error::{AppError, AppResult};
use crate::settings::Settings;
use serde::Deserialize;

const SERVICE: &str = "dev.mintflow.derunner";
pub const KINDS: [&str; 5] = ["ollama", "lmstudio", "openai", "anthropic", "openrouter"];

#[derive(Deserialize, Clone, Debug)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug)]
pub struct Resolved {
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub key: Option<String>,
}

fn entry(kind: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &format!("{kind}-api-key")).map_err(|e| AppError::Other(format!("keychain: {e}")))
}

pub fn get_key(kind: &str) -> Option<String> {
    entry(kind).ok()?.get_password().ok().filter(|k| !k.is_empty())
}
pub fn set_key(kind: &str, key: &str) -> AppResult<()> {
    entry(kind)?.set_password(key).map_err(|e| AppError::Other(format!("keychain: {e}")))
}
pub fn clear_key(kind: &str) -> AppResult<()> {
    match entry(kind)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!("keychain: {e}"))),
    }
}

pub fn resolve(s: &Settings, kind: Option<&str>, require_model: bool) -> AppResult<Resolved> {
    let kind = kind.unwrap_or(&s.ai.default_provider).to_string();
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::Invalid(format!("unknown provider '{kind}'")));
    }
    let p = s.ai.providers.get(&kind).cloned().unwrap_or_default();
    if require_model && p.model.trim().is_empty() {
        return Err(AppError::Invalid(format!("No model selected for {kind}. Choose one in Settings → AI.")));
    }
    let key = get_key(&kind);
    if matches!(kind.as_str(), "openai" | "anthropic" | "openrouter") && key.is_none() {
        return Err(AppError::Invalid(format!("No API key saved for {kind}. Add it in Settings → AI.")));
    }
    Ok(Resolved { kind, base_url: p.base_url.trim_end_matches('/').to_string(), model: p.model, key })
}
