use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use regex::Regex;
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};

use crate::types::BackendError;
use crate::utils::CommandExt as _;

#[derive(Default)]
struct SidecarRuntime {
    child: Option<Child>,
    base_url: Option<String>,
    token: Option<String>,
    script_path: Option<String>,
    python_bin: Option<String>,
    started_at: Option<String>,
}

#[derive(Serialize)]
pub struct SidecarStatus {
    pub process_running: bool,
    pub pid: Option<u32>,
    pub base_url: Option<String>,
    pub token_configured: bool,
    pub script_path: Option<String>,
    pub python_bin: Option<String>,
    pub started_at: Option<String>,
}

fn runtime() -> &'static Mutex<SidecarRuntime> {
    static RUNTIME: OnceLock<Mutex<SidecarRuntime>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(SidecarRuntime::default()))
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn normalize_base_url(raw: &str) -> Option<String> {
    let mut base = raw.trim().to_string();
    if base.is_empty() {
        return None;
    }
    if !base.starts_with("http://") && !base.starts_with("https://") {
        base = format!("http://{}", base);
    }
    Some(base.trim_end_matches('/').to_string())
}

fn is_valid_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn http_url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"https?://[^\s"'<>]+"#).expect("valid http url regex"))
}

fn sanitize_extracted_url(raw: &str) -> String {
    raw.trim()
        .trim_end_matches(|c: char| matches!(c, ',' | ';' | ')' | ']' | '}' | '"' | '\''))
        .replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("\\u003d", "=")
        .replace("&amp;", "&")
}

fn is_http_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .map(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn extract_http_urls_from_text(
    text: &str,
    dedup: &mut HashSet<String>,
    out: &mut Vec<String>,
) -> usize {
    let mut added = 0usize;
    for mat in http_url_regex().find_iter(text) {
        let candidate = sanitize_extracted_url(mat.as_str());
        if candidate.is_empty() || !is_http_url(&candidate) {
            continue;
        }
        if dedup.insert(candidate.clone()) {
            out.push(candidate);
            added += 1;
        }
    }
    added
}

fn parse_csv_row(line: &str) -> Vec<String> {
    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    cur.push('"');
                    let _ = chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == ',' {
            cells.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    cells.push(cur.trim().to_string());
    cells
}
fn infer_media_kind(value: &str) -> &'static str {
    let lower = value.to_ascii_lowercase();
    if lower.contains("video-downloads.googleusercontent.com")
        || lower.contains("/videoplayback")
        || Regex::new(r"\.(mp4|m4v|webm|mov|mkv|avi|3gp|ts|m3u8?|flv)(?:$|[?#&])").unwrap().is_match(&lower)
        || Regex::new(r"(?:^|[?&])(?:mime|content_type|type)=video(?:%2f|/)").unwrap().is_match(&lower)
    {
        return "video";
    }
    if lower.contains("audio-downloads.googleusercontent.com")
        || Regex::new(r"\.(mp3|m4a|aac|wav|flac|ogg|opus)(?:$|[?#&])").unwrap().is_match(&lower)
        || Regex::new(r"(?:^|[?&])(?:mime|content_type|type)=audio(?:%2f|/)").unwrap().is_match(&lower)
    {
        return "audio";
    }
    if Regex::new(r"\.gif(?:$|[?#&])").unwrap().is_match(&lower)
        || Regex::new(r"(?:^|[?&])(?:fm|format)=gif(?:$|[&#])").unwrap().is_match(&lower)
    {
        return "gif";
    }
    "image"
}

fn extract_media_items_from_csv_text(
    text: &str,
    source_file: &str,
    item_dedup: &mut HashSet<String>,
    items: &mut Vec<Value>,
    url_dedup: &mut HashSet<String>,
    urls: &mut Vec<String>,
) -> usize {
    let mut lines = text.lines();
    let header_line = match lines.next() {
        Some(h) => h,
        None => return 0,
    };

    let headers = parse_csv_row(header_line)
        .into_iter()
        .map(|h| h.trim().trim_matches('"').to_ascii_lowercase())
        .collect::<Vec<_>>();

    let find_index = |names: &[&str]| -> Option<usize> {
        names.iter().find_map(|name| headers.iter().position(|h| h == name))
    };

    let media_idx = find_index(&["image_url", "direct_url", "media_url", "download_url", "url"]);
    let page_url_idx = find_index(&["page_url", "source_url", "webpage_url"]);
    let page_title_idx = find_index(&["page_title", "title"]);
    let file_name_idx = find_index(&["file_name", "filename"]);
    let saved_absolute_path_idx = find_index(&["saved_absolute_path", "saved_path", "absolute_path"]);
    let output_subdir_idx = find_index(&["output_subdir", "subdir"]);
    let status_idx = find_index(&["status"]);

    let Some(media_idx) = media_idx else {
        return 0;
    };

    let mut added = 0usize;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let cells = parse_csv_row(line);
        let media_url = cells
            .get(media_idx)
            .map(|v| sanitize_extracted_url(v))
            .unwrap_or_default();
        if media_url.is_empty() || !is_http_url(&media_url) || !item_dedup.insert(media_url.clone()) {
            continue;
        }

        if url_dedup.insert(media_url.clone()) {
            urls.push(media_url.clone());
        }

        let file_name = file_name_idx.and_then(|idx| cells.get(idx)).map(|v| v.trim().to_string()).unwrap_or_default();
        let saved_absolute_path = saved_absolute_path_idx.and_then(|idx| cells.get(idx)).map(|v| v.trim().to_string()).unwrap_or_default();
        let output_subdir = output_subdir_idx.and_then(|idx| cells.get(idx)).map(|v| v.trim().to_string()).unwrap_or_default();
        let page_url = page_url_idx.and_then(|idx| cells.get(idx)).map(|v| v.trim().to_string()).unwrap_or_default();
        let page_title = page_title_idx.and_then(|idx| cells.get(idx)).map(|v| v.trim().to_string()).unwrap_or_default();
        let status = status_idx.and_then(|idx| cells.get(idx)).map(|v| v.trim().to_string()).unwrap_or_default();
        let kind_source = if !file_name.is_empty() { file_name.as_str() } else { media_url.as_str() };

        items.push(json!({
            "url": media_url,
            "kind": infer_media_kind(kind_source),
            "pageUrl": page_url,
            "pageTitle": page_title,
            "fileName": file_name,
            "savedAbsolutePath": saved_absolute_path,
            "outputSubdir": output_subdir,
            "status": status,
            "sourceFile": source_file,
        }));
        added += 1;
    }

    added
}

