import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'dist/index.js');

function run(...args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

const rootHelp = run('--help');
assert.match(rootHelp, /douban - 豆瓣命令行工具 v\d+/);
assert.doesNotMatch(rootHelp, /vundefined/);

const bookHelp = run('book', '--help');
assert.match(bookHelp, /Usage: douban book/);
assert.match(bookHelp, /top250/);
assert.match(bookHelp, /chart/);
assert.match(bookHelp, /comments/);

const legacyHotHelp = run('book', 'hot', '--help');
assert.match(legacyHotHelp, /--start/);

const searchHelp = run('book', 'search', '--help');
assert.match(searchHelp, /<keyword>/);
assert.match(searchHelp, /--limit/);

console.log('CLI help smoke tests passed');
