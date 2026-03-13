import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import Hls, {
  type FragmentLoaderContext,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type LoaderResponse,
  type LoaderStats,
  type PlaylistLoaderContext,
} from 'hls.js';
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { buildProxyRequest } from '@/lib/proxyFetch';

/** Returns true if the URL looks like an HLS manifest (.m3u8 / .m3u). */
export function isHlsUrl(url: string): boolean {
  return /\.m3u8?(?:$|[?#&])/i.test(url);
}

interface CodecInfo {
  name: string;
  mse: boolean;
  native: string;
}

interface StreamCodecInfo {
  video: string[];
  audio: string[];
}

interface ImageSequenceManifest {
  frames: string[];
  frameDurationSec: number;
}

interface HttpInspectResponse {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  contentLength?: number | null;
}

const HLS_TEXT_ACCEPT =
  'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.9, */*;q=0.8';
const MEDIA_ACCEPT = '*/*';
const HEVC_STORE_URL = 'ms-windows-store://pdp/?ProductId=9n4wgh0z6vhq';
const HEVC_WEB_URL = 'https://apps.microsoft.com/detail/9n4wgh0z6vhq';

function resolveManifestUrl(baseUrl: string, value: string): string {
  try {
    return new URL(value.trim(), baseUrl).toString();
  } catch {
    return value.trim();
  }
}

function parseImageSequenceManifest(
  text: string,
  manifestUrl: string,
): ImageSequenceManifest | null {
  const lines = text.split(/\r?\n/);
  const frames: string[] = [];
  const durations: number[] = [];
  let pendingDuration = 2;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice(8).split(',')[0] || '2');
      pendingDuration = Number.isFinite(value) && value > 0 ? value : 2;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!/\.(jpg|jpeg|png|webp)(?:$|[?#&])/i.test(line)) {
      return null;
    }
    frames.push(resolveManifestUrl(manifestUrl, line));
    durations.push(pendingDuration);
  }

  if (frames.length === 0) return null;
  const avg =
    durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 2;
  return {
    frames,
    frameDurationSec: avg > 0 ? avg : 2,
  };
}

function createEmptyLoaderStats(): LoaderStats {
  const now = performance.now();
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: now, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

function buildPlaybackHeaders(
  sourceUrl: string,
  accept: string,
  requestHeaders?: Record<string, string>,
  extraHeaders?: Record<string, string>,
) {
  return buildProxyRequest(sourceUrl, {
    accept,
    extraHeaders: {
      ...(requestHeaders || {}),
      ...(extraHeaders || {}),
    },
  }).headers;
}

function createTauriHlsLoader(sourceUrl: string, requestHeaders?: Record<string, string>) {
  return class SourceAwareTauriHlsLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = createEmptyLoaderStats();
    private requestId = 0;

    destroy(): void {
      this.abort();
      this.context = null;
    }

    abort(): void {
      this.requestId += 1;
      this.stats.aborted = true;
    }

    load(
      context: LoaderContext,
      _config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      const requestId = ++this.requestId;
      const wantsBinary = context.responseType === 'arraybuffer';
      const accept = wantsBinary ? MEDIA_ACCEPT : HLS_TEXT_ACCEPT;
      const request = buildProxyRequest(context.url, {
        accept,
        extraHeaders: buildPlaybackHeaders(sourceUrl, accept, requestHeaders, context.headers),
        rangeStart: context.rangeStart,
        rangeEnd: context.rangeEnd,
      });

      this.context = context;
      this.stats = createEmptyLoaderStats();

      void (async () => {
        try {
          if (wantsBinary) {
            const bytes = await invoke<number[]>('fetch_binary_url', { request });
            if (requestId !== this.requestId) {
              callbacks.onAbort?.(this.stats, context, null);
              return;
            }

            const data = Uint8Array.from(bytes).buffer;
            this.finishSuccess(
              context,
              callbacks,
              {
                url: context.url,
                data,
                code: 200,
              },
              data.byteLength,
            );
            return;
          }

          const text = await invoke<string>('fetch_text_url', { request });
          if (requestId !== this.requestId) {
            callbacks.onAbort?.(this.stats, context, null);
            return;
          }

          this.finishSuccess(
            context,
            callbacks,
            {
              url: context.url,
              data: text,
              text,
              code: 200,
            },
            new TextEncoder().encode(text).byteLength,
          );
        } catch (error) {
          if (requestId !== this.requestId || this.stats.aborted) {
            callbacks.onAbort?.(this.stats, context, null);
            return;
          }

          this.stats.loading.end = performance.now();
          callbacks.onError(
            {
              code: 0,
              text: error instanceof Error ? error.message : String(error),
            },
            context,
            null,
            this.stats,
          );
        }
      })();
    }

    private finishSuccess(
      context: LoaderContext,
      callbacks: LoaderCallbacks<LoaderContext>,
      response: LoaderResponse,
      totalBytes: number,
    ): void {
      const now = performance.now();
      this.stats.loading.first = now;
      this.stats.loading.end = now;
      this.stats.loaded = totalBytes;
      this.stats.total = totalBytes;
      this.stats.chunkCount = totalBytes > 0 ? 1 : 0;
      callbacks.onSuccess(response, this.stats, context, null);
    }
  };
}

function uniqueCodecs(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isCodecSupported(mime: string): boolean {
  try {
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime)) {
      return true;
    }
    const video = document.createElement('video');
    return video.canPlayType(mime) !== '';
  } catch {
    return false;
  }
}

