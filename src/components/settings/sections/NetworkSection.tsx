import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  CircleOff,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HlsVideoPlayer, isHlsUrl } from '@/components/HlsVideoPlayer';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useDownload } from '@/contexts/DownloadContext';
import { useUniversal } from '@/contexts/UniversalContext';
import { extractBackendError, localizeUnknownError } from '@/lib/backend-error';
import {
  crawlerSidecarAttach,
  crawlerSidecarCollectTaskLinks,
  crawlerSidecarGetTask,
  crawlerSidecarGetTaskLogs,
  crawlerSidecarHealth,
  crawlerSidecarListTasks,
  crawlerSidecarStartService,
  crawlerSidecarStartTask,
  crawlerSidecarStatus,
  crawlerSidecarStopService,
  crawlerSidecarStopTask,
  type SidecarStatus,
} from '@/lib/crawler-sidecar';
import type { BrowserProfile, BrowserType, CookieMode, ProxyMode } from '@/lib/types';
import { BROWSER_OPTIONS } from '@/lib/types';
import { SettingsCard, SettingsSection } from '../SettingsSection';

interface NetworkSectionProps {
  highlightId?: string | null;
}

const SIDECAR_STORAGE_PREFIX = 'youwee_crawler_sidecar_';
const SIDECAR_DEFAULT_BASE_URL = 'http://127.0.0.1:17870';
const SIDECAR_DEFAULT_HOST = '127.0.0.1';
const SIDECAR_DEFAULT_PORT = '17870';
const SIDECAR_DEFAULT_SCRIPT_PATH = 'scripts/crawler_sidecar_service.py';
const SIDECAR_DEFAULT_PYTHON_BIN = 'python';
const SIDECAR_DEFAULT_TASK_SCOPE = 'page';
const SIDECAR_DEFAULT_TASK_WORKERS = '6';
const SIDECAR_DEFAULT_TASK_TIMEOUT = '20';
const SIDECAR_DEFAULT_TASK_RETRIES = '2';
const SIDECAR_DEFAULT_TASK_DELAY = '0.4';
const SIDECAR_DEFAULT_TASK_LOG_EVERY = '50';
const SIDECAR_DEFAULT_TASK_NEXT_SELECTORS = 'Next,下一,次';
const SIDECAR_DEFAULT_TASK_IMAGE_TYPES =
  'jpg,jpeg,png,gif,webp,bmp,svg,avif,mp4,webm,mov,m4v,mp3,m4a,aac,ogg,opus,wav,flac,weba';
const SIDECAR_DEFAULT_TASK_MAX_PAGES = '200';
const SIDECAR_DEFAULT_TASK_PREFER_TYPE = 'none';
const SIDECAR_DEFAULT_TASK_TEMPLATE = 'none';
const SIDECAR_DEFAULT_TASK_EXTRA_ARGS = '';
const SIDECAR_DEFAULT_TASK_HOST_PARALLEL_LIMIT = '';
const SIDECAR_DEFAULT_TASK_RANGE_WORKER_LIMIT = '';
const SIDECAR_DEFAULT_TASK_RANGE_CHUNK_SIZE_MB = '';
const SIDECAR_LOG_LIMIT = 300;
const SIDECAR_TASK_POLL_MS = 1500;
const TASK_MEDIA_BROWSER_PAGE_SIZE = 60;

type SidecarHealthState = 'unknown' | 'ok' | 'fail';
type SidecarTaskState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'success'
  | 'failed'
  | 'error'
  | 'unknown';
type ImportMediaKind = 'image' | 'gif' | 'video' | 'audio';
type TaskMediaBrowserFilter = 'all' | ImportMediaKind;
type TaskMediaBrowserMetaFilter =
  | 'all'
  | 'with-title'
  | 'with-page'
  | 'with-file'
  | 'with-path'
  | 'downloaded';

type TaskPreviewLinkState = 'unknown' | 'ready' | 'pending' | 'missing';
type TaskMediaBrowserSourceMode = 'task' | 'folder';
type BuildCrawlerTaskPayloadOptions = {
  url?: string;
  urlQueueFile?: string;
  retryFailedFrom?: string;
  scope?: 'page' | 'site';
  cookiesFile?: string;
  loginVerifyBeforeCrawl?: boolean;
  loginVerifyUrl?: string;
  loginFailAction?: 'continue' | 'stop';
  loginCapture?: boolean;
};

type TaskDownloadMode = 'segmented' | 'single';

interface TaskMediaBrowserItem {
  url: string;
  dedupeKey?: string;
  kind: ImportMediaKind;
  pageUrl?: string;
  pageTitle?: string;
  fileName?: string;
  savedAbsolutePath?: string;
  outputSubdir?: string;
  status?: string;
  sourceFile?: string;
}

interface ImportMediaCounts {
  image: number;
  gif: number;
  video: number;
  audio: number;
}

const EMPTY_IMPORT_COUNTS: ImportMediaCounts = {
  image: 0,
  gif: 0,
  video: 0,
  audio: 0,
};

interface SidecarTaskSnapshot {
  task_id: string;
  status: SidecarTaskState;
  created_at: string;
  started_at: string;
  finished_at: string;
  exit_code: number | null;
  pid: number | null;
  log_total: number;
}

