import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secureAtomicWriteFile } from '../storage/secure-file.ts';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'douban-secure-file-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('secureAtomicWriteFile', () => {
  it('creates a complete private file', () => {
    const target = path.join(tempDir, 'session.json');

    secureAtomicWriteFile(target, 'secret\n');

    expect(readFileSync(target, 'utf8')).toBe('secret\n');
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
  });

  it('repairs permissive permissions when replacing a file', () => {
    const target = path.join(tempDir, 'session.json');
    writeFileSync(target, 'old', { mode: 0o644 });
    chmodSync(target, 0o644);

    secureAtomicWriteFile(target, 'new');

    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
  });

  it('refuses regular and dangling symbolic link targets', () => {
    const realTarget = path.join(tempDir, 'real.txt');
    const linkedTarget = path.join(tempDir, 'linked.txt');
    const danglingTarget = path.join(tempDir, 'dangling.txt');
    writeFileSync(realTarget, 'untouched');
    symlinkSync(realTarget, linkedTarget);
    symlinkSync(path.join(tempDir, 'missing.txt'), danglingTarget);

    expect(() => secureAtomicWriteFile(linkedTarget, 'overwrite')).toThrow('symbolic link');
    expect(() => secureAtomicWriteFile(danglingTarget, 'overwrite')).toThrow('symbolic link');
    expect(readFileSync(realTarget, 'utf8')).toBe('untouched');
  });
});
