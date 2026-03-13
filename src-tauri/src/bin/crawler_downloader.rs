use futures_util::StreamExt;
use reqwest::header::{COOKIE, RANGE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::{Mutex, Notify};

#[derive(Default, Debug, Clone)]
struct Config {
    url: String,
    output: PathBuf,
    referer: Option<String>,
    cookie_header: Option<String>,
    proxy: Option<String>,
    connect_timeout_s: u64,
    read_timeout_s: u64,
    segments: usize,
    chunk_size_mb: f64,
    segmented: bool,
}

#[derive(Serialize)]
struct OutputPayload {
    content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestRange {
    id: u64,
    start: u64,
    end: u64,
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestPayload {
    url: String,
    total_size: u64,
    worker_count: usize,
    ranges: Vec<ManifestRange>,
}

#[derive(Debug, Clone)]
struct RangeEntry {
    id: u64,
    start: u64,
    end: u64,
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct ChunkResult {
    throughput_bps: f64,
    retry_reason: Option<String>,
}

#[derive(Debug)]
struct SchedulerState {
    pending: Vec<RangeEntry>,
    inflight: Vec<RangeEntry>,
    completed: Vec<RangeEntry>,
    next_part_id: u64,
    base_chunk_size: u64,
    active_chunk_size: u64,
    throughput_ewma: f64,
    worker_count: usize,
    dispatch_limit: usize,
    active_workers: usize,
    slow_window: usize,
    restore_window: usize,
    request_failures: usize,
    status_failures: usize,
    stream_failures: usize,
    incomplete_failures: usize,
    error: Option<String>,
}

fn parse_args() -> Result<Config, String> {
    let mut cfg = Config {
        connect_timeout_s: 10,
        read_timeout_s: 60,
        segments: 4,
        chunk_size_mb: 0.0,
        segmented: false,
        ..Default::default()
    };

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => cfg.url = args.next().ok_or("missing value for --url")?,
            "--output" => cfg.output = PathBuf::from(args.next().ok_or("missing value for --output")?),
            "--referer" => cfg.referer = args.next().map(Some).ok_or("missing value for --referer")?,
            "--cookie-header" => cfg.cookie_header = args.next().map(Some).ok_or("missing value for --cookie-header")?,
            "--proxy" => cfg.proxy = args.next().map(Some).ok_or("missing value for --proxy")?,
            "--connect-timeout" => {
                cfg.connect_timeout_s = args.next().ok_or("missing value for --connect-timeout")?.parse().map_err(|_| "invalid --connect-timeout")?
            }
            "--read-timeout" => {
                cfg.read_timeout_s = args.next().ok_or("missing value for --read-timeout")?.parse().map_err(|_| "invalid --read-timeout")?
            }
            "--segments" => {
                cfg.segments = args.next().ok_or("missing value for --segments")?.parse().map_err(|_| "invalid --segments")?
            }
            "--chunk-size-mb" => {
                cfg.chunk_size_mb = args.next().ok_or("missing value for --chunk-size-mb")?.parse().map_err(|_| "invalid --chunk-size-mb")?
            }
            "--segmented" => cfg.segmented = true,
            other => return Err(format!("unknown arg: {}", other)),
        }
    }

    if cfg.url.trim().is_empty() {
        return Err("--url is required".to_string());
    }
    if cfg.output.as_os_str().is_empty() {
        return Err("--output is required".to_string());
    }
    cfg.segments = cfg.segments.clamp(1, 16);
    Ok(cfg)
}

fn normalize_host(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|value| value.host_str().map(|host| host.to_ascii_lowercase()))
        .unwrap_or_default()
}

fn is_google_host(host: &str) -> bool {
    host.contains("googleusercontent.com") || host.contains("googlevideo.com")
}

#[derive(Clone, Copy)]
struct HostTransferPolicy {
    segment_cap: usize,
    chunk_cap: u64,
}

fn host_transfer_policy(host: &str) -> HostTransferPolicy {
    if host == "i.ibb.co" {
        HostTransferPolicy {
            segment_cap: 4,
            chunk_cap: 6 * 1024 * 1024,
        }
    } else if is_google_host(host) {
        HostTransferPolicy {
            segment_cap: 6,
            chunk_cap: 8 * 1024 * 1024,
        }
    } else {
        HostTransferPolicy {
            segment_cap: 8,
            chunk_cap: 12 * 1024 * 1024,
        }
    }
}

fn build_part_path(output: &Path, index: u64) -> PathBuf {
    PathBuf::from(format!("{}.part{}", output.to_string_lossy(), index))
}

fn build_manifest_path(output: &Path) -> PathBuf {
    PathBuf::from(format!("{}.parts.json", output.to_string_lossy()))
}

fn entry_size(entry: &RangeEntry) -> u64 {
    entry.end.saturating_sub(entry.start).saturating_add(1)
}

fn entry_current_size(entry: &RangeEntry) -> u64 {
    fs::metadata(&entry.path).map(|meta| meta.len()).unwrap_or(0).min(entry_size(entry))
}

fn entry_done(entry: &RangeEntry) -> bool {
    let expected = entry_size(entry);
    expected > 0 && entry_current_size(entry) >= expected
}

fn build_entry(output: &Path, id: u64, start: u64, end: u64) -> RangeEntry {
    RangeEntry {
        id,
        start,
        end,
        path: build_part_path(output, id),
    }
}

fn split_entry(entry: &RangeEntry, next_part_id: u64, output: &Path) -> Option<(RangeEntry, RangeEntry)> {
    if entry.end <= entry.start {
        return None;
    }
    let mid = entry.start + ((entry.end - entry.start + 1) / 2) - 1;
    if mid < entry.start || mid >= entry.end {
        return None;
    }
    Some((
        RangeEntry {
            id: entry.id,
            start: entry.start,
            end: mid,
            path: entry.path.clone(),
        },
        build_entry(output, next_part_id, mid + 1, entry.end),
    ))
}

fn manifest_snapshot(url: &str, total_size: u64, worker_count: usize, entries: &[RangeEntry]) -> ManifestPayload {
    let mut ranges: Vec<ManifestRange> = entries
        .iter()
        .map(|entry| {
            let current = entry_current_size(entry);
            ManifestRange {
                id: entry.id,
                start: entry.start,
                end: entry.end,
                path: entry.path.to_string_lossy().to_string(),
                size: current,
                done: current >= entry_size(entry) && entry_size(entry) > 0,
            }
        })
        .collect();
    ranges.sort_by_key(|entry| (entry.start, entry.id));
    ManifestPayload {
        url: url.to_string(),
        total_size,
        worker_count,
        ranges,
    }
}

fn write_manifest(manifest_path: &Path, payload: &ManifestPayload) -> Result<(), String> {
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create manifest dir: {}", e))?;
    }
    let text = serde_json::to_string_pretty(payload).map_err(|e| format!("failed to encode manifest: {}", e))?;
    fs::write(manifest_path, text).map_err(|e| format!("failed to write manifest: {}", e))
}