function readStoredValue(key: string, fallback: string): string {
  try {
    const raw = localStorage.getItem(`${SIDECAR_STORAGE_PREFIX}${key}`);
    return raw?.trim() ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredValue(key: string, value: string): void {
  try {
    localStorage.setItem(`${SIDECAR_STORAGE_PREFIX}${key}`, value);
  } catch {
    // Ignore storage write errors.
  }
}

function formatUnknownError(error: unknown): string {
  return localizeUnknownError(error);
}

function extractRunningTaskIdFromError(error: unknown): string | null {
  const payload = extractBackendError(error);
  const message = String(payload.message || '');
  if (!message) return null;

  const direct = /running_task_id"?\s*[:=]\s*"([A-Za-z0-9_-]+)"/.exec(message);
  if (direct?.[1]) return direct[1].trim();

  const jsonStart = message.indexOf('{');
  if (jsonStart >= 0) {
    const jsonPart = message.slice(jsonStart);
    try {
      const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
      const taskId = parsed.running_task_id;
      if (typeof taskId === 'string' && taskId.trim()) {
        return taskId.trim();
      }
    } catch {
      // ignore parse failure
    }
  }

  return null;
}

function isSidecarTransportError(error: unknown): boolean {
  const payload = extractBackendError(error);
  const message = String(payload.message || '').toLowerCase();
  if (!message.includes('sidecar request failed')) return false;

  return (
    message.includes('error sending request') ||
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('tcp connect error') ||
    message.includes('timed out') ||
    message.includes('timeout')
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readStringField(obj: Record<string, unknown>, key: string, fallback = ''): string {
  const value = obj[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumberField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArrayField(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readTaskStatus(value: unknown): SidecarTaskState {
  if (typeof value !== 'string') return 'unknown';
  switch (value) {
    case 'queued':
    case 'starting':
    case 'running':
    case 'stopping':
    case 'stopped':
    case 'success':
    case 'failed':
    case 'error':
      return value;
    default:
      return 'unknown';
  }
}

function isTaskActiveStatus(status: SidecarTaskState | null | undefined): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping';
}

function isTaskTerminalStatus(status: SidecarTaskState | null | undefined): boolean {
  return status === 'success' || status === 'failed' || status === 'error' || status === 'stopped';
}

function parseTaskCompletionSummary(lines: string[]): {
  downloaded: number | null;
  failed: number | null;
  filtered: number | null;
  existing: number | null;
  noNew: boolean;
} {
  let existing: number | null = null;
  let noNew = false;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() || '';
    let match = /Done\. success=(\d+), filtered=(\d+), failed=(\d+)/.exec(line);
    if (match) {
      return {
        downloaded: Number.parseInt(match[1], 10),
        filtered: Number.parseInt(match[2], 10),
        failed: Number.parseInt(match[3], 10),
        existing,
        noNew,
      };
    }
    match = /\[QUEUE\]\[SUMMARY\].*success=(\d+)\s+filtered=(\d+)\s+failed=(\d+)/.exec(line);
    if (match) {
      return {
        downloaded: Number.parseInt(match[1], 10),
        filtered: Number.parseInt(match[2], 10),
        failed: Number.parseInt(match[3], 10),
        existing,
        noNew,
      };
    }
    match = /\[EXISTS\]\s+skip=(\d+)\s+already downloaded URLs/i.exec(line);
    if (match && existing === null) {
      existing = Number.parseInt(match[1], 10);
      continue;
    }
    if (line.includes('Nothing new to download.')) {
      noNew = true;
    }
  }
  if (noNew) {
    return {
      downloaded: 0,
      failed: 0,
      filtered: 0,
      existing,
      noNew,
    };
  }
  return { downloaded: null, failed: null, filtered: null, existing, noNew };
}

function parseTaskSourceMissingSummary(lines: string[]): {
  sourceMissing: number | null;
  telegraphSourceMissing: boolean;
} {
  let sourceMissing: number | null = null;
  let telegraphSourceMissing = false;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() || '';
    const match = /\[WARN\]\s+source_missing=(\d+)\s+http_404=(\d+)/i.exec(line);
    if (match && sourceMissing === null) {
      sourceMissing = Number.parseInt(match[1], 10);
      telegraphSourceMissing = true;
      continue;
    }
    if (line.includes('Telegraph page is reachable, but source images returned 404.')) {
      telegraphSourceMissing = true;
    }
  }

  return { sourceMissing, telegraphSourceMissing };
}

function isCorruptedTaskPath(pathLike: string): boolean {
  const value = pathLike.trim();
  if (!value) return true;
  return value.includes('�') || /[ÃÂÐÑÕÖ×ØÙÚÛÜÝÞß]{2,}/.test(value);
}

function parseTaskTelegramFallbackLinks(lines: string[]): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine?.trim() || '';
    const match = /\[INFO\]\s+Telegram fallback link:\s+(.+)$/i.exec(line);
    const url = match?.[1]?.trim() || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }

  return links;
}

function parseTaskRangeSummary(lines: string[]): {
  ranged: number;
  fallback: number;
  retries: number;
} {
  let ranged = 0;
  let fallback = 0;
  let retries = 0;
  for (const rawLine of lines) {
    const line = rawLine?.trim() || '';
    if (/\[DL\]\s+range\s+host=/i.test(line)) ranged += 1;
    if (/\[DL\]\s+range\s+fallback\s+host=/i.test(line)) fallback += 1;
    if (/\[DL\]\s+range\s+retry\s+bytes=/i.test(line)) retries += 1;
  }
  return { ranged, fallback, retries };
}

function parseTaskRustTransferSummary(lines: string[]): {
  transfers: number;
  fallback: number;
  latestMode: string | null;
  latestSpeedBps: number | null;
  latestActive: number | null;
  latestPending: number | null;
  latestEwmaBps: number | null;
  policyHost: string | null;
  policySegmentCap: number | null;
  policyChunkCap: number | null;
  waitCount: number;
  retryCount: number;
  tuneCount: number;
  rebalanceCount: number;
  throttleCount: number;
  slowWindowCount: number;
  restoreCount: number;
} {
  let transfers = 0;
  let fallback = 0;
  let latestMode: string | null = null;
  let latestSpeedBps: number | null = null;
  let latestActive: number | null = null;
  let latestPending: number | null = null;
  let latestEwmaBps: number | null = null;
  let policyHost: string | null = null;
  let policySegmentCap: number | null = null;
  let policyChunkCap: number | null = null;
  let waitCount = 0;
  let retryCount = 0;
  let tuneCount = 0;
  let rebalanceCount = 0;
  let throttleCount = 0;
  let slowWindowCount = 0;
  let restoreCount = 0;
  for (const rawLine of lines) {
    const line = rawLine?.trim() || '';
    let match = /\[DL\]\s+rust\s+host=.*\bmode=(segmented|single)\b/i.exec(line);
    if (match) {
      transfers += 1;
      latestMode = match[1].toLowerCase();
      continue;
    }
    if (/\[DL\]\s+rust\s+fallback\s+host=/i.test(line)) {
      fallback += 1;
      continue;
    }
    match =
      /\[RUST-DL\]\s+progress\s+mode=(segmented|single)\s+downloaded=(\d+)\s+total=(\d+)\s+speed_bps=(\d+)/i.exec(
        line,
      );
    if (match) {
      latestMode = match[1].toLowerCase();
      latestSpeedBps = Number.parseInt(match[4], 10);
      continue;
    }
    match =
      /\[RUST-DL\]\s+range\s+wait\s+host=([^\s]+)\s+active=(\d+)\s+pending=(\d+)\s+ewma_bps=([0-9.]+)/i.exec(
        line,
      );
    if (match) {
      waitCount += 1;
      policyHost = match[1];
      latestActive = Number.parseInt(match[2], 10);
      latestPending = Number.parseInt(match[3], 10);
      latestEwmaBps = Number.parseFloat(match[4]);
      continue;
    }
    if (/\[RUST-DL\]\s+range\s+retry\s+bytes=/i.test(line)) {
      retryCount += 1;
      continue;
    }
    if (/\[RUST-DL\]\s+range\s+tune\s+host=/i.test(line)) {
      tuneCount += 1;
      continue;
    }
    if (/\[RUST-DL\]\s+range\s+rebalance\s+host=/i.test(line)) {
      rebalanceCount += 1;
      continue;
    }
    if (/\[RUST-DL\]\s+host\s+throttle\s+host=/i.test(line)) {
      throttleCount += 1;
      continue;
    }
    if (/\[RUST-DL\]\s+slow-window\s+host=/i.test(line)) {
      slowWindowCount += 1;
      continue;
    }
    if (/\[RUST-DL\]\s+host\s+restore\s+host=/i.test(line)) {
      restoreCount += 1;
      continue;
    }
    match =
      /\[RUST-DL\]\s+host\s+policy\s+host=([^\s]+)\s+segment_cap=(\d+)\s+chunk_cap=(\d+)\s+worker_count=(\d+)/i.exec(
        line,
      );
    if (match) {
      policyHost = match[1];
      policySegmentCap = Number.parseInt(match[2], 10);
      policyChunkCap = Number.parseInt(match[3], 10);
    }
  }
  return {
    transfers,
    fallback,
    latestMode,
    latestSpeedBps,
    latestActive,
    latestPending,
    latestEwmaBps,
    policyHost,
    policySegmentCap,
    policyChunkCap,
    waitCount,
    retryCount,
    tuneCount,
    rebalanceCount,
    throttleCount,
    slowWindowCount,
    restoreCount,
  };
}

function formatBytes(value: number | null): string {
  if (!value || value <= 0 || !Number.isFinite(value)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatBytesPerSecond(value: number | null): string {
  if (!value || value <= 0 || !Number.isFinite(value)) return '-';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function inferCrawlerTransferPreset(url: string): {
  hostParallelLimit: number;
  rangeWorkerLimit: number;
  rangeChunkSizeMb: number;
  label: 'imgbb' | 'google' | null;
} | null {
  const value = url.trim().toLowerCase();
  if (!value) return null;
  if (value.includes('ibb.co') || value.includes('imgbb.com') || value.includes('i.ibb.co')) {
    return { hostParallelLimit: 4, rangeWorkerLimit: 3, rangeChunkSizeMb: 2, label: 'imgbb' };
  }
  if (
    value.includes('photos.google.com') ||
    value.includes('googleusercontent.com') ||
    value.includes('googlevideo.com')
  ) {
    return { hostParallelLimit: 6, rangeWorkerLimit: 4, rangeChunkSizeMb: 4, label: 'google' };
  }
  return null;
}

function parseTaskResolvedOutputDir(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() || '';
    let match = /\[INFO\]\s+Media output directory:\s+(.+)$/i.exec(line);
    if (match?.[1]) {
      const resolved = resolveArtifactOwnerDir(match[1].trim());
      if (!isCorruptedTaskPath(resolved)) return resolved;
    }
    match = /\[INFO\]\s+Existing media directory:\s+(.+)$/i.exec(line);
    if (match?.[1]) {
      const resolved = resolveArtifactOwnerDir(match[1].trim());
      if (!isCorruptedTaskPath(resolved)) return resolved;
    }
    match = /\[INFO\]\s+Artifact data moved to:\s+(.+)$/i.exec(line);
    if (match?.[1]) {
      const resolved = resolveArtifactOwnerDir(match[1].trim());
      if (!isCorruptedTaskPath(resolved)) return resolved;
    }
  }
  return '';
}
function inferCrawlerAutoGroupBy(url: string): 'album' | 'title' | null {
  const lower = url.trim().toLowerCase();
  if (!lower) return null;
  if (
    lower.includes('/album/') ||
    lower.includes('/albums/') ||
    lower.includes('photos.google.com/share/')
  ) {
    return 'album';
  }
  if (
    lower.includes('/gallery') ||
    lower.includes('/list') ||
    lower.includes('/collections') ||
    lower.includes('/category/')
  ) {
    return 'title';
  }
  return null;
}

function inferImportMediaKind(url: string): ImportMediaKind {
  const lower = url.toLowerCase();

  const isVideo =
    lower.includes('video-downloads.googleusercontent.com') ||
    lower.includes('/videoplayback') ||
    /\.(mp4|m4v|webm|mov|mkv|avi|3gp|ts|m3u8?|flv)(?:$|[?#&])/i.test(lower) ||
    /(?:^|[?&])(?:mime|content_type|type)=video(?:%2f|\/)/i.test(lower);
  if (isVideo) return 'video';

  const isAudio =
    lower.includes('audio-downloads.googleusercontent.com') ||
    /\.(mp3|m4a|aac|wav|flac|ogg|opus)(?:$|[?#&])/i.test(lower) ||
    /(?:^|[?&])(?:mime|content_type|type)=audio(?:%2f|\/)/i.test(lower);
  if (isAudio) return 'audio';

  const isGif =
    /\.gif(?:$|[?#&])/i.test(lower) || /(?:^|[?&])(?:fm|format)=gif(?:$|[&#])/i.test(lower);
  if (isGif) return 'gif';

  return 'image';
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

function joinPathParts(base: string, name: string): string {
  if (!base.trim()) return name;
  const separator = /^[A-Za-z]:[\\/]/.test(base) || base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function dirnamePath(filePath: string): string {
  const normalized = filePath.trim().replace(/[\\/]+$/, '');
  if (!normalized) return '';
  const boundary = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return boundary >= 0 ? normalized.slice(0, boundary) : '';
}

function sanitizeFolderName(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/g, '');
  return normalized || fallback;
}

function formatLocalDateTime(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function classifyHistoryFileGroup(filePath: string): 'CSV' | 'TXT' | 'HTML' | 'Other' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.csv')) return 'CSV';
  if (lower.endsWith('.txt')) return 'TXT';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'HTML';
  return 'Other';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toCsvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function getTaskMediaItemKey(item: TaskMediaBrowserItem, index: number): string {
  return item.dedupeKey || `${item.url}::${item.fileName || ''}::${index}`;
}

function buildTaskMediaDedupeKey(fields: {
  url?: string;
  pageUrl?: string;
  pageTitle?: string;
  fileName?: string;
}): string {
  const fileName = fields.fileName?.trim().toLowerCase() || '';
  const pageUrl = fields.pageUrl?.trim() || '';
  const pageTitle = fields.pageTitle?.trim().toLowerCase() || '';
  if (fileName && pageUrl) {
    try {
      const parsedPage = new URL(pageUrl);
      parsedPage.hash = '';
      return `page-file:${parsedPage.origin.toLowerCase()}${parsedPage.pathname.toLowerCase()}|${fileName}|${pageTitle}`;
    } catch {
      return `page-file:${pageUrl.toLowerCase()}|${fileName}|${pageTitle}`;
    }
  }

  const rawUrl = fields.url?.trim() || '';
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/g, '') || '/';
    const basename = pathname.split('/').filter(Boolean).pop() || '';
    if (basename && pageTitle) {
      return `media:${parsed.hostname.toLowerCase()}|${basename.toLowerCase()}|${pageTitle}`;
    }
    return `url:${parsed.origin.toLowerCase()}${pathname.toLowerCase()}?${parsed.searchParams.toString().toLowerCase()}`;
  } catch {
    return `raw:${rawUrl.replace(/#.*$/, '').toLowerCase()}`;
  }
}
function resolveTaskMediaItemDir(item: TaskMediaBrowserItem | null | undefined): string {
  if (!item) return '';
  const byAbsolutePath = resolveArtifactOwnerDir(item.savedAbsolutePath || '');
  if (byAbsolutePath) return byAbsolutePath;
  if (item.fileName && item.sourceFile) {
    const sourceOwner = resolveArtifactOwnerDir(item.sourceFile);
    if (sourceOwner) {
      const baseName = reportFileName(item.fileName);
      if (baseName) {
        return sourceOwner;
      }
    }
  }
  return '';
}

function reportFileName(fileName: string): string {
  const normalized = fileName.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  return normalized.split('/').filter(Boolean).pop() || '';
}

function resolveArtifactOwnerDir(pathLike: string): string {
  const raw = pathLike.trim();
  if (!raw) return '';

  const normalized = raw.replace(/[\\/]+$/g, '');
  const lastSegment = normalized.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || '';
  if (!lastSegment) return normalized;

  if (lastSegment === 'data' || lastSegment === '.tmp_download' || lastSegment === 'checkpoints') {
    return dirnamePath(normalized);
  }

  if (/\.[a-z0-9]{1,8}$/i.test(lastSegment)) {
    const parent = dirnamePath(normalized);
    if (!parent) return normalized;
    const parentLast = parent.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || '';
    if (parentLast === 'data' || parentLast === '.tmp_download' || parentLast === 'checkpoints') {
      return dirnamePath(parent);
    }
    return parent;
  }

  return normalized;
}

function parseCrawlerMediaCsv(text: string, sourceFile: string): TaskMediaBrowserItem[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length <= 1) return [];

  const headers = parseCsvRow(lines[0]).map((header) => header.trim().toLowerCase());
  const findIndex = (...candidates: string[]) => {
    for (const candidate of candidates) {
      const index = headers.indexOf(candidate);
      if (index >= 0) return index;
    }
    return -1;
  };

  const mediaUrlIndex = findIndex('image_url', 'direct_url', 'media_url', 'download_url', 'url');
  if (mediaUrlIndex < 0) return [];

  const pageUrlIndex = findIndex('page_url', 'source_url', 'webpage_url');
  const pageTitleIndex = findIndex('page_title', 'title');
  const fileNameIndex = findIndex('file_name', 'filename');
  const savedAbsolutePathIndex = findIndex('saved_absolute_path', 'saved_path', 'absolute_path');
  const outputSubdirIndex = findIndex('output_subdir', 'subdir');
  const statusIndex = findIndex('status');

  const items: TaskMediaBrowserItem[] = [];
  const dedup = new Set<string>();

  for (const line of lines.slice(1)) {
    const cells = parseCsvRow(line);
    const mediaUrl = cells[mediaUrlIndex]?.trim() || '';
    const fileName = fileNameIndex >= 0 ? cells[fileNameIndex]?.trim() || '' : '';
    const savedAbsolutePath =
      savedAbsolutePathIndex >= 0 ? cells[savedAbsolutePathIndex]?.trim() || '' : '';
    const outputSubdir = outputSubdirIndex >= 0 ? cells[outputSubdirIndex]?.trim() || '' : '';
    const pageUrl = pageUrlIndex >= 0 ? cells[pageUrlIndex]?.trim() || '' : '';
    const pageTitle = pageTitleIndex >= 0 ? cells[pageTitleIndex]?.trim() || '' : '';
    const dedupeKey = buildTaskMediaDedupeKey({
      url: mediaUrl,
      pageUrl,
      pageTitle,
      fileName,
    });
    if (!mediaUrl || !isHttpUrl(mediaUrl) || !dedupeKey || dedup.has(dedupeKey)) continue;
    dedup.add(dedupeKey);

    items.push({
      url: mediaUrl,
      dedupeKey,
      kind: inferImportMediaKind(fileName || mediaUrl),
      pageUrl,
      pageTitle,
      fileName,
      savedAbsolutePath,
      outputSubdir,
      status: statusIndex >= 0 ? cells[statusIndex]?.trim() || '' : '',
      sourceFile,
    });
  }

  return items;
}

function buildFallbackTaskMediaItems(urls: string[], sourceFile = ''): TaskMediaBrowserItem[] {
  const dedup = new Set<string>();
  const items: TaskMediaBrowserItem[] = [];

  for (const rawUrl of urls) {
    const normalized = rawUrl.trim();
    const dedupeKey = buildTaskMediaDedupeKey({ url: normalized });
    if (!normalized || !dedupeKey || dedup.has(dedupeKey)) continue;
    dedup.add(dedupeKey);
    items.push({
      url: normalized,
      dedupeKey,
      kind: inferImportMediaKind(normalized),
      sourceFile,
    });
  }

  return items;
}

function parseTaskMediaBrowserItemsFromPayload(raw: unknown): TaskMediaBrowserItem[] {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set<string>();
  const items: TaskMediaBrowserItem[] = [];
  for (const entry of raw) {
    const obj = asRecord(entry);
    if (!obj) continue;
    const url = readStringField(obj, 'url').trim();
    const kindRaw = readStringField(obj, 'kind').trim().toLowerCase();
    const fileName = readStringField(obj, 'fileName').trim();
    const savedAbsolutePath = readStringField(obj, 'savedAbsolutePath').trim();
    const outputSubdir = readStringField(obj, 'outputSubdir').trim();
    const pageUrl = readStringField(obj, 'pageUrl').trim();
    const pageTitle = readStringField(obj, 'pageTitle').trim();
    const dedupeKey = buildTaskMediaDedupeKey({
      url,
      pageUrl,
      pageTitle,
      fileName,
    });
    if (!url || !isHttpUrl(url) || !dedupeKey || dedup.has(dedupeKey)) continue;
    dedup.add(dedupeKey);
    items.push({
      url,
      dedupeKey,
      kind:
        kindRaw === 'video' || kindRaw === 'audio' || kindRaw === 'gif' || kindRaw === 'image'
          ? kindRaw
          : inferImportMediaKind(fileName || url),
      pageUrl,
      pageTitle,
      fileName,
      savedAbsolutePath,
      outputSubdir,
      status: readStringField(obj, 'status').trim(),
      sourceFile: readStringField(obj, 'sourceFile').trim(),
    });
  }
  return items;
}

function mergeCrawlerMediaItems(
  parsedItems: TaskMediaBrowserItem[],
  urls: string[],
  sourceFile = '',
): TaskMediaBrowserItem[] {
  if (parsedItems.length === 0) return buildFallbackTaskMediaItems(urls, sourceFile);

  const merged = [...parsedItems];
  const dedup = new Set(
    parsedItems
      .map(
        (item) =>
          item.dedupeKey ||
          buildTaskMediaDedupeKey({
            url: item.url,
            pageUrl: item.pageUrl,
            pageTitle: item.pageTitle,
            fileName: item.fileName,
          }),
      )
      .filter(Boolean),
  );
  for (const rawUrl of urls) {
    const normalized = rawUrl.trim();
    const dedupeKey = buildTaskMediaDedupeKey({ url: normalized });
    if (!normalized || !dedupeKey || dedup.has(dedupeKey)) continue;
    dedup.add(dedupeKey);
    merged.push({
      url: normalized,
      dedupeKey,
      kind: inferImportMediaKind(normalized),
      sourceFile,
    });
  }
  return merged;
}

function deriveCrawlerFolderName(item: TaskMediaBrowserItem, taskId: string): string {
  const pageUrl = item.pageUrl?.trim() || '';
  const pageTitle = item.pageTitle?.trim() || '';
  const fileNameStem = (item.fileName || '').replace(/\.[^.]+$/, '').trim();

  let fallback = `task-${taskId}`;
  if (pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      const lastSegment = parsed.pathname
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean)
        .pop();
      if (lastSegment) {
        fallback = lastSegment;
      } else if (parsed.hostname) {
        fallback = parsed.hostname;
      }
    } catch {
      fallback = `task-${taskId}`;
    }
  }

  return sanitizeFolderName(pageTitle || fileNameStem || fallback, fallback);
}

function buildTaskMediaLinksCsv(items: TaskMediaBrowserItem[]): string {
  const rows = [
    ['kind', 'page_title', 'page_url', 'download_url', 'file_name', 'status'],
    ...items.map((item) => [
      item.kind,
      item.pageTitle || '',
      item.pageUrl || '',
      item.url,
      item.fileName || '',
      item.status || '',
    ]),
  ];
  return rows.map((row) => row.map((cell) => toCsvCell(String(cell || ''))).join(',')).join('\n');
}

function buildTaskMediaBrowserHtml(items: TaskMediaBrowserItem[], title: string): string {
  const cards = items
    .map((item) => {
      const preview =
        item.kind === 'video'
          ? `<video src="${escapeHtml(item.url)}" controls preload="metadata"></video>`
          : item.kind === 'audio'
            ? `<audio src="${escapeHtml(item.url)}" controls preload="metadata"></audio>`
            : `<img src="${escapeHtml(item.url)}" loading="lazy" referrerpolicy="no-referrer" alt="${escapeHtml(item.kind)}" />`;
      return `<article class="card">
  <div class="preview">${preview}</div>
  <div class="meta">
    <div><strong>Type:</strong> ${escapeHtml(item.kind)}</div>
    ${item.pageTitle ? `<div><strong>Title:</strong> ${escapeHtml(item.pageTitle)}</div>` : ''}
    ${item.fileName ? `<div><strong>File:</strong> ${escapeHtml(item.fileName)}</div>` : ''}
    ${item.pageUrl ? `<div><strong>Page:</strong> <a href="${escapeHtml(item.pageUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.pageUrl)}</a></div>` : ''}
    <div><strong>Download:</strong> <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a></div>
    ${item.status ? `<div><strong>Status:</strong> ${escapeHtml(item.status)}</div>` : ''}
  </div>
</article>`;
    })
    .join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 24px; background: #f4f4f4; color: #111; }
    h1 { margin: 0 0 8px; }
    p { margin: 0 0 16px; color: #555; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .card { background: #fff; border: 1px solid #ddd; border-radius: 12px; overflow: hidden; }
    .preview { background: #111; min-height: 200px; display: flex; align-items: center; justify-content: center; }
    img, video { width: 100%; max-height: 320px; object-fit: contain; display: block; }
    audio { width: calc(100% - 24px); margin: 24px auto; }
    .meta { padding: 12px; font-size: 12px; line-height: 1.5; word-break: break-all; }
    a { color: #0f62fe; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>Total items: ${items.length}</p>
  <section class="grid">${cards}</section>
</body>
</html>`;
}
function toTaskSnapshot(value: unknown): SidecarTaskSnapshot | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const taskId = readStringField(obj, 'task_id').trim();
  if (!taskId) return null;
  return {
    task_id: taskId,
    status: readTaskStatus(obj.status),
    created_at: readStringField(obj, 'created_at'),
    started_at: readStringField(obj, 'started_at'),
    finished_at: readStringField(obj, 'finished_at'),
    exit_code: readNumberField(obj, 'exit_code'),
    pid: readNumberField(obj, 'pid'),
    log_total: readNumberField(obj, 'log_total') ?? 0,
  };
}

export function NetworkSection({ highlightId }: NetworkSectionProps) {
  const { t } = useTranslation('settings');
  const { cookieSettings, proxySettings, updateCookieSettings, updateProxySettings } =
    useDownload();
  const {
    addMediaItems: addUniversalMediaItems,
    startDownload: startUniversalDownload,
    retryFailedDownloads: retryFailedUniversalDownloads,
    items: universalItems,
    isDownloading: isUniversalDownloading,
  } = useUniversal();

  const [detectedBrowsers, setDetectedBrowsers] = useState<
    { name: string; browser_type: string }[]
  >([]);
  const [isDetectingBrowsers, setIsDetectingBrowsers] = useState(false);
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfile[]>([]);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [useCustomProfile, setUseCustomProfile] = useState(false);
  const [sidecarBaseUrl, setSidecarBaseUrl] = useState(() =>
    readStoredValue('base_url', SIDECAR_DEFAULT_BASE_URL),
  );
  const [sidecarToken, setSidecarToken] = useState(() => readStoredValue('token', ''));
  const [sidecarScriptPath, setSidecarScriptPath] = useState(() =>
    readStoredValue('script_path', SIDECAR_DEFAULT_SCRIPT_PATH),
  );
  const [sidecarHost, setSidecarHost] = useState(() =>
    readStoredValue('host', SIDECAR_DEFAULT_HOST),
  );
  const [sidecarPort, setSidecarPort] = useState(() =>
    readStoredValue('port', SIDECAR_DEFAULT_PORT),
  );
  const [sidecarPythonBin, setSidecarPythonBin] = useState(() =>
    readStoredValue('python_bin', SIDECAR_DEFAULT_PYTHON_BIN),
  );
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus | null>(null);
  const [sidecarHealth, setSidecarHealth] = useState<SidecarHealthState>('unknown');
  const [sidecarError, setSidecarError] = useState<string | null>(null);
  const [isSidecarAttaching, setIsSidecarAttaching] = useState(false);
  const [isSidecarRefreshing, setIsSidecarRefreshing] = useState(false);
  const [isSidecarStarting, setIsSidecarStarting] = useState(false);
  const [isSidecarStopping, setIsSidecarStopping] = useState(false);
  const [isSidecarCheckingHealth, setIsSidecarCheckingHealth] = useState(false);

  const [taskUrl, setTaskUrl] = useState(() => readStoredValue('task_url', ''));

  const [taskOutput, setTaskOutput] = useState(() => readStoredValue('task_output', './output'));

  const [taskScope, setTaskScope] = useState(() =>
    readStoredValue('task_scope', SIDECAR_DEFAULT_TASK_SCOPE),
  );

  const [taskWorkers, setTaskWorkers] = useState(() =>
    readStoredValue('task_workers', SIDECAR_DEFAULT_TASK_WORKERS),
  );

  const [taskTimeout, setTaskTimeout] = useState(() =>
    readStoredValue('task_timeout', SIDECAR_DEFAULT_TASK_TIMEOUT),
  );

  const [taskRetries, setTaskRetries] = useState(() =>
    readStoredValue('task_retries', SIDECAR_DEFAULT_TASK_RETRIES),
  );

  const [taskDelay, setTaskDelay] = useState(() =>
    readStoredValue('task_delay', SIDECAR_DEFAULT_TASK_DELAY),
  );

  const [taskImageTypes, setTaskImageTypes] = useState(() => {
    const VALID_TYPES = new Set([
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'bmp',
      'svg',
      'avif',
      'mp4',
      'webm',
      'mov',
      'm4v',
      'mp3',
      'm4a',
      'aac',
      'ogg',
      'oga',
      'opus',
      'wav',
      'flac',
      'weba',
    ]);
    const stored = readStoredValue('task_image_types', SIDECAR_DEFAULT_TASK_IMAGE_TYPES);
    const filtered = stored
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && VALID_TYPES.has(s))
      .join(',');
    return filtered || SIDECAR_DEFAULT_TASK_IMAGE_TYPES;
  });
  const [taskTemplate, setTaskTemplate] = useState(() =>
    readStoredValue('task_template', SIDECAR_DEFAULT_TASK_TEMPLATE),
  );
  const [taskDownloadMode, setTaskDownloadMode] = useState<TaskDownloadMode>(
    () => (readStoredValue('task_download_mode', 'segmented') as TaskDownloadMode) || 'segmented',
  );
  const [taskHostParallelLimit, setTaskHostParallelLimit] = useState(() =>
    readStoredValue('task_host_parallel_limit', SIDECAR_DEFAULT_TASK_HOST_PARALLEL_LIMIT),
  );
  const [taskRangeWorkerLimit, setTaskRangeWorkerLimit] = useState(() =>
    readStoredValue('task_range_worker_limit', SIDECAR_DEFAULT_TASK_RANGE_WORKER_LIMIT),
  );
  const [taskRangeChunkSizeMb, setTaskRangeChunkSizeMb] = useState(() =>
    readStoredValue('task_range_chunk_size_mb', SIDECAR_DEFAULT_TASK_RANGE_CHUNK_SIZE_MB),
  );
  const [taskUrlQueueFile, setTaskUrlQueueFile] = useState(() =>
    readStoredValue('task_url_queue_file', ''),
  );
  const [taskRetryFailedFrom, setTaskRetryFailedFrom] = useState(() =>
    readStoredValue('task_retry_failed_from', ''),
  );
  const [taskIncludeUrlRegex, setTaskIncludeUrlRegex] = useState(() =>
    readStoredValue('task_include_url_regex', ''),
  );
  const [taskExcludeUrlRegex, setTaskExcludeUrlRegex] = useState(() =>
    readStoredValue('task_exclude_url_regex', ''),
  );
  const [taskMinSize, setTaskMinSize] = useState(() => readStoredValue('task_min_size', ''));
  const [taskMaxSize, setTaskMaxSize] = useState(() => readStoredValue('task_max_size', ''));
  const [taskMinResolution, setTaskMinResolution] = useState(() =>
    readStoredValue('task_min_resolution', ''),
  );
  const [taskMaxResolution, setTaskMaxResolution] = useState(() =>
    readStoredValue('task_max_resolution', ''),
  );

  const [taskMaxPages, setTaskMaxPages] = useState(() =>
    readStoredValue('task_max_pages', SIDECAR_DEFAULT_TASK_MAX_PAGES),
  );
  const [taskAutoScope, setTaskAutoScope] = useState(
    () => readStoredValue('task_auto_scope', 'false') === 'true',
  );
  const [taskPreferType, setTaskPreferType] = useState(() =>
    readStoredValue('task_prefer_type', SIDECAR_DEFAULT_TASK_PREFER_TYPE),
  );
  const [taskExtraArgs, setTaskExtraArgs] = useState(() =>
    readStoredValue('task_extra_args', SIDECAR_DEFAULT_TASK_EXTRA_ARGS),
  );
  const [taskLogEvery, setTaskLogEvery] = useState(() =>
    readStoredValue('task_log_every', SIDECAR_DEFAULT_TASK_LOG_EVERY),
  );
  const [taskNextSelectors, setTaskNextSelectors] = useState(() =>
    readStoredValue('task_next_selectors', SIDECAR_DEFAULT_TASK_NEXT_SELECTORS),
  );
  const [taskJs, setTaskJs] = useState(() => readStoredValue('task_js', 'true') === 'true');
  const [taskExhaustive, setTaskExhaustive] = useState(
    () => readStoredValue('task_exhaustive', 'true') === 'true',
  );
  const [taskLinksOnly, setTaskLinksOnly] = useState(
    () => readStoredValue('task_links_only', 'false') === 'true',
  );
  const [taskImportImage, setTaskImportImage] = useState(
    () => readStoredValue('task_import_image', 'true') === 'true',
  );
  const [taskImportGif, setTaskImportGif] = useState(
    () => readStoredValue('task_import_gif', 'true') === 'true',
  );
  const [taskImportVideo, setTaskImportVideo] = useState(
    () => readStoredValue('task_import_video', 'true') === 'true',
  );
  const [taskImportAudio, setTaskImportAudio] = useState(
    () => readStoredValue('task_import_audio', 'false') === 'true',
  );
  const [taskAutoImport, setTaskAutoImport] = useState(
    () => readStoredValue('task_auto_import', 'false') === 'true',
  );
  const [taskAutoImportStart, setTaskAutoImportStart] = useState(
    () => readStoredValue('task_auto_import_start', 'false') === 'true',
  );
  const [taskCurrentId, setTaskCurrentId] = useState(() => readStoredValue('task_current_id', ''));
  const [taskObservedRunningId, setTaskObservedRunningId] = useState('');
  const [taskLastAutoImportTaskId, setTaskLastAutoImportTaskId] = useState(() =>
    readStoredValue('task_last_auto_import_task_id', ''),
  );
  const [taskSnapshot, setTaskSnapshot] = useState<SidecarTaskSnapshot | null>(null);
  const [taskLogs, setTaskLogs] = useState<string[]>([]);
  const [taskLogOffset, setTaskLogOffset] = useState(() => {
    const raw = Number.parseInt(readStoredValue('task_log_offset', '0'), 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  });
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskInfo, setTaskInfo] = useState<string | null>(null);
  const [taskPreviewLinkState, setTaskPreviewLinkState] = useState<TaskPreviewLinkState>('unknown');
  const [taskPreviewLinkOutputDir, setTaskPreviewLinkOutputDir] = useState('');
  const [taskPreviewLinkSourceFile, setTaskPreviewLinkSourceFile] = useState('');
  const [taskArtifactDataDir, setTaskArtifactDataDir] = useState('');
  const [taskResolvedMediaDir, setTaskResolvedMediaDir] = useState('');
  const [taskImportCounts, setTaskImportCounts] = useState<ImportMediaCounts>(EMPTY_IMPORT_COUNTS);
  const [taskMediaBrowserItems, setTaskMediaBrowserItems] = useState<TaskMediaBrowserItem[]>([]);
  const [taskMediaBrowserFilter, setTaskMediaBrowserFilter] =
    useState<TaskMediaBrowserFilter>('all');
  const [taskMediaBrowserVisibleCount, setTaskMediaBrowserVisibleCount] = useState(
    TASK_MEDIA_BROWSER_PAGE_SIZE,
  );
  const [taskMediaBrowserError, setTaskMediaBrowserError] = useState<string | null>(null);
  const [taskMediaBrowserInfo, setTaskMediaBrowserInfo] = useState<string | null>(null);
  const [taskMediaBrowserOutputDir, setTaskMediaBrowserOutputDir] = useState('');
  const [taskMediaBrowserSourceFile, setTaskMediaBrowserSourceFile] = useState('');
  const [taskMediaBrowserSourceMode, setTaskMediaBrowserSourceMode] =
    useState<TaskMediaBrowserSourceMode>('task');
  const [taskMediaBrowserExpandedKeys, setTaskMediaBrowserExpandedKeys] = useState<Set<string>>(
    new Set(),
  );
  const [taskMediaBrowserInfoPanelOpen, setTaskMediaBrowserInfoPanelOpen] = useState(false);
  const [taskParamsPanelOpen, setTaskParamsPanelOpen] = useState(
    () => readStoredValue('task_params_panel_open', 'false') === 'true',
  );
  const [taskStatusPanelOpen, setTaskStatusPanelOpen] = useState(
    () => readStoredValue('task_status_panel_open', 'true') === 'true',
  );
  const [taskLogsPanelOpen, setTaskLogsPanelOpen] = useState(
    () => readStoredValue('task_logs_panel_open', 'false') === 'true',
  );
  const [taskMediaBrowserPanelOpen, setTaskMediaBrowserPanelOpen] = useState(
    () => readStoredValue('task_media_browser_panel_open', 'false') === 'true',
  );
  const [taskMediaBrowserMetaFilter, setTaskMediaBrowserMetaFilter] =
    useState<TaskMediaBrowserMetaFilter>(
      () =>
        (readStoredValue('task_media_browser_meta_filter', 'all') as TaskMediaBrowserMetaFilter) ||
        'all',
    );
  const [taskMediaBrowserDetailsDefault, setTaskMediaBrowserDetailsDefault] = useState<
    'collapsed' | 'expanded'
  >(
    () =>
      (readStoredValue('task_media_browser_details_default', 'collapsed') as
        | 'collapsed'
        | 'expanded') || 'collapsed',
  );
  const [taskHistoryFolderPath, setTaskHistoryFolderPath] = useState(() =>
    readStoredValue('task_history_folder_path', ''),
  );
  const [taskHistoryFolderDataDir, setTaskHistoryFolderDataDir] = useState('');
  const [taskHistoryFolderDetectedFiles, setTaskHistoryFolderDetectedFiles] = useState<string[]>(
    [],
  );
  const [taskHistoryFolderMissingFiles, setTaskHistoryFolderMissingFiles] = useState<string[]>([]);
  const [taskHistoryFolderPreviewReportPath, setTaskHistoryFolderPreviewReportPath] = useState('');
  const [taskHistoryFolderScanMs, setTaskHistoryFolderScanMs] = useState(0);
  const [taskHistoryFolderScannedAt, setTaskHistoryFolderScannedAt] = useState<number | null>(null);
  const [isTaskMediaBrowserLoading, setIsTaskMediaBrowserLoading] = useState(false);
  const [isTaskMediaBrowserExporting, setIsTaskMediaBrowserExporting] = useState(false);
  const [isTaskMediaLinksExporting, setIsTaskMediaLinksExporting] = useState(false);
  const [isTaskRetryingFailedDownloads, setIsTaskRetryingFailedDownloads] = useState(false);
  const [isTaskMediaViewerOpen, setIsTaskMediaViewerOpen] = useState(false);
  const [taskMediaViewerIndex, setTaskMediaViewerIndex] = useState(0);
  const [taskMediaViewerFitMode, setTaskMediaViewerFitMode] = useState<'contain' | 'actual'>(
    'contain',
  );
  const [taskCompletionToast, setTaskCompletionToast] = useState<{
    id: string;
    title: string;
    path?: string;
    downloaded: number | null;
    failed: number | null;
    filtered: number | null;
    existing: number | null;
    noNew: boolean;
    sourceMissing: number | null;
    telegraphSourceMissing: boolean;
    telegramFallbackLinks: string[];
    status: SidecarTaskState;
  } | null>(null);
  const [isTaskStarting, setIsTaskStarting] = useState(false);
  const [isTaskStopping, setIsTaskStopping] = useState(false);
  const [isTaskRefreshing, setIsTaskRefreshing] = useState(false);
  const [isTaskLoadingLatest, setIsTaskLoadingLatest] = useState(false);
  const [isTaskImporting, setIsTaskImporting] = useState(false);
  const taskPollingInFlightRef = useRef(false);
  const taskLogOffsetRef = useRef(taskLogOffset);
  const taskAutoImportInFlightRef = useRef(false);
  const taskCurrentIdRef = useRef(taskCurrentId);
  const taskCompletionToastSeenRef = useRef<Set<string>>(new Set());

  // Detect browsers
  useEffect(() => {
    const detectBrowsers = async () => {
      setIsDetectingBrowsers(true);
      try {
        const browsers = await invoke<{ name: string; browser_type: string }[]>(
          'detect_installed_browsers',
        );
        setDetectedBrowsers(browsers);
      } catch (error) {
        console.error('Failed to detect browsers:', error);
      } finally {
        setIsDetectingBrowsers(false);
      }
    };
    detectBrowsers();
  }, []);

  // Load browser profiles when browser changes
  useEffect(() => {
    const loadProfiles = async () => {
      if (!cookieSettings.browser || cookieSettings.browser === 'safari') {
        setBrowserProfiles([]);
        return;
      }

      setIsLoadingProfiles(true);
      try {
        const profiles = await invoke<BrowserProfile[]>('get_browser_profiles', {
          browser: cookieSettings.browser,
        });
        setBrowserProfiles(profiles);

        // Auto-select first profile if none selected
        if (profiles.length > 0 && !cookieSettings.browserProfile) {
          updateCookieSettings({ browserProfile: profiles[0].folder_name });
        }
      } catch (error) {
        console.error('Failed to load profiles:', error);
        setBrowserProfiles([]);
      } finally {
        setIsLoadingProfiles(false);
      }
    };

    if (cookieSettings.mode === 'browser') {
      loadProfiles();
    }
  }, [
    cookieSettings.browser,
    cookieSettings.mode,
    cookieSettings.browserProfile,
    updateCookieSettings,
  ]);

  useEffect(() => {
    writeStoredValue('base_url', sidecarBaseUrl);
  }, [sidecarBaseUrl]);

  useEffect(() => {
    writeStoredValue('token', sidecarToken);
  }, [sidecarToken]);

  useEffect(() => {
    writeStoredValue('script_path', sidecarScriptPath);
  }, [sidecarScriptPath]);

  useEffect(() => {
    writeStoredValue('host', sidecarHost);
  }, [sidecarHost]);

  useEffect(() => {
    writeStoredValue('port', sidecarPort);
  }, [sidecarPort]);

  useEffect(() => {
    writeStoredValue('python_bin', sidecarPythonBin);
  }, [sidecarPythonBin]);

  useEffect(() => {
    writeStoredValue('task_url', taskUrl);
  }, [taskUrl]);

  useEffect(() => {
    writeStoredValue('task_output', taskOutput);
  }, [taskOutput]);

  useEffect(() => {
    writeStoredValue('task_scope', taskScope);
  }, [taskScope]);

  useEffect(() => {
    writeStoredValue('task_workers', taskWorkers);
  }, [taskWorkers]);

  useEffect(() => {
    writeStoredValue('task_timeout', taskTimeout);
  }, [taskTimeout]);

  useEffect(() => {
    writeStoredValue('task_retries', taskRetries);
  }, [taskRetries]);

  useEffect(() => {
    writeStoredValue('task_delay', taskDelay);
  }, [taskDelay]);

  useEffect(() => {
    writeStoredValue('task_image_types', taskImageTypes);
  }, [taskImageTypes]);

  useEffect(() => {
    writeStoredValue('task_template', taskTemplate);
  }, [taskTemplate]);

  useEffect(() => {
    writeStoredValue('task_download_mode', taskDownloadMode);
  }, [taskDownloadMode]);

  useEffect(() => {
    writeStoredValue('task_host_parallel_limit', taskHostParallelLimit);
  }, [taskHostParallelLimit]);

  useEffect(() => {
    writeStoredValue('task_range_worker_limit', taskRangeWorkerLimit);
  }, [taskRangeWorkerLimit]);

  useEffect(() => {
    writeStoredValue('task_range_chunk_size_mb', taskRangeChunkSizeMb);
  }, [taskRangeChunkSizeMb]);

  useEffect(() => {
    writeStoredValue('task_url_queue_file', taskUrlQueueFile);
  }, [taskUrlQueueFile]);

  useEffect(() => {
    writeStoredValue('task_retry_failed_from', taskRetryFailedFrom);
  }, [taskRetryFailedFrom]);
  useEffect(() => {
    writeStoredValue('task_history_folder_path', taskHistoryFolderPath);
  }, [taskHistoryFolderPath]);

  useEffect(() => {
    if (taskHistoryFolderPath.trim()) {
      setTaskHistoryFolderDataDir(joinPathParts(taskHistoryFolderPath.trim(), 'data'));
    } else {
      setTaskHistoryFolderDataDir('');
      setTaskHistoryFolderDetectedFiles([]);
      setTaskHistoryFolderMissingFiles([]);
      setTaskHistoryFolderPreviewReportPath('');
      setTaskHistoryFolderScanMs(0);
      setTaskHistoryFolderScannedAt(null);
    }
  }, [taskHistoryFolderPath]);

  useEffect(() => {
    writeStoredValue('task_include_url_regex', taskIncludeUrlRegex);
  }, [taskIncludeUrlRegex]);

  useEffect(() => {
    writeStoredValue('task_exclude_url_regex', taskExcludeUrlRegex);
  }, [taskExcludeUrlRegex]);

  useEffect(() => {
    writeStoredValue('task_min_size', taskMinSize);
  }, [taskMinSize]);

  useEffect(() => {
    writeStoredValue('task_max_size', taskMaxSize);
  }, [taskMaxSize]);

  useEffect(() => {
    writeStoredValue('task_min_resolution', taskMinResolution);
  }, [taskMinResolution]);

  useEffect(() => {
    writeStoredValue('task_max_resolution', taskMaxResolution);
  }, [taskMaxResolution]);

  useEffect(() => {
    writeStoredValue('task_max_pages', taskMaxPages);
  }, [taskMaxPages]);

  useEffect(() => {
    writeStoredValue('task_auto_scope', taskAutoScope ? 'true' : 'false');
  }, [taskAutoScope]);

  useEffect(() => {
    writeStoredValue('task_prefer_type', taskPreferType);
  }, [taskPreferType]);

  useEffect(() => {
    writeStoredValue('task_extra_args', taskExtraArgs);
  }, [taskExtraArgs]);

  useEffect(() => {
    writeStoredValue('task_log_every', taskLogEvery);
  }, [taskLogEvery]);

  useEffect(() => {
    writeStoredValue('task_next_selectors', taskNextSelectors);
  }, [taskNextSelectors]);

  useEffect(() => {
    writeStoredValue('task_js', taskJs ? 'true' : 'false');
  }, [taskJs]);

  useEffect(() => {
    writeStoredValue('task_exhaustive', taskExhaustive ? 'true' : 'false');
  }, [taskExhaustive]);

  useEffect(() => {
    writeStoredValue('task_links_only', taskLinksOnly ? 'true' : 'false');
  }, [taskLinksOnly]);

  useEffect(() => {
    writeStoredValue('task_import_image', taskImportImage ? 'true' : 'false');
  }, [taskImportImage]);

  useEffect(() => {
    writeStoredValue('task_import_gif', taskImportGif ? 'true' : 'false');
  }, [taskImportGif]);

  useEffect(() => {
    writeStoredValue('task_import_video', taskImportVideo ? 'true' : 'false');
  }, [taskImportVideo]);

  useEffect(() => {
    writeStoredValue('task_import_audio', taskImportAudio ? 'true' : 'false');
  }, [taskImportAudio]);

  useEffect(() => {
    writeStoredValue('task_auto_import', taskAutoImport ? 'true' : 'false');
  }, [taskAutoImport]);

  useEffect(() => {
    writeStoredValue('task_auto_import_start', taskAutoImportStart ? 'true' : 'false');
  }, [taskAutoImportStart]);

  useEffect(() => {
    taskCurrentIdRef.current = taskCurrentId;
    writeStoredValue('task_current_id', taskCurrentId);
  }, [taskCurrentId]);

  useEffect(() => {
    writeStoredValue('task_last_auto_import_task_id', taskLastAutoImportTaskId);
  }, [taskLastAutoImportTaskId]);

  useEffect(() => {
    writeStoredValue('task_log_offset', String(taskLogOffset));
  }, [taskLogOffset]);

  useEffect(() => {
    writeStoredValue('task_media_browser_meta_filter', taskMediaBrowserMetaFilter);
  }, [taskMediaBrowserMetaFilter]);

  useEffect(() => {
    writeStoredValue('task_media_browser_details_default', taskMediaBrowserDetailsDefault);
  }, [taskMediaBrowserDetailsDefault]);

  useEffect(() => {
    writeStoredValue('task_params_panel_open', taskParamsPanelOpen ? 'true' : 'false');
  }, [taskParamsPanelOpen]);

  useEffect(() => {
    writeStoredValue('task_status_panel_open', taskStatusPanelOpen ? 'true' : 'false');
  }, [taskStatusPanelOpen]);

  useEffect(() => {
    writeStoredValue('task_logs_panel_open', taskLogsPanelOpen ? 'true' : 'false');
  }, [taskLogsPanelOpen]);

  useEffect(() => {
    writeStoredValue('task_media_browser_panel_open', taskMediaBrowserPanelOpen ? 'true' : 'false');
  }, [taskMediaBrowserPanelOpen]);
  const taskCompletionSummary = useMemo(() => parseTaskCompletionSummary(taskLogs), [taskLogs]);
  const taskSourceMissingSummary = useMemo(
    () => parseTaskSourceMissingSummary(taskLogs),
    [taskLogs],
  );
  const taskTelegramFallbackLinks = useMemo(
    () => parseTaskTelegramFallbackLinks(taskLogs),
    [taskLogs],
  );
  const taskRangeSummary = useMemo(() => parseTaskRangeSummary(taskLogs), [taskLogs]);
  const taskRustTransferSummary = useMemo(() => parseTaskRustTransferSummary(taskLogs), [taskLogs]);
  const taskTransferPreset = useMemo(() => inferCrawlerTransferPreset(taskUrl), [taskUrl]);

  const taskRetryOutputDir = useMemo(() => {
    const explicit = taskMediaBrowserOutputDir.trim() || taskHistoryFolderPath.trim();
    if (explicit) return explicit;
    const retryFile = taskRetryFailedFrom.trim();
    if (!retryFile) return '';
    const retryDir = dirnamePath(retryFile);
    const parts = retryDir.split(/[\\/]/).filter(Boolean);
    if (parts.length > 0 && parts[parts.length - 1].toLowerCase() === 'data') {
      return dirnamePath(retryDir);
    }
    return retryDir;
  }, [taskHistoryFolderPath, taskMediaBrowserOutputDir, taskRetryFailedFrom]);

  const taskCompletionPath = useMemo(() => {
    return (
      parseTaskResolvedOutputDir(taskLogs) ||
      taskResolvedMediaDir.trim() ||
      resolveArtifactOwnerDir(taskMediaBrowserSourceFile) ||
      resolveArtifactOwnerDir(taskPreviewLinkSourceFile)
    );
  }, [taskLogs, taskMediaBrowserSourceFile, taskPreviewLinkSourceFile, taskResolvedMediaDir]);

  useEffect(() => {
    taskLogOffsetRef.current = taskLogOffset;
  }, [taskLogOffset]);

  useEffect(() => {
    const currentTaskId = taskCurrentId.trim();
    const currentStatus = taskSnapshot?.status ?? 'unknown';
    if (!currentTaskId) return;
    if (!isTaskTerminalStatus(currentStatus)) return;
    if (taskObservedRunningId !== currentTaskId) return;
    if (taskCompletionToastSeenRef.current.has(currentTaskId)) return;

    const completionPath = taskCompletionPath;
    const summary = taskCompletionSummary;
    const sourceMissing = taskSourceMissingSummary;

    taskCompletionToastSeenRef.current.add(currentTaskId);
    setTaskCompletionToast({
      id: currentTaskId,
      title: t('network.crawlerTask.taskCompleteTitle', { taskId: currentTaskId }),
      path: completionPath || undefined,
      downloaded: summary.downloaded,
      failed: summary.failed,
      filtered: summary.filtered,
      existing: summary.existing,
      noNew: summary.noNew,
      sourceMissing: sourceMissing.sourceMissing,
      telegraphSourceMissing: sourceMissing.telegraphSourceMissing,
      telegramFallbackLinks: taskTelegramFallbackLinks,
      status: currentStatus,
    });
  }, [
    taskCompletionSummary,
    taskCurrentId,
    taskLogs.length,
    taskObservedRunningId,
    taskCompletionPath,
    taskSnapshot?.status,
    taskSourceMissingSummary,
    taskTelegramFallbackLinks,
    t,
  ]);

  useEffect(() => {
    const currentTaskId = taskCurrentId.trim();
    const betterPath = taskCompletionPath.trim();
    if (!currentTaskId || !betterPath) return;
    setTaskCompletionToast((prev) => {
      if (!prev || prev.id !== currentTaskId) return prev;
      if (prev.path === betterPath) return prev;
      return { ...prev, path: betterPath };
    });
  }, [taskCompletionPath, taskCurrentId]);
  useEffect(() => {
    const currentTaskId = taskCurrentId.trim();
    if (!currentTaskId) return;
    setTaskCompletionToast((prev) => {
      if (!prev || prev.id !== currentTaskId) return prev;
      const nextPath = taskCompletionPath.trim() || prev.path;
      const nextDownloaded = taskCompletionSummary.downloaded ?? prev.downloaded;
      const nextFailed = taskCompletionSummary.failed ?? prev.failed;
      const nextFiltered = taskCompletionSummary.filtered ?? prev.filtered;
      const nextExisting = taskCompletionSummary.existing ?? prev.existing;
      const nextNoNew = taskCompletionSummary.noNew || prev.noNew;
      const nextSourceMissing = taskSourceMissingSummary.sourceMissing ?? prev.sourceMissing;
      const nextTelegraph =
        taskSourceMissingSummary.telegraphSourceMissing || prev.telegraphSourceMissing;
      const nextTelegramLinks =
        taskTelegramFallbackLinks.length > 0
          ? taskTelegramFallbackLinks
          : prev.telegramFallbackLinks;

      if (
        prev.path === nextPath &&
        prev.downloaded === nextDownloaded &&
        prev.failed === nextFailed &&
        prev.filtered === nextFiltered &&
        prev.existing === nextExisting &&
        prev.noNew === nextNoNew &&
        prev.sourceMissing === nextSourceMissing &&
        prev.telegraphSourceMissing === nextTelegraph &&
        prev.telegramFallbackLinks === nextTelegramLinks
      ) {
        return prev;
      }

      return {
        ...prev,
        path: nextPath,
        downloaded: nextDownloaded,
        failed: nextFailed,
        filtered: nextFiltered,
        existing: nextExisting,
        noNew: nextNoNew,
        sourceMissing: nextSourceMissing,
        telegraphSourceMissing: nextTelegraph,
        telegramFallbackLinks: nextTelegramLinks,
      };
    });
  }, [
    taskCompletionPath,
    taskCompletionSummary,
    taskCurrentId,
    taskSourceMissingSummary,
    taskTelegramFallbackLinks,
  ]);

  const handleSidecarHealthCheck = useCallback(async (silent = false) => {
    if (!silent) setIsSidecarCheckingHealth(true);
    try {
      await crawlerSidecarHealth();
      setSidecarHealth('ok');
      setSidecarError(null);
    } catch (error) {
      setSidecarHealth('fail');
      if (!silent) {
        setSidecarError(formatUnknownError(error));
      }
    } finally {
      if (!silent) setIsSidecarCheckingHealth(false);
    }
  }, []);

  const refreshSidecarStatus = useCallback(
    async ({
      silent = false,
      withHealthCheck = false,
    }: {
      silent?: boolean;
      withHealthCheck?: boolean;
    } = {}) => {
      if (!silent) setIsSidecarRefreshing(true);
      try {
        const status = await crawlerSidecarStatus();
        setSidecarStatus(status);
        if (withHealthCheck && status.base_url) {
          await handleSidecarHealthCheck(silent);
        } else if (!status.base_url) {
          setSidecarHealth('unknown');
        }
      } catch (error) {
        if (!silent) {
          setSidecarError(formatUnknownError(error));
        }
      } finally {
        if (!silent) setIsSidecarRefreshing(false);
      }
    },
    [handleSidecarHealthCheck],
  );

  useEffect(() => {
    void refreshSidecarStatus({ silent: true, withHealthCheck: true });
    const timer = window.setInterval(() => {
      void refreshSidecarStatus({ silent: true, withHealthCheck: true });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshSidecarStatus]);

  const handleAttachSidecar = useCallback(async () => {
    if (!sidecarBaseUrl.trim()) {
      setSidecarError(t('network.crawlerSidecar.baseUrlRequired'));
      return;
    }
    setIsSidecarAttaching(true);
    setSidecarError(null);
    try {
      const status = await crawlerSidecarAttach(
        sidecarBaseUrl.trim(),
        sidecarToken.trim() || undefined,
      );
      setSidecarStatus(status);
      await handleSidecarHealthCheck();
    } catch (error) {
      setSidecarError(formatUnknownError(error));
    } finally {
      setIsSidecarAttaching(false);
    }
  }, [handleSidecarHealthCheck, sidecarBaseUrl, sidecarToken, t]);

  const handleStartSidecar = useCallback(async () => {
    if (!sidecarScriptPath.trim()) {
      setSidecarError(t('network.crawlerSidecar.scriptRequired'));
      return;
    }
    const parsedPort = Number.parseInt(sidecarPort.trim(), 10);
    if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setSidecarError(t('network.crawlerSidecar.invalidPort'));
      return;
    }

    const normalizedHost = sidecarHost.trim() || SIDECAR_DEFAULT_HOST;
    setIsSidecarStarting(true);
    setSidecarError(null);
    try {
      const status = await crawlerSidecarStartService({
        scriptPath: sidecarScriptPath.trim(),
        host: normalizedHost,
        port: parsedPort,
        token: sidecarToken.trim() || undefined,
        pythonBin: sidecarPythonBin.trim() || undefined,
      });
      setSidecarStatus(status);
      setSidecarBaseUrl(`http://${normalizedHost}:${parsedPort}`);
      await refreshSidecarStatus({ withHealthCheck: true });
    } catch (error) {
      setSidecarError(formatUnknownError(error));
    } finally {
      setIsSidecarStarting(false);
    }
  }, [
    refreshSidecarStatus,
    sidecarHost,
    sidecarPort,
    sidecarPythonBin,
    sidecarScriptPath,
    sidecarToken,
    t,
  ]);

  const handleStopSidecar = useCallback(async () => {
    setIsSidecarStopping(true);
    setSidecarError(null);
    try {
      const status = await crawlerSidecarStopService();
      setSidecarStatus(status);
      setSidecarHealth('unknown');
    } catch (error) {
      setSidecarError(formatUnknownError(error));
    } finally {
      setIsSidecarStopping(false);
    }
  }, []);

  const handlePickSidecarScript = useCallback(async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: t('network.crawlerSidecar.pythonScriptFilter'), extensions: ['py'] }],
        title: t('network.crawlerSidecar.selectScript'),
      });
      if (typeof file === 'string') {
        setSidecarScriptPath(file);
      }
    } catch (error) {
      setSidecarError(formatUnknownError(error));
    }
  }, [t]);

  const handlePickTaskQueueFile = useCallback(async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: 'Queue files', extensions: ['txt', 'csv', 'jsonl'] }],
        title: t('network.crawlerTask.queueFileBrowse'),
      });
      if (typeof file === 'string') {
        setTaskUrlQueueFile(file);
      }
    } catch (error) {
      setTaskError(formatUnknownError(error));
    }
  }, [t]);

  const handlePickTaskRetryFile = useCallback(async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: 'Retry files', extensions: ['txt', 'csv'] }],
        title: t('network.crawlerTask.retryFileBrowse'),
      });
      if (typeof file === 'string') {
        setTaskRetryFailedFrom(file);
      }
    } catch (error) {
      setTaskError(formatUnknownError(error));
    }
  }, [t]);
  const handlePickTaskHistoryFolder = useCallback(async () => {
    try {
      const folder = await open({
        directory: true,
        multiple: false,
        title: t('network.crawlerTask.historyFolderBrowse'),
      });
      if (typeof folder === 'string') {
        setTaskHistoryFolderPath(folder);
        setTaskHistoryFolderDataDir(joinPathParts(folder, 'data'));
        setTaskHistoryFolderDetectedFiles([]);
        setTaskHistoryFolderMissingFiles([]);
        setTaskHistoryFolderPreviewReportPath('');
        setTaskHistoryFolderScanMs(0);
        setTaskHistoryFolderScannedAt(null);
      }
    } catch (error) {
      setTaskError(formatUnknownError(error));
    }
  }, [t]);
  const parsePositiveInt = useCallback((value: string): number | null => {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }, []);

  const refreshTaskData = useCallback(
    async ({
      taskId,
      silent = false,
      resetLogs = false,
    }: {
      taskId?: string;
      silent?: boolean;
      resetLogs?: boolean;
    } = {}) => {
      const effectiveTaskId = (taskId || taskCurrentId).trim();
      if (!effectiveTaskId) return;
      if (!sidecarStatus?.base_url) return;
      if (sidecarHealth === 'fail' && silent) return;
      if (taskPollingInFlightRef.current) return;
      taskPollingInFlightRef.current = true;
      if (!silent) {
        setIsTaskRefreshing(true);
        setTaskError(null);
        setTaskInfo(null);
      }
      try {
        const isStaleTaskRequest = () => {
          const selectedTaskId = taskCurrentIdRef.current.trim();
          return Boolean(selectedTaskId) && selectedTaskId !== effectiveTaskId;
        };

        const snapshotRaw = await crawlerSidecarGetTask(effectiveTaskId);
        if (isStaleTaskRequest()) return;
        const parsedSnapshot = toTaskSnapshot(snapshotRaw);
        const snapshotObj = asRecord(snapshotRaw);
        const snapshotArgs = asRecord(snapshotObj?.args);
        if (parsedSnapshot) {
          setTaskSnapshot(parsedSnapshot);
          if (
            parsedSnapshot.status === 'running' ||
            parsedSnapshot.status === 'starting' ||
            parsedSnapshot.status === 'stopping'
          ) {
            setTaskObservedRunningId(parsedSnapshot.task_id);
          }
        }
        let fallbackArtifactDataDir = '';
        if (snapshotArgs) {
          const retryFile = readStringField(snapshotArgs, 'retry_failed_from').trim();
          if (retryFile) {
            setTaskRetryFailedFrom(retryFile);
            fallbackArtifactDataDir = dirnamePath(retryFile);
          } else {
            const snapshotOutputDir = readStringField(snapshotArgs, 'output').trim();
            fallbackArtifactDataDir = snapshotOutputDir
              ? joinPathParts(snapshotOutputDir, 'data')
              : '';
          }
        }

        try {
          const previewRaw = await crawlerSidecarCollectTaskLinks(effectiveTaskId, 1);
          if (isStaleTaskRequest()) return;
          const previewObj = asRecord(previewRaw);
          const previewOutputDir = previewObj ? readStringField(previewObj, 'output_dir') : '';
          const previewSourceFile = previewObj ? readStringField(previewObj, 'source_file') : '';
          const previewItems = previewObj
            ? parseTaskMediaBrowserItemsFromPayload(previewObj.items)
            : [];
          setTaskPreviewLinkOutputDir(previewOutputDir);
          setTaskPreviewLinkSourceFile(previewSourceFile);
          const previewResolvedDir =
            previewItems.map((item) => resolveTaskMediaItemDir(item)).find(Boolean) || '';
          if (previewResolvedDir) {
            setTaskResolvedMediaDir(previewResolvedDir);
          }
          const nextArtifactDataDir = previewSourceFile.trim()
            ? dirnamePath(previewSourceFile)
            : previewOutputDir.trim()
              ? joinPathParts(previewOutputDir, 'data')
              : fallbackArtifactDataDir;
          setTaskArtifactDataDir(nextArtifactDataDir);
          if (previewSourceFile.trim()) {
            setTaskPreviewLinkState('ready');
          } else if (isTaskActiveStatus(parsedSnapshot?.status)) {
            setTaskPreviewLinkState('pending');
          } else {
            setTaskPreviewLinkState('missing');
          }
        } catch {
          setTaskPreviewLinkOutputDir('');
          setTaskPreviewLinkSourceFile('');
          setTaskArtifactDataDir((prev) => prev || fallbackArtifactDataDir);
          setTaskPreviewLinkState(
            isTaskActiveStatus(parsedSnapshot?.status) ? 'pending' : 'unknown',
          );
        }

        const offset = resetLogs ? 0 : taskLogOffsetRef.current;
        const logsRaw = await crawlerSidecarGetTaskLogs(effectiveTaskId, offset, 200);
        if (isStaleTaskRequest()) return;
        const logsObj = asRecord(logsRaw);
        const rawLines = Array.isArray(logsObj?.lines) ? logsObj.lines : [];
        const lines = rawLines
          .filter((line): line is string => typeof line === 'string')
          .map((line) => line.trimEnd());
        const nextOffset = logsObj ? readNumberField(logsObj, 'next_offset') : null;

        if (resetLogs) {
          setTaskLogs(lines.slice(-SIDECAR_LOG_LIMIT));
        } else if (lines.length > 0) {
          setTaskLogs((prev) => {
            const merged = [...prev, ...lines];
            return merged.length > SIDECAR_LOG_LIMIT
              ? merged.slice(merged.length - SIDECAR_LOG_LIMIT)
              : merged;
          });
        }
        if (nextOffset !== null && nextOffset >= 0) {
          setTaskLogOffset(nextOffset);
        }
      } catch (error) {
        if (isSidecarTransportError(error)) {
          setSidecarHealth('fail');
          setSidecarError(formatUnknownError(error));
          void refreshSidecarStatus({ silent: true, withHealthCheck: true });
          if (!silent) {
            setTaskError(
              t('network.crawlerTask.sidecarRequestFailed', { taskId: effectiveTaskId }),
            );
          }
        } else if (!silent) {
          setTaskError(formatUnknownError(error));
        }
      } finally {
        if (!silent) setIsTaskRefreshing(false);
        taskPollingInFlightRef.current = false;
      }
    },
    [refreshSidecarStatus, sidecarHealth, sidecarStatus?.base_url, t, taskCurrentId],
  );

  useEffect(() => {
    if (!taskCurrentId.trim()) return;
    if (!sidecarStatus?.base_url) return;
    if (sidecarHealth === 'fail') return;
    void refreshTaskData({ taskId: taskCurrentId, silent: true });
    const timer = window.setInterval(() => {
      void refreshTaskData({ taskId: taskCurrentId, silent: true });
    }, SIDECAR_TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [sidecarHealth, sidecarStatus?.base_url, taskCurrentId, refreshTaskData]);

  const handleLoadLatestTask = useCallback(async () => {
    setIsTaskLoadingLatest(true);
    setTaskError(null);
    setTaskInfo(null);
    try {
      const raw = await crawlerSidecarListTasks();
      const obj = asRecord(raw);
      const items = Array.isArray(obj?.items) ? obj.items : [];
      const latest = items.map((it) => toTaskSnapshot(it)).find((it) => it !== null) ?? null;
      if (!latest) {
        setTaskError(t('network.crawlerTask.noTaskFound'));
        return;
      }
      taskCurrentIdRef.current = latest.task_id;
      setTaskCurrentId(latest.task_id);
      setTaskSnapshot(latest);
      setTaskLogs([]);
      setTaskLogOffset(0);
      setTaskImportCounts(EMPTY_IMPORT_COUNTS);
      await refreshTaskData({ taskId: latest.task_id, resetLogs: true });
    } catch (error) {
      setTaskError(formatUnknownError(error));
    } finally {
      setIsTaskLoadingLatest(false);
    }
  }, [refreshTaskData, t]);

  const applyStartedTaskState = useCallback(
    (nextTaskId: string, taskObj: Record<string, unknown> | null) => {
      taskCurrentIdRef.current = nextTaskId;
      setTaskCurrentId(nextTaskId);
      setTaskObservedRunningId(nextTaskId);
      setTaskLogs([]);
      setTaskLogOffset(0);
      setTaskImportCounts(EMPTY_IMPORT_COUNTS);
      setTaskPreviewLinkState('unknown');
      setTaskPreviewLinkOutputDir('');
      setTaskPreviewLinkSourceFile('');
      setTaskArtifactDataDir('');
      setTaskResolvedMediaDir('');
      setTaskMediaBrowserItems([]);
      setTaskMediaBrowserFilter('all');
      setTaskMediaBrowserMetaFilter('all');
      setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
      setTaskMediaBrowserExpandedKeys(new Set());
      setTaskMediaBrowserError(null);
      setTaskMediaBrowserInfo(null);
      setTaskMediaBrowserOutputDir('');
      setTaskMediaBrowserSourceFile('');
      setTaskMediaBrowserSourceMode('task');
      setIsTaskMediaViewerOpen(false);
      setTaskMediaViewerIndex(0);
      setTaskSnapshot({
        task_id: nextTaskId,
        status: readTaskStatus(taskObj?.status),
        created_at: '',
        started_at: '',
        finished_at: '',
        exit_code: null,
        pid: readNumberField(taskObj ?? {}, 'pid'),
        log_total: 0,
      });
    },
    [],
  );

  const buildCrawlerTaskPayload = useCallback(
    (options: BuildCrawlerTaskPayloadOptions = {}): Record<string, unknown> => {
      const taskUrlValue = (options.url ?? taskUrl).trim();
      const queueFileValue = (options.urlQueueFile ?? taskUrlQueueFile).trim();
      const retryFileValue = (options.retryFailedFrom ?? taskRetryFailedFrom).trim();
      const scopeValue = options.scope ?? (taskScope === 'site' ? 'site' : 'page');
      const payload: Record<string, unknown> = {
        output: taskOutput.trim() || './output',
        scope: scopeValue,
        js: taskJs,
        links_only: taskLinksOnly,
        google_photos_exhaustive: taskExhaustive,
      };

      if (taskUrlValue) payload.url = taskUrlValue;
      if (!taskUrlValue && queueFileValue) payload.url_queue_file = queueFileValue;
      if (!taskUrlValue && !queueFileValue && retryFileValue) {
        payload.retry_failed_from = retryFileValue;
      }

      const workers = parsePositiveInt(taskWorkers);
      if (workers !== null) payload.workers = workers;
      const timeout = parsePositiveInt(taskTimeout);
      if (timeout !== null) payload.timeout = timeout;
      const parsedRetries = Number.parseInt(taskRetries.trim(), 10);
      if (Number.isFinite(parsedRetries) && parsedRetries >= 0) payload.retries = parsedRetries;
      const parsedDelay = Number.parseFloat(taskDelay.trim());
      if (Number.isFinite(parsedDelay) && parsedDelay >= 0) payload.delay = parsedDelay;
      const maxPages = parsePositiveInt(taskMaxPages);
      if (maxPages !== null) payload.max_pages = maxPages;
      if (taskImageTypes.trim()) payload.image_types = taskImageTypes.trim();
      if (taskTemplate !== 'none') payload.template = taskTemplate;
      if (taskDownloadMode === 'single') payload.single_stream_downloads = true;
      const hostParallelLimit = parsePositiveInt(taskHostParallelLimit);
      const rangeWorkerLimit = parsePositiveInt(taskRangeWorkerLimit);
      const rangeChunkSizeMb = Number.parseFloat(taskRangeChunkSizeMb.trim());
      const transferPreset = inferCrawlerTransferPreset(taskUrlValue);
      if (hostParallelLimit !== null) payload.host_parallel_limit = hostParallelLimit;
      else if (transferPreset) payload.host_parallel_limit = transferPreset.hostParallelLimit;
      if (rangeWorkerLimit !== null) payload.range_worker_limit = rangeWorkerLimit;
      else if (transferPreset) payload.range_worker_limit = transferPreset.rangeWorkerLimit;
      if (Number.isFinite(rangeChunkSizeMb) && rangeChunkSizeMb > 0)
        payload.range_chunk_size_mb = rangeChunkSizeMb;
      else if (transferPreset) payload.range_chunk_size_mb = transferPreset.rangeChunkSizeMb;
      if (taskIncludeUrlRegex.trim()) payload.include_url_regex = taskIncludeUrlRegex.trim();
      if (taskExcludeUrlRegex.trim()) payload.exclude_url_regex = taskExcludeUrlRegex.trim();
      if (taskMinSize.trim()) payload.min_size = taskMinSize.trim();
      if (taskMaxSize.trim()) payload.max_size = taskMaxSize.trim();
      if (taskMinResolution.trim()) payload.min_resolution = taskMinResolution.trim();
      if (taskMaxResolution.trim()) payload.max_resolution = taskMaxResolution.trim();
      if (taskAutoScope) payload.auto_scope = true;
      const extraArgsText = taskExtraArgs.trim();
      const hasExplicitGroupBy = /(?:^|\s)--group-by(?:\s|=)/.test(extraArgsText);
      if (taskPreferType === 'gif' || taskPreferType === 'static') {
        payload.prefer_type = taskPreferType;
      }
      if (!hasExplicitGroupBy) {
        const autoGroupBy = inferCrawlerAutoGroupBy(taskUrlValue);
        if (autoGroupBy) payload.group_by = autoGroupBy;
      }
      if (extraArgsText) payload.extra_args = extraArgsText;

      const logEvery = parsePositiveInt(taskLogEvery);
      if (logEvery !== null) payload.google_photos_log_every = logEvery;
      if (taskNextSelectors.trim()) {
        payload.google_photos_next_selectors = taskNextSelectors.trim();
      }

      const cookiesFile = (options.cookiesFile || '').trim();
      if (cookiesFile) payload.cookies_file = cookiesFile;
      if (options.loginVerifyBeforeCrawl) payload.login_verify_before_crawl = true;
      if ((options.loginVerifyUrl || '').trim())
        payload.login_verify_url = options.loginVerifyUrl?.trim();
      if ((options.loginFailAction || '').trim())
        payload.login_fail_action = options.loginFailAction;
      if (options.loginCapture) payload.login_capture = true;

      return payload;
    },
    [
      parsePositiveInt,
      taskAutoScope,
      taskDelay,
      taskDownloadMode,
      taskExcludeUrlRegex,
      taskExtraArgs,
      taskHostParallelLimit,
      taskExhaustive,
      taskImageTypes,
      taskIncludeUrlRegex,
      taskJs,
      taskLinksOnly,
      taskLogEvery,
      taskMaxPages,
      taskMaxResolution,
      taskMaxSize,
      taskMinResolution,
      taskMinSize,
      taskNextSelectors,
      taskOutput,
      taskPreferType,
      taskRetries,
      taskRetryFailedFrom,
      taskRangeChunkSizeMb,
      taskRangeWorkerLimit,
      taskScope,
      taskTemplate,
      taskTimeout,
      taskUrl,
      taskUrlQueueFile,
      taskWorkers,
    ],
  );

  const startTaskFromPayload = useCallback(
    async (
      payload: Record<string, unknown>,
      infoMessage: string | null = null,
    ): Promise<string> => {
      const raw = await crawlerSidecarStartTask(payload);
      const obj = asRecord(raw);
      const newTaskId = obj ? readStringField(obj, 'task_id').trim() : '';
      if (!newTaskId) {
        throw new Error(t('network.crawlerTask.startTaskFailed'));
      }

      applyStartedTaskState(newTaskId, obj);
      await refreshTaskData({ taskId: newTaskId, resetLogs: true, silent: true });
      setTaskError(null);
      setTaskInfo(infoMessage);
      return newTaskId;
    },
    [applyStartedTaskState, refreshTaskData, t],
  );

  const startCrawlerTaskWithRecovery = useCallback(
    async (payload: Record<string, unknown>, infoMessage: string | null = null): Promise<void> => {
      try {
        await startTaskFromPayload(payload, infoMessage);
      } catch (error) {
        const runningTaskId = extractRunningTaskIdFromError(error);
        if (runningTaskId) {
          try {
            const runningRaw = await crawlerSidecarGetTask(runningTaskId);
            const runningSnapshot = toTaskSnapshot(runningRaw);

            if (runningSnapshot && isTaskActiveStatus(runningSnapshot.status)) {
              taskCurrentIdRef.current = runningTaskId;
              setTaskCurrentId(runningTaskId);
              setTaskObservedRunningId(runningTaskId);
              setTaskLogs([]);
              setTaskLogOffset(0);
              setTaskImportCounts(EMPTY_IMPORT_COUNTS);
              setTaskSnapshot(runningSnapshot);
              await refreshTaskData({ taskId: runningTaskId, resetLogs: true, silent: true });
              setTaskError(null);
              setTaskInfo(t('network.crawlerTask.taskRunningDetected', { taskId: runningTaskId }));
              return;
            }

            const retryTaskId = await startTaskFromPayload(payload, infoMessage);
            setTaskInfo(
              t('network.crawlerTask.staleRunningRecovered', {
                taskId: runningTaskId,
                newTaskId: retryTaskId,
              }),
            );
          } catch (resolveError) {
            if (isSidecarTransportError(resolveError)) {
              try {
                await refreshSidecarStatus({ silent: true, withHealthCheck: true });
                const retryTaskId = await startTaskFromPayload(payload, infoMessage);
                setTaskInfo(
                  t('network.crawlerTask.staleRunningRecovered', {
                    taskId: runningTaskId,
                    newTaskId: retryTaskId,
                  }),
                );
              } catch (retryError) {
                setTaskError(formatUnknownError(retryError));
              }
            } else {
              setTaskError(formatUnknownError(resolveError));
            }
          }
        } else {
          setTaskError(formatUnknownError(error));
        }
      }
    },
    [refreshSidecarStatus, refreshTaskData, startTaskFromPayload, t],
  );

  const handleStartTask = useCallback(async () => {
    const taskUrlValue = taskUrl.trim();
    const queueFileValue = taskUrlQueueFile.trim();
    const retryFileValue = taskRetryFailedFrom.trim();

    if (!taskUrlValue && !queueFileValue && !retryFileValue) {
      setTaskError(t('network.crawlerTask.urlOrBatchRequired'));
      return;
    }
    if (!sidecarStatus?.base_url) {
      setTaskError(t('network.crawlerTask.connectServiceFirst'));
      return;
    }

    const payload = buildCrawlerTaskPayload();

    setIsTaskStarting(true);
    setTaskError(null);
    setTaskInfo(null);
    try {
      await startCrawlerTaskWithRecovery(payload);
    } finally {
      setIsTaskStarting(false);
    }
  }, [
    buildCrawlerTaskPayload,
    sidecarStatus?.base_url,
    startCrawlerTaskWithRecovery,
    t,
    taskRetryFailedFrom,
    taskUrl,
    taskUrlQueueFile,
  ]);

  const handleUseTelegramFallbackTask = useCallback(
    (url: string) => {
      setTaskUrl(url);
      setTaskUrlQueueFile('');
      setTaskRetryFailedFrom('');
      setTaskScope('page');
      setTaskError(null);
      setTaskInfo(t('network.crawlerTask.telegramFallbackApplied'));
    },
    [t],
  );

  const handleStartTelegramFallbackTask = useCallback(
    async (url: string) => {
      if (!sidecarStatus?.base_url) {
        setTaskError(t('network.crawlerTask.connectServiceFirst'));
        return;
      }

      const cookiesFile =
        cookieSettings.mode === 'file' ? String(cookieSettings.filePath || '').trim() : '';
      const payload = buildCrawlerTaskPayload({
        url,
        urlQueueFile: '',
        retryFailedFrom: '',
        scope: 'page',
        cookiesFile,
        loginVerifyBeforeCrawl: Boolean(cookiesFile),
        loginVerifyUrl: cookiesFile ? url : undefined,
        loginFailAction: cookiesFile ? 'stop' : undefined,
      });

      setTaskUrl(url);
      setTaskUrlQueueFile('');
      setTaskRetryFailedFrom('');
      setTaskScope('page');
      setIsTaskStarting(true);
      setTaskError(null);
      setTaskInfo(null);
      try {
        await startCrawlerTaskWithRecovery(
          payload,
          t('network.crawlerTask.telegramFallbackStartInfo'),
        );
      } finally {
        setIsTaskStarting(false);
      }
    },
    [
      buildCrawlerTaskPayload,
      cookieSettings.filePath,
      cookieSettings.mode,
      sidecarStatus?.base_url,
      startCrawlerTaskWithRecovery,
      t,
    ],
  );

  const handleStopTask = useCallback(async () => {
    if (!taskCurrentId.trim()) {
      setTaskError(t('network.crawlerTask.noTaskSelected'));
      return;
    }
    setIsTaskStopping(true);
    setTaskError(null);
    setTaskInfo(null);
    try {
      await crawlerSidecarStopTask(taskCurrentId);
      await refreshTaskData({ taskId: taskCurrentId });
    } catch (error) {
      setTaskError(formatUnknownError(error));
    } finally {
      setIsTaskStopping(false);
    }
  }, [refreshTaskData, t, taskCurrentId]);

  const handleClearTaskLogs = useCallback(() => {
    const keepOffset = taskSnapshot?.log_total ?? taskLogOffset;
    setTaskLogs([]);
    setTaskLogOffset(keepOffset > 0 ? keepOffset : 0);
  }, [taskLogOffset, taskSnapshot]);

  const buildImportPlan = useCallback(
    (items: TaskMediaBrowserItem[]) => {
      const counts: ImportMediaCounts = { ...EMPTY_IMPORT_COUNTS };
      const selectedKinds: Record<ImportMediaKind, boolean> = {
        image: taskImportImage,
        gif: taskImportGif,
        video: taskImportVideo,
        audio: taskImportAudio,
      };
      const selectedItems: TaskMediaBrowserItem[] = [];

      for (const item of items) {
        counts[item.kind] += 1;
        if (selectedKinds[item.kind]) {
          selectedItems.push(item);
        }
      }

      return { counts, selectedItems };
    },
    [taskImportAudio, taskImportGif, taskImportImage, taskImportVideo],
  );

  const loadTaskMediaBrowserData = useCallback(async (taskId: string) => {
    const raw = await crawlerSidecarCollectTaskLinks(taskId, 5000);
    const obj = asRecord(raw);
    const urls = obj ? readStringArrayField(obj, 'urls') : [];
    const structuredItems = obj ? parseTaskMediaBrowserItemsFromPayload(obj.items) : [];
    const totalUrls = obj
      ? (readNumberField(obj, 'total_urls') ?? Math.max(urls.length, structuredItems.length))
      : Math.max(urls.length, structuredItems.length);
    const outputDir = obj ? readStringField(obj, 'output_dir') : '';
    const sourceFile = obj ? readStringField(obj, 'source_file') : '';

    if (structuredItems.length > 0) {
      return {
        items: mergeCrawlerMediaItems(structuredItems, urls, sourceFile),
        totalUrls,
        outputDir,
        sourceFile,
      };
    }

    const candidateFiles = Array.from(
      new Set(
        [
          sourceFile,
          joinPathParts(outputDir, 'download_report.csv'),
          joinPathParts(joinPathParts(outputDir, 'data'), 'download_report.csv'),
          joinPathParts(outputDir, 'image_links.csv'),
          joinPathParts(joinPathParts(outputDir, 'data'), 'image_links.csv'),
          joinPathParts(outputDir, 'preview_links.csv'),
          joinPathParts(joinPathParts(outputDir, 'data'), 'preview_links.csv'),
        ].filter((value) => value.trim()),
      ),
    );

    let parsedItems: TaskMediaBrowserItem[] = [];
    for (const filePath of candidateFiles) {
      try {
        const text = await readTextFile(filePath);
        parsedItems = parseCrawlerMediaCsv(text, filePath);
        if (parsedItems.length > 0) {
          break;
        }
      } catch {
        // Ignore missing optional report files.
      }
    }

    return {
      items: mergeCrawlerMediaItems(parsedItems, urls, sourceFile),
      totalUrls,
      outputDir,
      sourceFile,
    };
  }, []);
  const loadFolderMediaBrowserData = useCallback(async (folderPath: string) => {
    const folder = folderPath.trim();
    const dataDir = joinPathParts(folder, 'data');
    const candidateFiles = [
      joinPathParts(dataDir, 'download_report.csv'),
      joinPathParts(folder, 'download_report.csv'),
      joinPathParts(dataDir, 'image_links.csv'),
      joinPathParts(folder, 'image_links.csv'),
      joinPathParts(dataDir, 'preview_links.csv'),
      joinPathParts(folder, 'preview_links.csv'),
      joinPathParts(dataDir, 'image_links.txt'),
      joinPathParts(folder, 'image_links.txt'),
    ];
    const reportCandidates = [
      joinPathParts(dataDir, 'preview_report.html'),
      joinPathParts(folder, 'preview_report.html'),
    ];

    const scanStart = performance.now();
    const detectedFiles: string[] = [];
    const missingFiles: string[] = [];
    let previewReportPath = '';
    let sourceFile = '';
    let items: TaskMediaBrowserItem[] = [];
    for (const filePath of candidateFiles) {
      try {
        const text = await readTextFile(filePath);
        detectedFiles.push(filePath);
        if (/\.(csv)$/i.test(filePath)) {
          items = parseCrawlerMediaCsv(text, filePath);
        } else {
          items = mergeCrawlerMediaItems([], text.split(/\r?\n/), filePath);
        }
        if (items.length > 0) {
          sourceFile = filePath;
          break;
        }
      } catch {
        missingFiles.push(filePath);
      }
    }

    for (const filePath of reportCandidates) {
      try {
        await readTextFile(filePath);
        previewReportPath = filePath;
        break;
      } catch {
        missingFiles.push(filePath);
      }
    }

    return {
      items,
      totalUrls: items.length,
      outputDir: folder,
      sourceFile,
      dataDir,
      detectedFiles,
      missingFiles,
      previewReportPath,
      scanMs: Math.max(0, Math.round(performance.now() - scanStart)),
    };
  }, []);

  const taskMediaBrowserCounts = useMemo<ImportMediaCounts>(() => {
    const counts: ImportMediaCounts = { ...EMPTY_IMPORT_COUNTS };
    for (const item of taskMediaBrowserItems) {
      counts[item.kind] += 1;
    }
    return counts;
  }, [taskMediaBrowserItems]);

  const taskHistoryFolderDetectedFileGroups = useMemo(() => {
    const groups: Record<'CSV' | 'TXT' | 'HTML' | 'Other', string[]> = {
      CSV: [],
      TXT: [],
      HTML: [],
      Other: [],
    };
    for (const filePath of taskHistoryFolderDetectedFiles) {
      groups[classifyHistoryFileGroup(filePath)].push(filePath);
    }
    return groups;
  }, [taskHistoryFolderDetectedFiles]);

  const taskHistoryFolderMissingFileGroups = useMemo(() => {
    const groups: Record<'CSV' | 'TXT' | 'HTML' | 'Other', string[]> = {
      CSV: [],
      TXT: [],
      HTML: [],
      Other: [],
    };
    for (const filePath of taskHistoryFolderMissingFiles) {
      groups[classifyHistoryFileGroup(filePath)].push(filePath);
    }
    return groups;
  }, [taskHistoryFolderMissingFiles]);

  const taskMediaBrowserFilteredItems = useMemo(() => {
    const byType =
      taskMediaBrowserFilter === 'all'
        ? taskMediaBrowserItems
        : taskMediaBrowserItems.filter((item) => item.kind === taskMediaBrowserFilter);
    if (taskMediaBrowserMetaFilter === 'with-title') {
      return byType.filter((item) => Boolean(item.pageTitle?.trim()));
    }
    if (taskMediaBrowserMetaFilter === 'with-page') {
      return byType.filter((item) => Boolean(item.pageUrl?.trim()));
    }
    if (taskMediaBrowserMetaFilter === 'with-file') {
      return byType.filter((item) => Boolean(item.fileName?.trim()));
    }
    if (taskMediaBrowserMetaFilter === 'with-path') {
      return byType.filter((item) => Boolean(item.savedAbsolutePath?.trim()));
    }
    if (taskMediaBrowserMetaFilter === 'downloaded') {
      return byType.filter((item) => {
        const status = item.status?.trim().toLowerCase() || '';
        return status === 'success' || Boolean(item.savedAbsolutePath?.trim());
      });
    }
    return byType;
  }, [taskMediaBrowserFilter, taskMediaBrowserItems, taskMediaBrowserMetaFilter]);

  const taskMediaBrowserVisibleItems = useMemo(
    () => taskMediaBrowserFilteredItems.slice(0, taskMediaBrowserVisibleCount),
    [taskMediaBrowserFilteredItems, taskMediaBrowserVisibleCount],
  );

  const taskMediaViewerItem = useMemo(
    () => taskMediaBrowserFilteredItems[taskMediaViewerIndex] ?? null,
    [taskMediaBrowserFilteredItems, taskMediaViewerIndex],
  );
  const canLoadMoreTaskMediaBrowser =
    taskMediaBrowserVisibleCount < taskMediaBrowserFilteredItems.length;

  const handleTaskMediaBrowserLoadMore = useCallback(() => {
    setTaskMediaBrowserVisibleCount((prev) => prev + TASK_MEDIA_BROWSER_PAGE_SIZE);
  }, []);

  const expandAllVisibleTaskMediaBrowser = useCallback(() => {
    setTaskMediaBrowserExpandedKeys((prev) => {
      const next = new Set(prev);
      for (let index = 0; index < taskMediaBrowserVisibleItems.length; index += 1) {
        next.add(getTaskMediaItemKey(taskMediaBrowserVisibleItems[index], index));
      }
      return next;
    });
    setTaskMediaBrowserDetailsDefault('expanded');
  }, [taskMediaBrowserVisibleItems]);

  const collapseAllTaskMediaBrowser = useCallback(() => {
    setTaskMediaBrowserExpandedKeys(new Set());
    setTaskMediaBrowserDetailsDefault('collapsed');
  }, []);

  const handleOpenTaskMediaViewer = useCallback((index: number) => {
    setTaskMediaViewerIndex(index);
    setIsTaskMediaViewerOpen(true);
  }, []);

  const handleTaskMediaViewerChange = useCallback(
    (delta: number) => {
      if (taskMediaBrowserFilteredItems.length === 0) return;
      setTaskMediaViewerIndex((prev) => {
        const next = prev + delta;
        if (next < 0) return 0;
        if (next >= taskMediaBrowserFilteredItems.length)
          return taskMediaBrowserFilteredItems.length - 1;
        return next;
      });
    },
    [taskMediaBrowserFilteredItems.length],
  );

  const toggleTaskMediaBrowserExpanded = useCallback((itemKey: string) => {
    setTaskMediaBrowserExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(itemKey)) {
        next.delete(itemKey);
      } else {
        next.add(itemKey);
      }
      return next;
    });
  }, []);

  const handleOpenTaskMediaUrl = useCallback(async (url: string) => {
    try {
      await openUrl(url);
    } catch (error) {
      setTaskMediaBrowserError(formatUnknownError(error));
    }
  }, []);

  const handleRevealTaskHistoryFile = useCallback(async (filePath: string) => {
    try {
      await revealItemInDir(filePath);
    } catch (error) {
      setTaskMediaBrowserError(formatUnknownError(error));
    }
  }, []);

  const handleOpenTaskHistoryPreviewReport = useCallback(async (filePath: string) => {
    try {
      const normalized = filePath.replace(/\\/g, '/');
      await openUrl(`file://${normalized.startsWith('/') ? '' : '/'}${normalized}`);
    } catch (error) {
      try {
        await revealItemInDir(filePath);
      } catch (revealError) {
        setTaskMediaBrowserError(formatUnknownError(revealError || error));
      }
    }
  }, []);

  const handleCopyTaskPath = useCallback(
    async (pathValue: string) => {
      try {
        await navigator.clipboard.writeText(pathValue);
        setTaskMediaBrowserInfo(t('network.crawlerTask.pathCopied', { path: pathValue }));
        setTaskMediaBrowserError(null);
      } catch (error) {
        setTaskMediaBrowserError(formatUnknownError(error));
      }
    },
    [t],
  );

  const applyHistoryFolderMediaData = useCallback(
    (
      folderPath: string,
      mediaData: {
        items: TaskMediaBrowserItem[];
        totalUrls: number;
        outputDir: string;
        sourceFile: string;
        dataDir: string;
        detectedFiles: string[];
        missingFiles: string[];
        previewReportPath: string;
        scanMs: number;
      },
    ) => {
      setTaskMediaBrowserItems(mediaData.items);
      setTaskMediaBrowserOutputDir(mediaData.outputDir);
      setTaskMediaBrowserSourceFile(mediaData.sourceFile);
      setTaskMediaBrowserSourceMode('folder');
      setTaskHistoryFolderDataDir(mediaData.dataDir);
      setTaskHistoryFolderDetectedFiles(mediaData.detectedFiles);
      setTaskHistoryFolderMissingFiles(mediaData.missingFiles);
      setTaskHistoryFolderPreviewReportPath(mediaData.previewReportPath);
      setTaskHistoryFolderScanMs(mediaData.scanMs);
      setTaskHistoryFolderScannedAt(Date.now());
      setTaskMediaBrowserFilter('all');
      setTaskMediaBrowserMetaFilter('all');
      setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
      setTaskMediaBrowserExpandedKeys(
        taskMediaBrowserDetailsDefault === 'expanded'
          ? new Set(mediaData.items.map((item, index) => getTaskMediaItemKey(item, index)))
          : new Set(),
      );

      if (mediaData.items.length === 0) {
        setTaskMediaBrowserInfo(null);
        setTaskMediaBrowserError(
          mediaData.detectedFiles.length === 0
            ? t('network.crawlerTask.historyFolderDataMissing', { folder: folderPath })
            : t('network.crawlerTask.historyFolderNoMediaLinks', {
                count: mediaData.detectedFiles.length,
                source: mediaData.detectedFiles.join(' | '),
              }),
        );
      } else {
        setTaskMediaBrowserError(null);
        setTaskMediaBrowserInfo(
          t('network.crawlerTask.historyFolderLoaded', {
            shown: mediaData.items.length,
            folder: folderPath,
          }),
        );
      }
    },
    [t, taskMediaBrowserDetailsDefault],
  );

  const scanHistoryFolderMediaBrowser = useCallback(
    async (folderPath: string) => {
      const mediaData = await loadFolderMediaBrowserData(folderPath);
      applyHistoryFolderMediaData(folderPath, mediaData);
      return mediaData;
    },
    [applyHistoryFolderMediaData, loadFolderMediaBrowserData],
  );

  const handleLoadTaskMediaBrowser = useCallback(async () => {
    const currentTaskId = taskCurrentId.trim();
    if (!currentTaskId) {
      setTaskMediaBrowserError(t('network.crawlerTask.noTaskSelected'));
      return;
    }

    setIsTaskMediaBrowserLoading(true);
    setTaskMediaBrowserError(null);
    setTaskMediaBrowserInfo(t('network.crawlerTask.mediaBrowserLoading'));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const mediaData = await loadTaskMediaBrowserData(currentTaskId);
      setTaskMediaBrowserItems(mediaData.items);
      setTaskMediaBrowserOutputDir(mediaData.outputDir);
      setTaskMediaBrowserSourceFile(mediaData.sourceFile);
      setTaskMediaBrowserSourceMode('task');
      const loadedResolvedDir =
        mediaData.items.map((item) => resolveTaskMediaItemDir(item)).find(Boolean) || '';
      if (loadedResolvedDir) {
        setTaskResolvedMediaDir(loadedResolvedDir);
      }
      setTaskMediaBrowserFilter('all');
      setTaskMediaBrowserMetaFilter('all');
      setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
      setTaskMediaBrowserExpandedKeys(
        taskMediaBrowserDetailsDefault === 'expanded'
          ? new Set(mediaData.items.map((item, index) => getTaskMediaItemKey(item, index)))
          : new Set(),
      );

      if (mediaData.items.length === 0) {
        setTaskMediaBrowserInfo(null);
        setTaskMediaBrowserError(
          isTaskActiveStatus(taskSnapshot?.status)
            ? t('network.crawlerTask.previewLinksPending')
            : t('network.crawlerTask.noImportableLinks'),
        );
      } else {
        setTaskMediaBrowserInfo(
          t('network.crawlerTask.mediaBrowserLoaded', {
            shown: mediaData.items.length,
            total: mediaData.totalUrls,
          }),
        );
      }
    } catch (error) {
      setTaskMediaBrowserError(formatUnknownError(error));
    } finally {
      setIsTaskMediaBrowserLoading(false);
    }
  }, [
    loadTaskMediaBrowserData,
    t,
    taskCurrentId,
    taskSnapshot?.status,
    taskMediaBrowserDetailsDefault,
  ]);

  const handleLoadHistoryFolderMediaBrowser = useCallback(async () => {
    const folderPath = taskHistoryFolderPath.trim();
    if (!folderPath) {
      setTaskMediaBrowserError(t('network.crawlerTask.historyFolderRequired'));
      return;
    }

    setIsTaskMediaBrowserLoading(true);
    setTaskMediaBrowserError(null);
    setTaskMediaBrowserInfo(t('network.crawlerTask.mediaBrowserLoading'));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      await scanHistoryFolderMediaBrowser(folderPath);
    } catch (error) {
      setTaskMediaBrowserError(formatUnknownError(error));
    } finally {
      setIsTaskMediaBrowserLoading(false);
    }
  }, [scanHistoryFolderMediaBrowser, t, taskHistoryFolderPath]);

  useEffect(() => {
    const folderPath = taskHistoryFolderPath.trim();
    if (!folderPath) return;

    let cancelled = false;
    const run = async () => {
      setIsTaskMediaBrowserLoading(true);
      setTaskMediaBrowserError(null);
      setTaskMediaBrowserInfo(t('network.crawlerTask.mediaBrowserLoading'));
      try {
        await scanHistoryFolderMediaBrowser(folderPath);
      } catch (error) {
        if (!cancelled) {
          setTaskMediaBrowserError(formatUnknownError(error));
        }
      } finally {
        if (!cancelled) {
          setIsTaskMediaBrowserLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [scanHistoryFolderMediaBrowser, t, taskHistoryFolderPath]);

  const handleImportHistoryFolderLinks = useCallback(
    async (startDownloadAfterImport: boolean) => {
      const folderPath = taskHistoryFolderPath.trim();
      if (!folderPath) {
        setTaskError(t('network.crawlerTask.historyFolderRequired'));
        return;
      }
      if (!taskImportImage && !taskImportGif && !taskImportVideo && !taskImportAudio) {
        setTaskError(t('network.crawlerTask.selectImportType'));
        return;
      }

      setIsTaskImporting(true);
      setTaskError(null);
      setTaskInfo(null);
      try {
        const mediaData = await scanHistoryFolderMediaBrowser(folderPath);
        const { items, totalUrls, sourceFile, detectedFiles } = mediaData;

        if (items.length === 0) {
          setTaskImportCounts(EMPTY_IMPORT_COUNTS);
          setTaskError(
            detectedFiles.length === 0
              ? t('network.crawlerTask.historyFolderDataMissing', { folder: folderPath })
              : t('network.crawlerTask.historyFolderNoMediaLinks', {
                  count: detectedFiles.length,
                  source: detectedFiles.join(' | '),
                }),
          );
          return;
        }

        const { counts, selectedItems } = buildImportPlan(items);
        setTaskImportCounts(counts);
        if (selectedItems.length === 0) {
          setTaskError(t('network.crawlerTask.noLinksAfterFilter'));
          return;
        }

        const folderName = sanitizeFolderName(
          folderPath.split(/[/]/).filter(Boolean).pop() || 'history-folder',
          'history-folder',
        );
        const added = await addUniversalMediaItems(
          selectedItems.map((item) => ({
            url: item.url,
            dedupeKey: item.dedupeKey,
            title: item.fileName?.trim() || item.pageTitle?.trim() || item.url,
            outputSubfolder: item.pageTitle?.trim()
              ? deriveCrawlerFolderName(item, folderName)
              : folderName,
            extractor: 'direct-media',
            thumbnail: item.kind === 'image' || item.kind === 'gif' ? item.url : undefined,
            refererUrl: item.pageUrl?.trim() || undefined,
          })),
        );
        if (startDownloadAfterImport && added > 0) {
          await startUniversalDownload();
        }

        setTaskInfo(
          added > 0
            ? t('network.crawlerTask.importedOk', {
                added,
                total: selectedItems.length,
                source: sourceFile || folderPath,
              })
            : t('network.crawlerTask.importedDuplicateOnly', {
                total: totalUrls,
                source: sourceFile || folderPath,
              }),
        );
      } catch (error) {
        setTaskError(formatUnknownError(error));
      } finally {
        setIsTaskImporting(false);
      }
    },
    [
      addUniversalMediaItems,
      buildImportPlan,
      scanHistoryFolderMediaBrowser,
      startUniversalDownload,
      t,
      taskHistoryFolderPath,
      taskImportAudio,
      taskImportGif,
      taskImportImage,
      taskImportVideo,
    ],
  );

  const handleRetryFailedTaskDownloads = useCallback(async () => {
    const currentTaskId = taskCurrentId.trim();
    const isFolderMode = taskMediaBrowserSourceMode === 'folder';
    const folderPath = taskHistoryFolderPath.trim();

    if (!currentTaskId && !isFolderMode) {
      setTaskError(t('network.crawlerTask.noTaskSelected'));
      return;
    }

    setIsTaskRetryingFailedDownloads(true);
    setTaskError(null);
    try {
      // Gather media data from whichever source is active.
      // In folder mode, ALWAYS reload from disk to avoid stale cached data.
      let mediaData: {
        items: TaskMediaBrowserItem[];
        outputDir: string;
        sourceFile: string;
      };

      if (isFolderMode && folderPath) {
        // Always reload folder data fresh to get the latest failed_downloads.txt
        const folderData = await loadFolderMediaBrowserData(folderPath);
        applyHistoryFolderMediaData(folderPath, folderData);
        mediaData = {
          items: folderData.items,
          outputDir: folderData.outputDir,
          sourceFile: folderData.sourceFile,
        };
      } else if (taskMediaBrowserItems.length > 0) {
        mediaData = {
          items: taskMediaBrowserItems,
          outputDir: taskMediaBrowserOutputDir,
          sourceFile: taskMediaBrowserSourceFile,
        };
      } else if (currentTaskId) {
        const taskData = await loadTaskMediaBrowserData(currentTaskId);
        mediaData = taskData;
      } else {
        setTaskInfo(t('network.crawlerTask.retryFailedDownloadsEmpty'));
        return;
      }

      if (taskMediaBrowserItems.length === 0) {
        setTaskMediaBrowserItems(mediaData.items);
        setTaskMediaBrowserOutputDir(mediaData.outputDir);
        setTaskMediaBrowserSourceFile(mediaData.sourceFile);
        if (!isFolderMode) {
          setTaskMediaBrowserSourceMode('task');
        }
      }

      // Step 1: Check if there are failed items already in Universal queue
      // that belong to THIS source (match both URL and output context).
      const mediaUrls = new Set(mediaData.items.map((item) => item.url));
      const currentOutputDir = mediaData.outputDir;

      console.log(
        '[RetryFailed] Step 1 - isFolderMode:',
        isFolderMode,
        'mediaUrls.size:',
        mediaUrls.size,
        'currentOutputDir:',
        currentOutputDir,
        'universalItems.length:',
        universalItems.length,
        'universalErrors:',
        universalItems.filter((i) => i.status === 'error').length,
      );

      const failedIds = universalItems
        .filter((item) => {
          if (item.status !== 'error') return false;
          if (!mediaUrls.has(item.url)) return false;
          // In folder mode, verify the item belongs to the current source
          // by checking that its output path relates to the current output dir.
          // This prevents retrying old failures from a different crawl session.
          if (isFolderMode && currentOutputDir) {
            const itemOutputPath = item.settings?.outputPath || '';
            const folderBaseName = currentOutputDir.split(/[\\/]/).filter(Boolean).pop() || '';
            if (folderBaseName && itemOutputPath && !itemOutputPath.includes(folderBaseName)) {
              return false;
            }
          }
          return true;
        })
        .map((item) => item.id);

      console.log('[RetryFailed] Step 1 result - failedIds.length:', failedIds.length);

      if (failedIds.length > 0) {
        const retryResult = retryFailedUniversalDownloads(failedIds);
        if (retryResult.reason === 'busy') {
          setTaskInfo(t('network.crawlerTask.retryFailedDownloadsBusy'));
          return;
        }
        if (retryResult.acceptedCount <= 0) {
          setTaskInfo(t('network.crawlerTask.retryFailedDownloadsEmpty'));
          return;
        }
        setTaskInfo(
          t('network.crawlerTask.retryFailedDownloadsDone', { count: retryResult.acceptedCount }),
        );
        return;
      }

      // Step 2: Locate failed_downloads.txt from available paths.
      const manualRetryFile = taskRetryFailedFrom.trim();
      const outputDir = mediaData.outputDir;
      let directRetryFile = '';
      let argsObj: Record<string, unknown> | null = null;

      console.log(
        '[RetryFailed] Step 2 - folder mode:',
        isFolderMode,
        'folderPath:',
        folderPath,
        'currentTaskId:',
        currentTaskId,
        'outputDir:',
        outputDir,
        'sourceFile:',
        mediaData.sourceFile,
        'manualRetryFile:',
        manualRetryFile,
        'mediaData.items.length:',
        mediaData.items.length,
      );

      // In folder mode, skip sidecar task lookup – we want to read the file
      // directly from the folder and import into Universal.
      if (currentTaskId && !isFolderMode) {
        try {
          const rawTask = await crawlerSidecarGetTask(currentTaskId);
          const taskObj = asRecord(rawTask);
          argsObj = asRecord(taskObj?.args);
          directRetryFile = argsObj ? readStringField(argsObj, 'retry_failed_from').trim() : '';
        } catch {
          // Sidecar may not be available; continue.
        }
      }

      // Build candidate paths – order matters (most specific first).
      // Also include the history folder's dataDir directly.
      const retryCandidates = Array.from(
        new Set(
          [
            directRetryFile,
            manualRetryFile,
            mediaData.sourceFile
              ? joinPathParts(dirnamePath(mediaData.sourceFile), 'failed_downloads.txt')
              : '',
            outputDir
              ? joinPathParts(joinPathParts(outputDir, 'data'), 'failed_downloads.txt')
              : '',
            outputDir ? joinPathParts(outputDir, 'failed_downloads.txt') : '',
            // Also check the folderPath directly when it differs from outputDir
            folderPath && folderPath !== outputDir
              ? joinPathParts(joinPathParts(folderPath, 'data'), 'failed_downloads.txt')
              : '',
            folderPath && folderPath !== outputDir
              ? joinPathParts(folderPath, 'failed_downloads.txt')
              : '',
          ].filter((value) => value.trim()),
        ),
      );

      console.log('[RetryFailed] Candidates:', retryCandidates);

      // ALL candidates must be verified on disk (including directRetryFile / manualRetryFile).
      let retryFilePath = '';
      const candidateResults: string[] = [];
      for (const candidate of retryCandidates) {
        try {
          const content = await readTextFile(candidate);
          const lineCount = content.split(/\r?\n/).filter((line) => line.trim()).length;
          candidateResults.push(`✓ ${candidate} (${lineCount} lines)`);
          if (lineCount > 0) {
            retryFilePath = candidate;
            break;
          }
        } catch (err) {
          candidateResults.push(
            `✗ ${candidate} (${err instanceof Error ? err.message : 'not found'})`,
          );
        }
      }

      console.log('[RetryFailed] Candidate results:', candidateResults);
      console.log('[RetryFailed] Selected retryFilePath:', retryFilePath);

      if (!retryFilePath) {
        // Show diagnostic info to help debug
        const diagMsg = `${t('network.crawlerTask.retryFailedDownloadsEmpty')}\n\nChecked paths:\n${candidateResults.join('\n')}`;
        setTaskInfo(diagMsg);
        return;
      }

      // Step 3: In folder mode (or without a sidecar task), read the file and
      // re-import the failed URLs directly into the Universal queue.
      if (isFolderMode || !argsObj) {
        let failedContent = '';
        try {
          failedContent = await readTextFile(retryFilePath);
        } catch {
          setTaskInfo(t('network.crawlerTask.retryFailedDownloadsEmpty'));
          return;
        }

        const allLines = failedContent
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);

        // Parse failed entries – support both JSON-per-line and plain-URL formats.
        interface FailedEntry {
          url: string;
          pageUrl?: string;
          pageTitle?: string;
          albumName?: string;
          outputSubdir?: string;
        }

        const failedEntries: FailedEntry[] = [];
        for (const line of allLines) {
          // Try JSON format first: {"url": "...", "page_url": "...", ...}
          if (line.startsWith('{')) {
            try {
              const obj = JSON.parse(line) as Record<string, unknown>;
              const url = typeof obj.url === 'string' ? obj.url.trim() : '';
              if (url && isHttpUrl(url)) {
                failedEntries.push({
                  url,
                  pageUrl: typeof obj.page_url === 'string' ? obj.page_url.trim() : undefined,
                  pageTitle: typeof obj.page_title === 'string' ? obj.page_title.trim() : undefined,
                  albumName: typeof obj.album_name === 'string' ? obj.album_name.trim() : undefined,
                  outputSubdir:
                    typeof obj.output_subdir === 'string' ? obj.output_subdir.trim() : undefined,
                });
              }
            } catch {
              // Not valid JSON, skip
            }
          } else if (isHttpUrl(line)) {
            // Plain URL format (backwards compatible)
            failedEntries.push({ url: line });
          }
        }

        console.log(
          '[RetryFailed] Step 3 - retryFilePath:',
          retryFilePath,
          'allLines:',
          allLines.length,
          'failedEntries:',
          failedEntries.length,
          'sample:',
          failedEntries.slice(0, 2),
        );

        if (failedEntries.length === 0) {
          setTaskInfo(t('network.crawlerTask.retryFailedDownloadsEmpty'));
          return;
        }

        const retryBaseOutputPath = (folderPath || outputDir).trim();
        const defaultFolderName = sanitizeFolderName(
          retryBaseOutputPath.split(/[\\/]/).filter(Boolean).pop() || 'retry',
          'retry',
        );
        const added = await addUniversalMediaItems(
          failedEntries.map((entry) => {
            const matchingItem = mediaData.items.find((mi) => mi.url === entry.url);
            // Prefer metadata from the failed record, fall back to media browser data
            const title =
              entry.pageTitle ||
              matchingItem?.fileName?.trim() ||
              matchingItem?.pageTitle?.trim() ||
              entry.url;
            const subfolder =
              entry.outputSubdir ||
              entry.albumName ||
              (matchingItem?.pageTitle?.trim()
                ? deriveCrawlerFolderName(matchingItem, defaultFolderName)
                : defaultFolderName);
            return {
              url: entry.url,
              dedupeKey:
                matchingItem?.dedupeKey ||
                buildTaskMediaDedupeKey({
                  url: entry.url,
                  pageUrl: entry.pageUrl || matchingItem?.pageUrl,
                  pageTitle: entry.pageTitle || matchingItem?.pageTitle,
                  fileName: matchingItem?.fileName,
                }),
              title,
              outputPathOverride: retryBaseOutputPath || undefined,
              outputSubfolder: subfolder,
              extractor: 'direct-media',
              thumbnail:
                matchingItem && (matchingItem.kind === 'image' || matchingItem.kind === 'gif')
                  ? matchingItem.url
                  : undefined,
              refererUrl: entry.pageUrl || matchingItem?.pageUrl?.trim() || undefined,
            };
          }),
        );

        if (added > 0) {
          await startUniversalDownload();
          setTaskInfo(
            `${t('network.crawlerTask.retryFailedDownloadsDone', { count: added })}
${t('network.crawlerTask.retryDestination', { path: retryBaseOutputPath || '-' })}`,
          );
        } else {
          setTaskInfo(t('network.crawlerTask.retryFailedDownloadsEmpty'));
        }
        return;
      }

      // Step 4: In task mode, start a new sidecar task with the retry file.
      setTaskRetryFailedFrom(retryFilePath);
      const inferredRetryOutput =
        outputDir.trim() ||
        folderPath.trim() ||
        (dirnamePath(retryFilePath).split(/[\\/]/).pop()?.toLowerCase() === 'data'
          ? dirnamePath(dirnamePath(retryFilePath))
          : dirnamePath(retryFilePath));
      const retryPayload: Record<string, unknown> = {
        ...argsObj,
        retry_failed_from: retryFilePath,
      };
      if (inferredRetryOutput) {
        retryPayload.output = inferredRetryOutput;
        setTaskInfo(t('network.crawlerTask.retryWillUseOutput', { path: inferredRetryOutput }));
      }
      delete retryPayload.task_id;
      delete retryPayload.crawler_script_path_used;

      const raw = await crawlerSidecarStartTask(retryPayload);
      const obj = asRecord(raw);
      const newTaskId = obj ? readStringField(obj, 'task_id').trim() : '';
      if (!newTaskId) {
        throw new Error(t('network.crawlerTask.startTaskFailed'));
      }

      taskCurrentIdRef.current = newTaskId;
      setTaskCurrentId(newTaskId);
      setTaskObservedRunningId(newTaskId);
      setTaskLogs([]);
      setTaskLogOffset(0);
      setTaskImportCounts(EMPTY_IMPORT_COUNTS);
      setTaskSnapshot({
        task_id: newTaskId,
        status: readTaskStatus(obj?.status),
        created_at: '',
        started_at: '',
        finished_at: '',
        exit_code: null,
        pid: readNumberField(obj ?? {}, 'pid'),
        log_total: 0,
      });
      await refreshTaskData({ taskId: newTaskId, resetLogs: true, silent: true });
      setTaskInfo(t('network.crawlerTask.retryFailedTaskStarted', { taskId: newTaskId }));
    } catch (error) {
      setTaskError(formatUnknownError(error));
    } finally {
      setIsTaskRetryingFailedDownloads(false);
    }
  }, [
    addUniversalMediaItems,
    applyHistoryFolderMediaData,
    loadFolderMediaBrowserData,
    loadTaskMediaBrowserData,
    refreshTaskData,
    retryFailedUniversalDownloads,
    startUniversalDownload,
    t,
    taskCurrentId,
    taskHistoryFolderPath,
    taskMediaBrowserItems,
    taskMediaBrowserOutputDir,
    taskMediaBrowserSourceFile,
    taskMediaBrowserSourceMode,
    taskRetryFailedFrom,
    universalItems,
  ]);

  const handleExportTaskMediaBrowser = useCallback(async () => {
    if (taskMediaBrowserFilteredItems.length === 0) {
      setTaskMediaBrowserError(t('network.crawlerTask.mediaBrowserNoMatch'));
      return;
    }

    setIsTaskMediaBrowserExporting(true);
    setTaskMediaBrowserError(null);
    try {
      const filePath = await save({
        defaultPath: `crawler-media-browser-${taskCurrentId || 'export'}.html`,
        filters: [{ name: 'HTML', extensions: ['html'] }],
        title: t('network.crawlerTask.mediaExportBrowser'),
      });
      if (!filePath) return;

      const title = `Crawler Media Browser - ${taskCurrentId || 'export'}`;
      const html = buildTaskMediaBrowserHtml(taskMediaBrowserFilteredItems, title);
      await writeTextFile(filePath, html);
      setTaskMediaBrowserInfo(
        t('network.crawlerTask.mediaExportBrowserDone', {
          count: taskMediaBrowserFilteredItems.length,
        }),
      );
    } catch (error) {
      setTaskMediaBrowserError(formatUnknownError(error));
    } finally {
      setIsTaskMediaBrowserExporting(false);
    }
  }, [taskCurrentId, taskMediaBrowserFilteredItems, t]);

  const handleExportTaskMediaLinks = useCallback(async () => {
    if (taskMediaBrowserFilteredItems.length === 0) {
      setTaskMediaBrowserError(t('network.crawlerTask.mediaBrowserNoMatch'));
      return;
    }

    setIsTaskMediaLinksExporting(true);
    setTaskMediaBrowserError(null);
    try {
      const filePath = await save({
        defaultPath: `crawler-media-links-${taskCurrentId || 'export'}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
        title: t('network.crawlerTask.mediaExportLinks'),
      });
      if (!filePath) return;

      const csv = buildTaskMediaLinksCsv(taskMediaBrowserFilteredItems);
      await writeTextFile(filePath, csv);
      setTaskMediaBrowserInfo(
        t('network.crawlerTask.mediaExportLinksDone', {
          count: taskMediaBrowserFilteredItems.length,
        }),
      );
    } catch (error) {
      setTaskMediaBrowserError(formatUnknownError(error));
    } finally {
      setIsTaskMediaLinksExporting(false);
    }
  }, [taskCurrentId, taskMediaBrowserFilteredItems, t]);

  useEffect(() => {
    setTaskMediaBrowserItems([]);
    setTaskMediaBrowserFilter('all');
    setTaskMediaBrowserMetaFilter('all');
    setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
    setTaskMediaBrowserExpandedKeys(new Set());
    setTaskMediaBrowserError(null);
    setTaskMediaBrowserInfo(null);
    setTaskMediaBrowserOutputDir('');
    setTaskMediaBrowserSourceFile('');
    setTaskMediaBrowserSourceMode('task');
    setIsTaskMediaViewerOpen(false);
    setTaskMediaViewerIndex(0);
    setTaskMediaViewerFitMode('contain');
  }, []);

  useEffect(() => {
    if (taskMediaBrowserFilteredItems.length === 0) {
      setIsTaskMediaViewerOpen(false);
      setTaskMediaViewerIndex(0);
      return;
    }
    setTaskMediaViewerIndex((prev) => Math.min(prev, taskMediaBrowserFilteredItems.length - 1));
  }, [taskMediaBrowserFilteredItems]);

  useEffect(() => {
    setTaskMediaViewerFitMode('contain');
  }, []);

  useEffect(() => {
    if (!isTaskMediaViewerOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handleTaskMediaViewerChange(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleTaskMediaViewerChange(1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsTaskMediaViewerOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTaskMediaViewerChange, isTaskMediaViewerOpen]);

  const handleImportTaskLinks = useCallback(
    async (startDownloadAfterImport: boolean, isAutoMode = false) => {
      const currentTaskId = taskCurrentId.trim();
      if (!currentTaskId) {
        setTaskError(t('network.crawlerTask.noTaskSelected'));
        return;
      }
      if (!taskImportImage && !taskImportGif && !taskImportVideo && !taskImportAudio) {
        setTaskError(t('network.crawlerTask.selectImportType'));
        return;
      }

      setIsTaskImporting(true);
      setTaskError(null);
      setTaskInfo(null);
      try {
        const mediaData = await loadTaskMediaBrowserData(currentTaskId);
        const { items, totalUrls, sourceFile, outputDir } = mediaData;

        setTaskMediaBrowserItems(items);
        setTaskMediaBrowserOutputDir(outputDir);
        setTaskMediaBrowserSourceFile(sourceFile);
        setTaskMediaBrowserSourceMode('task');

        if (items.length === 0) {
          setTaskImportCounts(EMPTY_IMPORT_COUNTS);
          setTaskError(t('network.crawlerTask.noImportableLinks'));
          return;
        }

        const { counts, selectedItems } = buildImportPlan(items);
        setTaskImportCounts(counts);
        if (selectedItems.length === 0) {
          setTaskError(t('network.crawlerTask.noLinksAfterFilter'));
          return;
        }

        const added = await addUniversalMediaItems(
          selectedItems.map((item) => ({
            url: item.url,
            dedupeKey: item.dedupeKey,
            title: item.fileName?.trim() || item.pageTitle?.trim() || item.url,
            outputSubfolder: deriveCrawlerFolderName(item, currentTaskId),
            extractor: 'direct-media',
            thumbnail: item.kind === 'image' || item.kind === 'gif' ? item.url : undefined,
            refererUrl: item.pageUrl?.trim() || undefined,
          })),
        );
        if (startDownloadAfterImport && added > 0) {
          await startUniversalDownload();
        }

        const baseInfo =
          added > 0
            ? t('network.crawlerTask.importedOk', {
                added,
                total: selectedItems.length,
                source: sourceFile || '-',
              })
            : t('network.crawlerTask.importedDuplicateOnly', {
                total: selectedItems.length,
                source: sourceFile || '-',
              });
        if (isAutoMode) {
          setTaskInfo(
            `${t('network.crawlerTask.autoImportTag')} ${baseInfo} | ${t(
              'network.crawlerTask.importSummary',
              {
                total: totalUrls,
                image: counts.image,
                gif: counts.gif,
                video: counts.video,
                audio: counts.audio,
              },
            )}`,
          );
        } else {
          setTaskInfo(baseInfo);
        }
      } catch (error) {
        setTaskError(formatUnknownError(error));
      } finally {
        setIsTaskImporting(false);
      }
    },
    [
      addUniversalMediaItems,
      buildImportPlan,
      loadTaskMediaBrowserData,
      startUniversalDownload,
      t,
      taskCurrentId,
      taskImportAudio,
      taskImportGif,
      taskImportImage,
      taskImportVideo,
    ],
  );

  const sidecarRunning = sidecarStatus?.process_running ?? false;
  const taskStatus = taskSnapshot?.status ?? 'unknown';
  const taskRunning =
    taskStatus === 'running' || taskStatus === 'starting' || taskStatus === 'stopping';

  useEffect(() => {
    const currentTaskId = taskCurrentId.trim();
    if (!taskAutoImport || !currentTaskId) return;
    if ((taskSnapshot?.status ?? 'unknown') !== 'success') return;
    if (taskObservedRunningId !== currentTaskId) return;
    if (taskLastAutoImportTaskId === currentTaskId) return;
    if (taskAutoImportInFlightRef.current || isTaskImporting) return;

    taskAutoImportInFlightRef.current = true;
    setTaskLastAutoImportTaskId(currentTaskId);
    void (async () => {
      try {
        await handleImportTaskLinks(taskAutoImportStart, true);
      } finally {
        taskAutoImportInFlightRef.current = false;
      }
    })();
  }, [
    handleImportTaskLinks,
    isTaskImporting,
    taskAutoImport,
    taskAutoImportStart,
    taskCurrentId,
    taskLastAutoImportTaskId,
    taskObservedRunningId,
    taskSnapshot?.status,
  ]);

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('network.title')}
        description={t('network.description')}
        icon={<Globe className="w-5 h-5 text-white" />}
        iconClassName="bg-gradient-to-br from-blue-500 to-cyan-600 shadow-blue-500/20"
      >
        {/* Video Authentication */}
        <SettingsCard
          id="cookie-mode"
          highlight={highlightId === 'cookie-mode' || highlightId === 'cookie-browser'}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <KeyRound className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-medium">{t('network.videoAuth')}</span>
              <p className="text-xs text-muted-foreground mt-0.5">{t('network.videoAuthDesc')}</p>
            </div>
          </div>

          {/* Cookie Mode Selection */}
          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium">{t('network.cookieSource')}</p>
                <p className="text-xs text-muted-foreground">{t('network.cookieSourceDesc')}</p>
              </div>
              <Select
                value={cookieSettings.mode}
                onValueChange={(v) => updateCookieSettings({ mode: v as CookieMode })}
              >
                <SelectTrigger className="h-8 w-full sm:w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('network.off')}</SelectItem>
                  <SelectItem value="browser">{t('network.fromBrowser')}</SelectItem>
                  <SelectItem value="file">{t('network.fromFile')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Browser Selection */}
          {cookieSettings.mode === 'browser' && (
            <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-medium">{t('network.browser')}</p>
                  <p className="text-xs text-muted-foreground">
                    {isDetectingBrowsers
                      ? t('network.detecting')
                      : t('network.browsersDetected', { count: detectedBrowsers.length })}
                  </p>
                </div>
                <Select
                  value={cookieSettings.browser || ''}
                  onValueChange={(v) => updateCookieSettings({ browser: v as BrowserType })}
                  disabled={isDetectingBrowsers}
                >
                  <SelectTrigger className="h-8 w-full sm:w-[160px]">
                    <SelectValue placeholder={t('network.selectBrowser')} />
                  </SelectTrigger>
                  <SelectContent>
                    {detectedBrowsers.map((browser) => (
                      <SelectItem key={browser.browser_type} value={browser.browser_type}>
                        <div className="flex items-center gap-2">
                          <Globe className="w-3 h-3" />
                          {browser.name}
                        </div>
                      </SelectItem>
                    ))}
                    {detectedBrowsers.length === 0 &&
                      BROWSER_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Browser Profile */}
              {cookieSettings.browser !== 'safari' && (
                <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-medium">{t('network.profile')}</p>
                    <p className="text-xs text-muted-foreground">
                      {isLoadingProfiles
                        ? t('network.loading')
                        : browserProfiles.length > 0
                          ? t('network.profilesFound', { count: browserProfiles.length })
                          : t('network.noProfilesDetected')}
                    </p>
                  </div>
                  {!useCustomProfile && browserProfiles.length > 0 ? (
                    <Select
                      value={cookieSettings.browserProfile || ''}
                      onValueChange={(v) => {
                        if (v === '__custom__') {
                          setUseCustomProfile(true);
                          updateCookieSettings({ browserProfile: '' });
                        } else {
                          updateCookieSettings({ browserProfile: v });
                        }
                      }}
                      disabled={isLoadingProfiles}
                    >
                      <SelectTrigger className="h-8 w-full sm:w-[200px]">
                        <SelectValue placeholder={t('network.selectProfile')} />
                      </SelectTrigger>
                      <SelectContent>
                        {browserProfiles.map((profile) => (
                          <SelectItem key={profile.folder_name} value={profile.folder_name}>
                            {profile.folder_name === profile.display_name
                              ? profile.folder_name
                              : `${profile.folder_name} (${profile.display_name})`}
                          </SelectItem>
                        ))}
                        <SelectItem value="__custom__">
                          <span className="text-muted-foreground">{t('network.custom')}</span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex w-full items-center gap-1 sm:w-auto">
                      <Input
                        type="text"
                        value={cookieSettings.browserProfile || ''}
                        onChange={(e) => updateCookieSettings({ browserProfile: e.target.value })}
                        placeholder={t('network.profileName')}
                        className="h-8 w-full text-xs sm:w-[160px]"
                      />
                      {browserProfiles.length > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2"
                          onClick={() => {
                            setUseCustomProfile(false);
                            if (browserProfiles.length > 0) {
                              updateCookieSettings({
                                browserProfile: browserProfiles[0].folder_name,
                              });
                            }
                          }}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* macOS Permission Warning */}
              {navigator.platform.includes('Mac') && (
                <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 text-xs">
                    <p className="font-medium text-amber-500">{t('network.fullDiskAccess')}</p>
                    <p className="text-muted-foreground mt-0.5">
                      {t('network.fullDiskAccessDesc')}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1.5"
                        onClick={async () => {
                          try {
                            await invoke('open_macos_privacy_settings');
                          } catch (error) {
                            console.error('Failed to open settings:', error);
                          }
                        }}
                      >
                        <ExternalLink className="w-3 h-3" />
                        {t('network.openSettings')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Windows Browser Lock Warning */}
              {navigator.platform.includes('Win') && (
                <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 text-xs">
                    <p className="font-medium text-amber-500">{t('network.browserMustBeClosed')}</p>
                    <p className="text-muted-foreground mt-0.5">
                      {t('network.browserMustBeClosedDesc')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* File Selection */}
          {cookieSettings.mode === 'file' && (
            <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">{t('network.cookieFile')}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {cookieSettings.filePath || t('network.noFileSelected')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      const file = await open({
                        multiple: false,
                        filters: [{ name: 'Cookie files', extensions: ['txt'] }],
                        title: 'Select cookies.txt file',
                      });
                      if (file) {
                        updateCookieSettings({ filePath: file as string });
                      }
                    } catch (error) {
                      console.error('Failed to select cookie file:', error);
                    }
                  }}
                  className="w-full gap-1.5 sm:w-auto"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  {t('network.browse')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('network.cookieFileHelp')}{' '}
                <a
                  href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Get cookies.txt LOCALLY
                </a>
              </p>
            </div>
          )}
        </SettingsCard>

        {/* Crawler Sidecar */}
        <SettingsCard id="crawler-sidecar" highlight={highlightId === 'crawler-sidecar'}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Server className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-medium">{t('network.crawlerSidecar.title')}</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('network.crawlerSidecar.desc')}
              </p>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
            <p className="text-xs font-medium">{t('network.crawlerSidecar.connection')}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium mb-1">{t('network.crawlerSidecar.baseUrl')}</p>
                <Input
                  type="text"
                  value={sidecarBaseUrl}
                  onChange={(e) => setSidecarBaseUrl(e.target.value)}
                  placeholder={SIDECAR_DEFAULT_BASE_URL}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <p className="text-xs font-medium mb-1">
                  {t('network.crawlerSidecar.tokenOptional')}
                </p>
                <Input
                  type="password"
                  value={sidecarToken}
                  onChange={(e) => setSidecarToken(e.target.value)}
                  placeholder={t('network.crawlerSidecar.tokenPlaceholder')}
                  className="h-8 text-xs"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={handleAttachSidecar}
                disabled={isSidecarAttaching || isSidecarStarting || isSidecarStopping}
              >
                {isSidecarAttaching ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerSidecar.attach')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => void refreshSidecarStatus({ withHealthCheck: false })}
                disabled={isSidecarRefreshing}
              >
                {isSidecarRefreshing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerSidecar.refreshStatus')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => void handleSidecarHealthCheck()}
                disabled={isSidecarCheckingHealth}
              >
                {isSidecarCheckingHealth ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerSidecar.checkHealth')}
              </Button>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
            <p className="text-xs font-medium">{t('network.crawlerSidecar.serviceControl')}</p>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <Input
                type="text"
                value={sidecarScriptPath}
                onChange={(e) => setSidecarScriptPath(e.target.value)}
                placeholder={t('network.crawlerSidecar.scriptPathPlaceholder')}
                className="h-8 text-xs flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 w-full sm:w-auto"
                onClick={() => void handlePickSidecarScript()}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t('network.crawlerSidecar.browseScript')}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <div>
                <p className="text-xs font-medium mb-1">{t('network.crawlerSidecar.host')}</p>
                <Input
                  type="text"
                  value={sidecarHost}
                  onChange={(e) => setSidecarHost(e.target.value)}
                  placeholder={SIDECAR_DEFAULT_HOST}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <p className="text-xs font-medium mb-1">{t('network.crawlerSidecar.port')}</p>
                <Input
                  type="number"
                  value={sidecarPort}
                  onChange={(e) => setSidecarPort(e.target.value)}
                  placeholder={SIDECAR_DEFAULT_PORT}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <p className="text-xs font-medium mb-1">{t('network.crawlerSidecar.pythonBin')}</p>
                <Input
                  type="text"
                  value={sidecarPythonBin}
                  onChange={(e) => setSidecarPythonBin(e.target.value)}
                  placeholder={t('network.crawlerSidecar.pythonBinPlaceholder')}
                  className="h-8 text-xs"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={handleStartSidecar}
                disabled={isSidecarStarting || sidecarRunning}
              >
                {isSidecarStarting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerSidecar.startService')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={handleStopSidecar}
                disabled={isSidecarStopping || !sidecarRunning}
              >
                {isSidecarStopping ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Square className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerSidecar.stopService')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('network.crawlerSidecar.saveHint')}</p>
          </div>

          <div className="mt-3 pt-3 border-t border-border/50 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={
                  sidecarRunning
                    ? 'rounded px-2 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'rounded px-2 py-1 bg-muted text-muted-foreground'
                }
              >
                {t('network.crawlerSidecar.statusLabel')}:{' '}
                {sidecarRunning
                  ? t('network.crawlerSidecar.statusRunning')
                  : t('network.crawlerSidecar.statusStopped')}
              </span>
              <span
                className={
                  sidecarHealth === 'ok'
                    ? 'rounded px-2 py-1 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    : sidecarHealth === 'fail'
                      ? 'rounded px-2 py-1 bg-destructive/10 text-destructive'
                      : 'rounded px-2 py-1 bg-muted text-muted-foreground'
                }
              >
                {t('network.crawlerSidecar.healthLabel')}:{' '}
                {sidecarHealth === 'ok'
                  ? t('network.crawlerSidecar.healthOk')
                  : sidecarHealth === 'fail'
                    ? t('network.crawlerSidecar.healthFail')
                    : t('network.crawlerSidecar.healthUnknown')}
              </span>
              {sidecarStatus?.pid && (
                <span className="rounded px-2 py-1 bg-muted text-muted-foreground">
                  {t('network.crawlerSidecar.pidLabel')}: {sidecarStatus.pid}
                </span>
              )}
            </div>
            {sidecarError && (
              <div className="rounded p-2 text-xs bg-destructive/10 text-destructive flex items-start gap-1.5">
                <CircleOff className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  {t('network.crawlerSidecar.lastError')}: {sidecarError}
                </span>
              </div>
            )}
          </div>
        </SettingsCard>

        {/* Crawler Task */}
        <SettingsCard id="crawler-task" highlight={highlightId === 'crawler-task'}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Play className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-medium">{t('network.crawlerTask.title')}</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('network.crawlerTask.desc')}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('network.crawlerTask.capabilityHint')}
              </p>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
            <div>
              <p className="text-xs font-medium mb-1">{t('network.crawlerTask.url')}</p>
              <Input
                type="text"
                value={taskUrl}
                onChange={(e) => setTaskUrl(e.target.value)}
                placeholder={t('network.crawlerTask.urlPlaceholder')}
                className="h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <div>
                <p className="text-xs font-medium mb-1">{t('network.crawlerTask.queueFile')}</p>
                <Input
                  type="text"
                  value={taskUrlQueueFile}
                  onChange={(e) => setTaskUrlQueueFile(e.target.value)}
                  placeholder={t('network.crawlerTask.queueFilePlaceholder')}
                  className="h-8 text-xs"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 self-end"
                onClick={() => void handlePickTaskQueueFile()}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t('network.crawlerTask.queueFileBrowse')}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <div>
                <p className="text-xs font-medium mb-1">
                  {t('network.crawlerTask.retryFailedFrom')}
                </p>
                <Input
                  type="text"
                  value={taskRetryFailedFrom}
                  onChange={(e) => setTaskRetryFailedFrom(e.target.value)}
                  placeholder={t('network.crawlerTask.retryFailedPlaceholder')}
                  className="h-8 text-xs"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 self-end"
                onClick={() => void handlePickTaskRetryFile()}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t('network.crawlerTask.retryFileBrowse')}
              </Button>
            </div>
            <div>
              <p className="text-xs font-medium mb-1">{t('network.crawlerTask.output')}</p>
              <Input
                type="text"
                value={taskOutput}
                onChange={(e) => setTaskOutput(e.target.value)}
                placeholder="./output"
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-left transition hover:bg-muted/40"
              onClick={() => setTaskParamsPanelOpen((prev) => !prev)}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium">{t('network.crawlerTask.taskParamsPanel')}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t('network.crawlerTask.taskParamsSummary', {
                    scope: t(
                      taskScope === 'site'
                        ? 'network.crawlerTask.scopeSite'
                        : 'network.crawlerTask.scopePage',
                    ),
                    workers: taskWorkers || SIDECAR_DEFAULT_TASK_WORKERS,
                    types: taskImageTypes || SIDECAR_DEFAULT_TASK_IMAGE_TYPES,
                  })}
                </p>
              </div>
              <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {taskParamsPanelOpen
                  ? t('network.crawlerTask.taskParamsHide')
                  : t('network.crawlerTask.taskParamsShow')}
                {taskParamsPanelOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </span>
            </button>
            {taskParamsPanelOpen && (
              <div className="space-y-3">
                <p className="text-xs font-medium">{t('network.crawlerTask.options')}</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.scope')}</p>
                    <Select value={taskScope} onValueChange={(value) => setTaskScope(value)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="page">{t('network.crawlerTask.scopePage')}</SelectItem>
                        <SelectItem value="site">{t('network.crawlerTask.scopeSite')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.template')}</p>
                    <Select
                      value={taskTemplate}
                      onValueChange={(value) => {
                        setTaskTemplate(value);
                        // Mirror Python apply_template_defaults(): auto-fill fields
                        if (value === 'high_quality') {
                          if (!taskMinSize || taskMinSize === '') setTaskMinSize('300KB');
                          if (!taskMinResolution || taskMinResolution === '')
                            setTaskMinResolution('1200x800');
                          const w = Number.parseInt(taskWorkers, 10) || 4;
                          if (w < 6) setTaskWorkers('6');
                        } else if (value === 'fast_preview') {
                          const mp = Number.parseInt(taskMaxPages, 10) || 200;
                          if (mp > 20) setTaskMaxPages('20');
                          const w = Number.parseInt(taskWorkers, 10) || 4;
                          if (w > 4) setTaskWorkers('4');
                          const t = Number.parseInt(taskTimeout, 10) || 20;
                          if (t > 10) setTaskTimeout('10');
                        } else if (value === 'speed_mode') {
                          setTaskJs(false);
                          setTaskAutoScope(true);
                          const w = Number.parseInt(taskWorkers, 10) || 4;
                          setTaskWorkers(String(Math.min(Math.max(w, 10), 16)));
                          const t = Number.parseInt(taskTimeout, 10) || 20;
                          if (t > 12) setTaskTimeout('12');
                          const r = Number.parseInt(taskRetries, 10) || 2;
                          if (r > 2) setTaskRetries('2');
                          const d = Number.parseFloat(taskDelay) || 0.4;
                          if (d > 0.3) setTaskDelay('0.3');
                        } else if (value === 'strict_site') {
                          setTaskScope('site');
                        } else if (value === 'stable_large') {
                          const w = Number.parseInt(taskWorkers, 10) || 4;
                          setTaskWorkers(String(Math.min(Math.max(w, 4), 8)));
                          const t = Number.parseInt(taskTimeout, 10) || 20;
                          if (t < 20) setTaskTimeout('20');
                          const r = Number.parseInt(taskRetries, 10) || 2;
                          if (r < 4) setTaskRetries('4');
                          const d = Number.parseFloat(taskDelay) || 0.4;
                          if (d < 1.0) setTaskDelay('1.0');
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          {t('network.crawlerTask.templateNone')}
                        </SelectItem>
                        <SelectItem value="high_quality">
                          {t('network.crawlerTask.templateHighQuality')}
                        </SelectItem>
                        <SelectItem value="fast_preview">
                          {t('network.crawlerTask.templateFastPreview')}
                        </SelectItem>
                        <SelectItem value="speed_mode">
                          ⚡ {t('network.crawlerTask.templateSpeedMode')}
                        </SelectItem>
                        <SelectItem value="strict_site">
                          {t('network.crawlerTask.templateStrictSite')}
                        </SelectItem>
                        <SelectItem value="stable_large">
                          {t('network.crawlerTask.templateStableLarge')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                      {t('network.crawlerTask.templateHint')}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.workers')}</p>
                    <Input
                      type="number"
                      value={taskWorkers}
                      onChange={(e) => setTaskWorkers(e.target.value)}
                      placeholder={SIDECAR_DEFAULT_TASK_WORKERS}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.timeout')}</p>
                    <Input
                      type="number"
                      value={taskTimeout}
                      onChange={(e) => setTaskTimeout(e.target.value)}
                      placeholder={SIDECAR_DEFAULT_TASK_TIMEOUT}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.retries')}</p>
                    <Input
                      type="number"
                      value={taskRetries}
                      onChange={(e) => setTaskRetries(e.target.value)}
                      placeholder={SIDECAR_DEFAULT_TASK_RETRIES}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.delay')}</p>
                    <Input
                      type="number"
                      value={taskDelay}
                      onChange={(e) => setTaskDelay(e.target.value)}
                      placeholder={SIDECAR_DEFAULT_TASK_DELAY}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.maxPages')}</p>
                    <Input
                      type="number"
                      value={taskMaxPages}
                      onChange={(e) => setTaskMaxPages(e.target.value)}
                      placeholder={SIDECAR_DEFAULT_TASK_MAX_PAGES}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.logEvery')}</p>
                    <Input
                      type="number"
                      value={taskLogEvery}
                      onChange={(e) => setTaskLogEvery(e.target.value)}
                      placeholder={SIDECAR_DEFAULT_TASK_LOG_EVERY}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.preferType')}
                    </p>
                    <Select
                      value={taskPreferType}
                      onValueChange={(value) => setTaskPreferType(value)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          {t('network.crawlerTask.preferTypeNone')}
                        </SelectItem>
                        <SelectItem value="gif">
                          {t('network.crawlerTask.preferTypeGif')}
                        </SelectItem>
                        <SelectItem value="static">
                          {t('network.crawlerTask.preferTypeStatic')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.downloadMode')}
                    </p>
                    <Select
                      value={taskDownloadMode}
                      onValueChange={(value) => setTaskDownloadMode(value as TaskDownloadMode)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="segmented">
                          {t('network.crawlerTask.downloadModeSegmented')}
                        </SelectItem>
                        <SelectItem value="single">
                          {t('network.crawlerTask.downloadModeSingle')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                      {t('network.crawlerTask.downloadModeHint')}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.hostParallelLimit')}
                    </p>
                    <Input
                      type="number"
                      value={taskHostParallelLimit}
                      onChange={(e) => setTaskHostParallelLimit(e.target.value)}
                      placeholder={t('network.crawlerTask.hostParallelLimitPlaceholder')}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.rangeWorkerLimit')}
                    </p>
                    <Input
                      type="number"
                      value={taskRangeWorkerLimit}
                      onChange={(e) => setTaskRangeWorkerLimit(e.target.value)}
                      placeholder={t('network.crawlerTask.rangeWorkerLimitPlaceholder')}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.rangeChunkSizeMb')}
                    </p>
                    <Input
                      type="number"
                      value={taskRangeChunkSizeMb}
                      onChange={(e) => setTaskRangeChunkSizeMb(e.target.value)}
                      placeholder={t('network.crawlerTask.rangeChunkSizeMbPlaceholder')}
                      className="h-8 text-xs"
                    />
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                      {t('network.crawlerTask.rangeChunkHint')}
                      {taskTransferPreset &&
                      !taskHostParallelLimit.trim() &&
                      !taskRangeWorkerLimit.trim() &&
                      !taskRangeChunkSizeMb.trim()
                        ? ` ${t('network.crawlerTask.transferPresetHint', {
                            preset:
                              taskTransferPreset.label === 'google'
                                ? t('network.crawlerTask.transferPreset_google')
                                : t('network.crawlerTask.transferPreset_imgbb'),
                            host: taskTransferPreset.hostParallelLimit,
                            range: taskTransferPreset.rangeWorkerLimit,
                            chunk: taskTransferPreset.rangeChunkSizeMb,
                          })}`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.imageTypes')}
                    </p>
                    <Input
                      type="text"
                      value={taskImageTypes}
                      onChange={(e) => setTaskImageTypes(e.target.value)}
                      placeholder={SIDECAR_DEFAULT_TASK_IMAGE_TYPES}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.nextSelectors')}
                    </p>
                    <Input
                      type="text"
                      value={taskNextSelectors}
                      onChange={(e) => setTaskNextSelectors(e.target.value)}
                      placeholder={SIDECAR_DEFAULT_TASK_NEXT_SELECTORS}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.extraArgs')}</p>
                    <Input
                      type="text"
                      value={taskExtraArgs}
                      onChange={(e) => setTaskExtraArgs(e.target.value)}
                      placeholder={t('network.crawlerTask.extraArgsPlaceholder')}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.urlRegexInclude')}
                    </p>
                    <Input
                      type="text"
                      value={taskIncludeUrlRegex}
                      onChange={(e) => setTaskIncludeUrlRegex(e.target.value)}
                      placeholder="googleusercontent|imgbb|photos.google"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.urlRegexExclude')}
                    </p>
                    <Input
                      type="text"
                      value={taskExcludeUrlRegex}
                      onChange={(e) => setTaskExcludeUrlRegex(e.target.value)}
                      placeholder="thumb|avatar|icon|sprite"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.minSize')}</p>
                    <Input
                      type="text"
                      value={taskMinSize}
                      onChange={(e) => setTaskMinSize(e.target.value)}
                      placeholder="100kb"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t('network.crawlerTask.maxSize')}</p>
                    <Input
                      type="text"
                      value={taskMaxSize}
                      onChange={(e) => setTaskMaxSize(e.target.value)}
                      placeholder="20mb"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.minResolution')}
                    </p>
                    <Input
                      type="text"
                      value={taskMinResolution}
                      onChange={(e) => setTaskMinResolution(e.target.value)}
                      placeholder="1280x720"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">
                      {t('network.crawlerTask.maxResolution')}
                    </p>
                    <Input
                      type="text"
                      value={taskMaxResolution}
                      onChange={(e) => setTaskMaxResolution(e.target.value)}
                      placeholder="7680x4320"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                    <span className="text-xs">{t('network.crawlerTask.js')}</span>
                    <Switch checked={taskJs} onCheckedChange={setTaskJs} />
                  </div>
                  <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                    <span className="text-xs">{t('network.crawlerTask.exhaustive')}</span>
                    <Switch checked={taskExhaustive} onCheckedChange={setTaskExhaustive} />
                  </div>
                  <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                    <span className="text-xs">{t('network.crawlerTask.linksOnly')}</span>
                    <Switch checked={taskLinksOnly} onCheckedChange={setTaskLinksOnly} />
                  </div>
                  <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                    <span className="text-xs">{t('network.crawlerTask.autoScope')}</span>
                    <Switch checked={taskAutoScope} onCheckedChange={setTaskAutoScope} />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium">{t('network.crawlerTask.importFilters')}</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-xs">{t('network.crawlerTask.importImage')}</span>
                      <Switch checked={taskImportImage} onCheckedChange={setTaskImportImage} />
                    </div>
                    <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-xs">{t('network.crawlerTask.importGif')}</span>
                      <Switch checked={taskImportGif} onCheckedChange={setTaskImportGif} />
                    </div>
                    <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-xs">{t('network.crawlerTask.importVideo')}</span>
                      <Switch checked={taskImportVideo} onCheckedChange={setTaskImportVideo} />
                    </div>
                    <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-xs">{t('network.crawlerTask.importAudio')}</span>
                      <Switch checked={taskImportAudio} onCheckedChange={setTaskImportAudio} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-xs">{t('network.crawlerTask.autoImport')}</span>
                      <Switch checked={taskAutoImport} onCheckedChange={setTaskAutoImport} />
                    </div>
                    <div className="rounded border border-border/60 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-xs">{t('network.crawlerTask.autoImportStart')}</span>
                      <Switch
                        checked={taskAutoImportStart}
                        onCheckedChange={setTaskAutoImportStart}
                        disabled={!taskAutoImport}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('network.crawlerTask.importSummary', {
                      total:
                        taskImportCounts.image +
                        taskImportCounts.gif +
                        taskImportCounts.video +
                        taskImportCounts.audio,
                      image: taskImportCounts.image,
                      gif: taskImportCounts.gif,
                      video: taskImportCounts.video,
                      audio: taskImportCounts.audio,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('network.crawlerTask.extraArgsHelp')}
                  </p>
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={handleStartTask}
                disabled={isTaskStarting || !sidecarStatus?.base_url}
              >
                {isTaskStarting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerTask.start')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={handleStopTask}
                disabled={isTaskStopping || !taskRunning}
              >
                {isTaskStopping ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Square className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerTask.stop')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => void refreshTaskData()}
                disabled={isTaskRefreshing || !taskCurrentId}
              >
                {isTaskRefreshing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerTask.refresh')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={handleLoadLatestTask}
                disabled={isTaskLoadingLatest}
              >
                {isTaskLoadingLatest ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Server className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerTask.loadLatest')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={handleClearTaskLogs}
                disabled={taskLogs.length === 0}
              >
                <X className="w-3.5 h-3.5" />
                {t('network.crawlerTask.clearLogs')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => void handleImportTaskLinks(false)}
                disabled={isTaskImporting || !taskCurrentId || isUniversalDownloading}
              >
                {isTaskImporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerTask.importQueue')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => void handleImportTaskLinks(true)}
                disabled={isTaskImporting || !taskCurrentId || isUniversalDownloading}
              >
                {isTaskImporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerTask.importAndStart')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => void handleRetryFailedTaskDownloads()}
                disabled={
                  isTaskRetryingFailedDownloads ||
                  (!taskCurrentId &&
                    !(taskMediaBrowserSourceMode === 'folder' && taskHistoryFolderPath.trim()))
                }
              >
                {isTaskRetryingFailedDownloads ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerTask.retryFailedDownloads')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={handlePickTaskHistoryFolder}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t('network.crawlerTask.historyFolderSelect')}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded px-2 py-1 bg-muted text-muted-foreground">
                {t('network.crawlerTask.taskId')}: {taskCurrentId || '-'}
              </span>
              <span
                className={
                  taskStatus === 'success'
                    ? 'rounded px-2 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : taskStatus === 'failed' || taskStatus === 'error'
                      ? 'rounded px-2 py-1 bg-destructive/10 text-destructive'
                      : taskStatus === 'running' ||
                          taskStatus === 'starting' ||
                          taskStatus === 'stopping'
                        ? 'rounded px-2 py-1 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                        : 'rounded px-2 py-1 bg-muted text-muted-foreground'
                }
              >
                {t('network.crawlerTask.status')}: {t(`network.crawlerTask.status_${taskStatus}`)}
              </span>
              <span
                className={
                  taskPreviewLinkState === 'ready'
                    ? 'rounded px-2 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : taskPreviewLinkState === 'pending'
                      ? 'rounded px-2 py-1 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                      : taskPreviewLinkState === 'missing'
                        ? 'rounded px-2 py-1 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        : 'rounded px-2 py-1 bg-muted text-muted-foreground'
                }
              >
                {t('network.crawlerTask.previewLinks')}:{' '}
                {t(`network.crawlerTask.previewLinks_${taskPreviewLinkState}`)}
              </span>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
            <div className="rounded-md border border-border/60 bg-background/40 p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">{t('network.crawlerTask.taskStatusPanel')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setTaskStatusPanelOpen((value) => !value)}
                >
                  {taskStatusPanelOpen ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      {t('network.crawlerTask.taskSectionHide')}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      {t('network.crawlerTask.taskSectionShow')}
                    </>
                  )}
                </Button>
              </div>

              {taskStatusPanelOpen && (
                <>
                  <div className="mt-3 text-xs text-muted-foreground space-y-1">
                    <p>
                      {t('network.crawlerTask.createdAt')}: {taskSnapshot?.created_at || '-'}
                    </p>

                    <p>
                      {t('network.crawlerTask.startedAt')}: {taskSnapshot?.started_at || '-'}
                    </p>

                    <p>
                      {t('network.crawlerTask.finishedAt')}: {taskSnapshot?.finished_at || '-'}
                    </p>

                    <p>
                      {t('network.crawlerTask.outputDir')}: {taskPreviewLinkOutputDir || '-'}
                    </p>

                    <p>
                      {t('network.crawlerTask.artifactDataDir')}: {taskArtifactDataDir || '-'}
                    </p>

                    <p>
                      {t('network.crawlerTask.retryOutputDir')}: {taskRetryOutputDir || '-'}
                    </p>
                    <p>
                      {t('network.crawlerTask.previewFile')}: {taskPreviewLinkSourceFile || '-'}
                    </p>

                    {(taskCompletionSummary.downloaded !== null ||
                      taskCompletionSummary.failed !== null ||
                      taskCompletionSummary.filtered !== null) && (
                      <p>
                        {t('network.crawlerTask.taskCompleteSummary', {
                          downloaded:
                            taskCompletionSummary.downloaded === null
                              ? '-'
                              : taskCompletionSummary.downloaded,
                          failed:
                            taskCompletionSummary.failed === null
                              ? '-'
                              : taskCompletionSummary.failed,
                          filtered:
                            taskCompletionSummary.filtered === null
                              ? '-'
                              : taskCompletionSummary.filtered,
                        })}
                      </p>
                    )}
                    {(taskRangeSummary.ranged > 0 ||
                      taskRangeSummary.fallback > 0 ||
                      taskRangeSummary.retries > 0) && (
                      <p>
                        {t('network.crawlerTask.rangeSummary', {
                          ranged: taskRangeSummary.ranged,
                          fallback: taskRangeSummary.fallback,
                          retries: taskRangeSummary.retries,
                        })}
                      </p>
                    )}
                    {(taskRustTransferSummary.transfers > 0 ||
                      taskRustTransferSummary.fallback > 0 ||
                      taskRustTransferSummary.latestSpeedBps) && (
                      <p>
                        {t('network.crawlerTask.rustTransferSummary', {
                          transfers: taskRustTransferSummary.transfers,
                          fallback: taskRustTransferSummary.fallback,
                          mode: taskRustTransferSummary.latestMode || '-',
                          speed: formatBytesPerSecond(taskRustTransferSummary.latestSpeedBps),
                        })}
                      </p>
                    )}
                    {(taskRustTransferSummary.latestActive !== null ||
                      taskRustTransferSummary.policySegmentCap !== null) && (
                      <div className="rounded border border-cyan-500/20 bg-cyan-500/5 px-2 py-2 text-[11px] text-cyan-800 dark:text-cyan-300 space-y-1">
                        <p className="font-medium">
                          {t('network.crawlerTask.rustTransferPanelTitle')}
                        </p>
                        <p>
                          {t('network.crawlerTask.rustTransferSummary', {
                            transfers: taskRustTransferSummary.transfers,
                            fallback: taskRustTransferSummary.fallback,
                            mode: taskRustTransferSummary.latestMode || '-',
                            speed: formatBytesPerSecond(taskRustTransferSummary.latestSpeedBps),
                          })}
                        </p>
                        <p>
                          {t('network.crawlerTask.rustTransferDetailSummary', {
                            host: taskRustTransferSummary.policyHost || '-',
                            active: taskRustTransferSummary.latestActive ?? '-',
                            pending: taskRustTransferSummary.latestPending ?? '-',
                            ewma: formatBytesPerSecond(taskRustTransferSummary.latestEwmaBps),
                            segmentCap: taskRustTransferSummary.policySegmentCap ?? '-',
                            chunkCap: formatBytes(taskRustTransferSummary.policyChunkCap),
                            waits: taskRustTransferSummary.waitCount,
                            retries: taskRustTransferSummary.retryCount,
                            tunes: taskRustTransferSummary.tuneCount,
                            rebalances: taskRustTransferSummary.rebalanceCount,
                            throttles: taskRustTransferSummary.throttleCount,
                            slowWindows: taskRustTransferSummary.slowWindowCount,
                            restores: taskRustTransferSummary.restoreCount,
                          })}
                        </p>
                      </div>
                    )}
                  </div>
                  {taskError && (
                    <div className="rounded p-2 text-xs bg-destructive/10 text-destructive flex items-start gap-1.5">
                      <CircleOff className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />

                      <span>
                        {t('network.crawlerTask.lastError')}: {taskError}
                      </span>
                    </div>
                  )}
                  {taskInfo && (
                    <div className="rounded p-2 text-xs bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex items-start gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />

                      <span>{taskInfo}</span>
                    </div>
                  )}
                  {taskSourceMissingSummary.telegraphSourceMissing && (
                    <div className="rounded p-2 text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 space-y-2">
                      <div className="flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />

                        <span>
                          {t('network.crawlerTask.telegraphSourceMissing', {
                            count: taskSourceMissingSummary.sourceMissing ?? 0,
                          })}
                        </span>
                      </div>
                      {taskTelegramFallbackLinks.length > 0 && (
                        <div className="space-y-2 pl-5">
                          <p className="text-[11px] font-medium">
                            {t('network.crawlerTask.telegramFallbackLinks')}
                          </p>
                          {taskTelegramFallbackLinks.map((url) => (
                            <div key={`task-telegram-fallback-${url}`} className="space-y-1">
                              <p className="truncate text-[11px] text-muted-foreground" title={url}>
                                {url}
                              </p>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1.5 text-[11px]"
                                  onClick={() => void openUrl(url)}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  {t('network.crawlerTask.openTelegramFallback')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1.5 text-[11px]"
                                  onClick={() => handleUseTelegramFallbackTask(url)}
                                >
                                  <Globe className="h-3.5 w-3.5" />
                                  {t('network.crawlerTask.telegramFallbackUseTask')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="h-7 gap-1.5 text-[11px]"
                                  onClick={() => void handleStartTelegramFallbackTask(url)}
                                  disabled={isTaskStarting}
                                >
                                  {isTaskStarting ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Play className="h-3.5 w-3.5" />
                                  )}
                                  {t('network.crawlerTask.telegramFallbackStartTask')}
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="rounded-md border border-border/60 bg-background/40 p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">{t('network.crawlerTask.taskLogsPanel')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setTaskLogsPanelOpen((value) => !value)}
                >
                  {taskLogsPanelOpen ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      {t('network.crawlerTask.taskSectionHide')}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      {t('network.crawlerTask.taskSectionShow')}
                    </>
                  )}
                </Button>
              </div>

              {taskLogsPanelOpen && (
                <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                  {taskLogs.length > 0 ? taskLogs.join('\n') : t('network.crawlerTask.logsEmpty')}
                </pre>
              )}
            </div>
            <div className="rounded-md border border-border/60 bg-background/40 p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">
                  {t('network.crawlerTask.taskMediaBrowserPanel')}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setTaskMediaBrowserPanelOpen((value) => !value)}
                >
                  {taskMediaBrowserPanelOpen ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      {t('network.crawlerTask.taskSectionHide')}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      {t('network.crawlerTask.taskSectionShow')}
                    </>
                  )}
                </Button>
              </div>

              {taskMediaBrowserPanelOpen && (
                <div className="mt-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium">{t('network.crawlerTask.mediaBrowser')}</p>

                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => void handleLoadTaskMediaBrowser()}
                      disabled={isTaskMediaBrowserLoading || !taskCurrentId}
                    >
                      {isTaskMediaBrowserLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}

                      {t('network.crawlerTask.mediaBrowserLoad')}
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => void handleExportTaskMediaBrowser()}
                      disabled={
                        isTaskMediaBrowserExporting || taskMediaBrowserFilteredItems.length === 0
                      }
                    >
                      {isTaskMediaBrowserExporting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <FolderOpen className="w-3.5 h-3.5" />
                      )}

                      {t('network.crawlerTask.mediaExportBrowser')}
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => void handleExportTaskMediaLinks()}
                      disabled={
                        isTaskMediaLinksExporting || taskMediaBrowserFilteredItems.length === 0
                      }
                    >
                      {isTaskMediaLinksExporting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}

                      {t('network.crawlerTask.mediaExportLinks')}
                    </Button>

                    <span className="rounded px-2 py-1 bg-muted text-muted-foreground text-[11px]">
                      {t('network.crawlerTask.mediaBrowserCount', {
                        shown: taskMediaBrowserFilteredItems.length,

                        total: taskMediaBrowserItems.length,
                      })}
                    </span>

                    <span className="rounded px-2 py-1 bg-muted text-muted-foreground text-[11px]">
                      {t('network.crawlerTask.mediaBrowserSource')}:{' '}
                      {taskMediaBrowserSourceMode === 'folder'
                        ? t('network.crawlerTask.mediaBrowserSource_folder')
                        : t('network.crawlerTask.mediaBrowserSource_task')}
                    </span>

                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={expandAllVisibleTaskMediaBrowser}
                      disabled={taskMediaBrowserVisibleItems.length === 0}
                    >
                      {t('network.crawlerTask.mediaDetailsExpandAll')}
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={collapseAllTaskMediaBrowser}
                      disabled={taskMediaBrowserExpandedKeys.size === 0}
                    >
                      {t('network.crawlerTask.mediaDetailsCollapseAll')}
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant={taskMediaBrowserMetaFilter === 'all' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserMetaFilter('all');
                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                    >
                      {t('network.crawlerTask.mediaMetaFilterAll')}
                    </Button>

                    <Button
                      size="sm"
                      variant={
                        taskMediaBrowserMetaFilter === 'with-title' ? 'secondary' : 'outline'
                      }
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserMetaFilter('with-title');
                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                    >
                      {t('network.crawlerTask.mediaMetaFilterWithTitle')}
                    </Button>

                    <Button
                      size="sm"
                      variant={taskMediaBrowserMetaFilter === 'with-page' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserMetaFilter('with-page');
                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                    >
                      {t('network.crawlerTask.mediaMetaFilterWithPage')}
                    </Button>

                    <Button
                      size="sm"
                      variant={taskMediaBrowserMetaFilter === 'with-file' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserMetaFilter('with-file');
                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                    >
                      {t('network.crawlerTask.mediaMetaFilterWithFile')}
                    </Button>

                    <Button
                      size="sm"
                      variant={taskMediaBrowserMetaFilter === 'with-path' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserMetaFilter('with-path');
                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                    >
                      {t('network.crawlerTask.mediaMetaFilterWithPath')}
                    </Button>

                    <Button
                      size="sm"
                      variant={
                        taskMediaBrowserMetaFilter === 'downloaded' ? 'secondary' : 'outline'
                      }
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserMetaFilter('downloaded');
                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                    >
                      {t('network.crawlerTask.mediaMetaFilterDownloaded')}
                    </Button>

                    <Button
                      size="sm"
                      variant={taskMediaBrowserFilter === 'all' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserFilter('all');

                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                    >
                      {t('network.crawlerTask.mediaBrowserAll')} ({taskMediaBrowserItems.length})
                    </Button>

                    <Button
                      size="sm"
                      variant={taskMediaBrowserFilter === 'image' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserFilter('image');

                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                      disabled={taskMediaBrowserCounts.image === 0}
                    >
                      {t('network.crawlerTask.mediaKind_image')} ({taskMediaBrowserCounts.image})
                    </Button>

                    <Button
                      size="sm"
                      variant={taskMediaBrowserFilter === 'gif' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserFilter('gif');

                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                      disabled={taskMediaBrowserCounts.gif === 0}
                    >
                      {t('network.crawlerTask.mediaKind_gif')} ({taskMediaBrowserCounts.gif})
                    </Button>

                    <Button
                      size="sm"
                      variant={taskMediaBrowserFilter === 'video' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserFilter('video');

                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                      disabled={taskMediaBrowserCounts.video === 0}
                    >
                      {t('network.crawlerTask.mediaKind_video')} ({taskMediaBrowserCounts.video})
                    </Button>

                    <Button
                      size="sm"
                      variant={taskMediaBrowserFilter === 'audio' ? 'secondary' : 'outline'}
                      className="h-7 text-xs"
                      onClick={() => {
                        setTaskMediaBrowserFilter('audio');

                        setTaskMediaBrowserVisibleCount(TASK_MEDIA_BROWSER_PAGE_SIZE);
                      }}
                      disabled={taskMediaBrowserCounts.audio === 0}
                    >
                      {t('network.crawlerTask.mediaKind_audio')} ({taskMediaBrowserCounts.audio})
                    </Button>
                  </div>

                  <div className="rounded border border-border/60 px-2 py-2 text-xs text-muted-foreground space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-foreground/80">
                        {t('network.crawlerTask.mediaBrowserInfoPanel')}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setTaskMediaBrowserInfoPanelOpen((value) => !value)}
                      >
                        {taskMediaBrowserInfoPanelOpen
                          ? t('network.crawlerTask.mediaBrowserInfoHide')
                          : t('network.crawlerTask.mediaBrowserInfoShow')}
                      </Button>
                    </div>

                    {taskMediaBrowserInfoPanelOpen && (
                      <>
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p>
                              {t('network.crawlerTask.historyFolderPath')}:{' '}
                              {taskHistoryFolderPath || '-'}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p>
                              {t('network.crawlerTask.historyFolderDataDir')}:{' '}
                              {taskHistoryFolderDataDir || '-'}
                            </p>
                            {taskHistoryFolderDataDir && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1.5 text-xs"
                                onClick={() => void handleCopyTaskPath(taskHistoryFolderDataDir)}
                              >
                                {t('network.crawlerTask.copyPath')}
                              </Button>
                            )}
                          </div>
                          <p>
                            {t('network.crawlerTask.historyFolderScanMs')}:{' '}
                            {taskHistoryFolderScanMs > 0 ? `${taskHistoryFolderScanMs} ms` : '-'}
                          </p>
                          <p>
                            {t('network.crawlerTask.historyFolderScannedAt')}:{' '}
                            {formatLocalDateTime(taskHistoryFolderScannedAt) || '-'}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <p>
                              {t('network.crawlerTask.historyFolderPreviewReport')}:{' '}
                              {taskHistoryFolderPreviewReportPath || '-'}
                            </p>
                            {taskHistoryFolderPreviewReportPath && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1.5 text-xs"
                                  onClick={() =>
                                    void handleCopyTaskPath(taskHistoryFolderPreviewReportPath)
                                  }
                                >
                                  {t('network.crawlerTask.copyPath')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1.5 text-xs"
                                  onClick={() =>
                                    void handleOpenTaskHistoryPreviewReport(
                                      taskHistoryFolderPreviewReportPath,
                                    )
                                  }
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                  {t('network.crawlerTask.historyFolderOpenPreviewReport')}
                                </Button>
                              </>
                            )}
                          </div>
                          <p>
                            {t('network.crawlerTask.historyFolderMissingFiles')}:{' '}
                            {taskHistoryFolderMissingFiles.length}
                          </p>
                        </div>
                        {Object.entries(taskHistoryFolderDetectedFileGroups).map(
                          ([groupName, files]) =>
                            files.length > 0 ? (
                              <div key={groupName} className="space-y-1">
                                <p>
                                  {t('network.crawlerTask.historyFolderDetectedFiles')} {groupName}:
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                  {files.map((filePath) => {
                                    const fileLabel =
                                      filePath.split(/[/]/).filter(Boolean).pop() || filePath;
                                    return (
                                      <Button
                                        key={filePath}
                                        size="sm"
                                        variant="outline"
                                        className="h-7 gap-1.5 text-xs"
                                        onClick={() => void handleRevealTaskHistoryFile(filePath)}
                                      >
                                        <FolderOpen className="w-3.5 h-3.5" />
                                        {fileLabel}
                                      </Button>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : null,
                        )}
                        {Object.entries(taskHistoryFolderMissingFileGroups).map(
                          ([groupName, files]) =>
                            files.length > 0 ? (
                              <div key={`missing-${groupName}`} className="space-y-1">
                                <p>
                                  {t('network.crawlerTask.historyFolderMissingFiles')} {groupName}:
                                </p>
                                <p className="break-all">{files.join(' | ')}</p>
                              </div>
                            ) : null,
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5 text-xs"
                            onClick={handlePickTaskHistoryFolder}
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                            {t('network.crawlerTask.historyFolderSelect')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5 text-xs"
                            onClick={() => void handleLoadHistoryFolderMediaBrowser()}
                            disabled={isTaskMediaBrowserLoading || !taskHistoryFolderPath.trim()}
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            {t('network.crawlerTask.historyFolderLoad')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5 text-xs"
                            onClick={() => void handleImportHistoryFolderLinks(false)}
                            disabled={
                              isTaskImporting ||
                              !taskHistoryFolderPath.trim() ||
                              isUniversalDownloading
                            }
                          >
                            <Download className="w-3.5 h-3.5" />
                            {t('network.crawlerTask.historyFolderImport')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5 text-xs"
                            onClick={() => void handleImportHistoryFolderLinks(true)}
                            disabled={
                              isTaskImporting ||
                              !taskHistoryFolderPath.trim() ||
                              isUniversalDownloading
                            }
                          >
                            <Play className="w-3.5 h-3.5" />
                            {t('network.crawlerTask.historyFolderImportAndStart')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5 text-xs"
                            onClick={() => void handleRetryFailedTaskDownloads()}
                            disabled={
                              isTaskRetryingFailedDownloads || !taskHistoryFolderPath.trim()
                            }
                          >
                            {isTaskRetryingFailedDownloads ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5" />
                            )}
                            {t('network.crawlerTask.retryFailedDownloads')}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>

                  {taskMediaBrowserError && (
                    <div className="rounded p-2 text-xs bg-destructive/10 text-destructive flex items-start gap-1.5">
                      <CircleOff className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />

                      <span>{taskMediaBrowserError}</span>
                    </div>
                  )}

                  {taskMediaBrowserInfo && (
                    <div className="rounded p-2 text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400 flex items-start gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />

                      <span>{taskMediaBrowserInfo}</span>
                    </div>
                  )}

                  {taskMediaBrowserVisibleItems.length > 0 ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-[420px] overflow-y-auto pr-1">
                      {taskMediaBrowserVisibleItems.map((item, index) => {
                        const itemKey = getTaskMediaItemKey(item, index);
                        const isExpanded = taskMediaBrowserExpandedKeys.has(itemKey);
                        return (
                          <div
                            key={itemKey}
                            className="rounded border border-border/60 bg-background/70 p-1.5 space-y-1.5"
                          >
                            <button
                              type="button"
                              className="h-28 w-full rounded bg-muted/40 overflow-hidden flex items-center justify-center transition-colors hover:bg-muted/60"
                              onClick={() => handleOpenTaskMediaViewer(index)}
                            >
                              {item.kind === 'video' ? (
                                <HlsVideoPlayer
                                  src={item.url}
                                  preload={isHlsUrl(item.url) ? 'none' : 'metadata'}
                                  className="h-full w-full object-cover"
                                />
                              ) : item.kind === 'audio' ? (
                                <div className="flex h-full w-full items-center justify-center px-3 text-xs text-muted-foreground">
                                  {t('network.crawlerTask.mediaKind_audio')}
                                </div>
                              ) : (
                                <img
                                  src={item.url}
                                  alt={item.kind}
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  className="h-full w-full object-cover"
                                />
                              )}
                            </button>

                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="rounded px-1.5 py-0.5 bg-muted text-[10px] text-muted-foreground">
                                  {t(`network.crawlerTask.mediaKind_${item.kind}`)}
                                </span>
                                {((item.status?.trim().toLowerCase() || '') === 'success' ||
                                  item.savedAbsolutePath) && (
                                  <span className="rounded px-1.5 py-0.5 bg-emerald-500/15 text-[10px] text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                                    {t('network.crawlerTask.mediaStatusDownloaded')}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-1">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={() => handleOpenTaskMediaViewer(index)}
                                >
                                  {t('network.crawlerTask.mediaPreview')}
                                </Button>

                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={() => void handleOpenTaskMediaUrl(item.url)}
                                >
                                  {t('network.crawlerTask.mediaOpen')}
                                </Button>

                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={() => toggleTaskMediaBrowserExpanded(itemKey)}
                                >
                                  {isExpanded
                                    ? t('network.crawlerTask.mediaDetailsHide')
                                    : t('network.crawlerTask.mediaDetailsShow')}
                                </Button>
                              </div>
                            </div>

                            {isExpanded && (
                              <div className="space-y-1.5 rounded border border-border/40 bg-muted/20 p-2">
                                {item.pageTitle && (
                                  <p
                                    className="text-[10px] font-medium text-foreground/80 break-all max-h-8 overflow-hidden"
                                    title={item.pageTitle}
                                  >
                                    {item.pageTitle}
                                  </p>
                                )}

                                {item.pageUrl && (
                                  <div className="space-y-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-[10px] text-muted-foreground">
                                        {t('network.crawlerTask.mediaPageUrl')}
                                      </span>

                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 px-2 text-[11px]"
                                        onClick={() =>
                                          void handleOpenTaskMediaUrl(item.pageUrl || '')
                                        }
                                      >
                                        {t('network.crawlerTask.mediaOpenPage')}
                                      </Button>
                                    </div>

                                    <p
                                      className="text-[10px] text-muted-foreground break-all max-h-8 overflow-hidden"
                                      title={item.pageUrl}
                                    >
                                      {item.pageUrl}
                                    </p>
                                  </div>
                                )}

                                {item.fileName && (
                                  <p
                                    className="text-[10px] text-muted-foreground break-all"
                                    title={item.fileName}
                                  >
                                    {t('network.crawlerTask.mediaFileName')}: {item.fileName}
                                  </p>
                                )}

                                {item.savedAbsolutePath && (
                                  <p
                                    className="text-[10px] text-muted-foreground break-all"
                                    title={item.savedAbsolutePath}
                                  >
                                    {t('network.crawlerTask.mediaSavedPath')}:{' '}
                                    {item.savedAbsolutePath}
                                  </p>
                                )}

                                <p
                                  className="text-[10px] text-muted-foreground break-all max-h-8 overflow-hidden"
                                  title={item.url}
                                >
                                  {item.url}
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {taskMediaBrowserItems.length === 0
                        ? t('network.crawlerTask.mediaBrowserEmpty')
                        : t('network.crawlerTask.mediaBrowserNoMatch')}
                    </p>
                  )}

                  {canLoadMoreTaskMediaBrowser && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={handleTaskMediaBrowserLoadMore}
                    >
                      {t('network.crawlerTask.mediaBrowserLoadMore')}
                    </Button>
                  )}
                </div>
              )}

              <Dialog open={isTaskMediaViewerOpen} onOpenChange={setIsTaskMediaViewerOpen}>
                <DialogContent className="max-w-5xl overflow-hidden p-0">
                  <div className="flex max-h-[85vh] flex-col">
                    <DialogHeader className="border-b border-border/60 px-5 py-4">
                      <DialogTitle className="flex items-center justify-between gap-3 text-base">
                        <span>{t('network.crawlerTask.mediaBrowser')}</span>

                        <span className="text-xs font-normal text-muted-foreground">
                          {taskMediaViewerItem
                            ? `${t(`network.crawlerTask.mediaKind_${taskMediaViewerItem.kind}`)} ${t(
                                'network.crawlerTask.mediaViewerPosition',
                                {
                                  current: taskMediaViewerIndex + 1,

                                  total: taskMediaBrowserFilteredItems.length,
                                },
                              )}`
                            : t('network.crawlerTask.mediaViewerPosition', {
                                current: 0,

                                total: taskMediaBrowserFilteredItems.length,
                              })}
                        </span>
                      </DialogTitle>
                    </DialogHeader>

                    {taskMediaViewerItem ? (
                      <>
                        <div className="flex min-h-[320px] items-center justify-center overflow-auto bg-black px-4 py-4">
                          {taskMediaViewerItem.kind === 'video' ? (
                            <HlsVideoPlayer
                              key={taskMediaViewerItem.url}
                              src={taskMediaViewerItem.url}
                              controls
                              preload={isHlsUrl(taskMediaViewerItem.url) ? 'auto' : 'metadata'}
                              className="max-h-[62vh] w-full rounded object-contain"
                            />
                          ) : taskMediaViewerItem.kind === 'audio' ? (
                            <div className="flex w-full max-w-2xl flex-col items-center gap-4 rounded-xl border border-white/10 bg-white/5 px-6 py-8 text-white">
                              <span className="text-sm uppercase tracking-[0.3em] text-white/70">
                                {t('network.crawlerTask.mediaKind_audio')}
                              </span>

                              <audio
                                key={taskMediaViewerItem.url}
                                src={taskMediaViewerItem.url}
                                controls
                                preload="metadata"
                                className="w-full"
                              >
                                <track kind="captions" />
                              </audio>
                            </div>
                          ) : (
                            <img
                              key={taskMediaViewerItem.url}
                              src={taskMediaViewerItem.url}
                              alt={taskMediaViewerItem.kind}
                              referrerPolicy="no-referrer"
                              className={
                                taskMediaViewerFitMode === 'actual'
                                  ? 'max-w-none rounded object-none'
                                  : 'max-h-[62vh] w-full rounded object-contain'
                              }
                            />
                          )}
                        </div>

                        <div className="flex flex-col gap-3 px-5 py-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleTaskMediaViewerChange(-1)}
                                disabled={taskMediaViewerIndex <= 0}
                              >
                                {t('network.crawlerTask.mediaViewerPrev')}
                              </Button>

                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleTaskMediaViewerChange(1)}
                                disabled={
                                  taskMediaViewerIndex >= taskMediaBrowserFilteredItems.length - 1
                                }
                              >
                                {t('network.crawlerTask.mediaViewerNext')}
                              </Button>

                              {(taskMediaViewerItem.kind === 'image' ||
                                taskMediaViewerItem.kind === 'gif') && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    setTaskMediaViewerFitMode((prev) =>
                                      prev === 'contain' ? 'actual' : 'contain',
                                    )
                                  }
                                >
                                  {taskMediaViewerFitMode === 'contain'
                                    ? t('network.crawlerTask.mediaViewerActual')
                                    : t('network.crawlerTask.mediaViewerFit')}
                                </Button>
                              )}
                            </div>

                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void handleOpenTaskMediaUrl(taskMediaViewerItem.url)}
                            >
                              {t('network.crawlerTask.mediaOpen')}
                            </Button>
                          </div>

                          <p className="max-h-20 overflow-y-auto break-all text-xs text-muted-foreground">
                            {taskMediaViewerItem.url}
                          </p>

                          <p className="text-[11px] text-muted-foreground">
                            {t('network.crawlerTask.mediaViewerHotkeys')}
                          </p>
                        </div>
                      </>
                    ) : null}
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>{' '}
        </SettingsCard>
        {/* Network Proxy */}
        <SettingsCard id="proxy" highlight={highlightId === 'proxy'}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <Globe className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-medium">{t('network.networkProxy')}</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('network.networkProxyDesc')}
              </p>
            </div>
          </div>

          {/* Proxy Mode Selection */}
          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium">{t('network.proxyType')}</p>
                <p className="text-xs text-muted-foreground">{t('network.proxyTypeDesc')}</p>
              </div>
              <Select
                value={proxySettings.mode}
                onValueChange={(v) => updateProxySettings({ mode: v as ProxyMode })}
              >
                <SelectTrigger className="h-8 w-full sm:w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('network.off')}</SelectItem>
                  <SelectItem value="http">{t('network.httpHttps')}</SelectItem>
                  <SelectItem value="socks5">{t('network.socks5')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Proxy Settings */}
          {proxySettings.mode !== 'off' && (
            <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
              {/* Host and Port */}
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <p className="text-xs font-medium mb-1">{t('network.host')}</p>
                  <Input
                    type="text"
                    value={proxySettings.host || ''}
                    onChange={(e) => updateProxySettings({ host: e.target.value })}
                    placeholder="127.0.0.1 or proxy.example.com"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="w-full sm:w-24">
                  <p className="text-xs font-medium mb-1">{t('network.port')}</p>
                  <Input
                    type="number"
                    value={proxySettings.port || ''}
                    onChange={(e) =>
                      updateProxySettings({
                        port: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                    placeholder="7890"
                    className="h-8 text-xs"
                  />
                </div>
              </div>

              {/* Username and Password */}
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <p className="text-xs font-medium mb-1">{t('network.usernameOptional')}</p>
                  <Input
                    type="text"
                    value={proxySettings.username || ''}
                    onChange={(e) => updateProxySettings({ username: e.target.value })}
                    placeholder="username"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="flex-1">
                  <p className="text-xs font-medium mb-1">{t('network.passwordOptional')}</p>
                  <Input
                    type="password"
                    value={proxySettings.password || ''}
                    onChange={(e) => updateProxySettings({ password: e.target.value })}
                    placeholder="password"
                    className="h-8 text-xs"
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">{t('network.commonProxies')}</p>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {taskCompletionToast && (
        <div className="toast-slide-in fixed bottom-4 right-4 z-[95] w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-emerald-500/30 bg-background/95 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                {t('network.crawlerTask.taskCompleteTitle', { taskId: taskCompletionToast.id })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('network.crawlerTask.taskCompleteSummary', {
                  downloaded:
                    taskCompletionToast.downloaded === null ? '-' : taskCompletionToast.downloaded,
                  failed: taskCompletionToast.failed === null ? '-' : taskCompletionToast.failed,
                  filtered:
                    taskCompletionToast.filtered === null ? '-' : taskCompletionToast.filtered,
                })}
              </p>
              {taskCompletionToast.noNew && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {t('network.crawlerTask.taskNoNewDownloads', {
                    existing:
                      taskCompletionToast.existing === null ? '-' : taskCompletionToast.existing,
                  })}
                </p>
              )}
              {taskCompletionToast.path && (
                <p
                  className="mt-1 truncate text-[11px] text-muted-foreground"
                  title={taskCompletionToast.path}
                >
                  {taskCompletionToast.path}
                </p>
              )}
              {taskCompletionToast.telegramFallbackLinks.length > 0 && (
                <div className="mt-2 space-y-2">
                  <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    {t('network.crawlerTask.telegramFallbackLinks')}
                  </p>
                  {taskCompletionToast.telegramFallbackLinks.map((url) => (
                    <div key={`toast-telegram-fallback-${url}`} className="space-y-1">
                      <p className="truncate text-[11px] text-muted-foreground" title={url}>
                        {url}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 text-[11px]"
                          onClick={() => void openUrl(url)}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t('network.crawlerTask.openTelegramFallback')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 text-[11px]"
                          onClick={() => handleUseTelegramFallbackTask(url)}
                        >
                          <Globe className="h-3.5 w-3.5" />
                          {t('network.crawlerTask.telegramFallbackUseTask')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7 gap-1.5 text-[11px]"
                          onClick={() => void handleStartTelegramFallbackTask(url)}
                          disabled={isTaskStarting}
                        >
                          {isTaskStarting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                          {t('network.crawlerTask.telegramFallbackStartTask')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={() => setTaskCompletionToast(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            {taskCompletionToast.path && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8 gap-1.5 text-xs"
                onClick={() =>
                  void invoke('open_file_location', { filepath: taskCompletionToast.path })
                }
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('network.crawlerTask.openOutputDir')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => setTaskCompletionToast(null)}
            >
              {t('network.crawlerTask.dismiss')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
