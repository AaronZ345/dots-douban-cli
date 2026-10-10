import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium,firefox,webkit } from 'playwright';
import { parseRecordForm } from '../dist/api/record.js';
import { launchBrowser } from '../dist/browser.js';
import { parseLaunchBrowser } from '../dist/browser-platform.js';
const { values } = parseArgs({ options: { browser: { type: 'string', multiple: true } } });
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