fn load_manifest(manifest_path: &Path, url: &str, total_size: u64) -> Option<(Vec<RangeEntry>, u64)> {
    let text = fs::read_to_string(manifest_path).ok()?;
    let payload: ManifestPayload = serde_json::from_str(&text).ok()?;
    if payload.url != url || payload.total_size != total_size || payload.ranges.is_empty() {
        return None;
    }
    let mut next_id = 0u64;
    let mut entries = Vec::new();
    for (index, item) in payload.ranges.into_iter().enumerate() {
        if item.end < item.start {
            continue;
        }
        let id = if item.id == 0 && index > 0 { index as u64 } else { item.id };
        next_id = next_id.max(id.saturating_add(1));
        entries.push(RangeEntry {
            id,
            start: item.start,
            end: item.end,
            path: if item.path.trim().is_empty() {
                let base = PathBuf::from(manifest_path.to_string_lossy().trim_end_matches(".parts.json"));
                build_part_path(&base, id)
            } else {
                PathBuf::from(item.path)
            },
        });
    }
    if entries.is_empty() {
        return None;
    }
    entries.sort_by_key(|entry| (entry.start, entry.id));
    Some((entries, next_id))
}

fn remove_range_artifacts(output: &Path) {
    let _ = fs::remove_file(build_manifest_path(output));
    if let Some(parent) = output.parent() {
        if let Some(name) = output.file_name().and_then(|value| value.to_str()) {
            if let Ok(read_dir) = fs::read_dir(parent) {
                for item in read_dir.flatten() {
                    let path = item.path();
                    if let Some(file_name) = path.file_name().and_then(|value| value.to_str()) {
                        if file_name.starts_with(&format!("{}.part", name)) {
                            let _ = fs::remove_file(path);
                        }
                    }
                }
            }
        }
    }
}