fn resolve_task_output_dir(output: &str, script_path: Option<&str>) -> PathBuf {
    let raw = output.trim();
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return path;
    }
    if let Some(script) = script_path {
        let script_parent = Path::new(script).parent().map(Path::to_path_buf);
        if let Some(base) = script_parent {
            return base.join(path);
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(path)
}

const HISTORY_TASK_PREFIX: &str = "history-";

fn format_system_time_local(ts: std::time::SystemTime) -> String {
    let dt_utc: chrono::DateTime<chrono::Utc> = ts.into();
    dt_utc
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn history_output_root(script_path: Option<&str>) -> PathBuf {
    resolve_task_output_dir("./output", script_path)
}

fn history_task_dir_name(task_id: &str) -> Option<&str> {
    task_id.strip_prefix(HISTORY_TASK_PREFIX)
}

fn history_task_id_from_dir_name(name: &str) -> String {
    format!("{}{}", HISTORY_TASK_PREFIX, name)
}

fn history_candidate_paths(dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut paths = vec![dir.join(name), dir.join("data").join(name)];
    let read_dir = match fs::read_dir(dir) {
        Ok(iter) => iter,
        Err(_) => return paths,
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        if dir_name.is_empty() || dir_name == "data" || dir_name == ".tmp_download" || dir_name == "checkpoints" {
            continue;
        }
        paths.push(path.join("data").join(name));
    }
    paths
}

fn history_candidate_file(dir: &Path, name: &str) -> Option<PathBuf> {
    history_candidate_paths(dir, name)
        .into_iter()
        .find(|path| path.exists() && path.is_file())
}

fn history_file_line_count(path: &Path) -> usize {
    fs::read_to_string(path)
        .ok()
        .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0)
}

fn history_task_log_lines(dir: &Path) -> Vec<String> {
    let preview_file = history_candidate_file(dir, "image_links.csv")
        .or_else(|| history_candidate_file(dir, "image_links.txt"));
    let failed_file = history_candidate_file(dir, "failed_downloads.txt");
    let report_file = history_candidate_file(dir, "download_report.csv");
    let failed_count = failed_file
        .as_ref()
        .map(|path| history_file_line_count(path))
        .unwrap_or(0);

    let mut lines = vec![format!(
        "[HISTORY] Loaded from output folder: {}",
        dir.to_string_lossy()
    )];
    if let Some(path) = preview_file {
        lines.push(format!("[HISTORY] Preview file: {}", path.to_string_lossy()));
    }
    if let Some(path) = report_file {
        lines.push(format!("[HISTORY] Report file: {}", path.to_string_lossy()));
    }
    if let Some(path) = failed_file {
        lines.push(format!(
            "[HISTORY] Failed list: {} (count={})",
            path.to_string_lossy(),
            failed_count
        ));
    } else {
        lines.push("[HISTORY] Failed list: not found".to_string());
    }
    lines
}

fn history_task_snapshot_from_output_dir(dir: &Path) -> Option<Value> {
    if !(dir.exists() && dir.is_dir()) {
        return None;
    }

    let dir_name = dir.file_name()?.to_string_lossy().to_string();
    let preview_file = history_candidate_file(dir, "image_links.csv")
        .or_else(|| history_candidate_file(dir, "image_links.txt"));
    let report_file = history_candidate_file(dir, "download_report.csv");
    let failed_file = history_candidate_file(dir, "failed_downloads.txt");
    let has_artifacts = preview_file.is_some() || report_file.is_some() || failed_file.is_some();
    if !has_artifacts {
        return None;
    }

    let modified = fs::metadata(dir)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .map(format_system_time_local)
        .unwrap_or_default();
    let log_total = history_task_log_lines(dir).len();

    let mut args = serde_json::Map::new();
    args.insert(
        "output".to_string(),
        Value::String(dir.to_string_lossy().to_string()),
    );
    if let Some(path) = failed_file.as_ref() {
        args.insert(
            "retry_failed_from".to_string(),
            Value::String(path.to_string_lossy().to_string()),
        );
    }
    if let Some(path) = preview_file.as_ref() {
        args.insert(
            "preview_source_file".to_string(),
            Value::String(path.to_string_lossy().to_string()),
        );
    }

    Some(json!({
        "task_id": history_task_id_from_dir_name(&dir_name),
        "status": "success",
        "created_at": modified,
        "started_at": "",
        "finished_at": modified,
        "exit_code": 0,
        "pid": Value::Null,
        "log_total": log_total,
        "output": dir.to_string_lossy().to_string(),
        "args": Value::Object(args),
        "history_task": true,
    }))
}

fn collect_history_task_snapshots(script_path: Option<&str>) -> Vec<Value> {
    let root = history_output_root(script_path);
    let mut entries: Vec<(std::time::SystemTime, Value)> = Vec::new();
    let read_dir = match fs::read_dir(&root) {
        Ok(iter) => iter,
        Err(_) => return Vec::new(),
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(meta) if meta.is_dir() => meta,
            _ => continue,
        };
        let snapshot = match history_task_snapshot_from_output_dir(&path) {
            Some(value) => value,
            None => continue,
        };
        let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((modified, snapshot));
    }

    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.into_iter().map(|(_, value)| value).collect()
}

