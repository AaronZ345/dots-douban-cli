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
assert.equal(rootHelp.stderr, '');

const bookHelp = run('book', '--help');
assert.equal(bookHelp.status, 0);
assert.match(bookHelp.stdout, /Usage: douban book/);
assert.match(bookHelp.stdout, /top250/);
assert.match(bookHelp.stdout, /chart/);
assert.match(bookHelp.stdout, /comments/);

const legacyHotHelp = run('book', 'hot', '--help');
assert.equal(legacyHotHelp.status, 0);
assert.match(legacyHotHelp.stdout, /--start/);

const searchHelp = run('search', '--help');
assert.equal(searchHelp.status, 0);
assert.match(searchHelp.stdout, /<keyword>/);
assert.match(searchHelp.stdout, /--limit/);

const nowHelp = run('now', '--help');
assert.equal(nowHelp.status, 0);
assert.match(nowHelp.stdout, /城市拼音/);
assert.match(nowHelp.stdout, /beijing/);

const invalidCity = run('now', '--city', '上海', '--json');
assert.equal(invalidCity.status, 1);
assert.equal(invalidCity.stdout, '');
const invalidCityPayload = JSON.parse(invalidCity.stderr);
assert.equal(invalidCityPayload.error.code, 'INVALID_ARGUMENT');
assert.match(invalidCityPayload.error.message, /必须使用拼音/);

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
