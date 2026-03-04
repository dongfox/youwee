import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle,
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDownload } from '@/contexts/DownloadContext';
import { useUniversal } from '@/contexts/UniversalContext';
import {
  crawlerSidecarAttach,
  crawlerSidecarCollectTaskLinks,
  crawlerSidecarGetTask,
  crawlerSidecarGetTaskLogs,
  crawlerSidecarHealth,
  crawlerSidecarListTasks,
  crawlerSidecarStartTask,
  crawlerSidecarStartService,
  crawlerSidecarStatus,
  crawlerSidecarStopTask,
  crawlerSidecarStopService,
  type SidecarStatus,
} from '@/lib/crawler-sidecar';
import type { BrowserProfile, BrowserType, CookieMode, ProxyMode } from '@/lib/types';
import { BROWSER_OPTIONS } from '@/lib/types';
import { SettingsCard, SettingsSection } from '../SettingsSection';
import { Switch } from '@/components/ui/switch';

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
const SIDECAR_DEFAULT_TASK_IMAGE_TYPES = 'jpg,jpeg,png,gif,webp,bmp,svg';
const SIDECAR_LOG_LIMIT = 300;
const SIDECAR_TASK_POLL_MS = 1500;

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
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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

function inferImportMediaKind(url: string): ImportMediaKind {
  const lower = url.toLowerCase();

  const isVideo =
    lower.includes('video-downloads.googleusercontent.com') ||
    lower.includes('/videoplayback') ||
    /\.(mp4|m4v|webm|mov|mkv|avi|3gp|ts|m3u8|flv)(?:$|[?#&])/i.test(lower) ||
    /(?:^|[?&])(?:mime|content_type|type)=video(?:%2f|\/)/i.test(lower);
  if (isVideo) return 'video';

  const isAudio =
    lower.includes('audio-downloads.googleusercontent.com') ||
    /\.(mp3|m4a|aac|wav|flac|ogg|opus)(?:$|[?#&])/i.test(lower) ||
    /(?:^|[?&])(?:mime|content_type|type)=audio(?:%2f|\/)/i.test(lower);
  if (isAudio) return 'audio';

  const isGif =
    /\.gif(?:$|[?#&])/i.test(lower) ||
    /(?:^|[?&])(?:fm|format)=gif(?:$|[&#])/i.test(lower);
  if (isGif) return 'gif';

  return 'image';
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
  const { addFromText: addUniversalFromText, startDownload: startUniversalDownload } =
    useUniversal();

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
  const [sidecarHost, setSidecarHost] = useState(() => readStoredValue('host', SIDECAR_DEFAULT_HOST));
  const [sidecarPort, setSidecarPort] = useState(() => readStoredValue('port', SIDECAR_DEFAULT_PORT));
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
  const [taskImageTypes, setTaskImageTypes] = useState(() =>
    readStoredValue('task_image_types', SIDECAR_DEFAULT_TASK_IMAGE_TYPES),
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
  const [taskImportCounts, setTaskImportCounts] = useState<ImportMediaCounts>(EMPTY_IMPORT_COUNTS);
  const [isTaskStarting, setIsTaskStarting] = useState(false);
  const [isTaskStopping, setIsTaskStopping] = useState(false);
  const [isTaskRefreshing, setIsTaskRefreshing] = useState(false);
  const [isTaskLoadingLatest, setIsTaskLoadingLatest] = useState(false);
  const [isTaskImporting, setIsTaskImporting] = useState(false);
  const taskPollingInFlightRef = useRef(false);
  const taskLogOffsetRef = useRef(taskLogOffset);
  const taskAutoImportInFlightRef = useRef(false);

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
    writeStoredValue('task_current_id', taskCurrentId);
  }, [taskCurrentId]);

  useEffect(() => {
    writeStoredValue('task_last_auto_import_task_id', taskLastAutoImportTaskId);
  }, [taskLastAutoImportTaskId]);

  useEffect(() => {
    writeStoredValue('task_log_offset', String(taskLogOffset));
  }, [taskLogOffset]);

  useEffect(() => {
    taskLogOffsetRef.current = taskLogOffset;
  }, [taskLogOffset]);

  const handleSidecarHealthCheck = useCallback(
    async (silent = false) => {
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
    },
    [setSidecarHealth, setSidecarError],
  );

  const refreshSidecarStatus = useCallback(
    async ({ silent = false, withHealthCheck = false }: { silent?: boolean; withHealthCheck?: boolean } = {}) => {
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
      void refreshSidecarStatus({ silent: true, withHealthCheck: false });
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
      const status = await crawlerSidecarAttach(sidecarBaseUrl.trim(), sidecarToken.trim() || undefined);
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
      if (taskPollingInFlightRef.current) return;
      taskPollingInFlightRef.current = true;
      if (!silent) {
        setIsTaskRefreshing(true);
        setTaskError(null);
        setTaskInfo(null);
      }
      try {
        const snapshotRaw = await crawlerSidecarGetTask(effectiveTaskId);
        const parsedSnapshot = toTaskSnapshot(snapshotRaw);
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

        const offset = resetLogs ? 0 : taskLogOffsetRef.current;
        const logsRaw = await crawlerSidecarGetTaskLogs(effectiveTaskId, offset, 200);
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
        if (!silent) {
          setTaskError(formatUnknownError(error));
        }
      } finally {
        if (!silent) setIsTaskRefreshing(false);
        taskPollingInFlightRef.current = false;
      }
    },
    [taskCurrentId],
  );

  useEffect(() => {
    if (!taskCurrentId.trim()) return;
    void refreshTaskData({ taskId: taskCurrentId, silent: true });
    const timer = window.setInterval(() => {
      void refreshTaskData({ taskId: taskCurrentId, silent: true });
    }, SIDECAR_TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [taskCurrentId, refreshTaskData]);

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

  const handleStartTask = useCallback(async () => {
    if (!taskUrl.trim()) {
      setTaskError(t('network.crawlerTask.urlRequired'));
      return;
    }
    if (!sidecarStatus?.base_url) {
      setTaskError(t('network.crawlerTask.connectServiceFirst'));
      return;
    }

    const payload: Record<string, unknown> = {
      url: taskUrl.trim(),
      output: taskOutput.trim() || './output',
      scope: taskScope === 'site' ? 'site' : 'page',
      js: taskJs,
      links_only: taskLinksOnly,
      google_photos_exhaustive: taskExhaustive,
    };

    const workers = parsePositiveInt(taskWorkers);
    if (workers !== null) payload.workers = workers;
    const timeout = parsePositiveInt(taskTimeout);
    if (timeout !== null) payload.timeout = timeout;
    const parsedRetries = Number.parseInt(taskRetries.trim(), 10);
    if (Number.isFinite(parsedRetries) && parsedRetries >= 0) payload.retries = parsedRetries;
    const parsedDelay = Number.parseFloat(taskDelay.trim());
    if (Number.isFinite(parsedDelay) && parsedDelay >= 0) payload.delay = parsedDelay;
    if (taskImageTypes.trim()) payload.image_types = taskImageTypes.trim();

    const logEvery = parsePositiveInt(taskLogEvery);
    if (logEvery !== null) payload.google_photos_log_every = logEvery;
    if (taskNextSelectors.trim()) {
      payload.google_photos_next_selectors = taskNextSelectors.trim();
    }

    setIsTaskStarting(true);
    setTaskError(null);
    setTaskInfo(null);
    try {
      const raw = await crawlerSidecarStartTask(payload);
      const obj = asRecord(raw);
      const newTaskId = obj ? readStringField(obj, 'task_id').trim() : '';
      if (!newTaskId) {
        throw new Error(t('network.crawlerTask.startTaskFailed'));
      }

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
      await refreshTaskData({ taskId: newTaskId, resetLogs: true });
    } catch (error) {
      setTaskError(formatUnknownError(error));
    } finally {
      setIsTaskStarting(false);
    }
  }, [
    parsePositiveInt,
    refreshTaskData,
    sidecarStatus?.base_url,
    t,
    taskDelay,
    taskExhaustive,
    taskImageTypes,
    taskJs,
    taskLinksOnly,
    taskLogEvery,
    taskNextSelectors,
    taskOutput,
    taskRetries,
    taskScope,
    taskTimeout,
    taskUrl,
    taskWorkers,
  ]);

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
    (urls: string[]) => {
      const counts: ImportMediaCounts = { ...EMPTY_IMPORT_COUNTS };
      const selectedKinds: Record<ImportMediaKind, boolean> = {
        image: taskImportImage,
        gif: taskImportGif,
        video: taskImportVideo,
        audio: taskImportAudio,
      };
      const selectedUrls: string[] = [];

      for (const url of urls) {
        const kind = inferImportMediaKind(url);
        counts[kind] += 1;
        if (selectedKinds[kind]) {
          selectedUrls.push(url);
        }
      }

      return { counts, selectedUrls };
    },
    [taskImportAudio, taskImportGif, taskImportImage, taskImportVideo],
  );

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
        const raw = await crawlerSidecarCollectTaskLinks(currentTaskId, 5000);
        const obj = asRecord(raw);
        const urls = obj ? readStringArrayField(obj, 'urls') : [];
        const totalUrls = obj ? readNumberField(obj, 'total_urls') ?? urls.length : urls.length;
        const sourceFile = obj ? readStringField(obj, 'source_file') : '';

        if (urls.length === 0) {
          setTaskImportCounts(EMPTY_IMPORT_COUNTS);
          setTaskError(t('network.crawlerTask.noImportableLinks'));
          return;
        }

        const { counts, selectedUrls } = buildImportPlan(urls);
        setTaskImportCounts(counts);
        if (selectedUrls.length === 0) {
          setTaskError(t('network.crawlerTask.noLinksAfterFilter'));
          return;
        }

        const added = await addUniversalFromText(selectedUrls.join('\n'));
        if (startDownloadAfterImport && added > 0) {
          await startUniversalDownload();
        }

        const baseInfo =
          added > 0
            ? t('network.crawlerTask.importedOk', {
                added,
                total: selectedUrls.length,
                source: sourceFile || '-',
              })
            : t('network.crawlerTask.importedDuplicateOnly', {
                total: selectedUrls.length,
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
      addUniversalFromText,
      buildImportPlan,
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
  const sidecarStartedAt = sidecarStatus?.started_at
    ? new Date(sidecarStatus.started_at).toLocaleString()
    : '-';
  const taskStatus = taskSnapshot?.status ?? 'unknown';
  const taskRunning = taskStatus === 'running' || taskStatus === 'starting' || taskStatus === 'stopping';

  useEffect(() => {
    const currentTaskId = taskCurrentId.trim();
    if (!taskAutoImport || !currentTaskId) return;
    if (taskStatus !== 'success') return;
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
    taskStatus,
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
              <p className="text-xs text-muted-foreground mt-0.5">{t('network.crawlerSidecar.desc')}</p>
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
                <p className="text-xs font-medium mb-1">{t('network.crawlerSidecar.tokenOptional')}</p>
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
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
                {t('network.crawlerSidecar.statusLabel')}: {sidecarRunning
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
                {t('network.crawlerSidecar.healthLabel')}: {sidecarHealth === 'ok'
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
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                {t('network.crawlerSidecar.baseUrlLabel')}: {sidecarStatus?.base_url || '-'}
              </p>
              <p>
                {t('network.crawlerSidecar.startedAtLabel')}: {sidecarStartedAt}
              </p>
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
              <p className="text-xs text-muted-foreground mt-0.5">{t('network.crawlerTask.desc')}</p>
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
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <p className="text-xs font-medium mb-1">{t('network.crawlerTask.imageTypes')}</p>
                <Input
                  type="text"
                  value={taskImageTypes}
                  onChange={(e) => setTaskImageTypes(e.target.value)}
                  placeholder={SIDECAR_DEFAULT_TASK_IMAGE_TYPES}
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
                <p className="text-xs font-medium mb-1">{t('network.crawlerTask.nextSelectors')}</p>
                <Input
                  type="text"
                  value={taskNextSelectors}
                  onChange={(e) => setTaskNextSelectors(e.target.value)}
                  placeholder={SIDECAR_DEFAULT_TASK_NEXT_SELECTORS}
                  className="h-8 text-xs"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
            </div>
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
                disabled={isTaskImporting || !taskCurrentId}
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
                disabled={isTaskImporting || !taskCurrentId}
              >
                {isTaskImporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {t('network.crawlerTask.importAndStart')}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {taskCurrentId ? (
                <span className="rounded px-2 py-1 bg-muted text-muted-foreground">
                  {t('network.crawlerTask.taskId')}: {taskCurrentId}
                </span>
              ) : (
                <span className="rounded px-2 py-1 bg-muted text-muted-foreground">
                  {t('network.crawlerTask.taskId')}: -
                </span>
              )}
              <span
                className={
                  taskStatus === 'success'
                    ? 'rounded px-2 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : taskStatus === 'failed' || taskStatus === 'error'
                      ? 'rounded px-2 py-1 bg-destructive/10 text-destructive'
                      : taskStatus === 'running' || taskStatus === 'starting' || taskStatus === 'stopping'
                        ? 'rounded px-2 py-1 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                        : 'rounded px-2 py-1 bg-muted text-muted-foreground'
                }
              >
                {t('network.crawlerTask.status')}: {t(`network.crawlerTask.status_${taskStatus}`)}
              </span>
              {taskSnapshot?.pid !== null && taskSnapshot?.pid !== undefined && (
                <span className="rounded px-2 py-1 bg-muted text-muted-foreground">
                  PID: {taskSnapshot.pid}
                </span>
              )}
              {taskSnapshot?.exit_code !== null && taskSnapshot?.exit_code !== undefined && (
                <span className="rounded px-2 py-1 bg-muted text-muted-foreground">
                  {t('network.crawlerTask.exitCode')}: {taskSnapshot.exit_code}
                </span>
              )}
              <span className="rounded px-2 py-1 bg-muted text-muted-foreground">
                {t('network.crawlerTask.logCount')}: {taskSnapshot?.log_total ?? taskLogs.length}
              </span>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                {t('network.crawlerTask.createdAt')}: {taskSnapshot?.created_at || '-'}
              </p>
              <p>
                {t('network.crawlerTask.startedAt')}: {taskSnapshot?.started_at || '-'}
              </p>
              <p>
                {t('network.crawlerTask.finishedAt')}: {taskSnapshot?.finished_at || '-'}
              </p>
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
            <div className="rounded-md border border-border/60 bg-background/40 p-2">
              <p className="text-xs font-medium mb-1">{t('network.crawlerTask.logs')}</p>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                {taskLogs.length > 0 ? taskLogs.join('\n') : t('network.crawlerTask.logsEmpty')}
              </pre>
            </div>
          </div>
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
    </div>
  );
}
