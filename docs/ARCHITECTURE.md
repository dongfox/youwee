# Youwee Architecture and Build Guide

This document provides a quick overview of Youwee's build workflow, module boundaries, and maintenance entry points.

## 1. Project Scope

Youwee is a Tauri-based desktop app for media downloading and processing.
Core goals:
- Unified download flow (YouTube + Universal)
- AI summary and processing capabilities
- Browser extension bridge and external crawler sidecar integration

## 2. Tech Stack

- Desktop container: Tauri 2 (Rust)
- Frontend: React 19 + TypeScript + Tailwind CSS
- Build toolchain: Bun + Vite
- Download engine: yt-dlp + FFmpeg (app-managed and system-managed source modes)
- Storage: SQLite (`logs.db`)

## 3. Core Directory Layout

- `src/`: frontend pages, components, contexts, types, and invoke wrappers
- `src-tauri/`: Rust commands, services, database layer, system integration
- `extensions/youwee-webext/`: browser extension source (Chromium/Firefox)
- `scripts/`: utility scripts and sidecar-related scripts
- `docs/`: multilingual docs, extension docs, error codes, changelogs

## 4. Development and Build Flow

### 4.1 Requirements

- Bun (match README-recommended version)
- Rust (with Cargo)
- Tauri prerequisites

### 4.2 Local Development

Run from repository root:

```bash
bun install
bun run tauri dev
```

### 4.3 Production Build

```bash
bun run tauri build
```

### 4.4 Browser Extension Packaging

```bash
bun run ext:build
bun run ext:package
```

Outputs:
- `extensions/youwee-webext/dist/chromium`
- `extensions/youwee-webext/dist/firefox`
- `extensions/youwee-webext/dist/packages`

## 5. Quality Gates and Commit Requirements

The project requires these checks before commit:

1. `bun run biome check --write .`
2. `bun run tsc -b`
3. `cargo check` (inside `src-tauri/`)

Note: pre-commit hook also enforces the same checks.

## 6. Frontend-Backend Call Chain

```text
React pages/components
  -> Context / lib wrappers
  -> Tauri invoke(command)
  -> Rust commands
  -> Rust services
  -> (yt-dlp / FFmpeg / SQLite / sidecar / network APIs)
```

Responsibility split:
- Frontend: state, orchestration, UI/UX
- Rust backend: system calls, process execution, DB, error normalization

## 7. Core Subsystems

### 7.1 Download and Media Pipeline

- yt-dlp for extraction/download
- FFmpeg for transcode/remux/post-processing
- Binary source switching: app-managed vs system-managed

### 7.2 Data and History

- Download/media history stored in SQLite
- Main entry point example: `src-tauri/src/database/history.rs`

### 7.3 AI Capabilities

- Supports Gemini / OpenAI / Ollama / proxy-style providers
- Unified backend error contract for localized frontend display
- See `docs/backend-error-codes.md`

### 7.4 Internationalization (i18n)

- Locales: `en`, `vi`, `zh-CN`
- Namespaces: `common`, `settings`, `pages`, `channels`, `download`, `universal`
- New UI text must be added to all three locales

### 7.5 Browser Extension Bridge

- Extension sends links via `youwee://` deep-link
- Desktop app routes URL to YouTube/Universal queue accordingly
- See `docs/browser-extension*.md`

### 7.6 Crawler Sidecar (Phase 1)

- Tauri commands control external Python sidecar
- Supports start/health/task state/log polling
- Task outputs can be imported to Universal with `image/gif/video/audio` filters
- See `docs/crawler-sidecar.zh-CN.md`

### 7.7 Crawler Download Performance

- **Connection pool**: `HTTPAdapter` with `pool_maxsize = workers + 4` prevents thread starvation
- **RPS throttle**: `acquire_request_slot()` calculates sleep inside lock, sleeps outside — threads download in parallel
- **Chunk size**: 64 KB for `iter_content()` to minimize syscall overhead
- **Template auto-fill**: Selecting a template in the UI auto-fills related fields (workers, timeout, delay, etc.) to mirror Python `apply_template_defaults()` logic
- **Media type validation**: Frontend strips unknown types (e.g. `m3u`, `m3u8`) from the `--image-types` argument at init time
- **Dev server**: Vite bound to `127.0.0.1:9981` (`strictPort: false`) to avoid Windows Hyper-V reserved port ranges

## 8. Versioning and Changelog Rules

Version must be updated in:
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Changelogs must be updated in:
- `CHANGELOG.md`
- `docs/CHANGELOG.vi.md`
- `docs/CHANGELOG.zh-CN.md`

Format follows Keep a Changelog.

## 9. Common Troubleshooting Hints

- `package.json` not found: run command from repo root
- `bun` not found: install Bun before running scripts
- Tauri package mismatch: align `@tauri-apps/*` with Rust crate major/minor
- Backend command errors: inspect standardized error code + source in UI logs

## 10. Recommended Reading Order

1. `README.md` (or `docs/README.zh-CN.md`)
2. `AGENTS.md`
3. `docs/backend-error-codes.md`
4. `docs/browser-extension.md`
5. `docs/crawler-sidecar.zh-CN.md`
6. key modules in `src/` and `src-tauri/`