fn history_task_snapshot_by_id(task_id: &str, script_path: Option<&str>) -> Option<Value> {
    let dir_name = history_task_dir_name(task_id)?;
    let output_dir = history_output_root(script_path).join(dir_name);
    history_task_snapshot_from_output_dir(&output_dir)
}

fn refresh_runtime_state(inner: &mut SidecarRuntime) {
    if let Some(child) = inner.child.as_mut() {
        if child.try_wait().ok().flatten().is_some() {
            inner.child = None;
            inner.started_at = None;
        }
    }
}

fn runtime_snapshot(inner: &SidecarRuntime) -> SidecarStatus {
    let pid = inner.child.as_ref().map(|c| c.id());
    SidecarStatus {
        process_running: inner.child.is_some(),
        pid,
        base_url: inner.base_url.clone(),
        token_configured: inner.token.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        script_path: inner.script_path.clone(),
        python_bin: inner.python_bin.clone(),
        started_at: inner.started_at.clone(),
    }
}

fn read_connection_config() -> Result<(String, Option<String>), String> {
    let lock = runtime()
        .lock()
        .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
    let mut inner = lock;
    refresh_runtime_state(&mut inner);
    let base_url = inner
        .base_url
        .clone()
        .ok_or_else(|| BackendError::from_message("Sidecar base URL is not configured").to_wire_string())?;
    Ok((base_url, inner.token.clone()))
}

