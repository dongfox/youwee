import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  BookmarkPlus,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileVideo,
  Folder,
  FolderDown,
  FolderOpen,
  Heart,
  Link,
  Loader2,
  Pencil,
  Play,
  Plus,
  Square,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HlsVideoPlayer, isHlsUrl } from '@/components/HlsVideoPlayer';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useUniversal } from '@/contexts/UniversalContext';
import { buildProxyRequest } from '@/lib/proxyFetch';

// ── Types ──────────────────────────────────────────────────

interface M3uEntry {
  url: string;
  title: string;
  duration: number;
  groupTitle: string;
  logoUrl: string;
  resolverUrl?: string;
  resolverContextUrl?: string;
  resolverIndex?: number;
}

interface ResolvedPageSource {
  sourceUrl: string;
  contextUrl: string;
  resolvedUrl: string;
  label: string;
  entries: M3uEntry[];
}

interface HistoryItem {
  url: string;
  label: string;
  entryCount: number;
  timestamp: number;
}

interface FavoriteEntry extends M3uEntry {
  addedAt: number;
  sourceUrl: string;
}

interface FavoriteFolder {
  id: string;
  name: string;
  entries: FavoriteEntry[];
  createdAt: number;
  sourceUrl: string;
}

interface FavoritesData {
  folders: FavoriteFolder[];
  singles: FavoriteEntry[];
}

// ── Storage helpers ────────────────────────────────────────

const STORAGE_HISTORY = 'youwee_m3u_history';
const STORAGE_FAVORITES = 'youwee_m3u_favorites';
const MAX_HISTORY = 20;

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: HistoryItem[]) {
  localStorage.setItem(STORAGE_HISTORY, JSON.stringify(items.slice(0, MAX_HISTORY)));
}

function loadFavoritesData(): FavoritesData {
  try {
    const raw = localStorage.getItem(STORAGE_FAVORITES);
    if (!raw) return { folders: [], singles: [] };
    const parsed = JSON.parse(raw);
    // Migration: old format was FavoriteEntry[] (flat array)
    if (Array.isArray(parsed)) {
      return { folders: [], singles: parsed as FavoriteEntry[] };
    }
    // New format: { folders, singles }
    return parsed as FavoritesData;
  } catch {
    return { folders: [], singles: [] };
  }
}

function saveFavoritesData(data: FavoritesData) {
  localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(data));
}

// ── M3U parser ─────────────────────────────────────────────

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveM3uEntryUrl(baseSource: string | undefined, rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (/^(https?:|data:|blob:|file:)/i.test(trimmed)) return trimmed;

  const base = (baseSource || '').trim();
  if (isHttpUrl(base)) {
    try {
      return new URL(trimmed, base).toString();
    } catch {
      return trimmed;
    }
  }

  if (!base) return trimmed;

  const normalizedBase = base.replace(/[\\/]+$/, '');
  const boundary = Math.max(normalizedBase.lastIndexOf('/'), normalizedBase.lastIndexOf('\\'));
  if (boundary < 0) return trimmed;
  const baseDir = normalizedBase.slice(0, boundary + 1);
  const candidate = trimmed.replace(/^\.\/[\\/]?/, '');
  return `${baseDir}${candidate}`;
}

function readQuotedAttr(line: string, name: string): string {
  const match = line.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match?.[1]?.trim() || '';
}

function buildVariantTitle(infoLine: string, fallbackUrl: string): string {
  const name = readQuotedAttr(infoLine, 'NAME') || readQuotedAttr(infoLine, 'VIDEO');
  const resolution = readQuotedAttr(infoLine, 'RESOLUTION');
  const bandwidthMatch = infoLine.match(/BANDWIDTH=(\d+)/i);
  const bandwidth = bandwidthMatch?.[1]
    ? `${Math.round(Number.parseInt(bandwidthMatch[1], 10) / 1000)} kbps`
    : '';
  const parts = [name, resolution, bandwidth].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : fallbackUrl.split('/').pop() || fallbackUrl;
}