fn estimate_chunk_size(host: &str, total_size: u64, chunk_size_mb: f64, segments: usize) -> u64 {
    let policy = host_transfer_policy(host);
    if chunk_size_mb > 0.0 {
        return ((chunk_size_mb * 1024.0 * 1024.0).round() as u64).max(512 * 1024);
    }
    let mut chunk = (total_size / segments.max(1) as u64).max(1024 * 1024);
    if total_size >= 128 * 1024 * 1024 {
        chunk = chunk.max(6 * 1024 * 1024);
    } else if total_size >= 32 * 1024 * 1024 {
        chunk = chunk.max(3 * 1024 * 1024);
    }
    chunk = chunk.min(policy.chunk_cap);
    chunk.max(512 * 1024)
}

fn adapt_chunk_size(host: &str, base_chunk_size: u64, observed_bps: f64) -> u64 {
    let policy = host_transfer_policy(host);
    if observed_bps <= 0.0 {
        return base_chunk_size;
    }
    let mut chunk = base_chunk_size;
    if observed_bps < 1.5 * 1024.0 * 1024.0 {
        chunk = (base_chunk_size / 4).max(512 * 1024);
    } else if observed_bps < 4.0 * 1024.0 * 1024.0 {
        chunk = (base_chunk_size / 2).max(1024 * 1024);
    } else if observed_bps > 20.0 * 1024.0 * 1024.0 {
        chunk = (base_chunk_size * 2).min(16 * 1024 * 1024);
    } else if observed_bps > 10.0 * 1024.0 * 1024.0 {
        chunk = ((base_chunk_size as f64 * 1.5) as u64).min(12 * 1024 * 1024);
    }
    chunk = chunk.min(policy.chunk_cap);
    chunk.max(512 * 1024)
}

fn classify_retry_reason(reason: &str) -> &'static str {
    if reason.starts_with("status_") {
        "status"
    } else if reason == "stream" {
        "stream"
    } else if reason == "incomplete" {
        "incomplete"
    } else {
        "request"
    }
}

fn initial_ranges(host: &str, output: &Path, total_size: u64, base_chunk_size: u64, workers: usize) -> Vec<RangeEntry> {
    if total_size == 0 {
        return vec![build_entry(output, 0, 0, 0)];
    }
    let initial_chunk_size = (base_chunk_size * 4).max((total_size + workers as u64 - 1) / workers.max(1) as u64);
    let mut entries = Vec::new();
    let mut start = 0u64;
    let mut next_id = 0u64;
    let _ = host;
    while start < total_size {
        let end = (start + initial_chunk_size).saturating_sub(1).min(total_size.saturating_sub(1));
        entries.push(build_entry(output, next_id, start, end));
        next_id += 1;
        start = end.saturating_add(1);
    }
    entries
}