function isProbablyUnsupportedVideoCodec(codec: string): boolean {
  const normalized = codec.toLowerCase();
  if (normalized.includes('hvc1') || normalized.includes('hev1')) {
    return !isCodecSupported(`video/mp4; codecs="${codec}"`);
  }
  if (normalized.includes('av01')) {
    return !isCodecSupported(`video/mp4; codecs="${codec}"`);
  }
  return false;
}

export function detectCodecs(): CodecInfo[] {
  const video = document.createElement('video');
  const codecs: Array<{ name: string; mime: string }> = [
    { name: 'H.264 (AVC)', mime: 'video/mp4; codecs="avc1.42E01E"' },
    { name: 'H.264 High', mime: 'video/mp4; codecs="avc1.640028"' },
    { name: 'H.265 (HEVC) hvc1', mime: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
    { name: 'H.265 (HEVC) hev1', mime: 'video/mp4; codecs="hev1.1.6.L93.B0"' },
    { name: 'VP8', mime: 'video/webm; codecs="vp8"' },
    { name: 'VP9', mime: 'video/webm; codecs="vp9"' },
    { name: 'AV1', mime: 'video/mp4; codecs="av01.0.01M.08"' },
    { name: 'AAC', mime: 'audio/mp4; codecs="mp4a.40.2"' },
    { name: 'Opus', mime: 'audio/webm; codecs="opus"' },
    { name: 'MPEG-TS H.264', mime: 'video/mp2t; codecs="avc1.42E01E"' },
  ];
  return codecs.map(({ name, mime }) => ({
    name,
    mse: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime),
    native: video.canPlayType(mime) || 'no',
  }));
}

function isHevcSupported(): boolean {
  try {
    if (typeof MediaSource !== 'undefined') {
      if (
        MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
        MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')
      ) {
        return true;
      }
    }
    const video = document.createElement('video');
    return (
      video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') === 'probably' ||
      video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') === 'probably'
    );
  } catch {
    return false;
  }
}

type PlaybackState = 'loading' | 'playing' | 'audio-only' | 'error' | 'external';

interface HlsVideoPlayerProps {
  src: string;
  key?: string;
  controls?: boolean;
  autoPlay?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
  className?: string;
  style?: CSSProperties;
  videoRef?: RefObject<HTMLVideoElement | null>;
  requestHeaders?: Record<string, string>;
  sourcePageUrl?: string;
}