async fn sidecar_http_request(
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let (base_url, token) = read_connection_config()?;
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| BackendError::from_message(format!("Failed to build HTTP client: {}", e)).to_wire_string())?;

    let mut req = client.request(method, &url);
    if let Some(t) = token {
        if !t.is_empty() {
            req = req.header("X-Sidecar-Token", t);
        }
    }
    if let Some(payload) = body {
        req = req.json(&payload);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| BackendError::from_message(format!("Sidecar request failed: {}", e)).to_wire_string())?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| BackendError::from_message(format!("Failed to read sidecar response: {}", e)).to_wire_string())?;

    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
    if !status.is_success() {
        return Err(
            BackendError::from_message(format!("Sidecar API error {}: {}", status, parsed)).to_wire_string(),
        );
    }
    Ok(parsed)
}

#[tauri::command]
pub fn crawler_sidecar_attach(base_url: String, token: Option<String>) -> Result<SidecarStatus, String> {
    let normalized = normalize_base_url(&base_url)
        .ok_or_else(|| BackendError::from_message("Invalid base_url").to_wire_string())?;
    let mut inner = runtime()
        .lock()
        .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
    refresh_runtime_state(&mut inner);
    inner.base_url = Some(normalized);
    inner.token = token.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(runtime_snapshot(&inner))
}

#[tauri::command]
pub fn crawler_sidecar_status() -> Result<SidecarStatus, String> {
    let mut inner = runtime()
        .lock()
        .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
    refresh_runtime_state(&mut inner);
    Ok(runtime_snapshot(&inner))
}

#[tauri::command]
pub fn crawler_sidecar_start_service(
    script_path: String,
    host: Option<String>,
    port: Option<u16>,
    token: Option<String>,
    python_bin: Option<String>,
) -> Result<SidecarStatus, String> {
    let script = PathBuf::from(script_path.trim());
    if !script.exists() {
        return Err(
            BackendError::from_message(format!("Sidecar script not found: {}", script.display())).to_wire_string(),
        );
    }

    let h = host
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let p = port.unwrap_or(17870);
    let py = python_bin
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| "python".to_string());
    let base_url = format!("http://{}:{}", h, p);

    let mut inner = runtime()
        .lock()
        .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
    refresh_runtime_state(&mut inner);
    if inner.child.is_some() {
        return Err(BackendError::from_message("Sidecar service is already running").to_wire_string());
    }

    let mut cmd = Command::new(&py);
    cmd.arg(script.to_string_lossy().to_string())
        .arg("--host")
        .arg(&h)
        .arg("--port")
        .arg(p.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .hide_window();
    if let Some(t) = token.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        cmd.arg("--token").arg(t);
    }
    if let Some(parent) = script.parent() {
        cmd.current_dir(parent);
    }

    let child = cmd
        .spawn()
        .map_err(|e| BackendError::from_message(format!("Failed to start sidecar service: {}", e)).to_wire_string())?;

    inner.child = Some(child);
    inner.base_url = Some(base_url);
    inner.token = token.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    inner.script_path = Some(script.to_string_lossy().to_string());
    inner.python_bin = Some(py);
    inner.started_at = Some(now_rfc3339());
    Ok(runtime_snapshot(&inner))
}

