use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};

use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, RANGE};

// Pending deep links received before the frontend listener is ready.
static PENDING_EXTERNAL_LINKS: Mutex<Vec<String>> = Mutex::new(Vec::new());
const MAX_PENDING_EXTERNAL_LINKS: usize = 100;
const MAX_EXTERNAL_LINK_LENGTH: usize = 4096;

#[derive(Clone, serde::Serialize)]
pub struct ExternalOpenUrlEventPayload {
    pub urls: Vec<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchRequest {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub range_start: Option<u64>,
    pub range_end: Option<u64>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageResolveRequest {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPageEntry {
    pub url: String,
    pub title: String,
    pub duration: i32,
    pub group_title: String,
    pub logo_url: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPageSource {
    pub source_url: String,
    pub context_url: String,
    pub resolved_url: String,
    pub label: String,
    pub entries: Vec<ResolvedPageEntry>,
}
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpInspectResponse {
    pub url: String,
    pub final_url: String,
    pub status: u16,
    pub ok: bool,
    pub content_type: String,
    pub content_length: Option<u64>,
}

fn extract_external_link_from_arg(arg: &str) -> Option<String> {
    let trimmed = arg.trim().trim_matches('"').trim_matches('\'');
    if trimmed.starts_with("youwee://") {
        if is_valid_external_link(trimmed) {
            return Some(trimmed.to_string());
        }
        return None;
    }

    trimmed.find("youwee://").and_then(|start| {
        let candidate = trimmed[start..].trim_matches('"').to_string();
        if is_valid_external_link(&candidate) {
            Some(candidate)
        } else {
            None
        }
    })
}

fn is_valid_external_link(link: &str) -> bool {
    let trimmed = link.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_EXTERNAL_LINK_LENGTH {
        return false;
    }
    if !trimmed.starts_with("youwee://download") {
        return false;
    }
    trimmed.contains("v=1") && trimmed.contains("url=")
}

pub fn extract_external_links_from_argv(argv: &[String]) -> Vec<String> {
    let mut links: Vec<String> = Vec::new();
    for arg in argv {
        if let Some(link) = extract_external_link_from_arg(arg) {
            if !links.iter().any(|existing| existing == &link) {
                links.push(link);
            }
        }
    }
    links
}

pub fn enqueue_external_links(urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    if let Ok(mut pending) = PENDING_EXTERNAL_LINKS.lock() {
        for url in urls {
            if !is_valid_external_link(&url) {
                continue;
            }
            if !pending.iter().any(|existing| existing == &url) {
                pending.push(url);
                if pending.len() > MAX_PENDING_EXTERNAL_LINKS {
                    let overflow = pending.len() - MAX_PENDING_EXTERNAL_LINKS;
                    pending.drain(0..overflow);
                }
            }
        }
    }
}

pub fn take_pending_external_links() -> Vec<String> {
    if let Ok(mut pending) = PENDING_EXTERNAL_LINKS.lock() {
        return std::mem::take(&mut *pending);
    }
    Vec::new()
}

fn validate_remote_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Only http:// and https:// URLs are supported".to_string());
    }
    Ok(trimmed)
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

fn build_headers(request: &HttpFetchRequest) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    for (name, value) in &request.headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("Invalid header name '{}': {}", name, e))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|e| format!("Invalid header value for '{}': {}", name, e))?;
        headers.insert(header_name, header_value);
    }

    if !headers.contains_key("user-agent") {
        headers.insert(
            HeaderName::from_static("user-agent"),
            HeaderValue::from_static("Youwee/1.0"),
        );
    }

    if !headers.contains_key(RANGE) {
        if let Some(start) = request.range_start {
            let range_value = match request.range_end {
                Some(end) => format!("bytes={}-{}", start, end),
                None => format!("bytes={}-", start),
            };
            let header_value = HeaderValue::from_str(&range_value)
                .map_err(|e| format!("Invalid range header: {}", e))?;
            headers.insert(RANGE, header_value);
        }
    }

    Ok(headers)
}

async fn send_http_request(request: &HttpFetchRequest) -> Result<reqwest::Response, String> {
    let url = validate_remote_url(&request.url)?;
    let client = build_http_client()?;
    let headers = build_headers(request)?;

    let response = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    Ok(response)
}

async fn fetch_text_with_headers(
    url: &str,
    headers: HashMap<String, String>,
) -> Result<String, String> {
    fetch_text_url(HttpFetchRequest {
        url: url.to_string(),
        headers,
        range_start: None,
        range_end: None,
    })
    .await
}

fn build_page_fetch_headers(
    source_url: &str,
    extra_headers: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut headers = extra_headers.clone();
    if let Ok(parsed) = reqwest::Url::parse(source_url) {
        let origin = format!(
            "{}://{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or_default()
        );
        headers
            .entry("Referer".to_string())
            .or_insert_with(|| source_url.to_string());
        headers.entry("Origin".to_string()).or_insert(origin);
    }
    headers
}

