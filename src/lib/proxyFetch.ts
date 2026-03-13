export interface NativeProxyRequest {
  url: string;
  headers?: Record<string, string>;
  rangeStart?: number;
  rangeEnd?: number;
}

interface BuildProxyRequestOptions {
  accept?: string;
  extraHeaders?: Record<string, string>;
  rangeStart?: number;
  rangeEnd?: number;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function deriveOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function buildProxyRequest(
  url: string,
  options: BuildProxyRequestOptions = {},
): NativeProxyRequest {
  const headers: Record<string, string> = {
    'User-Agent': 'Youwee/1.0',
  };

  if (options.accept) {
    headers.Accept = options.accept;
  }

  if (isHttpUrl(url)) {
    const origin = deriveOrigin(url);
    if (origin) {
      headers.Origin = origin;
      headers.Referer = `${origin}/`;
    }
  }

  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders);
  }

  return {
    url,
    headers,
    ...(typeof options.rangeStart === 'number' ? { rangeStart: options.rangeStart } : {}),
    ...(typeof options.rangeEnd === 'number' ? { rangeEnd: options.rangeEnd } : {}),
  };
}
