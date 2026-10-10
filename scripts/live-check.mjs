import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configureBrowserReads, closeReadBrowser } from '../dist/api/browser-transport.js';
import * as movie from '../dist/api/movie.js';
import * as book from '../dist/api/book.js';
import { searchMovies } from '../dist/api/search.js';
import { getHotLists } from '../dist/api/list.js';
import { getDoulist } from '../dist/api/doulist.js';
import { ensureAuth } from '../dist/auth.js';
import { loadAuthenticatedUserCollectionPage } from '../dist/api/collection.js';
import { getPersonalRecord, editPersonalRecord } from '../dist/api/record.js';

const { values } = parseArgs({ options: { only: { type: 'string' }, browser: { type: 'string', default: 'chromium' }, resume: { type: 'boolean' }, private: { type: 'boolean' } } });
const output = path.resolve('user/live-validation.json');
mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const report = values.resume ? JSON.parse(readFileSync(output, 'utf8')) : { date: new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()), results: [] };
configureBrowserReads({ browser: values.browser });
let auth;
const cases = [
 ['movie.search', async () => { const metadata={partial:false,warnings:[]};const items=await searchMovies('沙丘',0,2,metadata);return {items,...metadata}; }],
 ['movie.detail', () => movie.getMovieDetail('1292052')],
 ['movie.hot', () => movie.getHot('movie','热门',2)],
 ['movie.tv', () => movie.getHot('tv','英剧',2)],
 ['movie.rank', () => movie.getRank(17,2)],
 ['movie.top250', () => movie.getTop250(0,2)],
 ['movie.coming', () => movie.getComing(2)],
 ['movie.weekly', () => movie.getWeekly(2)],
 ['movie.rating', () => movie.getRatingStats('1292052')],
 ['movie.comments', () => movie.getComments('1292052','hot',0,2)],
 ['movie.reviews', () => movie.getReviews('1292052',0,2)],
 ['book.search', async () => {const metadata={partial:false,warnings:[]};const items=await book.searchBooks('三体',0,2,metadata);return {items,...metadata};}],
 ['book.detail', () => book.getBookInfo('2567698')],
 ['book.top250', () => book.getBookTop250(0,2)],
 ['book.chart', () => book.getBookChart('小说',2)],
 ['book.new', () => book.getLatestBooks('科学新知',2)],
 ['book.rating', () => book.getBookRatingStats('2567698')],
 ['book.comments', () => book.getBookComments('2567698','hot',0,2)],
 ['book.reviews', () => book.getBookReviews('2567698',0,2)],
 ['book.notes', () => book.getBookNotes('2567698',0,2)],
 ['list.hot', () => getHotLists(2)],
 ['list.detail', () => getDoulist('240962',{limit:26,delayMs:1000})]
];
if (values.private) {
 for (const kind of ['movie','book']) {
  cases.push([`${kind}.records`, async () => {
   auth ??= await ensureAuth();
   return loadAuthenticatedUserCollectionPage({kind,userId:auth.accountId,status:'collect',count:2},auth.cookies);
  }]);
  cases.push([`${kind}.record`, async () => {
   auth ??= await ensureAuth();
   const page=await loadAuthenticatedUserCollectionPage({kind,userId:auth.accountId,status:'collect',count:1},auth.cookies);
   if(!page.items.length) return {skipped:true,reason:'没有收藏'};
   const record=await getPersonalRecord(kind,page.items[0].id,auth.cookies);
   const preview=await editPersonalRecord(kind,record.id,{comment:record.comment},auth.cookies,true);
   return {id:record.id,status:record.status,dryRun:preview.dryRun,changed:preview.changed};
  }]);
 }
}
const selected = values.only?.split(',');
try {
 for (const [name, test] of cases) {
  if (selected && !selected.includes(name)) continue;
  if (values.resume && report.results.some(r=>r.name===name && r.status==='passed')) continue;
  if (report.results.length) await new Promise(resolve=>setTimeout(resolve,1000));
  const started=Date.now();
  let result;
  try {
   const value=await test();
   const items=Array.isArray(value)?value:value.items;
   if(value?.partial) throw new Error(`结果不完整：${(value.warnings??[]).join('; ')}`);
   result={name,status:value?.skipped?'skipped':'passed',elapsedMs:Date.now()-started,...(items?{count:items.length}:{}),...(value?.title?{title:value.title}:{}),...(value?.dryRun?{dryRun:true}:{}),...(value?.limited?{limited:true,nextStart:value.nextStart}:{})};
  } catch (error) {
   result={name,status:'failed',elapsedMs:Date.now()-started,message: error instanceof Error ? error.message : String(error)};
   process.exitCode=1;
  }
  report.results=report.results.filter(r=>r.name!==name);report.results.push(result);
  writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));
  if(result.status==='failed') break;
 }
} finally { await closeReadBrowser(); }
