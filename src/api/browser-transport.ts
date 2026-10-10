import { createHash } from 'node:crypto';
import type { Browser, BrowserContext, Response as BrowserResponse } from 'playwright';
import { launchBrowser, type LaunchBrowserName } from '../browser.js';

let options: { browser: LaunchBrowserName; executable?: string; headed?: boolean } | undefined;
let pending: Promise<Browser> | undefined;
const contexts = new Map<string, Promise<BrowserContext>>();

export function configureBrowserReads(config: typeof options): void { options = config; }

export async function closeReadBrowser(): Promise<void> {
  const browser = await pending?.catch(() => undefined);
  pending = undefined;
  contexts.clear();
  await browser?.close();
}

async function contextFor(headers: Headers): Promise<BrowserContext> {
  if (!options) throw new Error('浏览器查询方式未配置');
  const cookieHeader = headers.get('cookie') ?? '';
  const key = createHash('sha256').update(cookieHeader).digest('hex');
  pending ??= launchBrowser(options.browser, options.executable, !options.headed);
  let context = contexts.get(key);
  if (!context) {
    context = pending.then(async (browser) => {
      const selected = await browser.newContext({ userAgent: headers.get('user-agent') ?? undefined });
      const cookies = cookieHeader.split(';').map((entry) => {
        const split = entry.indexOf('=');
        return { name: entry.slice(0, split).trim(), value: entry.slice(split + 1).trim(), domain: '.douban.com', path: '/', secure: true };
      }).filter((cookie) => cookie.name === 'dbcl2' || cookie.name === 'ck');
      if (cookies.length) await selected.addCookies(cookies);
      return selected;
    });
    contexts.set(key, context);
  }
  return context;
}

export const readFetch: typeof fetch = async (input, init) => {
  if (!options) return fetch(input, init);
  const url = new URL(String(input));
  if (url.protocol !== 'https:' || !(url.hostname === 'douban.com' || url.hostname.endsWith('.douban.com'))) throw new Error('浏览器查询仅接受豆瓣 HTTPS 地址');
  if (init?.method && init.method !== 'GET') throw new Error('浏览器查询只支持 GET');
  const headers = new Headers(init?.headers);
  const context = await contextFor(headers);
  const page = await context.newPage();
  let response: BrowserResponse | null = null;
  page.on('response', (current) => {
    if (current.request().isNavigationRequest() && current.frame() === page.mainFrame()) response = current;
  });
  try {
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000, referer: headers.get('referer') ?? undefined });
    if (new URL(page.url()).hostname === 'sec.douban.com') {
      // Allow the page's normal JavaScript verification to finish. Captchas are not solved.
      await page.waitForURL((current) => current.hostname !== 'sec.douban.com', { timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    const finalResponse = response as BrowserResponse | null;
    if (!finalResponse) throw new Error('浏览器没有返回导航响应');
    const responseHeaders = await finalResponse.allHeaders();
    const isJson = (responseHeaders['content-type'] ?? '').includes('json');
    const body = isJson ? await finalResponse.text() : await page.content();
    const result = new Response(body, { status: finalResponse.status(), headers: responseHeaders });
    Object.defineProperty(result, 'url', { value: page.url() });
    return result;
  } finally { await page.close(); }
};
