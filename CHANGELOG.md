# Changelog

All notable changes to Youwee will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Hidden JPG-sequence playback for page-resolved streams** - The in-app HLS player now detects manifests that are actually image-frame playlists, such as AVJB `newembed` JPG sequences, and renders them through an internal frame-sequence path instead of handing them to standard Hls.js video decoding
- **AVJB playback context and fallback order** - Page-resolved playback now carries the original resolver page as the Referer/Origin context, skips the native HLS shortcut when page context is required, and only falls back to JPG-sequence rendering after Hls.js has genuinely failed so AVJB 
ewembed streams behave closer to the original userscript
- **Playback-time refresh for page-resolved signed streams** - Page-resolved entries now retain their source page and refresh the resolved stream URL again when the viewer opens, so short-lived signed manifests such as AVJB `newembed` m3u8 links do not expire before playback starts
- **AVJB newembed fallback expanded to avjb.com** - The hidden page-stream resolver now applies the same AVJB video/embed fallback to both `avjb.cc` and `avjb.com`, matching the original userscript strategy of bypassing the page player by scraping `/newembed/<videoId>` for playable m3u8 sources
- **Hidden all-site page-stream resolution in the existing M3U flow** - The current M3U URL loader now recognizes ordinary page URLs, distinguishes direct media from playlist text, resolves playable m3u8/mp4/video sources through a new generic Tauri backend command, and feeds the result into the existing HLS playback/download pipeline without adding a separate UI surface
- **Rust dispatch restoration and dedicated scheduler status block** - The Rust crawler scheduler now raises `dispatch_limit` back up after several stable segments, while the task status area shows Rust transfer metrics in a dedicated block instead of a single packed line
- **Rust slow-window chunk decay and failure-aware host throttling** - The Rust crawler scheduler now shrinks later chunk sizes after consecutive slow segments, tracks request/status/stream/incomplete retry classes, and automatically lowers the active dispatch limit for retry-heavy ImgBB or Google hosts instead of holding full concurrency under repeated failures
- **Rust pre-dispatch chunk rebalancing and scheduler counters** - Before assigning work to a worker, the Rust downloader now re-splits oversized pending ranges against the current adaptive chunk size, and the task status panel now tracks wait/retry/tune/rebalance counts alongside host policy and EWMA throughput
- **Rust host transfer quotas and live scheduler stats** - The Rust crawler downloader now applies per-host segment/chunk caps for ImgBB versus Google media, logs the active host policy, and surfaces active/pending/EWMA scheduler stats in the task status panel so transfer pressure is visible without reading raw logs
- **Rust segmented scheduler takeover** - The crawler Rust downloader now owns segmented transfer scheduling end-to-end, including manifest persistence, pending/in-flight/completed range queues, per-part resume, and final merge, instead of relying on Python for the chunk-dispatch loop
- **Rust range work-stealing and slow-link chunk tuning** - Segmented Rust transfers now keep a shared remaining-range queue, split oversized pending ranges as workers free up, and shrink or grow later chunk sizes from observed throughput so faster connections steal more work while slower links get smaller chunks
- **Rust crawler progress telemetry** - The Rust `crawler_downloader` now emits live transfer progress, Python streams those logs into crawler task output in real time, and the task status panel summarizes active Rust transfer mode, fallback count, and current throughput
- **Automatic crawler transfer presets** - ImgBB and Google Photos URLs now auto-apply sensible host/range/chunk defaults when the tuning fields are left empty, so segmented Rust transfers start with better per-site settings without manual tuning
- **Crawler host/range tuning controls** - The crawler task UI now exposes host parallel limit, per-file range worker limit, and range chunk size overrides so problematic image hosts can be tuned without falling back to raw extra args
- **Rust crawler downloader scaffold** - Added a standalone `crawler_downloader` Rust binary that can parse crawler `.parts.json` manifests and report resumable part state, establishing the first concrete CLI entry point for a future native crawler transfer backend
- **Crawler download transport abstraction** - The crawler now routes segmented and single-stream transfers through a dedicated transport wrapper so chunk scheduling can evolve independently from the underlying HTTP engine, preparing the path for a future Rust/native transfer backend
- **Crawler segmented-download manifest and chunk scheduler** - Ranged crawler downloads now persist a `.parts.json` manifest beside the target file, keep `.part` chunks after real failures for later resume, dynamically split oversized pending chunks as workers free up, adapt later chunk sizes from observed throughput, and log worker/chunk counts so resumable multi-range transfers behave more like a real download manager
- **Crawler download-mode control and segmented transfer stats** - The crawler task UI now exposes segmented versus single-stream download mode, and task status summarizes segmented hits, fallbacks, and per-part retries from sidecar logs
- **Segmented crawler direct-media downloads by default** - Any crawler direct-media file that exposes `Accept-Ranges: bytes` now attempts IDM-style 2-4 parallel `Range` requests first, with automatic single-stream fallback when the server does not honor segmented transfers
- **Collapsible crawler status, logs, and browser panels** - The crawler task card now keeps task status open by default while tucking live logs and the media browser into dedicated collapsible sections for a cleaner working layout
- **Collapsible crawler task-parameter panel** - The crawler task card now keeps URL/output fields visible while moving advanced options, import filters, and related task parameters into a dedicated collapsible panel for a cleaner default layout
- **Crawler and M3U maintenance roundup** - Consolidated today's crawler-sidecar, Telegraph fallback, media-browser, and M3U/HLS fixes into Unreleased, covering scan-to-download stability, Telegram fallback task actions, cleaner crawler browser defaults, and stronger HLS request handling
- **Telegram fallback crawler actions** - Telegraph source-missing warnings and completion toasts now expose Telegram fallback links with direct actions to open Telegram, apply the link to the crawler task form, or start a crawler task immediately while forwarding cookie-file login verification settings through the sidecar
- **Crawler media-browser defaults, filters, and detail controls** - The crawler browser now defaults to a cleaner collapsed layout, remembers detail preferences, adds title/page/file/path/downloaded filters, highlights downloaded items, and provides per-card plus bulk expand/collapse controls
- **Crawler task completion toast** - Successful crawler tasks now show an in-app completion popup with a quick action to open the resolved output directory
- **Crawler import and Universal output visibility** - Retry/import flows now show and reuse the effective output directory, Universal can open the configured output folder, completed items expose saved paths plus open-folder actions, and direct-media imports support configurable segmented downloads
- **Custom M3U request headers** - The M3U page now accepts per-source HTTP headers and passes them into both remote playlist loading and in-app HLS playback
- **In-app download completion toast** - Download and Universal queues now show a transient in-app completion popup with quick access to the saved file location
- **Expanded M3U parser coverage** - M3U/M3U8 parsing now resolves relative entry URLs against the source playlist, understands `#EXT-X-STREAM-INF` master playlists, deduplicates entries, and preserves more IPTV metadata such as `tvg-name`, `tvg-id`, and `group-title`
- **M3U/M3U8 stream support** - Crawler now detects and collects `.m3u` and `.m3u8` HLS playlist links. The media browser and viewer play HLS streams inline via hls.js. Detected streams can be imported into Universal for yt-dlp download
- **Dedicated M3U workspace and library tools** - The M3U sidebar now bundles playlist loading, inline browsing, favorites, load history, grouped batch download, and folder-based bulk favorite management into one workflow
- **M3U playback fallback and error overlay** - When HLS or direct streams fail to play (e.g. H.265/HEVC codec not supported in browser), an error overlay shows the reason and offers "Open in external player", "Copy URL", and "Show codec info" buttons. Manifest CORS failures automatically retry through Tauri backend proxy
- **HEVC codec detection and install guide** - Automatically detects if H.265/HEVC system codec is installed via `MediaSource.isTypeSupported()`. When missing and playback fails, shows a blue install card with direct link to Microsoft Store free HEVC Video Extensions package
- **System codec diagnostic panel** - New "Show codec info" button in error overlay displays a table of all detected codecs (H.264, H.265, VP8, VP9, AV1, AAC, Opus, MPEG-TS) with MSE and native support status
- **WebView2 HEVC hardware acceleration** - Added `--enable-features=PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport` to Tauri WebView2 browser args, enabling hardware H.265 decode when system codec is installed
- **CSP worker/blob support** - Extended Content Security Policy to allow `worker-src blob:` (for hls.js Web Worker) and `blob:` in `connect-src` and `script-src` (for proxied manifest blob URLs)
- **M3U/HLS playback and download reliability** - The M3U stack now forwards stronger playback headers, respects the chosen download folder, rewrites proxied manifest URLs correctly, fixes the in-app video layout bug, and surfaces clearer diagnostics for audio-only or header-sensitive HLS sources
- **Crawler history-folder preview and recovery workflow** - History folders can now auto-scan their `data` files, expose richer diagnostics, load preview artifacts after sidecar restarts, and drive failed-download recovery directly from saved task output
- **Dependency source selector (yt-dlp/FFmpeg)** - Added source switching in Settings -> Dependencies so users can choose between app-managed binaries and system-managed binaries
- **Safety confirmation before switching to system source** - Added a confirmation dialog when switching yt-dlp/FFmpeg to system source to prevent accidental changes
- **Proxy API style selector for custom providers** - Added AI Settings options for Third-party OpenAI, OpenAI Responses, and NewAPI Gateway, with inline notes describing suffix and response differences
- **Provider model discovery for OpenAI/Proxy** - Added a Fetch Models action that loads available models directly from provider endpoints and refreshes quick-select options
- **Sidebar Image Crawler entry** - Added a dedicated left-sidebar entry that opens crawler controls directly
- **Expanded crawler task controls** - Added queue/retry file inputs, template presets, include/exclude URL regex, and size/resolution filters to reuse more image_crawler capabilities
- **Crawler media browser panel** - Added an in-app media browser under Crawler Task with load preview, type filters (All/Image/GIF/Video/Audio), inline preview tiles, and open-link actions
- **Crawler media viewer dialog** - Added an in-app viewer overlay for crawler results so preview tiles can open directly inside the app with previous/next navigation across the active filter
- **Crawler viewer keyboard/image controls** - Added ArrowLeft/ArrowRight/Escape shortcuts and image fit/original-size toggle inside the crawler media viewer
- **Crawler retry/export/task-folder workflow** - Added retry-failed-downloads for current crawler media, browser/link export actions, source-page links in media browser, and automatic per-page output subfolders when importing crawler results into Universal
- **Sidecar health diagnostics payload** - `/health` now returns build id, PID, and script path to quickly verify which sidecar instance is running
- **Crawler template auto-fill** - Selecting a template preset (Speed Mode, High Quality, Fast Preview, Strict Site, Stable Large) now instantly updates related UI fields (workers, timeout, delay, retries, scope, etc.) to mirror the Python `apply_template_defaults()` behavior
- **Crawler download speed diagnostics** - Progress log now prints download rate and elapsed time every 10 items (`[PROGRESS] 50/200 (2.5/s, 20s)`) and session config at startup (`[NET] pool_maxsize=12 workers=8 ...`)