fn maybe_expand_pending(pending: &mut Vec<RangeEntry>, target_chunk_size: u64, desired_pending: usize, next_part_id: &mut u64, output: &Path) {
    while pending.len() < desired_pending {
        let mut split_index: Option<usize> = None;
        let mut split_size = 0u64;
        for (idx, entry) in pending.iter().enumerate() {
            let current_size = entry_size(entry);
            if entry_current_size(entry) > 0 {
                continue;
            }
            if current_size > target_chunk_size.saturating_mul(2) && current_size > split_size {
                split_index = Some(idx);
                split_size = current_size;
            }
        }
        let Some(index) = split_index else {
            break;
        };
        let entry = pending.remove(index);
        let Some((left, right)) = split_entry(&entry, *next_part_id, output) else {
            pending.push(entry);
            break;
        };
        *next_part_id += 1;
        pending.push(left);
        pending.push(right);
    }
    pending.sort_by_key(|entry| (entry.start, entry.id));
}

fn build_client(cfg: &Config) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(std::time::Duration::from_secs(cfg.connect_timeout_s))
        .read_timeout(std::time::Duration::from_secs(cfg.read_timeout_s));
    if let Some(proxy) = cfg.proxy.as_deref().filter(|v| !v.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("invalid proxy: {}", e))?);
    }
    builder.build().map_err(|e| format!("failed to build client: {}", e))
}

fn apply_headers(mut req: reqwest::RequestBuilder, cfg: &Config) -> reqwest::RequestBuilder {
    req = req.header(USER_AGENT, "Mozilla/5.0 YouweeCrawlerRust/0.11.1");
    if let Some(referer) = cfg.referer.as_deref().filter(|v| !v.trim().is_empty()) {
        req = req.header(REFERER, referer);
    }
    if let Some(cookie) = cfg.cookie_header.as_deref().filter(|v| !v.trim().is_empty()) {
        req = req.header(COOKIE, cookie);
    }
    req
}

fn spawn_progress_reporter(
    mode: &'static str,
    downloaded: Arc<AtomicU64>,
    total: u64,
    stop: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let started = Instant::now();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let bytes = downloaded.load(Ordering::Relaxed);
            let elapsed = started.elapsed().as_secs_f64();
            let speed_bps = if elapsed > 0.0 {
                (bytes as f64 / elapsed).round() as u64
            } else {
                0
            };
            eprintln!(
                "[RUST-DL] progress mode={} downloaded={} total={} speed_bps={}",
                mode, bytes, total, speed_bps
            );
        }
    })
}

async fn single_stream_download(client: &reqwest::Client, cfg: &Config) -> Result<Option<String>, String> {
    let request = apply_headers(client.get(&cfg.url), cfg);
    let response = request.send().await.map_err(|e| format!("request failed: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("request failed with status {}", status));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let total_size = response.content_length().unwrap_or(0);

    if let Some(parent) = cfg.output.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create output dir: {}", e))?;
    }
    let file = tokio::fs::File::create(&cfg.output).await.map_err(|e| format!("failed to create output: {}", e))?;
    let mut writer = BufWriter::new(file);
    let mut stream = response.bytes_stream();
    let downloaded = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let reporter = spawn_progress_reporter("single", downloaded.clone(), total_size, stop.clone());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream failed: {}", e))?;
        downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        writer.write_all(&chunk).await.map_err(|e| format!("write failed: {}", e))?;
    }
    writer.flush().await.map_err(|e| format!("flush failed: {}", e))?;
    stop.store(true, Ordering::Relaxed);
    reporter.abort();
    Ok(content_type)
}

