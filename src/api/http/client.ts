import { HttpRequestError } from './errors.js';

type ResponseKind = 'html' | 'json';

export interface HttpClientOptions {
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export interface HtmlPage {
  html: string;
  url: string;
  status: number;
}

interface TextResponse {
  text: string;
  url: string;
  status: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function responseSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - now);
}

function isJsonContentType(contentType: string): boolean {
  return /(?:^|\s|;)application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType);
}

function isHtmlContentType(contentType: string): boolean {
  return /(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType);
}

export function isChallengeHtml(html: string): boolean {
  const normalized = html.toLowerCase();
  return (
    (normalized.includes('name="sec"') && normalized.includes('id="sec"'))
    || normalized.includes('sec.douban.com')
    || html.includes('检测到有异常请求')
    || html.includes('访问豆瓣的方式有点异常')
    || (html.includes('载入中') && /验证码|安全验证|机器人/.test(html))
  );
}

export function isLoginHtml(html: string): boolean {
  return (
    /<title[^>]*>\s*(?:登录豆瓣|豆瓣登录)[\s\S]*?<\/title>/i.test(html)
    || (/accounts\.douban\.com\/passport\/login/i.test(html) && /(?:form_email|form_password|account-form)/i.test(html))
  );
}

function isLoginRedirect(finalUrl: string): boolean {
  if (!finalUrl) return false;
  try {
    const parsed = new URL(finalUrl);
    return parsed.hostname === 'accounts.douban.com' && /\/passport\/login/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function validateRedirect(requestUrl: string, responseUrl: string): void {
  if (!responseUrl) return;

  let requested: URL;
  let resolved: URL;
  try {
    requested = new URL(requestUrl);
    resolved = new URL(responseUrl);
  } catch {
    throw new HttpRequestError(`Invalid redirect target for ${requestUrl}`, {
      code: 'REDIRECT',
      url: requestUrl
    });
  }

  if (resolved.protocol !== 'https:') {
    throw new HttpRequestError(`Refused non-HTTPS redirect for ${requestUrl}`, {
      code: 'REDIRECT',
      url: requestUrl
    });
  }

  const requestedIsDouban = requested.hostname === 'douban.com' || requested.hostname.endsWith('.douban.com');
  const resolvedIsDouban = resolved.hostname === 'douban.com' || resolved.hostname.endsWith('.douban.com');
  if (requestedIsDouban && !resolvedIsDouban) {
    throw new HttpRequestError(`Refused redirect outside douban.com for ${requestUrl}`, {
      code: 'REDIRECT',
      url: requestUrl
    });
  }
}

export class HttpClient {
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: HttpClientOptions = {}) {
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 3));
    this.baseRetryDelayMs = Math.max(0, options.baseRetryDelayMs ?? 150);
    this.maxRetryDelayMs = Math.max(this.baseRetryDelayMs, options.maxRetryDelayMs ?? 10000);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const { text } = await this.getText(url, headers, 'json');
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new HttpRequestError(`Invalid JSON response from ${url}`, {
        code: 'INVALID_JSON',
        url,
        responseSnippet: responseSnippet(text),
        cause: error
      });
    }
  }

  async getHtml(url: string, headers: Record<string, string> = {}): Promise<string> {
    const { text } = await this.getText(url, headers, 'html');
    return text;
  }

  async getHtmlPage(url: string, headers: Record<string, string> = {}): Promise<HtmlPage> {
    const response = await this.getText(url, headers, 'html');
    return {
      html: response.text,
      url: response.url,
      status: response.status
    };
  }

  private async getText(url: string, headers: Record<string, string>, kind: ResponseKind): Promise<TextResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { ...this.defaultHeaders, ...headers },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const text = await response.text();
        const snippet = responseSnippet(text);

        validateRedirect(url, response.url);
        if (isLoginRedirect(response.url) || isLoginHtml(text)) {
          throw new HttpRequestError(`Authentication is required for ${url}`, {
            code: 'AUTH_REQUIRED',
            url,
            status: response.status,
            attempts: attempt,
            responseSnippet: snippet
          });
        }
        if (isChallengeHtml(text)) {
          throw new HttpRequestError(`Anti-bot challenge returned for ${url}`, {
            code: 'CHALLENGE',
            url,
            status: response.status,
            attempts: attempt,
            responseSnippet: snippet
          });
        }

        if (!response.ok) {
          const retryable = RETRYABLE_STATUS.has(response.status);
          if (retryable && attempt < this.maxAttempts) {
            await this.sleep(this.retryDelayMs(attempt, response.headers.get('retry-after')));
            continue;
          }
          throw new HttpRequestError(`HTTP ${response.status} for ${url}`, {
            code: 'HTTP_STATUS',
            url,
            status: response.status,
            attempts: attempt,
            retryable,
            responseSnippet: snippet
          });
        }

        const contentType = response.headers.get('content-type') || '';
        const validContentType = kind === 'json'
          ? isJsonContentType(contentType)
          : isHtmlContentType(contentType);
        if (!validContentType) {
          throw new HttpRequestError(`Unexpected content-type "${contentType || 'missing'}" for ${url}`, {
            code: 'CONTENT_TYPE',
            url,
            status: response.status,
            attempts: attempt,
            responseSnippet: snippet
          });
        }

        return {
          text,
          url: response.url || url,
          status: response.status
        };
      } catch (error) {
        if (error instanceof HttpRequestError) throw error;
        lastError = error;
        if (attempt < this.maxAttempts) {
          await this.sleep(this.retryDelayMs(attempt, null));
          continue;
        }
      }
    }

    throw new HttpRequestError(`Network request failed for ${url}`, {
      code: 'NETWORK',
      url,
      attempts: this.maxAttempts,
      retryable: true,
      cause: lastError
    });
  }

  private retryDelayMs(attempt: number, retryAfter: string | null): number {
    const requestedDelay = parseRetryAfter(retryAfter);
    if (requestedDelay !== null) return Math.min(requestedDelay, this.maxRetryDelayMs);

    const exponential = this.baseRetryDelayMs * (2 ** Math.max(0, attempt - 1));
    const jitter = 0.75 + this.random() * 0.5;
    return Math.min(Math.round(exponential * jitter), this.maxRetryDelayMs);
  }
}
