import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium,firefox,webkit } from 'playwright';
import { parseRecordForm } from '../dist/api/record.js';
const fixture=JSON.parse(readFileSync(new URL('../src/__tests__/fixtures/record-book-current.json',import.meta.url),'utf8'));
for(const [name,engine] of Object.entries({chromium,firefox,webkit})) {
 const browser=await engine.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.route('https://example.org/**',route=>route.fulfill({contentType:'text/html',body:`<h1>匿名兼容性测试</h1>${fixture.html}`}));
  await page.goto('https://example.org/compatibility');
  const current=await page.locator('form').evaluate(form=>({html:form.outerHTML,tags:['合成标签']}));
  const record=parseRecordForm(current,'book','42','fixture-only-csrf').record;
  assert.equal(record.status,'collect');assert.equal(record.rating,5);assert.equal(record.private,true);
  console.log(JSON.stringify({browser:name,launch:true,anonymousDom:true,recordParsing:true}));
 } finally {await browser.close();}
}