async fn ranged_part_download(
    client: reqwest::Client,
    cfg: Config,
    entry: RangeEntry,
    downloaded: Arc<AtomicU64>,
) -> Result<ChunkResult, String> {
    let expected = entry_size(&entry);
    let mut attempt = 0usize;
    let mut last_retry_reason: Option<String> = None;
    loop {
        attempt += 1;
        let mut existing = entry_current_size(&entry);
        if existing >= expected && expected > 0 {
            return Ok(ChunkResult { throughput_bps: 0.0, retry_reason: None });
        }
        if existing > expected {
            let _ = tokio::fs::remove_file(&entry.path).await;
            existing = 0;
        }
        let resume_start = entry.start + existing;
        let request = apply_headers(
            client.get(&cfg.url).header(RANGE, format!("bytes={}-{}", resume_start, entry.end)),
            &cfg,
        );
        let started = Instant::now();
        let response = request.send().await.map_err(|e| format!("range request failed: {}", e));
        match response {
            Ok(response) => {
                if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                    if attempt >= 3 {
                        return Err(format!("range request not honored: {}", response.status()));
                    }
                    last_retry_reason = Some(format!("status_{}", response.status()));
                    eprintln!("[RUST-DL] range retry bytes={}-{} attempt={} reason=status_{}", entry.start, entry.end, attempt + 1, response.status());
                    continue;
                }
                if existing > 0 {
                    eprintln!("[RUST-DL] range resume bytes={}-{} existing={}", entry.start, entry.end, existing);
                }
                let file = if existing > 0 {
                    tokio::fs::OpenOptions::new().append(true).open(&entry.path).await
                } else {
                    tokio::fs::File::create(&entry.path).await
                }
                .map_err(|e| format!("failed to open part file: {}", e))?;
                let mut writer = BufWriter::new(file);
                let mut stream = response.bytes_stream();
                let mut written = 0u64;
                while let Some(chunk) = stream.next().await {
                    let chunk = match chunk {
                        Ok(value) => value,
                        Err(error) => {
                            if attempt >= 3 {
                                return Err(format!("range stream failed: {}", error));
                            }
                            last_retry_reason = Some("stream".to_string());
                            eprintln!("[RUST-DL] range retry bytes={}-{} attempt={} reason=stream", entry.start, entry.end, attempt + 1);
                            written = 0;
                            break;
                        }
                    };
                    written += chunk.len() as u64;
                    downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    if let Err(error) = writer.write_all(&chunk).await {
                        return Err(format!("part write failed: {}", error));
                    }
                }
                writer.flush().await.map_err(|e| format!("part flush failed: {}", e))?;
                let final_size = entry_current_size(&entry);
                if final_size >= expected {
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    let throughput_bps = written as f64 / elapsed;
                    return Ok(ChunkResult { throughput_bps, retry_reason: last_retry_reason.clone() });
                }
                if attempt >= 3 {
                    return Err(format!("range part incomplete: {}/{}", final_size, expected));
                }
                last_retry_reason = Some("incomplete".to_string());
                eprintln!("[RUST-DL] range retry bytes={}-{} attempt={} reason=incomplete", entry.start, entry.end, attempt + 1);
            }
            Err(error) => {
                if attempt >= 3 {
                    return Err(error);
                }
                last_retry_reason = Some("request".to_string());
                eprintln!("[RUST-DL] range retry bytes={}-{} attempt={} reason=request", entry.start, entry.end, attempt + 1);
            }
        }
    }
}

fn snapshot_state_entries(state: &SchedulerState) -> Vec<RangeEntry> {
    let mut entries = Vec::with_capacity(state.pending.len() + state.inflight.len() + state.completed.len());
    entries.extend(state.completed.iter().cloned());
    entries.extend(state.pending.iter().cloned());
    entries.extend(state.inflight.iter().cloned());
    entries.sort_by_key(|entry| (entry.start, entry.id));
    entries
}