fn normalize_title(raw: &str, fallback: &str) -> String {
    let cleaned = raw
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("—", " ")
        .replace("|", " ")
        .trim()
        .to_string();

    let normalized = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn extract_html_title(html: &str, fallback: &str) -> String {
    let title_regex = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("valid title regex");
    title_regex
        .captures(html)
        .and_then(|captures| captures.get(1))
        .map(|value| normalize_title(value.as_str(), fallback))
        .unwrap_or_else(|| fallback.to_string())
}

fn decode_js_escapes(value: &str) -> String {
    value
        .replace("\\u0026", "&")
        .replace("\\u002F", "/")
        .replace("\\/", "/")
}

fn resolve_candidate_url(candidate: &str, base: &str) -> Option<String> {
    let trimmed = decode_js_escapes(candidate.trim());
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Some(trimmed);
    }
    if trimmed.starts_with("//") {
        let parsed = reqwest::Url::parse(base).ok()?;
        return Some(format!("{}:{}", parsed.scheme(), trimmed));
    }
    let base_url = reqwest::Url::parse(base).ok()?;
    base_url.join(&trimmed).ok().map(|url| url.to_string())
}

fn media_extension_priority(url: &str) -> Option<(u8, String)> {
    let lower = url.to_ascii_lowercase();
    for (score, ext) in [
        (1, ".m3u8"),
        (1, ".m3u"),
        (2, ".mpd"),
        (3, ".mp4"),
        (4, ".m4v"),
        (5, ".webm"),
        (6, ".mov"),
    ] {
        if lower.contains(ext) {
            return Some((score, ext.trim_start_matches('.').to_string()));
        }
    }
    None
}

fn push_candidate(candidates: &mut Vec<String>, seen: &mut HashSet<String>, candidate: Option<String>) {
    if let Some(value) = candidate {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() || !seen.insert(trimmed.clone()) {
            return;
        }
        candidates.push(trimmed);
    }
}

fn extract_candidates_by_regex(html: &str, base_url: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    let patterns = [
        r#"(?is)<source[^>]+src=["']([^"']+)["']"#,
        r#"(?is)<video[^>]+src=["']([^"']+)["']"#,
        r#"(?is)<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']"#,
        r#"(?is)<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']"#,
        r#"(?is)(?:file|src|url|playUrl|videoUrl|streamUrl|contentUrl)\s*[:=]\s*["']([^"']+\.(?:m3u8?|mpd|mp4|m4v|webm|mov)[^"']*)["']"#,
        r#"(?is)["']((?:https?:)?//[^"']+\.(?:m3u8?|mpd|mp4|m4v|webm|mov)[^"']*)["']"#,
        r#"(?is)["']([^"']+\.(?:m3u8?|mpd|mp4|m4v|webm|mov)[^"']*)["']"#,
    ];

    for raw in patterns {
        let pattern = Regex::new(raw).expect("valid media regex");
        for captures in pattern.captures_iter(html) {
            if let Some(candidate) = captures.get(1) {
                push_candidate(
                    &mut candidates,
                    &mut seen,
                    resolve_candidate_url(candidate.as_str(), base_url),
                );
            }
        }
    }

    candidates
}

fn extract_candidate_iframes(html: &str, base_url: &str) -> Vec<String> {
    let iframe_regex = Regex::new(r#"(?is)<iframe[^>]+src=["']([^"']+)["']"#)
        .expect("valid iframe regex");
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for captures in iframe_regex.captures_iter(html) {
        if let Some(candidate) = captures.get(1) {
            push_candidate(
                &mut results,
                &mut seen,
                resolve_candidate_url(candidate.as_str(), base_url),
            );
        }
    }
    results
}

fn build_entries(label: &str, candidates: &[String]) -> Vec<ResolvedPageEntry> {
    let mut entries = Vec::new();
    for (index, url) in candidates.iter().enumerate() {
        let kind = media_extension_priority(url)
            .map(|(_, ext)| ext.to_ascii_uppercase())
            .unwrap_or_else(|| "STREAM".to_string());
        let title = if candidates.len() == 1 {
            label.to_string()
        } else {
            format!("{} [{} {}]", label, kind, index + 1)
        };
        entries.push(ResolvedPageEntry {
            url: url.clone(),
            title,
            duration: -1,
            group_title: "Page stream".to_string(),
            logo_url: String::new(),
        });
    }
    entries
}

fn is_avjb_host(parsed: &reqwest::Url) -> bool {
    matches!(parsed.host_str().unwrap_or_default().to_ascii_lowercase().as_str(), "avjb.cc" | "www.avjb.cc" | "avjb.com" | "www.avjb.com")
}

fn extract_avjb_video_id(path: &str) -> Option<String> {
    let patterns = [
        Regex::new(r"/video/(\d+)(?:/|$)").ok()?,
        Regex::new(r"/videos/(\d+)(?:/|$)").ok()?,
        Regex::new(r"/newembed/(\d+)(?:/|$)").ok()?,
    ];
    for pattern in &patterns {
        if let Some(captures) = pattern.captures(path) {
            if let Some(video_id) = captures.get(1) {
                return Some(video_id.as_str().to_string());
            }
        }
    }
    None
}

fn build_avjb_embed_url(parsed: &reqwest::Url, video_id: &str) -> String {
    let locale = parsed
        .path_segments()
        .and_then(|mut segments| {
            let first = segments.next()?.trim();
            if first.len() >= 2
                && first.len() <= 5
                && first.chars().all(|ch| ch.is_ascii_alphabetic())
            {
                Some(first.to_string())
            } else {
                None
            }
        })
        .unwrap_or_default();

    if locale.is_empty() {
        format!(
            "{}://{}/newembed/{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or("avjb.com"),
            video_id
        )
    } else {
        format!(
            "{}://{}/{}/newembed/{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or("avjb.com"),
            locale,
            video_id
        )
    }
}

#[tauri::command]
pub fn consume_pending_external_links() -> Vec<String> {
    take_pending_external_links()
}

#[tauri::command]
pub async fn inspect_http_url(request: HttpFetchRequest) -> Result<HttpInspectResponse, String> {
    let url = validate_remote_url(&request.url)?;
    let client = build_http_client()?;
    let headers = build_headers(&request)?;

    let response = client
        .get(url.clone())
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let content_length = response.content_length();

    Ok(HttpInspectResponse {
        url,
        final_url,
        status: status.as_u16(),
        ok: status.is_success(),
        content_type,
        content_length,
    })
}
#[tauri::command]
pub async fn fetch_text_url(request: HttpFetchRequest) -> Result<String, String> {
    let response = send_http_request(&request).await?;
    response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))
}