### Fixed
- **Crawler Rust transfer handoff** - Direct-media crawler downloads now prefer the compiled `crawler_downloader` Rust binary for actual file transfer, while Python keeps scanning/filtering/reporting and falls back to the in-process downloader only when the Rust path is unavailable or fails
- **Crawler host-level connection gating** - Media requests now share per-host concurrency slots across probe, segmented, and fallback transfers, with startup diagnostics for active host limits and wait logs when an image host is saturated
- **Crawler ranged-download worker scheduling** - Range downloads now derive the actual worker count after pending chunks are expanded, log the real dispatch concurrency, and emit periodic wait heartbeats so multi-range runs no longer appear frozen while large chunks are still in flight
- **More aggressive adaptive segmented crawler downloads** - Crawler direct-media transfers now scale up to 12 parallel ranges by file size and host profile, resume unfinished `.part` segments instead of restarting them from zero, keep chunk state across failed runs for true resume, and size the HTTP connection pool for heavy multi-range runs
- **Per-part retries for ranged crawler downloads** - Parallel `Range` downloads now retry each part independently instead of restarting the whole file on a single segment failure, including Google Photos image and video hosts
- **Host-specific crawler read timeouts** - The crawler now applies longer read timeouts for slower image hosts such as `i.ibb.co` and Google user-content URLs while keeping default connect timeouts short, and startup logs now print the active timeout policy map
- **Crawler media-host download stability** - Image downloads now use each item's source page as the `Referer`, print effective download timeout settings at startup, and relax the `stable_large` template's throttling defaults so large album runs no longer self-limit as aggressively
- **Crawler download timeout and retry tuning** - Direct image downloads now use separate connect/read timeouts, larger stream chunks, and skip repeated retries for non-retryable HTTP failures so slow media hosts fail less often and exhausted retries no longer drag throughput down
- **Crawler scan-to-download handoff crash** - Fixed a `crawl_pages()` return-value mismatch (`expected 5, got 4`) that could let discovery finish successfully and then stop before the actual download stage began
- **Crawler output-path resolution and reporting** - Completion toasts and output-folder actions now resolve the real media directory from preview/report artifacts and saved-path metadata, while reports record enough path detail to recover existing media folders instead of falling back to retry or parent output directories
- **Crawler sidecar UTF-8 process logs** - The sidecar now forces `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, and unbuffered child output before spawning `image_crawler.py`, preventing Chinese task logs and folder paths from turning into mojibake in the app
- **Crawler duplicate-name visibility** - When a crawled file collides with an existing filename, the crawler now logs `[EXISTS] ...` and tags the success record so duplicate-name saves are visible in task logs and reports
- **Crawler download performance and concurrency fixes** - Crawler downloads now use a larger HTTP connection pool, lock-safe RPS throttling, larger stream chunks, and higher concurrency defaults so batch image runs no longer stall or collapse into near-serial throughput
- **Crawler task fails with "Unknown media type(s): m3u, m3u8"** - Removed invalid `m3u,m3u8` from default media types list. Added runtime validation to strip unknown types from cached localStorage values
- **Vite dev server EACCES on Windows** - Port 5173 was reserved by Windows Hyper-V/WinNAT. Changed dev server to bind `127.0.0.1:9981` with `strictPort: false` fallback
- **Crawler artifact data path polling is now stable** - Task polling now computes one final artifact `data` path per refresh cycle instead of briefly bouncing between fallback output paths and preview-derived paths, which stops the artifact path label from flickering
- **Crawler report artifacts now relocate into the media folder `data` directory** - After a run finishes and media lands in a single generated folder, reports, preview links, failed lists, checkpoints, and hashes are moved from `output/data` into that folder's own `data` directory, and sidecar lookup now follows the relocated files
- **Crawler metadata now lives under `output/data`** - Preview links, reports, failed lists, checkpoints, recovery guides, and hash logs now write into a dedicated `data` subfolder, and sidecar preview collection checks both root and `data` paths
- **Crawler scan mode now emits preview link exports** - Normal crawler runs now refresh `image_links.txt/csv` during detection so Load Preview can read current-task media before downloads finish
- **Crawler direct downloads now resolve real output folders first** - Media imported from crawler results now resolve the effective absolute output directory before deriving page-based subfolders, so downloads land in the selected folder tree
- **OS-aware system source label** - System source label now adapts by platform (Homebrew on macOS, PATH on Windows, package manager on Linux)
- **Proxy routing is now mode-aware** - Proxy generation now follows selected API style: chat-completions for OpenAI/NewAPI and responses endpoint for OpenAI Responses, with compatible fallback paths
- **Proxy normalization now preserves API style** - AI config normalization/test flow now persists proxy_api_style together with endpoint/model updates
- **Crawler copy now reflects generic media support** - Settings copy now clarifies crawler sidecar supports Google Photos and generic media pages
- **Sidecar task lifecycle, recovery, and shutdown behavior** - The crawler sidecar now avoids task-lock deadlocks, recovers more cleanly from stale `task_running` states and transient disconnects, pauses unhealthy polling, and shuts down with the main window instead of leaving hidden listeners behind
- **Retry Failed Downloads not working in history-folder mode** - The Retry Failed Downloads button was disabled and non-functional when using folder-source mode because it required a sidecar task ID. Now supports folder mode by reading `failed_downloads.txt` directly from the history folder and re-importing failed URLs into the Universal queue
- **Crawler start now prioritizes URL and queue over stale retry files** - Starting a normal crawler task no longer gets hijacked by a previously loaded `retry_failed_from` path; retry mode only applies when URL and queue inputs are empty
- **Retry-failed crawler downloads now preserve target subfolders** - Failed download records now store page and subfolder context, and retry mode backfills older records from `download_report.csv` or a single detected media folder so retried files return to the original album folder whenever possible
- **Crawler empty-preview state now distinguishes active scans** - Media Browser now shows a pending-preview message for running tasks instead of reporting missing importable links too early
- **Crawler preview loading now yields before heavy parsing** - The Load Preview action now paints its loading state before parsing large task reports, reducing the impression that the button does nothing on large result sets
- **Direct-media hotlink downloads now forward page referer** - Crawler-imported direct media requests now send the source page URL as `Referer`, improving compatibility with media hosts that reject bare file requests
- **Schedule notifications no longer request permission mid-download** - Scheduled start/stop/completion notifications now only fire when OS notification permission was already granted, preventing unexpected system popups after a download finishes
- **Default download fallback path separator** - Fixed home-directory fallback joining on Windows so automatic output paths resolve to a real Downloads folder
- **Missing crawler output subfolders** - Fixed direct-media imports using empty/relative output paths, which could prevent folder creation and leave files outside the intended download directory
- **Universal queue visibility for direct downloads** - Added direct-media and segment badges in queue items so direct-link jobs are distinguishable from yt-dlp jobs
- **Incorrect suffix chaining on responses base URLs** - Fixed malformed endpoint assembly such as /v1/responses/chat/completions that caused 404 errors
- **Proxy endpoint diagnostics** - Error output now includes attempted endpoint URLs, making mismatches easier to compare with external clients (for example, Cherry Studio)
- **Sidecar flag passthrough for crawler advanced args** - Added support for auto-scope, prefer-type, template, regex/size filters, and parsed extra_args forwarding to image_crawler.py
- **Crawler task persistence gap** - task_image_types now persists correctly between sessions

## [0.11.1] - 2026-03-01

- **Backend error localization** - Backend error messages (download failures, network errors, etc.) are now translated to the user's selected language instead of always showing English

- **Refactored transcript fallback chain** - Unified transcript fallback logic across AI summary and processing tasks for more consistent behavior

- **Transcript errors and short captions** - Transcript errors are now preserved for diagnostics instead of being silently swallowed; short captions are accepted as valid transcripts instead of being rejected
- **TikTok default settings** - Aligned TikTok default download settings to match platform conventions

## [0.11.0] - 2026-02-20

- **Extension setup in Settings** - Added a new Settings → Extension section with direct download buttons and easy install steps for Chromium and Firefox

- **UI/UX refresh for YouTube and Universal pages** - Simplified input, preview, queue, and title-bar interactions for a cleaner and more consistent experience

- **Strict system-mode behavior** - When system source is selected and binary is missing, app now fails with a clear error instead of silently falling back

## [0.10.1] - 2026-02-15

- **Line-break workflow** - Added quick auto line-break action and Shift+Enter newline support while editing subtitle text
- **Configurable auto retry** - Added Auto Retry settings for YouTube and Universal downloads with customizable retry attempts and delay to recover from unstable network/live interruptions automatically



## [0.10.0] - 2026-02-15

- **Advanced subtitle tools** - Added waveform/spectrogram timeline, shot-change sync, realtime QC with style profiles, split/merge tools, translator mode (source/target), and batch project tools


## [0.9.4] - 2026-02-14

- **Multi-file attachments in Processing AI chat** - Processing chat now supports image/video/subtitle attachments (picker + drag/drop) with contextual previews and metadata
- **Language request shortcut in Settings** - Added a quick link in Settings → General for users to vote/request next language support on GitHub Discussions
- **System tray app update action** - Added a new tray menu action to check for Youwee updates directly from tray

- **Deterministic subtitle/merge command generation** - Processing command generation now handles subtitle burn-in and multi-video merge (including intro/outro ordering hints) before AI fallback for more reliable results
- **Clearer system tray channel check label** - Renamed "Check All Now" to "Check Followed Channels Now" to better reflect checking followed channels
- **Simplified page headers** - Removed leading title icons from Metadata, Processing, and AI Summary pages for a cleaner look

- **Stable channel update check always shows available** - Fixed yt-dlp stable/nightly update check to read the installed channel binary version (`--version`) instead of file-existence metadata, so "Up to date" is shown correctly after update
- **Bundled update status and binary source mismatch** - Fixed bundled update flow to show latest available version in Settings and prefer the user-updated `app_data/bin/yt-dlp` binary when present, so updating bundled actually takes effect
- **Processing page video info redesign** - Refreshed the section below player with a YouTube-style title + modern metadata chips, and removed hover color shift/shadow on codec badges for cleaner visuals
- **Prompt Templates dropdown close behavior** - Fixed Processing Prompt Templates dropdown to auto-close on outside click and Escape key
- **Duplicate URL count in Universal input** - Fixed the URL count badge showing duplicated number (e.g. `1 1 URL`) in Universal URL input

## [0.9.3] - 2026-02-14


- **Improved time range input UX** - Replaced plain text inputs with auto-formatting time inputs that insert `:` separators as you type (e.g. `1030` → `10:30`, `10530` → `1:05:30`). Smart placeholder shows `M:SS` or `H:MM:SS` based on video duration. Real-time validation with red border for invalid format or when start >= end. Shows total video duration hint when available

## [0.9.2] - 2026-02-13

- **Auto-check FFmpeg updates on startup** - FFmpeg update check now runs automatically when the app starts (for bundled installs). If an update is available, it shows in Settings > Dependencies without needing to manually click the refresh button

## [0.9.1] - 2026-02-13

- **Auto-download ignores user settings** - Channel auto-download now respects per-channel download preferences (Video/Audio mode, quality, format, codec, bitrate) instead of using hardcoded values. Each channel has its own download settings configurable in the channel settings panel
- **Security hardening** - FFmpeg commands now use structured argument arrays instead of shell string parsing, preventing command injection. Added URL scheme validation and `--` separator for all yt-dlp calls to block option injection. Enabled Content Security Policy, removed overly broad shell permissions, and added `isSafeUrl` validation for rendered links
- **Video preview fails for MKV/AVI/FLV/TS containers** - Preview detection now checks both container format and codec. Videos in unsupported containers (MKV, AVI, FLV, WMV, TS, WebM, OGG) are correctly transcoded to H.264 preview. HEVC in MP4/MOV no longer unnecessarily transcoded on macOS
- **Scheduled downloads not visible in tray mode** - Desktop notifications now fire when a scheduled download starts, stops, or completes while the app is minimized to system tray. Tray menu shows active schedule status (e.g. "YouTube: 23:00"). Schedule works on both YouTube and Universal pages
- **Quit from tray kills active downloads** - Tray "Quit" now uses graceful shutdown instead of force-killing the process, allowing active downloads to finish cleanup and preventing corrupted files
- **Dock icon setting lost on restart (macOS)** - The "Hide Dock icon on close" preference is now synced to the native layer on app startup, not only when visiting the Settings page
- **Universal queue shows skeleton instead of URL while loading** - Replaced pulsing skeleton placeholder with the actual URL text and a "Loading info..." spinner badge. When metadata fetch fails, items now exit loading state gracefully instead of showing skeleton forever

## [0.9.0] - 2026-02-12

- **Large file preview confirmation** - Configurable file size threshold (default 300MB) that shows a confirmation dialog before loading large videos in Processing. Threshold adjustable in Settings → General → Processing
- **i18n-aware Settings search** - Settings search now works in all languages. Searching in Vietnamese (e.g. "giao diện") or Chinese returns matching results. English keywords still work as fallback regardless of language


## [0.8.2] - 2026-02-11

- **8K/4K/2K quality options for Universal downloads** - Quality dropdown now includes 8K Ultra HD, 4K Ultra HD and 2K QHD options, matching the YouTube tab. Falls back gracefully if the source doesn't have high-res formats
- **Live from start toggle for Universal downloads** - New toggle in Advanced Settings to record live streams from the beginning instead of the current point. Uses yt-dlp's `--live-from-start` flag
- **Video preview for Universal downloads** - Automatically shows thumbnail, title, duration and channel when adding URLs from TikTok, Bilibili, Facebook, Instagram, Twitter and other sites. Thumbnails are also saved to Library history
- **Smarter platform detection** - Library now correctly identifies and tags all 1800+ sites supported by yt-dlp (Bilibili, Dailymotion, SoundCloud, etc.) instead of showing "Other". Added Bilibili as a dedicated filter tab

- **Broken thumbnails in Library** - Fix thumbnails from sites like Bilibili that use HTTP URLs. Thumbnails now gracefully fall back to a placeholder icon if they fail to load
- **Library not refreshing on page switch** - Library now automatically loads latest downloads when navigating to the page instead of requiring a manual refresh

## [0.8.1] - 2026-02-09

- **Settings not applied when adding to queue** - Fix stale closure issue where changing format (Video → Audio) immediately before adding URL would use old settings. Now uses ref to always capture current settings
- **Library source filter not working** - Fix parameter name mismatch between frontend (`sourceFilter`) and backend (`source`) that caused TikTok, Facebook and other platform filters to show all entries instead of filtered results. Also fix search and count queries to respect active filters

## [0.8.0] - 2026-02-09

- **Image attachment in Processing** - Upload images via attach button or drag & drop, AI generates FFmpeg commands for overlay, watermark, intro/outro, PiP and more
- **Custom Whisper backend** - Configure custom endpoint URL and model for Whisper transcription, compatible with Groq, LocalAI, Faster-Whisper and other OpenAI-compatible APIs
- **SponsorBlock integration** - Auto-skip sponsors, intros, outros and promotions using community data. Three modes: Remove all (cut segments), Mark all (chapter markers), or Custom per-category control
- **Scheduled downloads** - Schedule downloads to start at a specific time with optional stop time. Quick presets (1h, 3h, tonight, tomorrow) or custom time picker. Works on both YouTube and Universal pages

- **Processing input layout** - Move prompt templates button into input card, textarea on top with action buttons below
- **yt-dlp channel selector** - Redesigned from segmented toggle to radio cards with descriptions, active badge, and install status for clearer selection

- **Download speed not showing** - Fixed regex not capturing speed and ETA from yt-dlp progress output
- **Failed to fetch video info for YouTube** - Add Deno JS runtime to video info, transcript, playlist, and subtitle fetching (same as download)
- **Video title shows Unknown in Library** - Extract title from filepath when yt-dlp doesn't output Destination message
- **Slow yt-dlp version loading** - Eliminated redundant version checks on startup (7 sequential calls → 1), channel info now uses lightweight file-exists check instead of running binaries

## [0.7.1] - 2026-02-06

- **Failed download hints** - Shows "View Logs page for details" when download fails
- **Troubleshooting tips in Logs** - Auto-detect common errors and show fix suggestions (FFmpeg missing, auth required, rate limit, etc.)
- **Windows cookie error handling** - Auto-detect browser cookie lock errors, show retry dialog with instructions to close browser
- **Windows cookie warning** - Shows warning in Settings → Network when using browser cookie mode on Windows

- **Windows path handling** - Fixed download folder detection for Windows paths (C:\, D:\)

- **Larger default window** - 1100x800 (was 1000x700)
- **Disable reload in production** - Block right-click menu, F5, Ctrl+R

## [0.7.0] - 2026-02-05

- **Live stream download support** - Toggle in Settings → Download, shows LIVE badge on queue items
- **Download speed limit** - Limit bandwidth with custom value and unit (KB/s, MB/s, GB/s)


- **New Download settings section** - Moved Post-processing, Live Stream, Speed Limit to dedicated section
- **Compact Advanced Settings popover** - Better fit for small screens with scroll support

## [0.6.1] - 2026-02-03

- **Auto-download yt-dlp Stable** - Automatically downloads latest stable yt-dlp on first launch
- **Fallback to bundled** - Uses bundled yt-dlp when Stable/Nightly not available (no internet, download failed)

- **Default channel is now Stable** - App defaults to Stable channel instead of Bundled for latest features and fixes
- **Status indicators** - Shows "Using bundled temporarily..." when falling back, "Downloading yt-dlp..." during auto-download
- **Embed Thumbnail off by default** - Disabled by default since it requires FFmpeg

- **FFmpeg/Deno download with progress** - Shows download percentage and stage (downloading, extracting, verifying) instead of hanging indefinitely
- **Display download error details** - Failed downloads now show error message in the queue item instead of just "Error" status


## [0.6.0] - 2026-02-03

- **Replaced Bun with Deno** - Now uses Deno runtime for YouTube JavaScript extraction (required by yt-dlp)
- **Auto-download Deno on first launch** - App automatically downloads Deno if not installed
- **Setup progress dialog** - Shows "Setting Up YouTube Support" popup when downloading Deno on first launch

- **Use `--js-runtimes` flag** - Switched from `--extractor-args` to `--js-runtimes deno:PATH` for better compatibility
- **yt-dlp update not taking effect** - Fixed issue where updated yt-dlp version was not used after restart (now prioritizes user-updated version over bundled)


## [0.5.4] - 2026-01-28


- Wider Model input and Summary Style dropdown for better readability


## [0.5.3] - 2026-01-28

- **Language switcher** in Settings → General → Appearance
- **Localized README** - Vietnamese and Chinese versions in `/docs`


## [0.5.2] - 2026-01-27

- Restored "Made with ❤️ by Vietnam" branding
- Added License link in About section
- Restored Auto-check for updates toggle in About section


## [0.5.1] - 2026-01-27

- **DeepSeek & Qwen AI providers** - More AI options for video summarization
- **Proxy support** - Configure HTTP/HTTPS/SOCKS proxy for yt-dlp downloads
- **Clear All button** in Processing History - Quickly remove all history entries
- **Settings search** - Find settings quickly with keyboard search

- **Settings page redesigned** - New sidebar navigation with 5 sections (General, Dependencies, AI, Network, About)
- **Universal page** now has Video/Audio toggle like YouTube page for consistency
- **macOS app icon** updated with proper Apple guidelines padding



## [0.5.0] - 2026-01-27

- Post-processing settings - Embed metadata and thumbnails into downloaded files
- Embed Metadata settings - Add title, artist, description to files (enabled by default)
- Embed Thumbnail settings - Add cover art/thumbnail to files (enabled by default, requires FFmpeg)

- Summarize button now hidden when AI features disabled
- Summarize button hidden on failed download items to prevent confusion
- yt-dlp version now correctly shows updated version after update
- FFmpeg update checker - check for new versions from GitHub releases
- Bun runtime update checker - check for new versions from GitHub releases


## [0.4.1] - 2026-01-24

- Browser cookie extraction (Chrome, Firefox, Safari, Edge, Brave, Opera, Vivaldi)
- Browser profile detection with display names
- Cookie file support as alternative authentication method
- macOS Full Disk Access guidance for browser cookie access
- Hindi and Portuguese (Brazil) language options for summaries
- Debug logging for Gemini API requests in dev mode

- Updated OpenAI models to latest: GPT-5.2, GPT-5.1, GPT-5, GPT-4.1 series
- Gemini API now uses x-goog-api-key header instead of query parameter
- Thinking models (Gemini 2.5, 3) no longer use generationConfig restrictions
- yt-dlp now uses nightly builds for latest features and fixes
- Improved logo clarity in sidebar and about section (128px instead of 64px)
- Error messages now show full details with auth guidance when needed

- Gemini thinking models returning empty responses
- Age-restricted video errors now guide users to enable authentication
- Video preview and queue items now show actual error messages

## [0.4.0] - 2026-01-24

- Proxy AI provider for OpenAI-compatible APIs with custom domain (Azure, LiteLLM, OpenRouter)
- Dedicated AI Summary page for quick video summarization without downloading
- Configurable transcript languages with priority order
- Video transcript extraction from YouTube subtitles (including auto-generated)
- Concise summary style option (between Short and Detailed)
- Summarize button in queue items to generate summary without downloading
- YouTube Troubleshooting option for actual player.js version (fixes download issues)
- Re-download with progress tracking in Library
- Copy summary button in Library items

- Redesigned download settings with clear Video/Audio toggle for better UX
- Merged App Updates section into About section in Settings for cleaner UI
- macOS app icon now follows Apple guidelines with rounded corners and proper sizing (84.4%)
- Improved About section with modern card layout and quick links
- Re-download now updates existing history entry instead of creating new one

- Re-download for summary-only entries now uses best quality and user's output path
- FFmpeg check now defaults to false, properly requiring FFmpeg for best/2K+ quality
- Improved Gemini API error handling with detailed error messages
- Fixed transcript extraction to support YouTube auto-generated subtitles
- Added video description as fallback when no subtitles available
- Prevent transcript cross-contamination between videos
- Show full yt-dlp command in logs instead of just args

## [0.3.2] - 2026-01-22

- SHA256 checksum verification for FFmpeg downloads on all platforms
- Linux ARM64 support for FFmpeg downloads

- FFmpeg source for Windows/Linux changed to BtbN/FFmpeg-Builds (more reliable, with checksums)
- FFmpeg source for macOS now uses vanloctech/ffmpeg-macos repository


## [0.3.1] - 2025-01-21



## [0.3.0] - 2025-01-20

- Logs page for tracking download activities
- Universal Download page for non-YouTube sources (1000+ sites)
- Gradient progress bar with shimmer effect
- Quality/format badges in download queue
- Per-item download settings in queue

- Simplified audio quality options to match YouTube's available bitrates
- Reduced max log entries from 1000 to 500 for performance

- Show actual file size after MP3 conversion
- Use proper FFmpeg postprocessor args for audio bitrate
- Sum video+audio stream sizes for accurate total filesize

## [0.2.1] - 2025-01-15


## [0.2.0] - 2025-01-10

- Multiple quality options (8K, 4K, 2K, 1080p, 720p, 480p)
- Multiple format support (MP4, MKV, WebM, MP3, M4A, Opus)
- Subtitle download with language selection
- Concurrent downloads (up to 5 parallel)
- Auto-update with secure signature verification

- Improved UI with 6 color themes
- Better error handling and user feedback

## [0.1.0] - 2025-01-01

- YouTube video download
- Basic quality selection
- Dark/Light mode
- Bundled yt-dlp
























