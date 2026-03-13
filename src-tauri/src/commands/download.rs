//! Download command - handles video downloading with yt-dlp
//! 
//! This module contains the core download functionality including:
//! - Video/audio download with quality/format options
//! - Playlist support
//! - Progress tracking
//! - Subtitle handling

use std::process::Stdio;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::utils::validate_url;
use tauri::{AppHandle, Emitter};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_TYPE, RANGE, REFERER, USER_AGENT};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::types::{BackendError, DependencySource, DownloadProgress};
use crate::database::add_log_internal;
use crate::database::add_history_internal;
use crate::database::update_history_download;
use crate::utils::{build_format_string, parse_progress, format_size, sanitize_output_path, CommandExt};
use crate::services::{
    get_ffmpeg_path,
    get_deno_path,
    get_ytdlp_path,
    get_ytdlp_source,
    system_ytdlp_not_found_message,
};

pub static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

const RECENT_OUTPUT_LIMIT: usize = 30;

/// Decode raw bytes from a child process into a Rust String.
///
/// On Windows with a non-UTF-8 locale (e.g. Chinese → GBK), yt-dlp outputs
/// file paths in the system ANSI code page.  Tokio's `BufReader::lines()`
/// expects UTF-8 and returns `Err` on such bytes, which silently stops the
/// reading loop and loses the filepath — causing history records to never be
/// created.  This helper decodes via the Win32 `MultiByteToWideChar` API so
/// the full filepath (including CJK characters) is preserved.
#[cfg(windows)]
fn decode_process_output(bytes: &[u8]) -> String {
    // Fast path: already valid UTF-8
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }

    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte_str: *const u8,
            multi_byte: i32,
            wide_char_str: *mut u16,
            wide_char: i32,
        ) -> i32;
    }

    const CP_ACP: u32 = 0; // System default Windows ANSI code page

    unsafe {
        let len = MultiByteToWideChar(
            CP_ACP, 0,
            bytes.as_ptr(), bytes.len() as i32,
            std::ptr::null_mut(), 0,
        );
        if len <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut wide = vec![0u16; len as usize];
        MultiByteToWideChar(
            CP_ACP, 0,
            bytes.as_ptr(), bytes.len() as i32,
            wide.as_mut_ptr(), len,
        );
        OsString::from_wide(&wide).to_string_lossy().into_owned()
    }
}

#[cfg(not(windows))]
fn decode_process_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Kill all yt-dlp and ffmpeg processes
fn kill_all_download_processes() {
    #[cfg(unix)]
    {
        use std::process::Command as StdCommand;
        StdCommand::new("pkill").args(["-9", "-f", "yt-dlp"]).spawn().ok();
        StdCommand::new("pkill").args(["-9", "-f", "ffmpeg"]).spawn().ok();
    }
    #[cfg(windows)]
    {
        use std::process::Command as StdCommand;
        use crate::utils::CommandExt as _;
        let mut cmd1 = StdCommand::new("taskkill");
        cmd1.args(["/F", "/IM", "yt-dlp.exe"]);
        cmd1.hide_window();
        cmd1.spawn().ok();
        
        let mut cmd2 = StdCommand::new("taskkill");
        cmd2.args(["/F", "/IM", "ffmpeg.exe"]);
        cmd2.hide_window();
        cmd2.spawn().ok();
    }
}

fn push_recent_output(buffer: &mut VecDeque<String>, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if buffer.len() >= RECENT_OUTPUT_LIMIT {
        buffer.pop_front();
    }
    buffer.push_back(trimmed.to_string());
}

fn push_recent_output_shared(buffer: &Arc<Mutex<VecDeque<String>>>, line: &str) {
    if let Ok(mut guard) = buffer.lock() {
        push_recent_output(&mut guard, line);
    }
}

fn recent_output_snapshot(buffer: &Arc<Mutex<VecDeque<String>>>) -> Vec<String> {
    buffer
        .lock()
        .map(|guard| guard.iter().cloned().collect())
        .unwrap_or_default()
}

fn build_download_error_message(exit_code: Option<i32>, recent_lines: &[String]) -> BackendError {
    let reason = recent_lines
        .iter()
        .rev()
        .find(|line| {
            let lower = line.to_lowercase();
            lower.contains("error")
                || lower.contains("unable")
                || lower.contains("failed")
                || lower.contains("http error")
                || lower.contains("forbidden")
                || lower.contains("too many requests")
                || lower.contains("timed out")
        })
        .cloned()
        .or_else(|| recent_lines.last().cloned())
        .unwrap_or_else(|| "Unknown error".to_string());

    match exit_code {
        Some(code) => BackendError::from_message(format!("Download failed (exit code {}): {}", code, reason))
            .with_param("exitCode", code),
        None => BackendError::from_message(format!("Download failed: {}", reason)),
    }
}

