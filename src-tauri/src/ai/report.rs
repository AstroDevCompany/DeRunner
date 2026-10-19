//! AI narrative for tracking sessions, layered on top of the deterministic report.
use super::{context::PERSONA, providers, ChatMsg};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub fn spawn_report(app: AppHandle, id: i64) {
    tauri::async_runtime::spawn(async move {
        let _ = generate(&app, id).await;
    });
}

pub async fn generate(app: &AppHandle, id: i64) -> AppResult<String> {
    let st = app.state::<Arc<AppState>>().inner().clone();
    let res = run(&st, id).await;
    match &res {
        Ok(t) => {
            let _ = st.store.set_ai(id, Some(t), None);
        }
        Err(e) => {
            let _ = st.store.set_ai(id, None, Some(&e.to_string()));
        }
    }
    let _ = app.emit("session-report-updated", id);
    res
}

async fn run(st: &AppState, id: i64) -> AppResult<String> {
    let detail = st.store.get_session(id)?;
    let report = detail.report.ok_or_else(|| AppError::Invalid("Session has no report yet.".into()))?;
    let r = super::resolve(&st.settings.read(), None, true)?;
    let json = serde_json::to_string(&report)?;
    let system = format!(
        "{PERSONA}\n\nYou are writing the analysis section of a tracking-session report. Use exactly these Markdown headings: \
## Summary, ## Resource usage, ## Notable events, ## Anomalies, ## Possible explanations, ## Recommendations. \
In 'Possible explanations' give both benign and concerning hypotheses, ranked, and what evidence would distinguish them. \
Do not invent data that is not in the report."
    );
    let msg = ChatMsg { role: "user".into(), content: format!("Analyse this session report (JSON):\n{}", json.chars().take(30_000).collect::<String>()) };
    let mut text = String::new();
    providers::stream_chat(&r, &system, &[msg], |d| text.push_str(&d)).await?;
    if text.trim().is_empty() {
        return Err(AppError::Other("The model returned an empty response.".into()));
    }
    Ok(text)
}