#[tauri::command]
pub fn crawler_sidecar_stop_service() -> Result<SidecarStatus, String> {
    let mut inner = runtime()
        .lock()
        .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
    refresh_runtime_state(&mut inner);
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    inner.started_at = None;
    Ok(runtime_snapshot(&inner))
}

#[tauri::command]
pub async fn crawler_sidecar_health() -> Result<Value, String> {
    sidecar_http_request(Method::GET, "/health", None).await
}

#[tauri::command]
pub async fn crawler_sidecar_list_tasks() -> Result<Value, String> {
    let live = sidecar_http_request(Method::GET, "/api/v1/tasks", None).await?;
    let live_items = live
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if !live_items.is_empty() {
        return Ok(live);
    }

    let script_path = {
        let mut inner = runtime()
            .lock()
            .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
        refresh_runtime_state(&mut inner);
        inner.script_path.clone()
    };
    let history_items = collect_history_task_snapshots(script_path.as_deref());
    Ok(json!({
        "items": history_items,
        "history_fallback": true,
    }))
}

#[tauri::command]
pub async fn crawler_sidecar_start_task(payload: Value) -> Result<Value, String> {
    sidecar_http_request(Method::POST, "/api/v1/tasks/start", Some(payload)).await
}

#[tauri::command]
pub async fn crawler_sidecar_get_task(task_id: String) -> Result<Value, String> {
    let id = task_id.trim();
    if !is_valid_task_id(id) {
        return Err(BackendError::from_message("Invalid task_id").to_wire_string());
    }
    if history_task_dir_name(id).is_some() {
        let script_path = {
            let mut inner = runtime()
                .lock()
                .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
            refresh_runtime_state(&mut inner);
            inner.script_path.clone()
        };
        return history_task_snapshot_by_id(id, script_path.as_deref()).ok_or_else(|| {
            BackendError::from_message(format!("History task {} not found", id)).to_wire_string()
        });
    }
    let path = format!("/api/v1/tasks/{}", id);
    sidecar_http_request(Method::GET, &path, None).await
}

#[tauri::command]
pub async fn crawler_sidecar_stop_task(task_id: String) -> Result<Value, String> {
    let id = task_id.trim();
    if !is_valid_task_id(id) {
        return Err(BackendError::from_message("Invalid task_id").to_wire_string());
    }
    let path = format!("/api/v1/tasks/{}/stop", id);
    sidecar_http_request(Method::POST, &path, Some(Value::Object(Default::default()))).await
}