async fn worker_loop(
    client: reqwest::Client,
    cfg: Config,
    host: String,
    output: PathBuf,
    url: String,
    total_size: u64,
    manifest_path: PathBuf,
    state: Arc<Mutex<SchedulerState>>,
    notify: Arc<Notify>,
    downloaded: Arc<AtomicU64>,
) -> Result<(), String> {
    loop {
        let (entry, worker_count, manifest_entries) = loop {
            let mut guard = state.lock().await;
            if let Some(error) = &guard.error {
                return Err(error.clone());
            }
            if guard.active_workers >= guard.dispatch_limit {
                let notified = notify.notified();
                drop(guard);
                notified.await;
                continue;
            }
            if let Some(mut entry) = guard.pending.first().cloned() {
                let _ = guard.pending.remove(0);
                let active_chunk_size = guard.active_chunk_size;
                if entry_size(&entry) > active_chunk_size.saturating_mul(2) {
                    if let Some((left, right)) = split_entry(&entry, guard.next_part_id, &output) {
                        guard.next_part_id = guard.next_part_id.saturating_add(1);
                        guard.pending.push(right);
                        guard.pending.sort_by_key(|item| (item.start, item.id));
                        eprintln!(
                            "[RUST-DL] range rebalance host={} split={} chunk={}",
                            host,
                            entry_size(&entry),
                            active_chunk_size
                        );
                        entry = left;
                    }
                }
                guard.active_workers += 1;
                guard.inflight.push(entry.clone());
                let worker_count = guard.worker_count;
                let manifest_entries = snapshot_state_entries(&guard);
                break (entry, worker_count, manifest_entries);
            }
            if guard.active_workers == 0 && guard.inflight.is_empty() {
                return Ok(());
            }
            let notified = notify.notified();
            drop(guard);
            notified.await;
        };
        write_manifest(&manifest_path, &manifest_snapshot(&url, total_size, worker_count, &manifest_entries))?;
        let result = ranged_part_download(client.clone(), cfg.clone(), entry.clone(), downloaded.clone()).await;
        let (manifest_entries, worker_count, fatal_error) = {
            let mut guard = state.lock().await;
            guard.active_workers = guard.active_workers.saturating_sub(1);
            guard.inflight.retain(|item| item.id != entry.id);
            match result {
                Ok(chunk) => {
                    guard.completed.push(entry.clone());
                    if let Some(reason) = chunk.retry_reason.as_deref() {
                        match classify_retry_reason(reason) {
                            "status" => guard.status_failures += 1,
                            "stream" => guard.stream_failures += 1,
                            "incomplete" => guard.incomplete_failures += 1,
                            _ => guard.request_failures += 1,
                        }
                    }
                    if chunk.throughput_bps > 0.0 {
                        guard.throughput_ewma = if guard.throughput_ewma <= 0.0 {
                            chunk.throughput_bps
                        } else {
                            guard.throughput_ewma * 0.7 + chunk.throughput_bps * 0.3
                        };
                        let tuned = adapt_chunk_size(&host, guard.base_chunk_size, guard.throughput_ewma);
                        if tuned != guard.active_chunk_size {
                            eprintln!(
                                "[RUST-DL] range tune host={} chunk={} ewma_bps={:.0}",
                                host,
                                tuned,
                                guard.throughput_ewma
                            );
                        }
                        guard.active_chunk_size = tuned;
                        let slow_threshold = 1.2 * 1024.0 * 1024.0;
                        if chunk.throughput_bps < slow_threshold {
                            guard.slow_window += 1;
                            guard.restore_window = 0;
                        } else {
                            guard.slow_window = 0;
                            guard.restore_window += 1;
                        }
                        if guard.slow_window >= 2 {
                            let reduced = (guard.active_chunk_size / 2).max(512 * 1024);
                            if reduced < guard.active_chunk_size {
                                guard.active_chunk_size = reduced;
                                eprintln!(
                                    "[RUST-DL] slow-window host={} chunk={} bps={:.0} window={}",
                                    host,
                                    guard.active_chunk_size,
                                    chunk.throughput_bps,
                                    guard.slow_window
                                );
                            }
                            guard.slow_window = 0;
                        }
                    }
                    let total_failures = guard.request_failures + guard.status_failures + guard.stream_failures + guard.incomplete_failures;
                    if total_failures >= 3 && guard.dispatch_limit > 1 {
                        guard.dispatch_limit -= 1;
                        guard.restore_window = 0;
                        eprintln!(
                            "[RUST-DL] host throttle host={} limit={} failures=request:{} status:{} stream:{} incomplete:{}",
                            host,
                            guard.dispatch_limit,
                            guard.request_failures,
                            guard.status_failures,
                            guard.stream_failures,
                            guard.incomplete_failures
                        );
                        guard.request_failures = 0;
                        guard.status_failures = 0;
                        guard.stream_failures = 0;
                        guard.incomplete_failures = 0;
                    } else if guard.restore_window >= 3 && guard.dispatch_limit < guard.worker_count {
                        guard.dispatch_limit += 1;
                        guard.restore_window = 0;
                        eprintln!(
                            "[RUST-DL] host restore host={} limit={} ewma_bps={:.0}",
                            host,
                            guard.dispatch_limit,
                            guard.throughput_ewma
                        );
                    }
                    let desired_pending = (guard.dispatch_limit * 2 + 1).max(guard.dispatch_limit + 1);
                    let active_chunk_size = guard.active_chunk_size;
                    let mut next_part_id = guard.next_part_id;
                    maybe_expand_pending(
                        &mut guard.pending,
                        active_chunk_size,
                        desired_pending,
                        &mut next_part_id,
                        &output,
                    );
                    guard.next_part_id = next_part_id;
                    let manifest_entries = snapshot_state_entries(&guard);
                    let worker_count = guard.worker_count;
                    notify.notify_waiters();
                    (manifest_entries, worker_count, None)
                }
                Err(error) => {
                    guard.pending.push(entry.clone());
                    guard.pending.sort_by_key(|item| (item.start, item.id));
                    guard.error = Some(error.clone());
                    let manifest_entries = snapshot_state_entries(&guard);
                    let worker_count = guard.worker_count;
                    notify.notify_waiters();
                    (manifest_entries, worker_count, Some(error))
                }
            }
        };
        write_manifest(&manifest_path, &manifest_snapshot(&url, total_size, worker_count, &manifest_entries))?;
        if let Some(error) = fatal_error {
            return Err(error);
        }
    }
}