#[tauri::command]
pub async fn download_video(
    app: AppHandle,
    id: String,
    url: String,
    output_path: String,
    quality: String,
    format: String,
    download_playlist: bool,
    video_codec: String,
    audio_bitrate: String,
    playlist_limit: Option<u32>,
    subtitle_mode: String,
    subtitle_langs: String,
    subtitle_embed: bool,
    subtitle_format: String,
    log_stderr: Option<bool>,
    _use_bun_runtime: Option<bool>, // Deprecated - now auto uses deno
    use_actual_player_js: Option<bool>,
    history_id: Option<String>,
    // Cookie settings
    cookie_mode: Option<String>,
    cookie_browser: Option<String>,
    cookie_browser_profile: Option<String>,
    cookie_file_path: Option<String>,
    // Embed settings
    embed_metadata: Option<bool>,
    embed_thumbnail: Option<bool>,
    // Proxy settings
    proxy_url: Option<String>,
    // Live stream settings
    live_from_start: Option<bool>,
    // Speed limit settings
    speed_limit: Option<String>,
    // SponsorBlock settings
    sponsorblock_remove: Option<String>,  // comma-separated categories to remove
    sponsorblock_mark: Option<String>,    // comma-separated categories to mark as chapters
    // Download sections (time range)
    download_sections: Option<String>,    // e.g. "*10:30-14:30" for partial download
    // Title (optional, passed from frontend for display purposes)
    title: Option<String>,
    // Thumbnail URL (optional, passed from frontend for non-YouTube sites)
    thumbnail: Option<String>,
    // Source/extractor name (optional, from yt-dlp extractor e.g. "BiliBili", "TikTok")
    source: Option<String>,
) -> Result<(), String> {
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    validate_url(&url).map_err(|e| BackendError::from_message(e).to_wire_string())?;
    
    let should_log_stderr = log_stderr.unwrap_or(true);
    let sanitized_path =
        sanitize_output_path(&output_path).map_err(|e| BackendError::from_message(e).to_wire_string())?;
    let format_string = build_format_string(&quality, &format, &video_codec);
    let output_template = format!("{}/%(title)s.%(ext)s", sanitized_path);

    // Use a temp file to capture the final filepath from yt-dlp.
    // On Windows with non-UTF-8 locales (e.g. Chinese/GBK), stdout is encoded
    // in the system ANSI code page which cannot represent all Unicode characters
    // (such as ⧸ U+29F8 used by yt-dlp to replace / in filenames).
    // --print-to-file always writes UTF-8, so we get the exact filepath.
    let filepath_tmp = std::env::temp_dir().join(format!("youwee-fp-{}.txt", id));

    let mut args = vec![
        "--newline".to_string(),
        "--progress".to_string(),
        "--no-warnings".to_string(),
        "-f".to_string(),
        format_string,
        "-o".to_string(),
        output_template,
        "--print-to-file".to_string(),
        "after_move:filepath".to_string(),
        filepath_tmp.to_string_lossy().to_string(),
        "--no-keep-video".to_string(),
        "--no-keep-fragments".to_string(),
        "--retries".to_string(),
        "3".to_string(),
        "--fragment-retries".to_string(),
        "3".to_string(),
        "--extractor-retries".to_string(),
        "2".to_string(),
        "--file-access-retries".to_string(),
        "2".to_string(),
    ];
    
    // Auto use Deno runtime for YouTube (required for JS extractor)
    // Use --js-runtimes instead of --extractor-args (handles spaces in path correctly)
    if url.contains("youtube.com") || url.contains("youtu.be") {
        if let Some(deno_path) = get_deno_path(&app).await {
            args.push("--js-runtimes".to_string());
            args.push(format!("deno:{}", deno_path.to_string_lossy()));
        }
    }
    
    // Add actual player.js version if enabled (fixes some YouTube download issues)
    // See: https://github.com/yt-dlp/yt-dlp/issues/14680
    if use_actual_player_js.unwrap_or(false) && (url.contains("youtube.com") || url.contains("youtu.be")) {
        args.push("--extractor-args".to_string());
        args.push("youtube:player_js_version=actual".to_string());
    }
    
    // Add FFmpeg location if available
    if let Some(ffmpeg_path) = get_ffmpeg_path(&app).await {
        if let Some(parent) = ffmpeg_path.parent() {
            args.push("--ffmpeg-location".to_string());
            args.push(parent.to_string_lossy().to_string());
        }
    }
    
    // Subtitle settings
    if subtitle_mode != "off" {
        args.push("--write-subs".to_string());
        if subtitle_mode == "auto" {
            args.push("--write-auto-subs".to_string());
            args.push("--sub-langs".to_string());
            args.push("all".to_string());
        } else {
            args.push("--sub-langs".to_string());
            args.push(subtitle_langs.clone());
        }
        args.push("--sub-format".to_string());
        args.push(subtitle_format.clone());
        if subtitle_embed {
            args.push("--embed-subs".to_string());
        }
    }
    
    // Cookie/Authentication settings
    let mode = cookie_mode.as_deref().unwrap_or("off");
    match mode {
        "browser" => {
            if let Some(browser) = cookie_browser.as_ref() {
                let mut cookie_arg = browser.clone();
                // Add profile if specified
                if let Some(profile) = cookie_browser_profile.as_ref() {
                    if !profile.is_empty() {
                        cookie_arg = format!("{}:{}", browser, profile);
                    }
                }
                args.push("--cookies-from-browser".to_string());
                args.push(cookie_arg);
            }
        }
        "file" => {
            if let Some(file_path) = cookie_file_path.as_ref() {
                if !file_path.is_empty() {
                    args.push("--cookies".to_string());
                    args.push(file_path.clone());
                }
            }
        }
        _ => {}
    }
    
    // Proxy settings
    if let Some(proxy) = proxy_url.as_ref() {
        if !proxy.is_empty() {
            args.push("--proxy".to_string());
            args.push(proxy.clone());
        }
    }
    
    // Live stream settings
    if live_from_start.unwrap_or(false) {
        args.push("--live-from-start".to_string());
        args.push("--no-part".to_string());
    }
    
    // Speed limit settings
    if let Some(limit) = speed_limit.as_ref() {
        if !limit.is_empty() {
            args.push("--limit-rate".to_string());
            args.push(limit.clone());
        }
    }
    
    // Force overwrite to avoid HTTP 416 errors from stale .part files
    args.push("--force-overwrites".to_string());
    
    // Playlist handling
    if !download_playlist {
        args.push("--no-playlist".to_string());
    } else if let Some(limit) = playlist_limit {
        if limit > 0 {
            args.push("--playlist-end".to_string());
            args.push(limit.to_string());
        }
    }
    
    // Audio formats
    let is_audio_format = format == "mp3" || format == "m4a" || format == "opus" || quality == "audio";
    
    if is_audio_format {
        args.push("-x".to_string());
        args.push("--audio-format".to_string());
        match format.as_str() {
            "mp3" => args.push("mp3".to_string()),
            "m4a" => args.push("m4a".to_string()),
            "opus" => args.push("opus".to_string()),
            _ => args.push("mp3".to_string()),
        }
        args.push("--audio-quality".to_string());
        match audio_bitrate.as_str() {
            "128" => args.push("128K".to_string()),
            _ => args.push("0".to_string()),
        }
    } else {
        args.push("--merge-output-format".to_string());
        args.push(format.clone());
    }
    
    // Embed metadata and thumbnail
    if embed_metadata.unwrap_or(false) {
        args.push("--embed-metadata".to_string());
    }
    if embed_thumbnail.unwrap_or(false) {
        args.push("--embed-thumbnail".to_string());
        // Convert thumbnail to jpg for better compatibility with MP4 container
        args.push("--convert-thumbnails".to_string());
        args.push("jpg".to_string());
    }
    
    // SponsorBlock settings
    if let Some(ref remove_cats) = sponsorblock_remove {
        if !remove_cats.is_empty() {
            args.push("--sponsorblock-remove".to_string());
            args.push(remove_cats.clone());
        }
    }
    if let Some(ref mark_cats) = sponsorblock_mark {
        if !mark_cats.is_empty() {
            args.push("--sponsorblock-mark".to_string());
            args.push(mark_cats.clone());
        }
    }
    
    // Download sections (time range)
    if let Some(ref sections) = download_sections {
        if !sections.is_empty() {
            args.push("--download-sections".to_string());
            args.push(sections.clone());
        }
    }
    
    args.push("--".to_string());
    args.push(url.clone());
    
    // Get binary info for logging
    let binary_info = get_ytdlp_path(&app).await;
    let binary_path_str = binary_info.as_ref()
        .map(|(p, is_bundled)| format!("{} (bundled: {})", p.display(), is_bundled))
        .unwrap_or_else(|| "sidecar".to_string());
    
    // Log command with binary path
    let command_str = format!("[{}] yt-dlp {}", binary_path_str, args.join(" "));
    add_log_internal("command", &command_str, None, Some(&url)).ok();
    
    // Try to get yt-dlp path (prioritizes bundled version for stability)
    if let Some((binary_path, _)) = get_ytdlp_path(&app).await {
        // Build extended PATH with deno/bun locations for JavaScript runtime support
        let home_dir = std::env::var("HOME").unwrap_or_else(|_| "/Users".to_string());
        let current_path = std::env::var("PATH").unwrap_or_default();
        let extended_path = format!(
            "{}/.deno/bin:{}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:{}",
            home_dir, home_dir, current_path
        );
        
        let mut cmd = Command::new(&binary_path);
        cmd.args(&args)
            .env("HOME", &home_dir)
            .env("PATH", &extended_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.hide_window();
        
        let process = cmd.spawn()
            .map_err(|e| BackendError::from_message(format!("Failed to start yt-dlp: {}", e)).to_wire_string())?;
        
        return handle_tokio_download(app, id, process, quality, format, url, should_log_stderr, title, thumbnail, source, download_sections, filepath_tmp.clone()).await;
    }

    let ytdlp_source = get_ytdlp_source(&app).await;
    if ytdlp_source == DependencySource::System {
        return Err(BackendError::new(crate::types::code::YTDLP_SYSTEM_NOT_FOUND, system_ytdlp_not_found_message()).to_wire_string());
    }
    
    // Fallback to sidecar
    let sidecar_result = app.shell().sidecar("yt-dlp");
    
    match sidecar_result {
        Ok(sidecar) => {
            let (mut rx, child) = sidecar
                .args(&args)
                .spawn()
                .map_err(|e| BackendError::from_message(format!("Failed to start bundled yt-dlp: {}", e)).to_wire_string())?;
            
            // Only use frontend title if it's not a URL (placeholder)
            let mut current_title: Option<String> = title.clone().filter(|t| !t.starts_with("http"));
            let mut current_index: Option<u32> = None;
            let mut total_count: Option<u32> = None;
            let mut total_filesize: u64 = 0;
            let mut current_stream_size: Option<u64> = None;
            let mut final_filepath: Option<String> = None;
            let mut recent_output: VecDeque<String> = VecDeque::new();
            
            let quality_display = match quality.as_str() {
                "8k" => Some("8K".to_string()),
                "4k" => Some("4K".to_string()),
                "2k" => Some("2K".to_string()),
                "1080" => Some("1080p".to_string()),
                "720" => Some("720p".to_string()),
                "480" => Some("480p".to_string()),
                "360" => Some("360p".to_string()),
                "audio" => Some("Audio".to_string()),
                "best" => Some("Best".to_string()),
                _ => None,
            };
            
            while let Some(event) = rx.recv().await {
                if CANCEL_FLAG.load(Ordering::SeqCst) {
                    child.kill().ok();
                    kill_all_download_processes();
                    return Err(BackendError::from_message("Download cancelled").to_wire_string());
                }
                
                match event {
                    CommandEvent::Stdout(line_bytes) => {
                        let line = decode_process_output(&line_bytes);
                        push_recent_output(&mut recent_output, &line);
                        
                        // Parse playlist item info
                        if line.contains("Downloading item") {
                            if let Some(re) = regex::Regex::new(r"Downloading item (\d+) of (\d+)").ok() {
                                if let Some(caps) = re.captures(&line) {
                                    current_index = caps.get(1).and_then(|m| m.as_str().parse().ok());
                                    total_count = caps.get(2).and_then(|m| m.as_str().parse().ok());
                                }
                            }
                        }
                        
                        // Extract title from [download] messages
                        // Handles both: "Destination: /path/file.mp4" and "/path/file.mp4 has already been downloaded"
                        if line.contains("[download]") && (line.contains("Destination:") || line.contains("has already been downloaded") || line.contains("[ExtractAudio]")) {
                            let path_sep = if line.contains('\\') { '\\' } else { '/' };
                            if let Some(start) = line.rfind(path_sep) {
                                let filename = &line[start + 1..];
                                // Remove suffix if present
                                let filename = filename.trim_end_matches(" has already been downloaded");
                                if let Some(end) = filename.rfind('.') {
                                    current_title = Some(filename[..end].to_string());
                                }
                            }
                        }
                        
                        // Capture final filepath
                        let trimmed = line.trim();
                        if !trimmed.is_empty()
                            && !trimmed.starts_with('[')
                            && !trimmed.starts_with("Deleting")
                            && !trimmed.starts_with("WARNING")
                            && !trimmed.starts_with("ERROR")
                            && (trimmed.ends_with(".mp3")
                                || trimmed.ends_with(".m4a")
                                || trimmed.ends_with(".opus")
                                || trimmed.ends_with(".mp4")
                                || trimmed.ends_with(".mkv")
                                || trimmed.ends_with(".webm")
                                || trimmed.ends_with(".flac")
                                || trimmed.ends_with(".wav"))
                        {
                            final_filepath = Some(trimmed.to_string());
                        }
                        
                        // Parse filesize
                        if line.contains(" of ") && (line.contains("MiB") || line.contains("GiB") || line.contains("KiB")) {
                            if let Some(re) = regex::Regex::new(r"of\s+(\d+(?:\.\d+)?)\s*(GiB|MiB|KiB)").ok() {
                                if let Some(caps) = re.captures(&line) {
                                    if let (Some(num), Some(unit)) = (caps.get(1), caps.get(2)) {
                                        if let Ok(size) = num.as_str().parse::<f64>() {
                                            let size_bytes = match unit.as_str() {
                                                "GiB" => (size * 1024.0 * 1024.0 * 1024.0) as u64,
                                                "MiB" => (size * 1024.0 * 1024.0) as u64,
                                                "KiB" => (size * 1024.0) as u64,
                                                _ => size as u64,
                                            };
                                            if current_stream_size != Some(size_bytes) {
                                                if let Some(prev_size) = current_stream_size {
                                                    total_filesize += prev_size;
                                                }
                                                current_stream_size = Some(size_bytes);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        // Parse progress
                        if let Some((percent, speed, eta, pi, pc, downloaded_size, elapsed_time)) = parse_progress(&line) {
                            if pi.is_some() { current_index = pi; }
                            if pc.is_some() { total_count = pc; }
                            
                            let progress = DownloadProgress {
                                id: id.clone(),
                                percent,
                                speed,
                                eta,
                                status: "downloading".to_string(),
                                title: current_title.clone(),
                                filepath: None,
                                playlist_index: current_index,
                                playlist_count: total_count,
                                filesize: None,
                                resolution: None,
                                format_ext: None,
                                error_message: None,
                                error_code: None,
                                error_params: None,
                                downloaded_size,
                                elapsed_time,
                            };
                            app.emit("download-progress", progress).ok();
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        let stderr_line = decode_process_output(&bytes);
                        let stderr_line = stderr_line.trim().to_string();
                        push_recent_output(&mut recent_output, &stderr_line);
                        
                        if let Some((percent, speed, eta, pi, pc, downloaded_size, elapsed_time)) = parse_progress(&stderr_line) {
                            if pi.is_some() { current_index = pi; }
                            if pc.is_some() { total_count = pc; }
                            
                            let progress = DownloadProgress {
                                id: id.clone(),
                                percent,
                                speed,
                                eta,
                                status: "downloading".to_string(),
                                title: current_title.clone(),
                                filepath: None,
                                playlist_index: current_index,
                                playlist_count: total_count,
                                filesize: None,
                                resolution: None,
                                format_ext: None,
                                error_message: None,
                                error_code: None,
                                error_params: None,
                                downloaded_size,
                                elapsed_time,
                            };
                            app.emit("download-progress", progress).ok();
                        }
                        
                        if should_log_stderr && !stderr_line.is_empty() {
                            add_log_internal("stderr", &stderr_line, None, Some(&url)).ok();
                        }
                    }
                    CommandEvent::Error(err) => {
                        let error = BackendError::from_message(format!("Process error: {}", err));
                        add_log_internal("error", error.message(), None, Some(&url)).ok();
                        return Err(error.to_wire_string());
                    }
                    CommandEvent::Terminated(status) => {
                        if CANCEL_FLAG.load(Ordering::SeqCst) {
                            add_log_internal("info", "Download cancelled by user", None, Some(&url)).ok();
                            return Err(BackendError::from_message("Download cancelled").to_wire_string());
                        }

                        // Primary filepath source: read from --print-to-file temp file (UTF-8)
                        if let Ok(contents) = std::fs::read_to_string(&filepath_tmp) {
                            let path = contents.trim().to_string();
                            if !path.is_empty() {
                                final_filepath = Some(path);
                            }
                        }
                        std::fs::remove_file(&filepath_tmp).ok();

                        if status.code == Some(0) {
                            let actual_filesize = final_filepath.as_ref()
                                .and_then(|fp| std::fs::metadata(fp).ok())
                                .map(|m| m.len());
                            
                            let reported_filesize = actual_filesize.or_else(|| {
                                if let Some(last_size) = current_stream_size {
                                    Some(total_filesize + last_size)
                                } else if total_filesize > 0 {
                                    Some(total_filesize)
                                } else {
                                    None
                                }
                            });
                            
                            let display_title = current_title.clone().or_else(|| {
                                final_filepath.as_ref().and_then(|path| {
                                    std::path::Path::new(path)
                                        .file_stem()
                                        .and_then(|s| s.to_str())
                                        .map(|s| s.to_string())
                                })
                            });
                            
                            // Log success
                            let success_msg = format!("Downloaded: {}", display_title.clone().unwrap_or_else(|| "Unknown".to_string()));
                            let details = format!(
                                "Size: {} · Quality: {} · Format: {}",
                                reported_filesize.map(format_size).unwrap_or_else(|| "Unknown".to_string()),
                                quality_display.clone().unwrap_or_else(|| quality.clone()),
                                format.clone()
                            );
                            add_log_internal("success", &success_msg, Some(&details), Some(&url)).ok();
                            
                            // Save to history (update existing or create new)
                            if let Some(ref filepath) = final_filepath {
                                // Extract time range from download_sections (strip "*" prefix)
                                let time_range = download_sections.as_ref().and_then(|s| {
                                    let stripped = s.strip_prefix('*').unwrap_or(s);
                                    if stripped.is_empty() { None } else { Some(stripped.to_string()) }
                                });
                                
                                if let Some(ref hist_id) = history_id {
                                    // Update existing history entry (re-download)
                                    update_history_download(
                                        hist_id.clone(),
                                        filepath.clone(),
                                        reported_filesize,
                                        quality_display.clone(),
                                        Some(format.clone()),
                                        time_range,
                                    ).ok();
                                } else {
                                    // Create new history entry
                                    let src = source.clone().or_else(|| detect_source(&url));
                                    let thumb = thumbnail.clone().or_else(|| generate_thumbnail_url(&url));
                                    
                                    add_history_internal(
                                        url.clone(),
                                        display_title.clone().unwrap_or_else(|| "Unknown".to_string()),
                                        thumb,
                                        filepath.clone(),
                                        reported_filesize,
                                        None,
                                        quality_display.clone(),
                                        Some(format.clone()),
                                        src,
                                        time_range,
                                    ).ok();
                                }
                            }
                            
                            let progress = DownloadProgress {
                                id: id.clone(),
                                percent: 100.0,
                                speed: String::new(),
                                eta: String::new(),
                                status: "finished".to_string(),
                                title: display_title,
                                filepath: final_filepath.clone(),
                                playlist_index: current_index,
                                playlist_count: total_count,
                                filesize: reported_filesize,
                                resolution: quality_display.clone(),
                                format_ext: Some(format.clone()),
                                error_message: None,
                                error_code: None,
                                error_params: None,
                                downloaded_size: None,
                                elapsed_time: None,
                            };
                            app.emit("download-progress", progress).ok();
                            return Ok(());
                        } else {
                            let recent_lines: Vec<String> = recent_output.iter().cloned().collect();
                            let error = build_download_error_message(status.code, &recent_lines);
                            add_log_internal("error", error.message(), None, Some(&url)).ok();
                            
                            // Emit error progress so frontend can display error message
                            let progress = DownloadProgress {
                                id: id.clone(),
                                percent: 0.0,
                                speed: String::new(),
                                eta: String::new(),
                                status: "error".to_string(),
                                title: current_title.clone(),
                                filepath: None,
                                playlist_index: current_index,
                                playlist_count: total_count,
                                filesize: None,
                                resolution: None,
                                format_ext: None,
                                error_message: Some(error.message().to_string()),
                                error_code: Some(error.code().to_string()),
                                error_params: error.params().cloned(),
                                downloaded_size: None,
                                elapsed_time: None,
                            };
                            app.emit("download-progress", progress).ok();
                            
                            return Err(error.to_wire_string());
                        }
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        Err(_) => {
            if ytdlp_source == DependencySource::App {
                return Err(BackendError::new(crate::types::code::YTDLP_APP_NOT_FOUND, "App-managed yt-dlp not found. Please install it from Settings > Dependencies.").with_retryable(false).to_wire_string());
            }

            // Fallback to system yt-dlp
            let mut cmd = Command::new("yt-dlp");
            cmd.args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            cmd.hide_window();
            
            let process = cmd.spawn()
                .map_err(|e| BackendError::from_message(format!("Failed to start yt-dlp: {}", e)).to_wire_string())?;
            
            handle_tokio_download(app, id, process, quality, format, url, should_log_stderr, title, thumbnail, source, download_sections, filepath_tmp).await
        }
    }
}

async fn handle_tokio_download(
    app: AppHandle,
    id: String,
    mut process: tokio::process::Child,
    quality: String,
    format: String,
    url: String,
    should_log_stderr: bool,
    title: Option<String>,
    thumbnail: Option<String>,
    source: Option<String>,
    download_sections: Option<String>,
    filepath_tmp: std::path::PathBuf,
) -> Result<(), String> {
    let stdout = process
        .stdout
        .take()
        .ok_or_else(|| BackendError::from_message("Failed to get stdout").to_wire_string())?;
    let stderr = process.stderr.take();
    let mut stdout_reader = BufReader::new(stdout);
    
    // Only use frontend title if it's not a URL (placeholder)
    let mut current_title: Option<String> = title.filter(|t| !t.starts_with("http"));
    let mut current_index: Option<u32> = None;
    let mut total_count: Option<u32> = None;
    let mut total_filesize: u64 = 0;
    let mut current_stream_size: Option<u64> = None;
    let mut final_filepath: Option<String> = None;
    let recent_output = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_filepath: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let quality_display = match quality.as_str() {
        "8k" => Some("8K".to_string()),
        "4k" => Some("4K".to_string()),
        "2k" => Some("2K".to_string()),
        "1080" => Some("1080p".to_string()),
        "720" => Some("720p".to_string()),
        "480" => Some("480p".to_string()),
        "360" => Some("360p".to_string()),
        "audio" => Some("Audio".to_string()),
        "best" => Some("Best".to_string()),
        _ => None,
    };
    
    // Spawn task to read stderr in parallel (for live stream progress)
    let stderr_app = app.clone();
    let stderr_id = id.clone();
    let stderr_url = url.clone();
    let stderr_recent_output = recent_output.clone();
    let stderr_fp_clone = stderr_filepath.clone();
    let stderr_task = if let Some(stderr_handle) = stderr {
        Some(tokio::spawn(async move {
            let mut stderr_reader = BufReader::new(stderr_handle);
            let mut line_buf = Vec::new();
            loop {
                line_buf.clear();
                match stderr_reader.read_until(b'\n', &mut line_buf).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                while line_buf.last().map_or(false, |&b| b == b'\n' || b == b'\r') {
                    line_buf.pop();
                }
                let line = decode_process_output(&line_buf);

                if CANCEL_FLAG.load(Ordering::SeqCst) {
                    break;
                }
                push_recent_output_shared(&stderr_recent_output, &line);

                // On Windows, yt-dlp may print --print after_move:filepath to stderr.
                // Capture it here as a fallback in case stdout doesn't contain the path.
                let t = line.trim();
                if !t.is_empty() && !t.starts_with('[')
                    && (t.ends_with(".mp4") || t.ends_with(".mkv") || t.ends_with(".mp3")
                        || t.ends_with(".m4a") || t.ends_with(".opus") || t.ends_with(".webm")
                        || t.ends_with(".flac") || t.ends_with(".wav"))
                {
                    if let Ok(mut guard) = stderr_fp_clone.lock() {
                        *guard = Some(t.to_string());
                    }
                }

                // Capture audio filepath from [ExtractAudio] Destination lines in stderr
                // e.g. "[ExtractAudio] Destination: C:\Users\...\song.mp3"
                if line.contains("[ExtractAudio]") && line.contains("Destination:") {
                    if let Some(pos) = line.find("Destination:") {
                        let path = line[pos + "Destination:".len()..].trim();
                        if !path.is_empty() {
                            if let Ok(mut guard) = stderr_fp_clone.lock() {
                                *guard = Some(path.to_string());
                            }
                        }
                    }
                }

                // Parse progress from stderr (live streams output here)
                if let Some((percent, speed, eta, pi, pc, downloaded_size, elapsed_time)) = parse_progress(&line) {
                    let progress = DownloadProgress {
                        id: stderr_id.clone(),
                        percent,
                        speed,
                        eta,
                        status: "downloading".to_string(),
                        title: None,
                        filepath: None,
                        playlist_index: pi,
                        playlist_count: pc,
                        filesize: None,
                        resolution: None,
                        format_ext: None,
                        error_message: None,
                        error_code: None,
                        error_params: None,
                        downloaded_size,
                        elapsed_time,
                    };
                    stderr_app.emit("download-progress", progress).ok();
                }

                // Log stderr if enabled
                if should_log_stderr && !line.trim().is_empty() {
                    add_log_internal("stderr", line.trim(), None, Some(&stderr_url)).ok();
                }
            }
        }))
    } else {
        None
    };
    
    // Read stdout — use raw byte reading + decode_process_output to handle
    // non-UTF-8 encodings (e.g. GBK on Chinese Windows).
    let mut stdout_line_buf = Vec::new();
    loop {
        stdout_line_buf.clear();
        match stdout_reader.read_until(b'\n', &mut stdout_line_buf).await {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break,
        }
        while stdout_line_buf.last().map_or(false, |&b| b == b'\n' || b == b'\r') {
            stdout_line_buf.pop();
        }
        let line = decode_process_output(&stdout_line_buf);

        if CANCEL_FLAG.load(Ordering::SeqCst) {
            process.kill().await.ok();
            kill_all_download_processes();
            return Err(BackendError::from_message("Download cancelled").to_wire_string());
        }
        push_recent_output_shared(&recent_output, &line);
        
        // Parse progress and emit events
        if let Some((percent, speed, eta, pi, pc, downloaded_size, elapsed_time)) = parse_progress(&line) {
            if pi.is_some() { current_index = pi; }
            if pc.is_some() { total_count = pc; }
            
            let progress = DownloadProgress {
                id: id.clone(),
                percent,
                speed,
                eta,
                status: "downloading".to_string(),
                title: current_title.clone(),
                filepath: None,
                playlist_index: current_index,
                playlist_count: total_count,
                filesize: None,
                resolution: None,
                format_ext: None,
                error_message: None,
                error_code: None,
                error_params: None,
                downloaded_size,
                elapsed_time,
            };
            app.emit("download-progress", progress).ok();
        }
        
        // Extract title from [download] messages
        // Handles both: "Destination: /path/file.mp4" and "/path/file.mp4 has already been downloaded"
        if line.contains("[download]") && (line.contains("Destination:") || line.contains("has already been downloaded")) {
            let path_sep = if line.contains('\\') { '\\' } else { '/' };
            if let Some(start) = line.rfind(path_sep) {
                let filename = &line[start + 1..];
                // Remove suffix if present
                let filename = filename.trim_end_matches(" has already been downloaded");
                if let Some(end) = filename.rfind('.') {
                    current_title = Some(filename[..end].to_string());
                }
            }
        }
        
        // Capture final filepath
        let trimmed = line.trim();
        if !trimmed.is_empty()
            && !trimmed.starts_with('[')
            && (trimmed.ends_with(".mp3") || trimmed.ends_with(".m4a")
                || trimmed.ends_with(".opus") || trimmed.ends_with(".mp4")
                || trimmed.ends_with(".mkv") || trimmed.ends_with(".webm")
                || trimmed.ends_with(".flac") || trimmed.ends_with(".wav"))
        {
            final_filepath = Some(trimmed.to_string());
        }

        // Capture audio filepath from [ExtractAudio] Destination lines
        // e.g. "[ExtractAudio] Destination: C:\Users\...\song.mp3"
        if line.contains("[ExtractAudio]") && line.contains("Destination:") {
            if let Some(pos) = line.find("Destination:") {
                let path = line[pos + "Destination:".len()..].trim();
                if !path.is_empty() {
                    final_filepath = Some(path.to_string());
                }
            }
        }
        
        // Parse filesize
        if line.contains(" of ") && (line.contains("MiB") || line.contains("GiB")) {
            if let Some(re) = regex::Regex::new(r"of\s+(\d+(?:\.\d+)?)\s*(GiB|MiB|KiB)").ok() {
                if let Some(caps) = re.captures(&line) {
                    if let (Some(num), Some(unit)) = (caps.get(1), caps.get(2)) {
                        if let Ok(size) = num.as_str().parse::<f64>() {
                            let size_bytes = match unit.as_str() {
                                "GiB" => (size * 1024.0 * 1024.0 * 1024.0) as u64,
                                "MiB" => (size * 1024.0 * 1024.0) as u64,
                                "KiB" => (size * 1024.0) as u64,
                                _ => size as u64,
                            };
                            if current_stream_size != Some(size_bytes) {
                                if let Some(prev_size) = current_stream_size {
                                    total_filesize += prev_size;
                                }
                                current_stream_size = Some(size_bytes);
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Wait for stderr task to finish reading all lines.
    if let Some(task) = stderr_task {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), task).await;
    }

    // Wait for process to fully exit before reading the temp file.
    // yt-dlp writes --print-to-file after_move:filepath near process exit;
    // reading before wait() can race and miss the path.
    let status = process
        .wait()
        .await
        .map_err(|e| BackendError::from_message(format!("Process error: {}", e)).to_wire_string())?;

    // Primary filepath source: read from the --print-to-file temp file (UTF-8).
    // This is reliable on all platforms, especially Windows with non-UTF-8 locales
    // where stdout encoding (GBK) corrupts Unicode characters in file paths.
    if let Ok(contents) = std::fs::read_to_string(&filepath_tmp) {
        let path = contents.trim().to_string();
        if !path.is_empty() {
            final_filepath = Some(path);
        }
    }
    // Clean up the temp file
    std::fs::remove_file(&filepath_tmp).ok();

    // Fallback: if the temp file didn't yield a filepath, try stdout/stderr captures
    if final_filepath.is_none() {
        if let Ok(guard) = stderr_filepath.lock() {
            if guard.is_some() {
                final_filepath = guard.clone();
            }
        }
    }

    if status.success() {
        let actual_filesize = final_filepath.as_ref()
            .and_then(|fp| std::fs::metadata(fp).ok())
            .map(|m| m.len());
        
        let reported_filesize = actual_filesize.or_else(|| {
            if let Some(last_size) = current_stream_size {
                Some(total_filesize + last_size)
            } else if total_filesize > 0 {
                Some(total_filesize)
            } else {
                None
            }
        });
        
        // Fallback: extract title from final_filepath if current_title is None
        let display_title = current_title.or_else(|| {
            final_filepath.as_ref().and_then(|path| {
                std::path::Path::new(path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
        });
        
        let success_msg = format!("Downloaded: {}", display_title.clone().unwrap_or_else(|| "Unknown".to_string()));
        let details = format!(
            "Size: {} · Quality: {} · Format: {}",
            reported_filesize.map(format_size).unwrap_or_else(|| "Unknown".to_string()),
            quality_display.clone().unwrap_or_else(|| quality.clone()),
            format.clone()
        );
        add_log_internal("success", &success_msg, Some(&details), Some(&url)).ok();
        
        // Save to history
        if let Some(ref filepath) = final_filepath {
            let src = source.clone().or_else(|| detect_source(&url));
            let thumb = thumbnail.clone().or_else(|| generate_thumbnail_url(&url));
            
            // Extract time range from download_sections (strip "*" prefix)
            let time_range = download_sections.as_ref().and_then(|s| {
                let stripped = s.strip_prefix('*').unwrap_or(s);
                if stripped.is_empty() { None } else { Some(stripped.to_string()) }
            });
            
            add_history_internal(
                url.clone(),
                display_title.clone().unwrap_or_else(|| "Unknown".to_string()),
                thumb,
                filepath.clone(),
                reported_filesize,
                None,
                quality_display.clone(),
                Some(format.clone()),
                src,
                time_range,
            ).ok();
        }
        
        let progress = DownloadProgress {
            id: id.clone(),
            percent: 100.0,
            speed: String::new(),
            eta: String::new(),
            status: "finished".to_string(),
            title: display_title,
            filepath: final_filepath.clone(),
            playlist_index: current_index,
            playlist_count: total_count,
            filesize: reported_filesize,
            resolution: quality_display,
            format_ext: Some(format),
            error_message: None,
            error_code: None,
            error_params: None,
            downloaded_size: None,
            elapsed_time: None,
        };
        app.emit("download-progress", progress).ok();
        Ok(())
    } else {
        let recent_lines = recent_output_snapshot(&recent_output);
        let error = build_download_error_message(status.code(), &recent_lines);
        add_log_internal("error", error.message(), None, Some(&url)).ok();
        
        // Emit error progress so frontend can display error message
        let progress = DownloadProgress {
            id: id.clone(),
            percent: 0.0,
            speed: String::new(),
            eta: String::new(),
            status: "error".to_string(),
            title: current_title,
            filepath: None,
            playlist_index: current_index,
            playlist_count: total_count,
            filesize: None,
            resolution: None,
            format_ext: None,
            error_message: Some(error.message().to_string()),
            error_code: Some(error.code().to_string()),
            error_params: error.params().cloned(),
            downloaded_size: None,
            elapsed_time: None,
        };
        app.emit("download-progress", progress).ok();
        
        Err(error.to_wire_string())
    }
}

fn sanitize_filename_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            _ => ch,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    if cleaned.is_empty() {
        "media".to_string()
    } else {
        cleaned.to_string()
    }
}

fn split_filename_parts(value: &str) -> (String, Option<String>) {
    let sanitized = sanitize_filename_component(value);
    if let Some((stem, ext)) = sanitized.rsplit_once('.') {
        if !stem.is_empty() && !ext.is_empty() && ext.len() <= 8 {
            return (sanitize_filename_component(stem), Some(ext.to_ascii_lowercase()));
        }
    }
    (sanitized, None)
}

fn extension_from_content_type(content_type: &str) -> Option<&'static str> {
    let normalized = content_type.split(';').next()?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "image/avif" => Some("avif"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "video/x-m4v" => Some("m4v"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/aac" => Some("aac"),
        "audio/ogg" => Some("ogg"),
        "audio/opus" => Some("opus"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/flac" => Some("flac"),
        "audio/webm" => Some("weba"),
        _ => None,
    }
}

fn extension_from_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let file_name = parsed.path_segments()?.last()?;
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (_, ext) = split_filename_parts(trimmed);
    ext
}

fn filename_from_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let file_name = parsed.path_segments()?.last()?;
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn filename_from_content_disposition(value: &str) -> Option<String> {
    for part in value.split(';') {
        let trimmed = part.trim();
        if let Some(rest) = trimmed.strip_prefix("filename=") {
            let candidate = rest.trim().trim_matches('"');
            if !candidate.is_empty() {
                return Some(candidate.to_string());
            }
        }
        if let Some(rest) = trimmed.strip_prefix("filename*=UTF-8''") {
            let candidate = rest.trim().trim_matches('"').replace("%20", " ");
            if !candidate.is_empty() {
                return Some(candidate);
            }
        }
    }
    None
}

fn ensure_unique_output_path(base_dir: &str, file_name: &str) -> PathBuf {
    let mut candidate = Path::new(base_dir).join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "media".to_string());
    let ext = path.extension().and_then(|s| s.to_str()).map(|s| s.to_string());

    for index in 1..10000 {
        let next_name = match ext.as_deref() {
            Some(ext) if !ext.is_empty() => format!("{} ({}).{}", stem, index, ext),
            _ => format!("{} ({})", stem, index),
        };
        candidate = Path::new(base_dir).join(next_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    Path::new(base_dir).join(file_name)
}

fn format_eta_label(seconds: u64) -> String {
    let minutes = seconds / 60;
    let secs = seconds % 60;
    if minutes >= 60 {
        let hours = minutes / 60;
        let rem_minutes = minutes % 60;
        format!("{:02}:{:02}:{:02}", hours, rem_minutes, secs)
    } else {
        format!("{:02}:{:02}", minutes, secs)
    }
}

fn format_speed_label(bytes_per_second: f64) -> String {
    if bytes_per_second <= 0.0 {
        String::new()
    } else {
        format!("{}/s", format_size(bytes_per_second as u64))
    }
}

fn build_direct_filename(
    url: &str,
    title: Option<&str>,
    content_disposition: Option<&str>,
    content_type: Option<&str>,
    id: &str,
) -> (String, String) {
    let disposition_name = content_disposition.and_then(filename_from_content_disposition);
    let title_name = title
        .filter(|value| !value.trim().is_empty() && !value.starts_with("http://") && !value.starts_with("https://"))
        .map(|value| value.trim().to_string());
    let url_name = filename_from_url(url);

    let preferred = disposition_name
        .or(title_name)
        .or(url_name)
        .unwrap_or_else(|| format!("media-{}", id));

    let (stem, explicit_ext) = split_filename_parts(&preferred);
    let ext = explicit_ext
        .or_else(|| content_type.and_then(extension_from_content_type).map(|value| value.to_string()))
        .or_else(|| extension_from_url(url))
        .unwrap_or_else(|| "bin".to_string());

    (format!("{}.{}", stem, ext), ext)
}

fn is_non_media_content_type(content_type: &str) -> bool {
    let normalized = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    normalized.starts_with("text/html")
        || normalized.starts_with("application/json")
        || normalized.starts_with("text/plain")
}

fn should_use_ranged_direct_download(total_size: Option<u64>, accept_ranges: Option<&str>) -> bool {
    matches!(total_size, Some(size) if size >= 8 * 1024 * 1024)
        && accept_ranges
            .map(|value| value.to_ascii_lowercase().contains("bytes"))
            .unwrap_or(false)
}

fn build_direct_ranges(total_size: u64, max_segments: Option<u8>) -> Vec<(u64, u64)> {
    if total_size < 8 * 1024 * 1024 {
        return vec![(0, total_size.saturating_sub(1))];
    }

    let auto_part_count = if total_size >= 64 * 1024 * 1024 {
        4
    } else if total_size >= 24 * 1024 * 1024 {
        3
    } else {
        2
    };
    let part_count = max_segments
        .map(|value| value.clamp(1, 4) as usize)
        .unwrap_or(auto_part_count);
    let chunk_size = (total_size / part_count as u64).max(1);
    let mut ranges = Vec::with_capacity(part_count);
    let mut start = 0u64;

    for index in 0..part_count {
        let end = if index == part_count - 1 {
            total_size.saturating_sub(1)
        } else {
            (start + chunk_size).saturating_sub(1).min(total_size.saturating_sub(1))
        };
        ranges.push((start, end));
        start = end.saturating_add(1);
    }

    ranges
}

fn build_direct_part_path(output_file: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.part{}", output_file.to_string_lossy(), index))
}

async fn cleanup_direct_part_files(paths: &[PathBuf]) {
    for path in paths {
        let _ = tokio::fs::remove_file(path).await;
    }
}

fn build_direct_progress(
    id: &str,
    title: &str,
    downloaded: u64,
    total_size: Option<u64>,
    started: Instant,
    format_ext: &str,
) -> DownloadProgress {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let speed_bps = downloaded as f64 / elapsed;
    let percent = total_size
        .map(|size| ((downloaded as f64 / size.max(1) as f64) * 100.0).min(100.0))
        .unwrap_or(0.0);
    let eta = total_size
        .and_then(|size| {
            if speed_bps <= 0.0 || downloaded >= size {
                None
            } else {
                Some(format_eta_label(((size - downloaded) as f64 / speed_bps).ceil() as u64))
            }
        })
        .unwrap_or_default();

    DownloadProgress {
        id: id.to_string(),
        percent,
        speed: format_speed_label(speed_bps),
        eta,
        status: "downloading".to_string(),
        title: Some(title.to_string()),
        filepath: None,
        playlist_index: None,
        playlist_count: None,
        filesize: total_size,
        resolution: None,
        format_ext: Some(format_ext.to_string()),
        error_message: None,
        error_code: None,
        error_params: None,
        downloaded_size: None,
        elapsed_time: None,
    }
}

async fn download_direct_range_part(
    client: reqwest::Client,
    url: String,
    referer_url: Option<String>,
    part_path: PathBuf,
    start: u64,
    end: u64,
    progress: Arc<AtomicU64>,
) -> Result<(), String> {
    let mut request = client
        .get(&url)
        .header(USER_AGENT, "Mozilla/5.0 Youwee/0.11.1")
        .header(RANGE, format!("bytes={}-{}", start, end));
    if let Some(referer) = referer_url.as_deref() {
        request = request.header(REFERER, referer);
    }
    let response = request
        .send()
        .await
        .map_err(|e| BackendError::from_message(format!("Direct media range request failed: {}", e)).to_wire_string())?;

    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(BackendError::from_message(format!("Direct media range request not supported: {}", response.status())).to_wire_string());
    }

    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| BackendError::from_message(format!("Failed to create part file: {}", e)).to_wire_string())?;

    while let Some(chunk) = stream.next().await {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(BackendError::from_message("Download cancelled").to_wire_string());
        }

        let chunk = chunk
            .map_err(|e| BackendError::from_message(format!("Direct media stream failed: {}", e)).to_wire_string())?;
        file.write_all(&chunk)
            .await
            .map_err(|e| BackendError::from_message(format!("Failed to write part file: {}", e)).to_wire_string())?;
        progress.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }

    file.flush()
        .await
        .map_err(|e| BackendError::from_message(format!("Failed to finalize part file: {}", e)).to_wire_string())?;
    Ok(())
}

#[tauri::command]
pub async fn download_direct_media(
    app: AppHandle,
    id: String,
    url: String,
    output_path: String,
    title: Option<String>,
    thumbnail: Option<String>,
    source: Option<String>,
    proxy_url: Option<String>,
    referer_url: Option<String>,
    max_segments: Option<u8>,
) -> Result<(), String> {
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    validate_url(&url).map_err(|e| BackendError::from_message(e).to_wire_string())?;

    let sanitized_path =
        sanitize_output_path(&output_path).map_err(|e| BackendError::from_message(e).to_wire_string())?;

    let mut client_builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(10));
    if let Some(proxy) = proxy_url.as_ref() {
        if !proxy.is_empty() {
            client_builder = client_builder.proxy(
                reqwest::Proxy::all(proxy)
                    .map_err(|e| BackendError::from_message(format!("Invalid proxy URL: {}", e)).to_wire_string())?,
            );
        }
    }
    let client = client_builder
        .build()
        .map_err(|e| BackendError::from_message(format!("Failed to build HTTP client: {}", e)).to_wire_string())?;

    let referer_value = referer_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let mut request = client
        .get(&url)
        .header(USER_AGENT, "Mozilla/5.0 Youwee/0.11.1");
    if let Some(referer) = referer_value.as_deref() {
        request = request.header(REFERER, referer);
    }

    let response = request
        .send()
        .await
        .map_err(|e| BackendError::from_message(format!("Direct media request failed: {}", e)).to_wire_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(BackendError::from_message(format!("Direct media request failed with status {}", status)).to_wire_string());
    }

    let headers = response.headers().clone();
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    if let Some(content_type) = content_type.as_deref() {
        if is_non_media_content_type(content_type) {
            return Err(BackendError::from_message(format!("Direct URL returned non-media content: {}", content_type)).to_wire_string());
        }
    }

    let content_disposition = headers
        .get(CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let accept_ranges = headers
        .get(ACCEPT_RANGES)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let total_size = response.content_length();
    let (file_name, format_ext) = build_direct_filename(
        &url,
        title.as_deref(),
        content_disposition.as_deref(),
        content_type.as_deref(),
        &id,
    );
    let output_file = ensure_unique_output_path(&sanitized_path, &file_name);
    let display_title = title
        .filter(|value| !value.starts_with("http://") && !value.starts_with("https://") && !value.trim().is_empty())
        .unwrap_or_else(|| {
            output_file
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("media")
                .to_string()
        });

    let started = Instant::now();

    if should_use_ranged_direct_download(total_size, accept_ranges.as_deref()) {
        drop(response);
        let total_bytes = total_size.unwrap_or_default();
        let ranges = build_direct_ranges(total_bytes, max_segments);
        let part_paths: Vec<PathBuf> = ranges
            .iter()
            .enumerate()
            .map(|(index, _)| build_direct_part_path(&output_file, index))
            .collect();
        let downloaded = Arc::new(AtomicU64::new(0));
        let mut handles = Vec::with_capacity(ranges.len());

        for (index, (start, end)) in ranges.iter().enumerate() {
            let client = client.clone();
            let url = url.clone();
            let part_path = part_paths[index].clone();
            let progress = downloaded.clone();
            let referer_url = referer_value.clone();
            let start = *start;
            let end = *end;
            handles.push(tokio::spawn(async move {
                download_direct_range_part(client, url, referer_url, part_path, start, end, progress).await
            }));
        }

        let mut join_all = Box::pin(futures_util::future::try_join_all(handles));
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let part_result: Result<Vec<Result<(), String>>, _> = loop {
            tokio::select! {
                result = &mut join_all => break result,
                _ = interval.tick() => {
                    let payload = build_direct_progress(
                        &id,
                        &display_title,
                        downloaded.load(Ordering::Relaxed),
                        total_size,
                        started,
                        &format_ext,
                    );
                    app.emit("download-progress", payload).ok();
                }
            }
        };

        match part_result {
            Ok(results) => {
                for result in results {
                    if let Err(error) = result {
                        cleanup_direct_part_files(&part_paths).await;
                        return Err(error);
                    }
                }
            }
            Err(error) => {
                cleanup_direct_part_files(&part_paths).await;
                return Err(BackendError::from_message(format!("Direct media task failed: {}", error)).to_wire_string());
            }
        }

        let mut final_file = tokio::fs::File::create(&output_file)
            .await
            .map_err(|e| BackendError::from_message(format!("Failed to create output file: {}", e)).to_wire_string())?;
        for part_path in &part_paths {
            let mut part_file = tokio::fs::File::open(part_path)
                .await
                .map_err(|e| BackendError::from_message(format!("Failed to open part file: {}", e)).to_wire_string())?;
            tokio::io::copy(&mut part_file, &mut final_file)
                .await
                .map_err(|e| BackendError::from_message(format!("Failed to merge part file: {}", e)).to_wire_string())?;
        }
        final_file.flush()
            .await
            .map_err(|e| BackendError::from_message(format!("Failed to finalize output file: {}", e)).to_wire_string())?;
        cleanup_direct_part_files(&part_paths).await;
    } else {
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(&output_file)
            .await
            .map_err(|e| BackendError::from_message(format!("Failed to create output file: {}", e)).to_wire_string())?;
        let mut last_emit = Instant::now();
        let mut downloaded: u64 = 0;

        while let Some(chunk) = stream.next().await {
            if CANCEL_FLAG.load(Ordering::SeqCst) {
                let _ = tokio::fs::remove_file(&output_file).await;
                return Err(BackendError::from_message("Download cancelled").to_wire_string());
            }

            let chunk = chunk
                .map_err(|e| BackendError::from_message(format!("Direct media stream failed: {}", e)).to_wire_string())?;
            file.write_all(&chunk)
                .await
                .map_err(|e| BackendError::from_message(format!("Failed to write output file: {}", e)).to_wire_string())?;
            downloaded += chunk.len() as u64;

            if last_emit.elapsed() >= Duration::from_millis(250) {
                let payload = build_direct_progress(
                    &id,
                    &display_title,
                    downloaded,
                    total_size,
                    started,
                    &format_ext,
                );
                app.emit("download-progress", payload).ok();
                last_emit = Instant::now();
            }
        }

        file.flush()
            .await
            .map_err(|e| BackendError::from_message(format!("Failed to finalize output file: {}", e)).to_wire_string())?;
    }

    let actual_size = tokio::fs::metadata(&output_file)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    let filepath = output_file.to_string_lossy().to_string();
    let success_message = format!("Downloaded: {}", display_title);
    let details = format!("Size: {} · Format: {}", format_size(actual_size), format_ext);
    add_log_internal("success", &success_message, Some(&details), Some(&url)).ok();
    add_history_internal(
        url.clone(),
        display_title.clone(),
        thumbnail,
        filepath.clone(),
        Some(actual_size),
        None,
        Some("Original".to_string()),
        Some(format_ext.clone()),
        source.or_else(|| Some("direct-media".to_string())),
        None,
    ).ok();
    app.emit(
        "download-progress",
        DownloadProgress {
            id,
            percent: 100.0,
            speed: String::new(),
            eta: String::new(),
            status: "finished".to_string(),
            title: Some(display_title),
            filepath: Some(filepath),
            playlist_index: None,
            playlist_count: None,
            filesize: Some(actual_size),
            resolution: None,
            format_ext: Some(format_ext),
            error_message: None,
            error_code: None,
            error_params: None,
            downloaded_size: None,
            elapsed_time: None,
        },
    ).ok();
    Ok(())
}
#[tauri::command]
pub async fn stop_download() -> Result<(), String> {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    kill_all_download_processes();
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    kill_all_download_processes();
    Ok(())
}

fn detect_source(url: &str) -> Option<String> {
    if url.contains("youtube.com") || url.contains("youtu.be") {
        Some("youtube".to_string())
    } else if url.contains("tiktok.com") {
        Some("tiktok".to_string())
    } else if url.contains("facebook.com") || url.contains("fb.watch") {
        Some("facebook".to_string())
    } else if url.contains("instagram.com") {
        Some("instagram".to_string())
    } else if url.contains("twitter.com") || url.contains("x.com") {
        Some("twitter".to_string())
    } else if url.contains("bilibili.com") || url.contains("b23.tv") {
        Some("bilibili".to_string())
    } else if url.contains("youku.com") {
        Some("youku".to_string())
    } else {
        Some("other".to_string())
    }
}

fn generate_thumbnail_url(url: &str) -> Option<String> {
    if url.contains("youtube.com") || url.contains("youtu.be") {
        let video_id = if url.contains("v=") {
            url.split("v=").nth(1).and_then(|s| s.split('&').next())
        } else if url.contains("youtu.be/") {
            url.split("youtu.be/").nth(1).and_then(|s| s.split('?').next())
        } else {
            None
        };
        video_id.map(|id| format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", id))
    } else {
        None
    }
}