#[tauri::command]
pub async fn crawler_sidecar_get_task_logs(
    task_id: String,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Value, String> {
    let id = task_id.trim();
    if !is_valid_task_id(id) {
        return Err(BackendError::from_message("Invalid task_id").to_wire_string());
    }
    let ofs = offset.unwrap_or(0).max(0);
    let lim = limit.unwrap_or(200).clamp(1, 1000);
    if history_task_dir_name(id).is_some() {
        let script_path = {
            let mut inner = runtime()
                .lock()
                .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
            refresh_runtime_state(&mut inner);
            inner.script_path.clone()
        };
        let dir_name = history_task_dir_name(id).ok_or_else(|| {
            BackendError::from_message(format!("History task {} not found", id)).to_wire_string()
        })?;
        let output_dir = history_output_root(script_path.as_deref()).join(dir_name);
        let lines_all = history_task_log_lines(&output_dir);
        let total = lines_all.len() as i64;
        let start = ofs.min(total).max(0) as usize;
        let end = (start as i64 + lim).min(total).max(start as i64) as usize;
        let lines = lines_all[start..end].to_vec();
        return Ok(json!({
            "task_id": id,
            "offset": start,
            "next_offset": end,
            "total": total,
            "base": 0,
            "lines": lines,
        }));
    }
    let path = format!("/api/v1/tasks/{}/logs?offset={}&limit={}", id, ofs, lim);
    sidecar_http_request(Method::GET, &path, None).await
}

#[tauri::command]
pub async fn crawler_sidecar_collect_task_links(
    task_id: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let id = task_id.trim();
    if !is_valid_task_id(id) {
        return Err(BackendError::from_message("Invalid task_id").to_wire_string());
    }

    let script_path = {
        let mut inner = runtime()
            .lock()
            .map_err(|_| BackendError::from_message("Failed to lock sidecar runtime").to_wire_string())?;
        refresh_runtime_state(&mut inner);
        inner.script_path.clone()
    };

    let (task_status, output_dir) = if history_task_dir_name(id).is_some() {
        let snapshot = history_task_snapshot_by_id(id, script_path.as_deref()).ok_or_else(|| {
            BackendError::from_message(format!("History task {} not found", id)).to_wire_string()
        })?;
        let task_obj = snapshot
            .as_object()
            .ok_or_else(|| BackendError::from_message("Invalid history task response").to_wire_string())?;
        let output_raw = task_obj
            .get("output")
            .and_then(|v| v.as_str())
            .unwrap_or("./output");
        (
            task_obj.get("status").cloned().unwrap_or(Value::Null),
            resolve_task_output_dir(output_raw, script_path.as_deref()),
        )
    } else {
        let task_path = format!("/api/v1/tasks/{}", id);
        let task_data = sidecar_http_request(Method::GET, &task_path, None).await?;
        let task_obj = task_data
            .as_object()
            .ok_or_else(|| BackendError::from_message("Invalid sidecar task response").to_wire_string())?;

        let args_obj = task_obj.get("args").and_then(|v| v.as_object());
        let output_raw = args_obj
            .and_then(|args| args.get("output"))
            .and_then(|v| v.as_str())
            .or_else(|| task_obj.get("output").and_then(|v| v.as_str()))
            .unwrap_or("./output");
        (
            task_obj.get("status").cloned().unwrap_or(Value::Null),
            resolve_task_output_dir(output_raw, script_path.as_deref()),
        )
    };
    let candidate_names = [
        "image_links.txt",
        "detected_original_links.txt",
        "image_links.csv",
        "preview_links.csv",
        "download_report.csv",
    ];

    let mut checked_files: Vec<String> = Vec::new();
    let mut url_dedup: HashSet<String> = HashSet::new();
    let mut item_dedup: HashSet<String> = HashSet::new();
    let mut urls: Vec<String> = Vec::new();
    let mut structured_items: Vec<Value> = Vec::new();
    let mut source_file: Option<String> = None;

    for name in &candidate_names {
        let candidate_paths = history_candidate_paths(&output_dir, name);
        for path in candidate_paths {
            let path_text = path.to_string_lossy().to_string();
            if checked_files.iter().any(|existing| existing == &path_text) {
                continue;
            }
            checked_files.push(path_text.clone());
            if !(path.exists() && path.is_file()) {
                continue;
            }

            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let text = String::from_utf8_lossy(&bytes);
            let added = if path
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("csv"))
                .unwrap_or(false)
            {
                extract_media_items_from_csv_text(
                    &text,
                    &path_text,
                    &mut item_dedup,
                    &mut structured_items,
                    &mut url_dedup,
                    &mut urls,
                )
            } else {
                extract_http_urls_from_text(&text, &mut url_dedup, &mut urls)
            };
            if added > 0 {
                source_file = Some(path_text.clone());
                if *name == "image_links.txt"
                    || *name == "detected_original_links.txt"
                    || *name == "image_links.csv"
                {
                    break;
                }
            }
        }
        if source_file.is_some()
            && (*name == "image_links.txt"
                || *name == "detected_original_links.txt"
                || *name == "image_links.csv")
        {
            break;
        }
    }

    let cap = limit.unwrap_or(5000).clamp(1, 20000) as usize;
    let total_urls = urls.len();
    let truncated = total_urls > cap;
    if truncated {
        urls.truncate(cap);
    }

    Ok(json!({
        "task_id": id,
        "task_status": task_status,
        "output_dir": output_dir.to_string_lossy().to_string(),
        "source_file": source_file,
        "files_checked": checked_files,
        "total_urls": total_urls,
        "returned_urls": urls.len(),
        "truncated": truncated,
        "urls": urls,
        "items": structured_items,
    }))
}


