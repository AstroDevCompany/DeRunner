use super::{ChatMsg, Resolved};
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(300))
            .user_agent(concat!("DeRunner/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client")
    })
}

fn headers(rb: reqwest::RequestBuilder, r: &Resolved) -> reqwest::RequestBuilder {
    match r.kind.as_str() {
        "anthropic" => rb.header("x-api-key", r.key.clone().unwrap_or_default()).header("anthropic-version", "2023-06-01"),
        "openrouter" => rb
            .bearer_auth(r.key.clone().unwrap_or_default())
            .header("HTTP-Referer", "https://mintflow.dev")
            .header("X-Title", "DeRunner"),
        _ => match &r.key {
            Some(k) => rb.bearer_auth(k),
            None => rb,
        },
    }
}

async fn check(resp: reqwest::Response) -> AppResult<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let snippet: String = body.chars().take(300).collect();
    Err(AppError::Other(format!("Provider returned {status}: {snippet}")))
}

fn conn_hint(e: reqwest::Error, r: &Resolved) -> AppError {
    if e.is_connect() {
        AppError::Other(format!("Could not reach {} at {}. Is it running?", r.kind, r.base_url))
    } else {
        AppError::Other(e.to_string())
    }
}

pub async fn list_models(r: &Resolved) -> AppResult<Vec<String>> {
    let url = match r.kind.as_str() {
        "ollama" => format!("{}/api/tags", r.base_url),
        "anthropic" => format!("{}/v1/models?limit=100", r.base_url),
        _ => format!("{}/models", r.base_url),
    };
    let resp = headers(client().get(&url), r).send().await.map_err(|e| conn_hint(e, r))?;
    let v: Value = check(resp).await?.json().await?;
    let mut out: Vec<String> = match r.kind.as_str() {
        "ollama" => v["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(String::from)).collect(),
        _ => v["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(String::from)).collect(),
    };
    out.sort();
    Ok(out)
}

/// Streams a chat completion, calling `on_delta` for each text chunk.
pub async fn stream_chat(r: &Resolved, system: &str, msgs: &[ChatMsg], mut on_delta: impl FnMut(String)) -> AppResult<()> {
    let mut all: Vec<Value> = vec![];
    let (url, body) = match r.kind.as_str() {
        "anthropic" => {
            for m in msgs {
                all.push(json!({"role": if m.role == "assistant" {"assistant"} else {"user"}, "content": m.content}));
            }
            (
                format!("{}/v1/messages", r.base_url),
                json!({"model": r.model, "max_tokens": 4096, "system": system, "messages": all, "stream": true}),
            )
        }
        kind => {
            all.push(json!({"role": "system", "content": system}));
            for m in msgs {
                all.push(json!({"role": m.role, "content": m.content}));
            }
            let url = if kind == "ollama" { format!("{}/api/chat", r.base_url) } else { format!("{}/chat/completions", r.base_url) };
            (url, json!({"model": r.model, "messages": all, "stream": true}))
        }
    };
    let resp = headers(client().post(&url), r).json(&body).send().await.map_err(|e| conn_hint(e, r))?;
    let mut stream = check(resp).await?.bytes_stream();
    let mut buf: Vec<u8> = vec![];
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk?);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match parse_line(&r.kind, line)? {
                Parsed::Text(t) if !t.is_empty() => on_delta(t),
                Parsed::Done => return Ok(()),
                _ => {}
            }
        }
    }
    Ok(())
}

enum Parsed {
    Text(String),
    Done,
    Skip,
}

fn parse_line(kind: &str, line: &str) -> AppResult<Parsed> {
    match kind {
        "ollama" => {
            let v: Value = serde_json::from_str(line)?;
            if let Some(e) = v["error"].as_str() {
                return Err(AppError::Other(e.into()));
            }
            if v["done"].as_bool() == Some(true) {
                return Ok(Parsed::Done);
            }
            Ok(Parsed::Text(v["message"]["content"].as_str().unwrap_or("").to_string()))
        }
        "anthropic" => {
            let Some(data) = line.strip_prefix("data:") else { return Ok(Parsed::Skip) };
            let v: Value = serde_json::from_str(data.trim())?;
            match v["type"].as_str() {
                Some("content_block_delta") => Ok(Parsed::Text(v["delta"]["text"].as_str().unwrap_or("").to_string())),
                Some("message_stop") => Ok(Parsed::Done),
                Some("error") => Err(AppError::Other(v["error"]["message"].as_str().unwrap_or("provider error").into())),
                _ => Ok(Parsed::Skip),
            }
        }
        _ => {
            let Some(data) = line.strip_prefix("data:") else { return Ok(Parsed::Skip) };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(Parsed::Done);
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(Parsed::Skip) };
            if let Some(e) = v["error"]["message"].as_str() {
                return Err(AppError::Other(e.into()));
            }
            Ok(Parsed::Text(v["choices"][0]["delta"]["content"].as_str().unwrap_or("").to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn text(p: AppResult<Parsed>) -> String {
        match p.unwrap() { Parsed::Text(t) => t, _ => "<none>".into() }
    }
    #[test]
    fn openai_sse() {
        assert_eq!(text(parse_line("openai", r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#)), "hi");
        assert!(matches!(parse_line("openrouter", "data: [DONE]").unwrap(), Parsed::Done));
    }
    #[test]
    fn anthropic_sse() {
        assert_eq!(text(parse_line("anthropic", r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"yo"}}"#)), "yo");
        assert!(matches!(parse_line("anthropic", "event: ping").unwrap(), Parsed::Skip));
    }
    #[test]
    fn ollama_ndjson() {
        assert_eq!(text(parse_line("ollama", r#"{"message":{"content":"ok"},"done":false}"#)), "ok");
        assert!(matches!(parse_line("ollama", r#"{"done":true}"#).unwrap(), Parsed::Done));
    }
}