#[tauri::command]
pub async fn fetch_binary_url(request: HttpFetchRequest) -> Result<Vec<u8>, String> {
    let response = send_http_request(&request).await?;
    response
        .bytes()
        .await
        .map(|body| body.to_vec())
        .map_err(|e| format!("Failed to read binary response body: {}", e))
}

#[tauri::command]
pub async fn resolve_page_stream(request: PageResolveRequest) -> Result<ResolvedPageSource, String> {
    let source_url = validate_remote_url(&request.url)?;
    let parsed = reqwest::Url::parse(&source_url).map_err(|e| format!("Invalid URL: {}", e))?;
    let headers = build_page_fetch_headers(&source_url, &request.headers);
    let html = fetch_text_with_headers(&source_url, headers.clone()).await?;

    if html.trim_start().starts_with("#EXTM3U") {
        let label = extract_html_title(&html, parsed.host_str().unwrap_or("stream"));
        return Ok(ResolvedPageSource {
            source_url: source_url.clone(),
            context_url: source_url.clone(),
            resolved_url: source_url.clone(),
            label: if label.is_empty() { source_url.clone() } else { label.clone() },
            entries: vec![ResolvedPageEntry {
                url: source_url.clone(),
                title: if label.is_empty() { source_url.clone() } else { label },
                duration: -1,
                group_title: "HLS".to_string(),
                logo_url: String::new(),
            }],
        });
    }

    let fallback_label = parsed
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| parsed.host_str().unwrap_or("Page stream"));
    let label = extract_html_title(&html, fallback_label);

    let mut context_url = source_url.clone();

    let mut candidates = if is_avjb_host(&parsed) {
        if let Some(video_id) = extract_avjb_video_id(parsed.path()) {
            let embed_url = build_avjb_embed_url(&parsed, &video_id);
            let embed_headers = build_page_fetch_headers(&source_url, &request.headers);
            if let Ok(embed_html) = fetch_text_with_headers(&embed_url, embed_headers).await {
                context_url = embed_url.clone();
                extract_candidates_by_regex(&embed_html, &embed_url)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    } else {
        extract_candidates_by_regex(&html, &source_url)
    };

    if candidates.is_empty() {
        let iframe_urls = extract_candidate_iframes(&html, &source_url);
        for iframe_url in iframe_urls.into_iter().take(3) {
            let iframe_headers = build_page_fetch_headers(&source_url, &request.headers);
            if let Ok(iframe_html) = fetch_text_with_headers(&iframe_url, iframe_headers).await {
                let nested = extract_candidates_by_regex(&iframe_html, &iframe_url);
                if !nested.is_empty() {
                    candidates = nested;
                    break;
                }
            }
        }
    }

    candidates.sort_by_key(|url| media_extension_priority(url).unwrap_or((99, "zzz".to_string())));
    candidates.dedup();

    if is_avjb_host(&parsed) && !candidates.is_empty() {
        candidates.truncate(1);
    }

    if candidates.is_empty() {
        return Err("No playable page stream found".to_string());
    }

    let entries = build_entries(&label, &candidates);
    let resolved_url = entries
        .first()
        .map(|entry| entry.url.clone())
        .unwrap_or_else(|| source_url.clone());

    Ok(ResolvedPageSource {
        source_url,
        context_url,
        resolved_url,
        label,
        entries,
    })
}

#[tauri::command]
pub async fn resolve_avjb_page(request: PageResolveRequest) -> Result<ResolvedPageSource, String> {
    let parsed = reqwest::Url::parse(&validate_remote_url(&request.url)?)
        .map_err(|e| format!("Invalid URL: {}", e))?;
    if !is_avjb_host(&parsed) {
        return Err("Only avjb.cc or avjb.com URLs are supported".to_string());
    }
    resolve_page_stream(request).await
}





