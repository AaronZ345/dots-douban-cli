import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'dist/index.js');

function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.error, undefined);
  return result;
}

const rootHelp = run('--help');
assert.equal(rootHelp.status, 0);
assert.match(rootHelp.stdout, /douban - 豆瓣命令行工具 v\d+/);
assert.doesNotMatch(rootHelp.stdout, /vundefined/);
assert.match(rootHelp.stdout, /电影:/);
assert.match(rootHelp.stdout, /书籍:/);
assert.match(rootHelp.stdout, /收藏与账号:/);
assert.match(rootHelp.stdout, /写入操作:/);
for (const bookCommand of [
  'hot',
  'top250',
  'user',
  'export',
  'chart',
  'new|latest',
  'search',
  'info',
  'rating',
  'comments',
  'reviews',
  'notes'
]) {
  assert.match(rootHelp.stdout, new RegExp(`douban book ${bookCommand.replace('|', '\\|')}`));
}
assert.doesNotMatch(rootHelp.stdout, /douban book tag/);
assert.equal(rootHelp.stderr, '');

const bookHelp = run('book', '--help');
assert.equal(bookHelp.status, 0);
assert.match(bookHelp.stdout, /Usage: douban book/);
assert.match(bookHelp.stdout, /top250/);
assert.match(bookHelp.stdout, /chart/);
assert.match(bookHelp.stdout, /comments/);
assert.doesNotMatch(bookHelp.stdout, /\btag\b/);

const movieCommentsHelp = run('comments', '--help');
assert.equal(movieCommentsHelp.status, 0);
assert.doesNotMatch(movieCommentsHelp.stdout, /--latest/);

const bookCommentsHelp = run('book', 'comments', '--help');
assert.equal(bookCommentsHelp.status, 0);
assert.doesNotMatch(bookCommentsHelp.stdout, /--latest/);

const legacyHotHelp = run('book', 'hot', '--help');
assert.equal(legacyHotHelp.status, 0);
assert.match(legacyHotHelp.stdout, /--start/);

const oversizedBookChart = run('book', 'chart', '--limit', '21', '--json');
assert.equal(oversizedBookChart.status, 1);
assert.equal(oversizedBookChart.stdout, '');
const oversizedBookChartPayload = JSON.parse(oversizedBookChart.stderr);
assert.equal(oversizedBookChartPayload.error.code, 'INVALID_ARGUMENT');
assert.match(oversizedBookChartPayload.error.message, /不能超过 20/);

const searchHelp = run('search', '--help');
assert.equal(searchHelp.status, 0);
assert.match(searchHelp.stdout, /<keyword>/);
assert.match(searchHelp.stdout, /--limit/);

const missingArgument = run('search');
assert.equal(missingArgument.status, 1);
assert.equal(missingArgument.stdout, '');
assert.match(missingArgument.stderr, /\[INVALID_ARGUMENT\]/);
assert.match(missingArgument.stderr, /missing required argument/);

const missingArgumentJson = run('search', '--json');
assert.equal(missingArgumentJson.status, 1);
assert.equal(missingArgumentJson.stdout, '');
const missingPayload = JSON.parse(missingArgumentJson.stderr);
assert.equal(missingPayload.ok, false);
assert.equal(missingPayload.error.code, 'INVALID_ARGUMENT');
assert.equal(missingPayload.error.command, 'douban');

const invalidEnumJson = run('rank', '不存在', '--json');
assert.equal(invalidEnumJson.status, 1);
assert.equal(invalidEnumJson.stdout, '');
const enumPayload = JSON.parse(invalidEnumJson.stderr);
assert.equal(enumPayload.ok, false);
assert.equal(enumPayload.error.code, 'INVALID_ARGUMENT');
assert.equal(enumPayload.error.command, 'rank');

const unknownCommandJson = run('not-a-command', '--json');
assert.equal(unknownCommandJson.status, 1);
assert.equal(unknownCommandJson.stdout, '');
const unknownPayload = JSON.parse(unknownCommandJson.stderr);
assert.equal(unknownPayload.ok, false);
assert.equal(unknownPayload.error.code, 'UNKNOWN_COMMAND');

console.log('CLI smoke tests passed');
