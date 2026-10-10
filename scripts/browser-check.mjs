import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium,firefox,webkit } from 'playwright';
import { parseRecordForm } from '../dist/api/record.js';
import { browserLaunchOptions, launchBrowser } from '../dist/browser.js';
import { parseLaunchBrowser } from '../dist/browser-platform.js';
import { readChromiumCookies } from '../dist/browser-cookies.js';
const { values } = parseArgs({ options: { browser: { type: 'string', multiple: true }, 'cookie-store': { type: 'boolean' } } });
const fixture=JSON.parse(readFileSync(new URL('../src/__tests__/fixtures/record-book-current.json',import.meta.url),'utf8'));
const selected = values.browser?.map(parseLaunchBrowser) ?? ['chromium', 'firefox', 'webkit'];
for(const name of selected) {
 const engines = { chromium, firefox, webkit };
 const browser = values.browser ? await launchBrowser(name) : await engines[name].launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.route('https://example.org/**',route=>route.fulfill({contentType:'text/html',body:`<h1>匿名兼容性测试</h1>${fixture.html}`}));
  await page.goto('https://example.org/compatibility');
  const current=await page.locator('form').evaluate(form=>({html:form.outerHTML,tags:['合成标签']}));
  const record=parseRecordForm(current,'book','42','fixture-only-csrf').record;
  assert.equal(record.status,'collect');assert.equal(record.rating,5);assert.equal(record.private,true);
  console.log(JSON.stringify({platform:process.platform,browser:name,version:browser.version(),adapter:Boolean(values.browser),launch:true,anonymousDom:true,recordParsing:true}));
 } finally {await browser.close();}
}
if (values['cookie-store']) {
 assert.equal(process.platform, 'linux', 'Cookie store check requires Linux');
 const directory = mkdtempSync(path.join(os.tmpdir(), 'douban-anonymous-chromium-'));
 try {
  const context = await chromium.launchPersistentContext(directory, {
   ...browserLaunchOptions('chromium'), headless: true, args: ['--password-store=basic']
  });
  try {
   await context.addCookies(['dbcl2', 'ck'].map(name => ({ name, value: `fixture-only-${name}`, domain: '.douban.com',
    path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 86400 })));
  } finally { await context.close(); }
  const result = await readChromiumCookies('chromium', directory);
  assert.deepEqual(result.cookies.map(cookie => [cookie.name, cookie.value]).sort(),
   [['ck', 'fixture-only-ck'], ['dbcl2', 'fixture-only-dbcl2']]);
  assert.deepEqual(result.warnings, []);
  console.log(JSON.stringify({ platform: process.platform, browser: 'chromium', cookieStoreRoundTrip: true, realAccount: false }));
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