function parseM3uContent(text: string, sourceBase?: string): M3uEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: M3uEntry[] = [];
  const seenUrls = new Set<string>();

  const pushEntry = (entry: M3uEntry) => {
    const normalizedUrl = entry.url.trim();
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) return;
    seenUrls.add(normalizedUrl);
    entries.push({ ...entry, url: normalizedUrl });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const infoLine = line.slice(8);
      let duration = -1;
      let title = '';
      let groupTitle = '';
      let logoUrl = '';

      const durationMatch = infoLine.match(/^(-?\d+)/);
      if (durationMatch) duration = Number.parseInt(durationMatch[1], 10);

      logoUrl = readQuotedAttr(infoLine, 'tvg-logo');
      groupTitle = readQuotedAttr(infoLine, 'group-title');
      title = readQuotedAttr(infoLine, 'tvg-name') || readQuotedAttr(infoLine, 'tvg-id');

      const commaIdx = infoLine.lastIndexOf(',');
      if (commaIdx >= 0) {
        const trailingTitle = infoLine.slice(commaIdx + 1).trim();
        if (trailingTitle) title = trailingTitle;
      }

      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (!nextLine || nextLine.startsWith('#')) continue;
        const resolvedUrl = resolveM3uEntryUrl(sourceBase, nextLine);
        pushEntry({
          url: resolvedUrl,
          title: title || resolvedUrl.split('/').pop() || resolvedUrl,
          duration,
          groupTitle,
          logoUrl,
        });
        i = j;
        break;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const infoLine = line.slice('#EXT-X-STREAM-INF:'.length);
      const groupTitle = readQuotedAttr(infoLine, 'GROUP-ID') || readQuotedAttr(infoLine, 'AUDIO');
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (!nextLine || nextLine.startsWith('#')) continue;
        const resolvedUrl = resolveM3uEntryUrl(sourceBase, nextLine);
        pushEntry({
          url: resolvedUrl,
          title: buildVariantTitle(infoLine, resolvedUrl),
          duration: -1,
          groupTitle,
          logoUrl: '',
        });
        i = j;
        break;
      }
      continue;
    }

    if (!line.startsWith('#')) {
      const resolvedUrl = resolveM3uEntryUrl(sourceBase, line);
      pushEntry({
        url: resolvedUrl,
        title: resolvedUrl.split('/').pop() || resolvedUrl,
        duration: -1,
        groupTitle: '',
        logoUrl: '',
      });
    }
  }

  return entries;
}

function parseRequestHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes(':')) continue;
    const idx = line.indexOf(':');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    headers[key] = value;
  }
  return headers;
}

function isLikelyDirectMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return /\.(mp4|m4v|webm|mov)(?:$|[?#&])/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function looksLikePlaylistText(text: string): boolean {
  const sample = text.trimStart();
  return sample.startsWith('#EXTM3U') || sample.startsWith('#EXT-X-');
}
// ── Constants ──────────────────────────────────────────────

const PAGE_SIZE = 50;

type Tab = 'browser' | 'favorites' | 'history';

// ── Component ──────────────────────────────────────────────

export function M3uPage() {
  const { t } = useTranslation('pages');
  const { addMediaItems: addUniversalMediaItems, startDownload: startUniversalDownload } =
    useUniversal();

  // Current tab
  const [activeTab, setActiveTab] = useState<Tab>('browser');

  // Browser state
  const [inputUrl, setInputUrl] = useState('');
  const [entries, setEntries] = useState<M3uEntry[]>([]);
  const [sourceLabel, setSourceLabel] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [requestHeadersText, setRequestHeadersText] = useState('');

  // History & Favorites
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);
  const [favData, setFavData] = useState<FavoritesData>(loadFavoritesData);

  // Folder UI state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());

  // Viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerResolvedSrc, setViewerResolvedSrc] = useState<string | null>(null);
  const [viewerResolving, setViewerResolving] = useState(false);

  // ── Derived ────────────────────────────────────────────

  const filteredEntries = useMemo(() => {
    if (!filter.trim()) return entries;
    const lower = filter.toLowerCase();
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(lower) ||
        e.groupTitle.toLowerCase().includes(lower) ||
        e.url.toLowerCase().includes(lower),
    );
  }, [entries, filter]);

  const visibleEntries = useMemo(
    () => filteredEntries.slice(0, visibleCount),
    [filteredEntries, visibleCount],
  );

  const viewerItem = filteredEntries[viewerIndex] ?? null;
  const requestHeaders = useMemo(
    () => parseRequestHeaders(requestHeadersText),
    [requestHeadersText],
  );

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.groupTitle) set.add(e.groupTitle);
    }
    return Array.from(set).sort();
  }, [entries]);

  // Collect all favorited URLs from both folders and singles
  const favoriteUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const f of favData.folders) {
      for (const e of f.entries) urls.add(e.url);
    }
    for (const s of favData.singles) urls.add(s.url);
    return urls;
  }, [favData]);

  const totalFavCount = useMemo(
    () => favData.folders.reduce((sum, f) => sum + f.entries.length, 0) + favData.singles.length,
    [favData],
  );

  // ── Actions ────────────────────────────────────────────

  const addToHistory = useCallback((url: string, label: string, entryCount: number) => {
    setHistory((prev) => {
      const next = [
        { url, label, entryCount, timestamp: Date.now() },
        ...prev.filter((h) => h.url !== url),
      ].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, []);

  const loadFromUrl = useCallback(
    async (url: string) => {
      const trimmed = url.trim();
      if (!trimmed) return;
      setIsLoading(true);
      setError(null);
      try {
        let parsed: M3uEntry[] = [];
        let historyLabel = trimmed.split('/').pop() || trimmed;
        let source = trimmed;

        if (isLikelyDirectMediaUrl(trimmed)) {
          parsed = [
            {
              url: trimmed,
              title: historyLabel,
              duration: -1,
              groupTitle: 'Direct media',
              logoUrl: '',
            },
          ];
        } else {
          const text = await invoke<string>('fetch_text_url', {
            request: buildProxyRequest(trimmed, {
              accept:
                'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.9, */*;q=0.8',
              extraHeaders: requestHeaders,
            }),
          });

          if (looksLikePlaylistText(text)) {
            parsed = parseM3uContent(text, trimmed);
          } else {
            const resolved = await invoke<ResolvedPageSource>('resolve_page_stream', {
              request: {
                url: trimmed,
                headers: requestHeaders,
              },
            });
            parsed = (resolved.entries || []).map((entry, index) => ({
              ...entry,
              resolverUrl: resolved.sourceUrl || trimmed,
              resolverContextUrl: resolved.contextUrl || resolved.sourceUrl || trimmed,
              resolverIndex: index,
            }));
            historyLabel = resolved.label || historyLabel;
            source = resolved.sourceUrl || trimmed;
          }
        }

        if (parsed.length === 0) {
          setError(t('m3u.noEntries'));
        }
        setEntries(parsed);
        setSourceLabel(source);
        setFilter('');
        setVisibleCount(PAGE_SIZE);
        setActiveTab('browser');
        if (parsed.length > 0) {
          addToHistory(source, historyLabel, parsed.length);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    },
    [t, addToHistory, requestHeaders],
  );

  const loadFromFile = useCallback(async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8', 'txt'] }],
      });
      if (typeof file !== 'string') return;
      setIsLoading(true);
      setError(null);
      const text = await readTextFile(file);
      const parsed = parseM3uContent(text, file);
      if (parsed.length === 0) {
        setError(t('m3u.noEntries'));
      }
      setEntries(parsed);
      setSourceLabel(file);
      setFilter('');
      setVisibleCount(PAGE_SIZE);
      setActiveTab('browser');
      if (parsed.length > 0) {
        const label = file.split(/[\\/]/).pop() || file;
        addToHistory(file, label, parsed.length);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [t, addToHistory]);

  const toggleFavorite = useCallback(
    (entry: M3uEntry) => {
      setFavData((prev) => {
        const exists = prev.singles.some((f) => f.url === entry.url);
        const next = {
          ...prev,
          singles: exists
            ? prev.singles.filter((f) => f.url !== entry.url)
            : [...prev.singles, { ...entry, addedAt: Date.now(), sourceUrl: sourceLabel }],
        };
        saveFavoritesData(next);
        return next;
      });
    },
    [sourceLabel],
  );

  const removeFavorite = useCallback((url: string) => {
    setFavData((prev) => {
      const next = { ...prev, singles: prev.singles.filter((f) => f.url !== url) };
      saveFavoritesData(next);
      return next;
    });
  }, []);

  // Save all currently displayed entries as a named folder
  const favoriteAll = useCallback(() => {
    const items = filteredEntries.length > 0 ? filteredEntries : entries;
    if (items.length === 0) return;
    const folderName =
      sourceLabel
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, '') || 'Untitled';
    const newFolder: FavoriteFolder = {
      id: crypto.randomUUID(),
      name: folderName,
      entries: items.map((e) => ({
        ...e,
        addedAt: Date.now(),
        sourceUrl: sourceLabel,
      })),
      createdAt: Date.now(),
      sourceUrl: sourceLabel,
    };
    setFavData((prev) => {
      const next = { ...prev, folders: [...prev.folders, newFolder] };
      saveFavoritesData(next);
      return next;
    });
    // Auto-expand the new folder
    setExpandedFolders((prev) => new Set(prev).add(newFolder.id));
  }, [entries, filteredEntries, sourceLabel]);

  const deleteFolder = useCallback((folderId: string) => {
    setFavData((prev) => {
      const next = { ...prev, folders: prev.folders.filter((f) => f.id !== folderId) };
      saveFavoritesData(next);
      return next;
    });
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      next.delete(folderId);
      return next;
    });
  }, []);

  const renameFolder = useCallback((folderId: string, newName: string) => {
    if (!newName.trim()) return;
    setFavData((prev) => {
      const next = {
        ...prev,
        folders: prev.folders.map((f) => (f.id === folderId ? { ...f, name: newName.trim() } : f)),
      };
      saveFavoritesData(next);
      return next;
    });
    setRenamingFolderId(null);
  }, []);

  const toggleFolderExpand = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const removeFolderEntry = useCallback((folderId: string, url: string) => {
    setFavData((prev) => {
      const next = {
        ...prev,
        folders: prev.folders
          .map((f) =>
            f.id === folderId ? { ...f, entries: f.entries.filter((e) => e.url !== url) } : f,
          )
          .filter((f) => f.entries.length > 0), // Remove empty folders
      };
      saveFavoritesData(next);
      return next;
    });
  }, []);

  const toggleSelectFolder = useCallback((folderId: string) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const selectAllFolders = useCallback(() => {
    setSelectedFolders(new Set(favData.folders.map((f) => f.id)));
  }, [favData.folders]);

  const deselectAllFolders = useCallback(() => {
    setSelectedFolders(new Set());
  }, []);

  const deleteSelectedFolders = useCallback(() => {
    if (selectedFolders.size === 0) return;
    setFavData((prev) => {
      const next = {
        ...prev,
        folders: prev.folders.filter((f) => !selectedFolders.has(f.id)),
      };
      saveFavoritesData(next);
      return next;
    });
    setSelectedFolders(new Set());
  }, [selectedFolders]);

  const clearAllFavorites = useCallback(() => {
    setFavData({ folders: [], singles: [] });
    saveFavoritesData({ folders: [], singles: [] });
    setSelectedFolders(new Set());
    setExpandedFolders(new Set());
  }, []);

  const reloadFolderSource = useCallback(
    (sourceUrl: string) => {
      setInputUrl(sourceUrl);
      void loadFromUrl(sourceUrl);
      setActiveTab('browser');
    },
    [loadFromUrl],
  );

  const removeHistoryItem = useCallback((url: string) => {
    setHistory((prev) => {
      const next = prev.filter((h) => h.url !== url);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  const handleImportAll = useCallback(
    async (start: boolean) => {
      const items = filteredEntries.length > 0 ? filteredEntries : entries;
      if (items.length === 0) return;
      await addUniversalMediaItems(
        items.map((e) => ({
          url: e.url,
          title: e.title,
          outputSubfolder: e.groupTitle || 'm3u',
          extractor: isHlsUrl(e.url) ? 'hls-stream' : 'direct-media',
          thumbnail: e.logoUrl || undefined,
        })),
      );
      if (start) await startUniversalDownload();
    },
    [addUniversalMediaItems, entries, filteredEntries, startUniversalDownload],
  );

  // Download all entries to a user-selected folder
  const handleDownloadToFolder = useCallback(async () => {
    const items = filteredEntries.length > 0 ? filteredEntries : entries;
    if (items.length === 0) return;
    try {
      const folder = await open({
        directory: true,
        multiple: false,
        title: t('m3u.selectDownloadFolder'),
      });
      if (typeof folder !== 'string') return;

      // Build a clean folder name from the source label
      const sourceName =
        sourceLabel
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, '') || 'm3u_download';

      await addUniversalMediaItems(
        items.map((e) => ({
          url: e.url,
          title: e.title,
          outputPathOverride: folder,
          // Use selected folder + source name as subfolder
          outputSubfolder: `${sourceName}${e.groupTitle ? `/${e.groupTitle}` : ''}`,
          extractor: isHlsUrl(e.url) ? 'hls-stream' : 'direct-media',
          thumbnail: e.logoUrl || undefined,
        })),
      );
      await startUniversalDownload();
    } catch {
      // user cancelled folder picker
    }
  }, [addUniversalMediaItems, entries, filteredEntries, sourceLabel, startUniversalDownload, t]);

  const handleImportSingle = useCallback(
    async (entry: M3uEntry, start: boolean) => {
      await addUniversalMediaItems([
        {
          url: entry.url,
          title: entry.title,
          outputSubfolder: entry.groupTitle || 'm3u',
          extractor: isHlsUrl(entry.url) ? 'hls-stream' : 'direct-media',
          thumbnail: entry.logoUrl || undefined,
        },
      ]);
      if (start) await startUniversalDownload();
    },
    [addUniversalMediaItems, startUniversalDownload],
  );

  const openViewer = useCallback((idx: number) => {
    setViewerIndex(idx);
    setViewerOpen(true);
  }, []);

  const viewerPrev = useCallback(() => setViewerIndex((i) => Math.max(0, i - 1)), []);
  const viewerNext = useCallback(
    () => setViewerIndex((i) => Math.min(filteredEntries.length - 1, i + 1)),
    [filteredEntries.length],
  );

  useEffect(() => {
    if (!viewerOpen || !viewerItem) {
      setViewerResolvedSrc(null);
      setViewerResolving(false);
      return;
    }

    if (!viewerItem.resolverUrl) {
      setViewerResolvedSrc(viewerItem.url);
      setViewerResolving(false);
      return;
    }

    let cancelled = false;
    setViewerResolving(true);
    setViewerResolvedSrc(viewerItem.url);

    void (async () => {
      try {
        const resolved = await invoke<ResolvedPageSource>('resolve_page_stream', {
          request: {
            url: viewerItem.resolverUrl || viewerItem.url,
            headers: requestHeaders,
          },
        });
        if (cancelled) return;
        const index = viewerItem.resolverIndex ?? 0;
        const refreshed =
          resolved.entries?.[index]?.url || resolved.entries?.[0]?.url || viewerItem.url;
        setViewerResolvedSrc(refreshed);
      } catch {
        if (!cancelled) {
          setViewerResolvedSrc(viewerItem.url);
        }
      } finally {
        if (!cancelled) {
          setViewerResolving(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [viewerItem, viewerOpen, requestHeaders]);

  useEffect(() => {
    if (!viewerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') viewerPrev();
      else if (e.key === 'ArrowRight') viewerNext();
      else if (e.key === 'Escape') setViewerOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [viewerOpen, viewerPrev, viewerNext]);

  const handleOpenUrl = useCallback(async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      // ignore
    }
  }, []);

  // ── Render helpers ─────────────────────────────────────

  const formatTime = useCallback((ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }, []);

  const renderEntryCard = useCallback(
    (entry: M3uEntry, idx: number, showFavButton: boolean) => (
      <div
        key={`${entry.url}-${idx}`}
        className="rounded-lg border border-border/60 bg-background/70 p-2 space-y-1.5 transition-colors hover:border-primary/30"
      >
        <button
          type="button"
          className="h-28 w-full rounded bg-muted/40 overflow-hidden flex items-center justify-center transition-colors hover:bg-muted/60 relative"
          onClick={() => openViewer(idx)}
        >
          {entry.logoUrl ? (
            <img
              src={entry.logoUrl}
              alt={entry.title}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-full w-full object-contain"
            />
          ) : isHlsUrl(entry.url) ? (
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              <FileVideo className="w-8 h-8" />
              <span className="text-[10px]">HLS</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              <Play className="w-8 h-8" />
              <span className="text-[10px]">Video</span>
            </div>
          )}
          {/* Favorite indicator */}
          {showFavButton && favoriteUrls.has(entry.url) && (
            <Star className="absolute top-1 right-1 w-4 h-4 text-yellow-400 fill-yellow-400" />
          )}
        </button>

        <p className="text-xs font-medium text-foreground/90 truncate" title={entry.title}>
          {entry.title}
        </p>

        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1 min-w-0">
            {entry.groupTitle && (
              <span className="rounded px-1.5 py-0.5 bg-purple-500/10 text-[10px] text-purple-600 dark:text-purple-400 truncate max-w-[100px]">
                {entry.groupTitle}
              </span>
            )}
            {entry.duration > 0 && (
              <span className="rounded px-1.5 py-0.5 bg-muted text-[10px] text-muted-foreground">
                {Math.floor(entry.duration / 60)}:{String(entry.duration % 60).padStart(2, '0')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            {showFavButton && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                onClick={() => toggleFavorite(entry)}
                title={favoriteUrls.has(entry.url) ? t('m3u.unfavorite') : t('m3u.favorite')}
              >
                <Star
                  className={`w-3.5 h-3.5 ${favoriteUrls.has(entry.url) ? 'text-yellow-400 fill-yellow-400' : 'text-muted-foreground'}`}
                />
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[11px]"
              onClick={() => openViewer(idx)}
            >
              <Play className="w-3 h-3 mr-0.5" />
              {t('m3u.play')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => void handleImportSingle(entry, true)}
            >
              <Download className="w-3 h-3 mr-0.5" />
              {t('m3u.download')}
            </Button>
          </div>
        </div>

        <p
          className="text-[10px] text-muted-foreground break-all max-h-6 overflow-hidden"
          title={entry.url}
        >
          {entry.url}
        </p>
      </div>
    ),
    [favoriteUrls, handleImportSingle, openViewer, t, toggleFavorite],
  );

  // ── Main render ────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-border/40">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-pink-500 to-rose-600 flex items-center justify-center shadow-lg shadow-pink-500/20">
            <FileVideo className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">{t('m3u.title')}</h1>
            <p className="text-xs text-muted-foreground">{t('m3u.description')}</p>
          </div>
        </div>

        {/* URL input / file picker */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadFromUrl(inputUrl);
              }}
              placeholder={t('m3u.urlPlaceholder')}
              className="h-9 text-sm flex-1"
            />
            <Button
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => void loadFromUrl(inputUrl)}
              disabled={isLoading || !inputUrl.trim()}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              {t('m3u.load')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-1.5"
              onClick={() => void loadFromFile()}
              disabled={isLoading}
            >
              <FolderOpen className="w-4 h-4" />
              {t('m3u.openFile')}
            </Button>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium text-foreground/80">
                {t('m3u.requestHeaders')}
              </p>
              <p className="text-[10px] text-muted-foreground">{t('m3u.requestHeadersHint')}</p>
            </div>
            <Textarea
              value={requestHeadersText}
              onChange={(e) => setRequestHeadersText(e.target.value)}
              placeholder={t('m3u.requestHeadersPlaceholder')}
              className="min-h-[72px] text-xs"
            />
          </div>
        </div>
        {/* Tabs */}
        <div className="flex items-center gap-1 mt-3">
          {(
            [
              ['browser', FileVideo, t('m3u.tabBrowser')],
              ['favorites', Heart, t('m3u.tabFavorites')],
              ['history', Clock, t('m3u.tabHistory')],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id as Tab)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              } `}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              {id === 'favorites' && totalFavCount > 0 && (
                <span className="rounded-full bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 px-1.5 text-[10px]">
                  {totalFavCount}
                </span>
              )}
              {id === 'history' && history.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 text-[10px]">{history.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Browser toolbar (only when in browser tab with entries) */}
        {activeTab === 'browser' && entries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="rounded px-2 py-1 bg-muted text-xs text-muted-foreground truncate max-w-[300px]">
              {sourceLabel}
            </span>
            <span className="rounded px-2 py-1 bg-blue-500/10 text-xs text-blue-600 dark:text-blue-400">
              {t('m3u.entryCount', { count: entries.length })}
            </span>
            {groups.length > 0 && (
              <span className="rounded px-2 py-1 bg-purple-500/10 text-xs text-purple-600 dark:text-purple-400">
                {t('m3u.groupCount', { count: groups.length })}
              </span>
            )}
            <div className="flex-1" />
            <Input
              type="text"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              placeholder={t('m3u.filterPlaceholder')}
              className="h-7 w-48 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => void handleImportAll(false)}
            >
              <Download className="w-3.5 h-3.5" />
              {t('m3u.importAll')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => void handleImportAll(true)}
            >
              <Play className="w-3.5 h-3.5" />
              {t('m3u.importAndStart')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => void handleDownloadToFolder()}
            >
              <FolderDown className="w-3.5 h-3.5" />
              {t('m3u.downloadToFolder')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={favoriteAll}
              title={t('m3u.favoriteAllHint')}
            >
              <BookmarkPlus className="w-3.5 h-3.5" />
              {t('m3u.favoriteAll')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs"
              onClick={() => {
                setEntries([]);
                setSourceLabel('');
                setFilter('');
                setError(null);
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('m3u.clear')}
            </Button>
          </div>
        )}

        {error && (
          <div className="rounded p-2 mt-2 text-xs bg-destructive/10 text-destructive flex items-center gap-1.5">
            <X className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* ── Tab Content ─────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Browser tab */}
        {activeTab === 'browser' &&
          (visibleEntries.length > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleEntries.map((entry, idx) => renderEntryCard(entry, idx, true))}
              </div>
              {visibleCount < filteredEntries.length && (
                <div className="flex justify-center mt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  >
                    {t('m3u.loadMore', { remaining: filteredEntries.length - visibleCount })}
                  </Button>
                </div>
              )}
            </>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <FileVideo className="w-12 h-12 opacity-40" />
              <p className="text-sm">{t('m3u.emptyState')}</p>
              <p className="text-xs max-w-md text-center">{t('m3u.emptyStateHint')}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('m3u.noMatch')}</p>
          ))}

        {/* Favorites tab */}
        {activeTab === 'favorites' &&
          (totalFavCount > 0 || favData.folders.length > 0 ? (
            <div className="space-y-3">
              {/* Favorites toolbar */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">
                  {favData.folders.length > 0 &&
                    `${favData.folders.length} ${t('m3u.foldersLabel')}`}
                  {favData.folders.length > 0 && favData.singles.length > 0 && ' · '}
                  {favData.singles.length > 0 &&
                    `${favData.singles.length} ${t('m3u.singlesLabel')}`}
                </span>
                <div className="flex-1" />
                {favData.folders.length > 0 && (
                  <>
                    {selectedFolders.size < favData.folders.length ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs"
                        onClick={selectAllFolders}
                      >
                        <CheckSquare className="w-3.5 h-3.5" />
                        {t('m3u.selectAll')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs"
                        onClick={deselectAllFolders}
                      >
                        <Square className="w-3.5 h-3.5" />
                        {t('m3u.deselectAll')}
                      </Button>
                    )}
                    {selectedFolders.size > 0 && (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 gap-1 text-xs"
                        onClick={deleteSelectedFolders}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {t('m3u.deleteSelected', { count: selectedFolders.size })}
                      </Button>
                    )}
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-xs text-destructive/70 hover:text-destructive"
                  onClick={clearAllFavorites}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('m3u.clearAllFavorites')}
                </Button>
              </div>
              {/* Folders */}
              {favData.folders.map((folder) => {
                const isExpanded = expandedFolders.has(folder.id);
                const isRenaming = renamingFolderId === folder.id;
                const isSelected = selectedFolders.has(folder.id);
                return (
                  <div
                    key={folder.id}
                    className={`rounded-xl border overflow-hidden transition-colors ${
                      isSelected
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-border/60 bg-background/70 hover:border-yellow-500/30'
                    }`}
                  >
                    {/* Folder header */}
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/30 border-b border-border/40">
                      {/* Select checkbox */}
                      <button
                        type="button"
                        className="flex-shrink-0"
                        onClick={() => toggleSelectFolder(folder.id)}
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-primary" />
                        ) : (
                          <Square className="w-4 h-4 text-muted-foreground" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-2 flex-1 min-w-0 text-left"
                        onClick={() => toggleFolderExpand(folder.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        )}
                        <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                        {isRenaming ? (
                          <Input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => renameFolder(folder.id, renameValue)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') renameFolder(folder.id, renameValue);
                              if (e.key === 'Escape') setRenamingFolderId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="h-6 text-xs flex-1 px-1.5"
                            autoFocus
                          />
                        ) : (
                          <span className="text-sm font-medium truncate">{folder.name}</span>
                        )}
                      </button>
                      <span className="rounded-full px-2 py-0.5 bg-yellow-500/15 text-[10px] text-yellow-600 dark:text-yellow-400 flex-shrink-0">
                        {folder.entries.length} {t('m3u.channels')}
                      </span>
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        {formatTime(folder.createdAt)}
                      </span>
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenamingFolderId(folder.id);
                            setRenameValue(folder.name);
                            // Focus input after render
                            setTimeout(() => renameInputRef.current?.focus(), 50);
                          }}
                          title={t('m3u.renameFolder')}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 text-destructive/60 hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFolder(folder.id);
                          }}
                          title={t('m3u.deleteFolder')}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>

                    {/* Source URL row */}
                    {folder.sourceUrl && (
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/20 border-b border-border/30">
                        <Link className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        <p
                          className="text-[10px] text-muted-foreground truncate flex-1 min-w-0"
                          title={folder.sourceUrl}
                        >
                          {folder.sourceUrl}
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1.5 text-[10px] flex-shrink-0"
                          onClick={() => reloadFolderSource(folder.sourceUrl)}
                        >
                          <FolderOpen className="w-2.5 h-2.5 mr-0.5" />
                          {t('m3u.reload')}
                        </Button>
                      </div>
                    )}

                    {/* Folder entries (when expanded) */}
                    {isExpanded && (
                      <div className="p-2">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                          {folder.entries.map((fav, idx) => (
                            <div
                              key={fav.url}
                              className="rounded-lg border border-border/40 bg-background/50 p-2 space-y-1 transition-colors hover:border-yellow-500/30"
                            >
                              <button
                                type="button"
                                className="h-24 w-full rounded bg-muted/30 overflow-hidden flex items-center justify-center transition-colors hover:bg-muted/50 relative"
                                onClick={() => {
                                  setEntries(folder.entries);
                                  setViewerIndex(idx);
                                  setViewerOpen(true);
                                }}
                              >
                                {fav.logoUrl ? (
                                  <img
                                    src={fav.logoUrl}
                                    alt={fav.title}
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                    className="h-full w-full object-contain"
                                  />
                                ) : (
                                  <div className="flex flex-col items-center gap-1 text-muted-foreground">
                                    <FileVideo className="w-6 h-6" />
                                    <span className="text-[9px]">
                                      {isHlsUrl(fav.url) ? 'HLS' : 'Video'}
                                    </span>
                                  </div>
                                )}
                              </button>
                              <p className="text-[11px] font-medium truncate" title={fav.title}>
                                {fav.title}
                              </p>
                              <div className="flex items-center justify-between gap-1">
                                <div className="flex items-center gap-1 min-w-0">
                                  {fav.groupTitle && (
                                    <span className="rounded px-1 py-0.5 bg-purple-500/10 text-[9px] text-purple-600 dark:text-purple-400 truncate max-w-[80px]">
                                      {fav.groupTitle}
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-0.5">
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-5 px-1.5 text-[10px]"
                                    onClick={() => {
                                      setEntries(folder.entries);
                                      setViewerIndex(idx);
                                      setViewerOpen(true);
                                    }}
                                  >
                                    <Play className="w-2.5 h-2.5 mr-0.5" />
                                    {t('m3u.play')}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                                    onClick={() => removeFolderEntry(folder.id, fav.url)}
                                  >
                                    <X className="w-2.5 h-2.5" />
                                  </Button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Individual favorites (singles) */}
              {favData.singles.length > 0 && (
                <>
                  {favData.folders.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-2 mb-1">
                      {t('m3u.individualFavorites')}
                    </p>
                  )}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {favData.singles.map((fav, idx) => (
                      <div
                        key={fav.url}
                        className="rounded-lg border border-border/60 bg-background/70 p-2 space-y-1.5 transition-colors hover:border-yellow-500/40"
                      >
                        <button
                          type="button"
                          className="h-28 w-full rounded bg-muted/40 overflow-hidden flex items-center justify-center transition-colors hover:bg-muted/60 relative"
                          onClick={() => {
                            setEntries(favData.singles);
                            setViewerIndex(idx);
                            setViewerOpen(true);
                          }}
                        >
                          {fav.logoUrl ? (
                            <img
                              src={fav.logoUrl}
                              alt={fav.title}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-1 text-muted-foreground">
                              <FileVideo className="w-8 h-8" />
                              <span className="text-[10px]">
                                {isHlsUrl(fav.url) ? 'HLS' : 'Video'}
                              </span>
                            </div>
                          )}
                          <Star className="absolute top-1 right-1 w-4 h-4 text-yellow-400 fill-yellow-400" />
                        </button>
                        <p
                          className="text-xs font-medium text-foreground/90 truncate"
                          title={fav.title}
                        >
                          {fav.title}
                        </p>
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1 min-w-0">
                            {fav.groupTitle && (
                              <span className="rounded px-1.5 py-0.5 bg-purple-500/10 text-[10px] text-purple-600 dark:text-purple-400 truncate max-w-[100px]">
                                {fav.groupTitle}
                              </span>
                            )}
                            <span className="rounded px-1.5 py-0.5 bg-muted text-[10px] text-muted-foreground">
                              {formatTime(fav.addedAt)}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => {
                                setEntries(favData.singles);
                                setViewerIndex(idx);
                                setViewerOpen(true);
                              }}
                            >
                              <Play className="w-3 h-3 mr-0.5" />
                              {t('m3u.play')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => void handleImportSingle(fav, true)}
                            >
                              <Download className="w-3 h-3 mr-0.5" />
                              {t('m3u.download')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 text-destructive/60 hover:text-destructive"
                              onClick={() => removeFavorite(fav.url)}
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                        <p
                          className="text-[10px] text-muted-foreground break-all max-h-6 overflow-hidden"
                          title={fav.url}
                        >
                          {fav.url}
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <Star className="w-12 h-12 opacity-40" />
              <p className="text-sm">{t('m3u.noFavorites')}</p>
              <p className="text-xs max-w-md text-center">{t('m3u.noFavoritesHint')}</p>
            </div>
          ))}

        {/* History tab */}
        {activeTab === 'history' &&
          (history.length > 0 ? (
            <div className="space-y-1.5">
              <div className="flex justify-end mb-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={clearHistory}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('m3u.clearHistory')}
                </Button>
              </div>
              {history.map((item) => (
                <div
                  key={item.url}
                  className="group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/40 hover:border-primary/30 bg-background/70 transition-colors"
                >
                  <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.label}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{item.url}</p>
                  </div>
                  <span className="rounded px-2 py-0.5 bg-blue-500/10 text-[10px] text-blue-600 dark:text-blue-400 flex-shrink-0">
                    {item.entryCount} entries
                  </span>
                  <span className="text-[10px] text-muted-foreground flex-shrink-0 w-16 text-right">
                    {formatTime(item.timestamp)}
                  </span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-xs gap-1"
                      onClick={() => {
                        setInputUrl(item.url);
                        void loadFromUrl(item.url);
                      }}
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      {t('m3u.load')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeHistoryItem(item.url)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <Clock className="w-12 h-12 opacity-40" />
              <p className="text-sm">{t('m3u.noHistory')}</p>
              <p className="text-xs max-w-md text-center">{t('m3u.noHistoryHint')}</p>
            </div>
          ))}
      </div>

      {/* ── Viewer dialog ────────────────────────────── */}
      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent className="max-w-5xl overflow-hidden p-0">
          <div className="flex max-h-[85vh] flex-col">
            <DialogHeader className="border-b border-border/60 px-5 py-4">
              <DialogTitle className="flex items-center justify-between gap-3 text-base">
                <span className="truncate">{viewerItem?.title ?? t('m3u.viewer')}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {viewerIndex + 1} / {filteredEntries.length}
                </span>
              </DialogTitle>
            </DialogHeader>

            {viewerItem && (
              <>
                <div className="flex min-h-[320px] items-center justify-center overflow-auto bg-black px-4 py-4">
                  {viewerResolving && (
                    <div className="absolute z-10 flex items-center gap-2 rounded bg-black/70 px-3 py-2 text-xs text-white">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Resolving stream...
                    </div>
                  )}
                  <HlsVideoPlayer
                    key={viewerResolvedSrc || viewerItem.url}
                    src={viewerResolvedSrc || viewerItem.url}
                    controls
                    autoPlay
                    preload="auto"
                    requestHeaders={requestHeaders}
                    sourcePageUrl={
                      viewerItem.resolverContextUrl ||
                      viewerItem.resolverUrl ||
                      sourceLabel ||
                      undefined
                    }
                    className="max-h-[62vh] w-full rounded object-contain"
                  />
                </div>

                <div className="flex flex-col gap-3 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={viewerPrev}
                        disabled={viewerIndex <= 0}
                      >
                        {t('m3u.prev')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={viewerNext}
                        disabled={viewerIndex >= filteredEntries.length - 1}
                      >
                        {t('m3u.next')}
                      </Button>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" onClick={() => toggleFavorite(viewerItem)}>
                        <Star
                          className={`w-3.5 h-3.5 mr-1 ${favoriteUrls.has(viewerItem.url) ? 'text-yellow-400 fill-yellow-400' : ''}`}
                        />
                        {favoriteUrls.has(viewerItem.url) ? t('m3u.unfavorite') : t('m3u.favorite')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleImportSingle(viewerItem, true)}
                      >
                        <Download className="w-3.5 h-3.5 mr-1" />
                        {t('m3u.download')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleOpenUrl(viewerItem.url)}
                      >
                        <ExternalLink className="w-3.5 h-3.5 mr-1" />
                        {t('m3u.openExternal')}
                      </Button>
                    </div>
                  </div>

                  <p className="max-h-16 overflow-y-auto break-all text-xs text-muted-foreground">
                    {viewerItem.url}
                  </p>

                  <p className="text-[11px] text-muted-foreground">{t('m3u.viewerHotkeys')}</p>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