async fn segmented_download(client: &reqwest::Client, cfg: &Config) -> Result<Option<String>, String> {
    let probe = apply_headers(client.get(&cfg.url), cfg);
    let response = probe.send().await.map_err(|e| format!("probe failed: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("probe failed with status {}", status));
    }
    let total_size = response.content_length().ok_or("missing content-length")?;
    let accept_ranges = response
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    drop(response);

    if !accept_ranges.contains("bytes") || total_size == 0 || cfg.segments <= 1 {
        return single_stream_download(client, cfg).await;
    }

    if let Some(parent) = cfg.output.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create output dir: {}", e))?;
    }

    let host = normalize_host(&cfg.url);
    let policy = host_transfer_policy(&host);
    let worker_count = cfg.segments.clamp(1, 16).min(policy.segment_cap.max(1));
    let base_chunk_size = estimate_chunk_size(&host, total_size, cfg.chunk_size_mb, worker_count);
    let output = cfg.output.clone();
    let manifest_path = build_manifest_path(&output);
    let (mut pending, next_part_id) = load_manifest(&manifest_path, &cfg.url, total_size).unwrap_or_else(|| {
        (initial_ranges(&host, &output, total_size, base_chunk_size, worker_count), worker_count as u64)
    });
    let mut completed = Vec::new();
    pending.retain(|entry| {
        if entry_done(entry) {
            completed.push(entry.clone());
            false
        } else {
            true
        }
    });
    let mut next_part_id = next_part_id.max(
        pending
            .iter()
            .chain(completed.iter())
            .map(|entry| entry.id.saturating_add(1))
            .max()
            .unwrap_or(0),
    );
    let desired_pending = (worker_count * 2).max(worker_count + 1);
    maybe_expand_pending(&mut pending, base_chunk_size, desired_pending, &mut next_part_id, &output);
    let existing_bytes: u64 = pending
        .iter()
        .chain(completed.iter())
        .map(entry_current_size)
        .sum::<u64>()
        .min(total_size);
    eprintln!(
        "[RUST-DL] host policy host={} segment_cap={} chunk_cap={} worker_count={}",
        host,
        policy.segment_cap,
        policy.chunk_cap,
        worker_count
    );
    eprintln!(
        "[RUST-DL] range dispatch host={} workers={} pending={} chunk={} size={}",
        host,
        worker_count,
        pending.len(),
        base_chunk_size,
        total_size
    );

    let state = Arc::new(Mutex::new(SchedulerState {
        pending,
        inflight: Vec::new(),
        completed,
        next_part_id,
        base_chunk_size,
        active_chunk_size: base_chunk_size,
        throughput_ewma: 0.0,
        worker_count,
        dispatch_limit: worker_count,
        active_workers: 0,
        slow_window: 0,
        restore_window: 0,
        request_failures: 0,
        status_failures: 0,
        stream_failures: 0,
        incomplete_failures: 0,
        error: None,
    }));
    let initial_entries = {
        let guard = state.lock().await;
        snapshot_state_entries(&guard)
    };
    write_manifest(&manifest_path, &manifest_snapshot(&cfg.url, total_size, worker_count, &initial_entries))?;

    let downloaded = Arc::new(AtomicU64::new(existing_bytes));
    let stop = Arc::new(AtomicBool::new(false));
    let reporter = spawn_progress_reporter("segmented", downloaded.clone(), total_size, stop.clone());
    let notify = Arc::new(Notify::new());
    let wait_state = state.clone();
    let wait_notify = notify.clone();
    let wait_host = host.clone();
    let wait_downloaded = downloaded.clone();
    let wait_stop = stop.clone();
    let wait_logger = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            if wait_stop.load(Ordering::Relaxed) {
                break;
            }
            let guard = wait_state.lock().await;
            if guard.active_workers == 0 && guard.pending.is_empty() {
                break;
            }
            eprintln!(
                "[RUST-DL] range wait host={} active={} pending={} ewma_bps={:.0} downloaded={}",
                wait_host,
                guard.active_workers,
                guard.pending.len(),
                guard.throughput_ewma,
                wait_downloaded.load(Ordering::Relaxed),
            );
            drop(guard);
            wait_notify.notify_waiters();
        }
    });

    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        handles.push(tokio::spawn(worker_loop(
            client.clone(),
            cfg.clone(),
            host.clone(),
            output.clone(),
            cfg.url.clone(),
            total_size,
            manifest_path.clone(),
            state.clone(),
            notify.clone(),
            downloaded.clone(),
        )));
    }

    let mut first_error: Option<String> = None;
    for handle in handles {
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(format!("join failed: {}", error));
                }
            }
        }
    }

    stop.store(true, Ordering::Relaxed);
    reporter.abort();
    wait_logger.abort();

    if let Some(error) = first_error {
        let entries = {
            let guard = state.lock().await;
            snapshot_state_entries(&guard)
        };
        write_manifest(&manifest_path, &manifest_snapshot(&cfg.url, total_size, worker_count, &entries))?;
        return Err(error);
    }

    let merged_entries = {
        let guard = state.lock().await;
        let mut entries = guard.completed.clone();
        entries.sort_by_key(|entry| (entry.start, entry.id));
        entries
    };
    let file = tokio::fs::File::create(&cfg.output).await.map_err(|e| format!("failed to create output: {}", e))?;
    let mut writer = BufWriter::new(file);
    for entry in &merged_entries {
        let mut part = tokio::fs::File::open(&entry.path).await.map_err(|e| format!("failed to open part: {}", e))?;
        tokio::io::copy(&mut part, &mut writer).await.map_err(|e| format!("failed to merge part: {}", e))?;
    }
    writer.flush().await.map_err(|e| format!("failed to flush output: {}", e))?;
    let final_size = fs::metadata(&cfg.output).map(|meta| meta.len()).unwrap_or(0);
    if final_size != total_size {
        return Err(format!("range merge incomplete: {}/{}", final_size, total_size));
    }
    remove_range_artifacts(&cfg.output);
    Ok(content_type)
}

#[tokio::main]
async fn main() {
    let cfg = match parse_args() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{}", error);
            std::process::exit(2);
        }
    };

    let client = match build_client(&cfg) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{}", error);
            std::process::exit(1);
        }
    };

    let result = if cfg.segmented {
        segmented_download(&client, &cfg).await
    } else {
        single_stream_download(&client, &cfg).await
    };

    match result {
        Ok(content_type) => {
            let payload = OutputPayload { content_type };
            println!("{}", serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()));
        }
        Err(error) => {
            eprintln!("{}", error);
            std::process::exit(1);
        }
    }
}