export function HlsVideoPlayer({
  src,
  controls,
  autoPlay,
  preload = 'metadata',
  className,
  style,
  videoRef: externalRef,
  requestHeaders,
  sourcePageUrl,
}: HlsVideoPlayerProps) {
  const internalRef = useRef<HTMLVideoElement | null>(null);
  const ref = externalRef ?? internalRef;
  const hlsRef = useRef<Hls | null>(null);
  const [state, setState] = useState<PlaybackState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [showCodecs, setShowCodecs] = useState(false);
  const [streamCodecs, setStreamCodecs] = useState<StreamCodecInfo>({ video: [], audio: [] });
  const [imageSequence, setImageSequence] = useState<ImageSequenceManifest | null>(null);
  const [imageFrameIndex, setImageFrameIndex] = useState(0);
  const [imageFrameSrc, setImageFrameSrc] = useState<string | null>(null);
  const [diagContextUrl, setDiagContextUrl] = useState('');
  const [diagFirstFrameUrl, setDiagFirstFrameUrl] = useState('');
  const [diagFirstFrameStatus, setDiagFirstFrameStatus] = useState('');
  const [diagHlsFailure, setDiagHlsFailure] = useState('');
  const hevcSupported = useMemo(() => isHevcSupported(), []);
  const codecList = useMemo(() => (showCodecs ? detectCodecs() : []), [showCodecs]);
  const fallbackStage = useRef(0);
  const playbackContextUrl = sourcePageUrl || src;

  const handleOpenExternal = useCallback(async () => {
    try {
      setState('external');
      await openUrl(src);
    } catch {
      /* ignore */
    }
  }, [src]);

  const handleInstallHevc = useCallback(async () => {
    try {
      await openUrl(HEVC_STORE_URL);
    } catch {
      try {
        await openUrl(HEVC_WEB_URL);
      } catch {
        try {
          await navigator.clipboard.writeText(HEVC_WEB_URL);
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const handleCopyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(src);
    } catch {
      /* ignore */
    }
  }, [src]);

  const tryNextFallback = useCallback(() => {
    const video = ref.current;
    if (!video) return;

    fallbackStage.current += 1;

    if (!errorMsg) {
      setErrorMsg(
        'Audio is loading but video frames are not decoding. This usually means the video codec is unsupported in the embedded browser or the video segments/keys require extra headers.',
      );
    }

    if (fallbackStage.current === 1) {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      setState('loading');
      video.src = src;
      video.load();
      video.play().catch(() => {});
    } else if (fallbackStage.current >= 2) {
      void handleOpenExternal();
    }
  }, [errorMsg, src, ref, handleOpenExternal]);

  useEffect(() => {
    if (!imageSequence || imageSequence.frames.length === 0) return;
    setImageFrameIndex(0);
    if (!autoPlay || imageSequence.frames.length <= 1) {
      setState('playing');
      return;
    }

    const frameMs = Math.max(120, Math.round(imageSequence.frameDurationSec * 1000));
    const timer = window.setInterval(() => {
      setImageFrameIndex((index) => (index + 1) % imageSequence.frames.length);
    }, frameMs);

    setState('playing');
    return () => window.clearInterval(timer);
  }, [imageSequence, autoPlay]);

  useEffect(() => {
    if (!imageSequence || imageSequence.frames.length === 0) {
      setImageFrameSrc((current) => {
        if (current?.startsWith('blob:')) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }

    let cancelled = false;
    let nextObjectUrl: string | null = null;
    const frameUrl =
      imageSequence.frames[Math.min(imageFrameIndex, imageSequence.frames.length - 1)];
    const accept = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

    if (imageFrameIndex === 0) {
      setDiagFirstFrameUrl(frameUrl);
    }

    void (async () => {
      try {
        const request = buildProxyRequest(frameUrl, {
          accept,
          extraHeaders: buildPlaybackHeaders(playbackContextUrl, accept, requestHeaders),
        });
        if (imageFrameIndex === 0) {
          const inspect = await invoke<HttpInspectResponse>('inspect_http_url', { request });
          if (!cancelled) {
            setDiagFirstFrameStatus(
              `${inspect.status} ${inspect.contentType || 'unknown'}${inspect.contentLength ? ` ${inspect.contentLength}B` : ''}`,
            );
          }
        }
        const bytes = await invoke<number[]>('fetch_binary_url', { request });
        if (cancelled) return;
        const ext = frameUrl.match(/\.([a-z0-9]+)(?:$|[?#&])/i)?.[1]?.toLowerCase() || 'jpg';
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        nextObjectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mime }));
        setImageFrameSrc((current) => {
          if (current?.startsWith('blob:')) URL.revokeObjectURL(current);
          return nextObjectUrl;
        });
        setState('playing');
      } catch (error) {
        if (cancelled) return;
        if (imageFrameIndex === 0 && !diagFirstFrameStatus) {
          setDiagFirstFrameStatus(error instanceof Error ? error.message : String(error));
        }
        setErrorMsg(
          `Frame sequence request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [imageSequence, imageFrameIndex, playbackContextUrl, requestHeaders, diagFirstFrameStatus]);

  useEffect(() => {
    if (state !== 'loading' || !src) return;
    const timer = window.setTimeout(() => {
      setDiagHlsFailure((current) => current || 'timeout:playback_stalled');
      setErrorMsg(
        (current) =>
          current ||
          'Playback timed out while waiting for the stream to start. Check the context URL, first-frame status, and HLS failure details above.',
      );
      setState((current) => (current === 'loading' ? 'error' : current));
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [state, src]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src || imageSequence) return;

    let checkCount = 0;
    const timer = setInterval(() => {
      checkCount += 1;

      if (video.videoWidth > 0 && video.videoHeight > 0 && !video.paused) {
        setState('playing');
        clearInterval(timer);
        return;
      }

      if (
        !video.paused &&
        video.currentTime > 0.3 &&
        video.readyState >= 2 &&
        video.videoWidth === 0 &&
        video.videoHeight === 0
      ) {
        setState('audio-only');
        clearInterval(timer);
        tryNextFallback();
        return;
      }

      if (checkCount >= 6) {
        clearInterval(timer);
      }
    }, 500);

    return () => clearInterval(timer);
  }, [src, ref, tryNextFallback, imageSequence]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;

    setState('loading');
    setErrorMsg('');
    setStreamCodecs({ video: [], audio: [] });
    setImageSequence(null);
    setImageFrameIndex(0);
    setImageFrameSrc((current) => {
      if (current?.startsWith('blob:')) URL.revokeObjectURL(current);
      return null;
    });
    setDiagContextUrl(playbackContextUrl);
    setDiagFirstFrameUrl('');
    setDiagFirstFrameStatus('');
    setDiagHlsFailure('');
    fallbackStage.current = 0;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (!isHlsUrl(src)) {
      video.src = src;
      const onError = () => {
        const me = video.error;
        const code = me?.code;
        let msg = 'Playback failed';
        if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
          msg = 'Format not supported';
        } else if (code === MediaError.MEDIA_ERR_NETWORK) {
          msg = 'Network error';
        } else if (code === MediaError.MEDIA_ERR_DECODE) {
          msg = 'Decode error';
        }
        if (!hevcSupported) msg += ' - H.265/HEVC codec may be needed';
        setErrorMsg(msg);
        setState('error');
      };
      video.addEventListener('error', onError);
      return () => {
        video.removeEventListener('error', onError);
      };
    }

    if (video.canPlayType('application/vnd.apple.mpegurl') && !requestHeaders && !sourcePageUrl) {
      video.src = src;
      return;
    }

    let cancelled = false;

    const tryImageSequence = async (): Promise<boolean> => {
      try {
        const request = buildProxyRequest(src, {
          accept: HLS_TEXT_ACCEPT,
          extraHeaders: buildPlaybackHeaders(playbackContextUrl, HLS_TEXT_ACCEPT, requestHeaders),
        });
        const manifestText = await invoke<string>('fetch_text_url', { request });
        if (cancelled) return true;
        const sequence = parseImageSequenceManifest(manifestText, src);
        if (!sequence) return false;
        setImageSequence(sequence);
        setState('playing');
        return true;
      } catch {
        return false;
      }
    };

    if (Hls.isSupported()) {
      void (async () => {
        let mediaErrorRecoverAttempts = 0;
        let imageSequenceFallbackTried = false;
        const SourceAwareLoader = createTauriHlsLoader(playbackContextUrl, requestHeaders);
        const TauriBaseLoader = SourceAwareLoader as unknown as new (
          _config: unknown,
        ) => Loader<LoaderContext>;
        const TauriPlaylistLoader = SourceAwareLoader as unknown as new (
          _config: unknown,
        ) => Loader<PlaylistLoaderContext>;
        const TauriFragmentLoader = SourceAwareLoader as unknown as new (
          _config: unknown,
        ) => Loader<FragmentLoaderContext>;

        const createHls = () =>
          new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferHole: 2,
            fragLoadingMaxRetry: 6,
            manifestLoadingMaxRetry: 4,
            levelLoadingMaxRetry: 4,
            loader: TauriBaseLoader,
            pLoader: TauriPlaylistLoader,
            fLoader: TauriFragmentLoader,
            xhrSetup: (xhr: XMLHttpRequest) => {
              xhr.withCredentials = false;
            },
          });

        const hls = createHls();
        hlsRef.current = hls;

        hls.loadSource(src);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          const declaredVideoCodecs = uniqueCodecs(
            data.levels.map((level) => level.videoCodec || ''),
          );
          const declaredAudioCodecs = uniqueCodecs(
            data.levels.map((level) => level.audioCodec || ''),
          );
          setStreamCodecs({ video: declaredVideoCodecs, audio: declaredAudioCodecs });

          const hasLikelyVideoTrack = data.levels.some(
            (level) => Boolean(level.videoCodec) || Boolean(level.width) || Boolean(level.height),
          );
          const allDeclaredVideoCodecsUnsupported =
            declaredVideoCodecs.length > 0 &&
            declaredVideoCodecs.every((codec) => isProbablyUnsupportedVideoCodec(codec));

          if (hasLikelyVideoTrack && allDeclaredVideoCodecsUnsupported) {
            setErrorMsg(
              'This stream uses a video codec that the embedded browser cannot decode. It would likely play audio only, so the app is switching to your external player.',
            );
            hls.destroy();
            void handleOpenExternal();
            return;
          }

          if (declaredVideoCodecs.some((codec) => isProbablyUnsupportedVideoCodec(codec))) {
            setErrorMsg(
              'This stream exposes a video codec that the embedded browser likely cannot decode. The audio track may still play, but video frames can stay black.',
            );
          }
          if (autoPlay) video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          setDiagHlsFailure(`${data.type}:${data.details || 'unknown'}`);
          void (async () => {
            if (!imageSequenceFallbackTried) {
              imageSequenceFallbackTried = true;
              if (await tryImageSequence()) {
                hls.destroy();
                return;
              }
            }

            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                setErrorMsg(
                  `Stream request failed: ${data.details || data.type}. The source may require Referer/Origin/Cookie headers or block segment/key access.`,
                );
                setState('error');
                hls.destroy();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                if (mediaErrorRecoverAttempts < 2) {
                  mediaErrorRecoverAttempts += 1;
                  hls.recoverMediaError();
                } else {
                  setErrorMsg('Media decode error');
                  setState('error');
                  hls.destroy();
                }
                break;
              default:
                setErrorMsg(`Playback error: ${data.details || 'unknown'}`);
                setState('error');
                hls.destroy();
                break;
            }
          })();
        });
      })();
    } else {
      video.src = src;
    }

    return () => {
      cancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [
    src,
    ref,
    autoPlay,
    hevcSupported,
    requestHeaders,
    handleOpenExternal,
    playbackContextUrl,
    sourcePageUrl,
  ]);

  const showInfoBar = state === 'audio-only';
  const showHevcInstall = !hevcSupported;
  const codecSummary = [
    streamCodecs.video.length > 0 ? `Video: ${streamCodecs.video.join(', ')}` : '',
    streamCodecs.audio.length > 0 ? `Audio: ${streamCodecs.audio.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const showDiagnostics = Boolean(
    sourcePageUrl || diagFirstFrameUrl || diagFirstFrameStatus || diagHlsFailure || errorMsg,
  );

  return (
    <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
      {/* biome-ignore lint/a11y/useMediaCaption: captions not available for arbitrary streams */}
      <video
        ref={ref}
        controls={controls}
        autoPlay={autoPlay}
        playsInline
        preload={preload}
        className={className}
        style={{
          display: imageSequence ? 'none' : 'block',
          width: '100%',
          minHeight: '200px',
          background: '#000',
          ...style,
        }}
      />

      {imageSequence && imageSequence.frames.length > 0 && (
        <img
          src={imageFrameSrc || undefined}
          alt="frame sequence"
          className={className}
          style={{
            display: 'block',
            width: '100%',
            minHeight: '200px',
            background: '#000',
            objectFit: 'contain',
            ...style,
          }}
        />
      )}

      {codecSummary && (
        <div
          style={{
            position: 'absolute',
            left: 12,
            bottom: 12,
            maxWidth: 'calc(100% - 24px)',
            padding: '6px 10px',
            borderRadius: '8px',
            background: 'rgba(0,0,0,0.68)',
            color: '#fff',
            fontSize: '11px',
            lineHeight: 1.4,
            zIndex: 8,
            whiteSpace: 'normal',
          }}
        >
          {codecSummary}
        </div>
      )}

      {showDiagnostics && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            maxWidth: 'calc(100% - 24px)',
            padding: '8px 10px',
            borderRadius: '8px',
            background: 'rgba(0,0,0,0.72)',
            color: '#fff',
            fontSize: '11px',
            lineHeight: 1.45,
            zIndex: 9,
            whiteSpace: 'normal',
            textAlign: 'left',
          }}
        >
          {diagContextUrl && <div>Context: {diagContextUrl}</div>}
          {diagFirstFrameUrl && <div>First frame: {diagFirstFrameUrl}</div>}
          {diagFirstFrameStatus && <div>First frame status: {diagFirstFrameStatus}</div>}
          {diagHlsFailure && <div>HLS failure: {diagHlsFailure}</div>}
        </div>
      )}

      {showInfoBar && (
        <div
          style={{
            position: 'absolute',
            bottom: 40,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: '8px',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
          {fallbackStage.current === 0
            ? 'Audio only detected, trying native playback...'
            : fallbackStage.current === 1
              ? 'Still no video, opening in external player...'
              : 'Opened in external player'}
        </div>
      )}

      {state === 'external' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            backgroundColor: 'rgba(0, 0, 0, 0.88)',
            color: '#fff',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: '14px', opacity: 0.9 }}>🖥️ Stream opened in external player</p>
          <p style={{ fontSize: '12px', opacity: 0.6, maxWidth: '380px', lineHeight: 1.5 }}>
            {errorMsg ||
              "This stream uses a video codec not supported by the browser. It has been opened in your system's default media player (VLC, Windows Media Player, etc.)"}
          </p>
          {codecSummary && (
            <p style={{ fontSize: '11px', opacity: 0.75, maxWidth: '380px', lineHeight: 1.5 }}>
              {codecSummary}
            </p>
          )}
          {showHevcInstall && (
            <div
              style={{
                marginTop: '4px',
                padding: '10px 14px',
                borderRadius: '8px',
                background: 'rgba(59, 130, 246, 0.12)',
                border: '1px solid rgba(59, 130, 246, 0.25)',
                maxWidth: '360px',
                width: '100%',
              }}
            >
              <p style={{ fontSize: '11px', opacity: 0.75, marginBottom: '6px' }}>
                💡 To play H.265 streams in-app, install the free HEVC codec:
              </p>
              <button
                type="button"
                onClick={() => void handleInstallHevc()}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'rgba(59, 130, 246, 0.7)',
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                Install HEVC Video Extensions (Free) ↗
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
            <button
              type="button"
              onClick={() => void handleOpenExternal()}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              Re-open in player
            </button>
            <button
              type="button"
              onClick={() => void handleCopyUrl()}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              Copy URL
            </button>
          </div>
        </div>
      )}

      {state === 'error' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            backgroundColor: 'rgba(0, 0, 0, 0.88)',
            color: '#fff',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: '13px', opacity: 0.9, maxWidth: '420px', lineHeight: 1.5 }}>
            {errorMsg || 'Playback failed'}
          </p>

          {codecSummary && (
            <p style={{ fontSize: '11px', opacity: 0.75, maxWidth: '420px', lineHeight: 1.5 }}>
              {codecSummary}
            </p>
          )}

          {showHevcInstall && (
            <div
              style={{
                marginTop: '4px',
                padding: '12px 16px',
                borderRadius: '10px',
                background: 'rgba(59, 130, 246, 0.15)',
                border: '1px solid rgba(59, 130, 246, 0.3)',
                maxWidth: '400px',
                width: '100%',
              }}
            >
              <p style={{ fontSize: '12px', opacity: 0.85, marginBottom: '8px' }}>
                💡 Install free HEVC codec to enable H.265 playback:
              </p>
              <button
                type="button"
                onClick={() => void handleInstallHevc()}
                style={{
                  padding: '7px 14px',
                  borderRadius: '7px',
                  border: 'none',
                  background: 'rgba(59, 130, 246, 0.8)',
                  color: '#fff',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                Install HEVC Video Extensions (Free) ↗
              </button>
              <p style={{ fontSize: '10px', opacity: 0.5, marginTop: '6px' }}>
                After installing, restart the app
              </p>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: '8px',
              marginTop: '4px',
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            <button
              type="button"
              onClick={() => void handleOpenExternal()}
              style={{
                padding: '7px 14px',
                borderRadius: '7px',
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'rgba(255,255,255,0.08)',
                color: '#fff',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              ▶ Open in external player
            </button>
            <button
              type="button"
              onClick={() => void handleCopyUrl()}
              style={{
                padding: '7px 14px',
                borderRadius: '7px',
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'rgba(255,255,255,0.08)',
                color: '#fff',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              Copy URL
            </button>
            <button
              type="button"
              onClick={() => setShowCodecs((v) => !v)}
              style={{
                padding: '7px 14px',
                borderRadius: '7px',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.05)',
                color: 'rgba(255,255,255,0.6)',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              {showCodecs ? 'Hide codec info' : 'Show codec info'}
            </button>
          </div>

          {showCodecs && codecList.length > 0 && (
            <div
              style={{
                marginTop: '6px',
                padding: '10px 14px',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                maxWidth: '420px',
                width: '100%',
                textAlign: 'left',
                maxHeight: '180px',
                overflowY: 'auto',
              }}
            >
              <p style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', opacity: 0.7 }}>
                System Codec Support:
              </p>
              <table style={{ width: '100%', fontSize: '10px', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                    <th style={{ textAlign: 'left', padding: '2px 4px', opacity: 0.5 }}>Codec</th>
                    <th style={{ textAlign: 'center', padding: '2px 4px', opacity: 0.5 }}>MSE</th>
                    <th style={{ textAlign: 'center', padding: '2px 4px', opacity: 0.5 }}>
                      Native
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {codecList.map((c) => (
                    <tr key={c.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '3px 4px' }}>{c.name}</td>
                      <td style={{ textAlign: 'center', padding: '3px 4px' }}>
                        {c.mse ? '✅' : '❌'}
                      </td>
                      <td style={{ textAlign: 'center', padding: '3px 4px' }}>
                        {c.native === 'probably' ? '✅' : c.native === 'maybe' ? '⚠️' : '❌'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
