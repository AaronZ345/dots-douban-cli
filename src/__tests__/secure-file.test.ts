import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensurePrivateDirectory,
  migratePrivateFile,
  secureAtomicWriteFile
} from '../storage/secure-file.ts';

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

describe('private storage migration', () => {
  it('creates the application directory with private permissions', () => {
    const directory = path.join(tempDir, 'state', 'douban-cli');

    ensurePrivateDirectory(directory);
    ensurePrivateDirectory(directory);

    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  });

  it('does not silently tighten permissions on an existing shared directory', () => {
    const directory = path.join(tempDir, 'shared');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);

    expect(() => ensurePrivateDirectory(directory)).toThrow('chmod 700');
    expect(lstatSync(directory).mode & 0o777).toBe(0o755);
  });

  it('deletes the legacy file only after the new copy is validated', () => {
    const source = path.join(tempDir, 'legacy.json');
    const target = path.join(tempDir, 'state', 'douban-cli', 'auth.json');
    writeFileSync(source, '{"ok":true}\n');

    const migrated = migratePrivateFile(source, target, (contents) => {
      expect(JSON.parse(contents)).toEqual({ ok: true });
    });

    expect(migrated).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}\n');
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
  });

  it('keeps the legacy file when validation fails', () => {
    const source = path.join(tempDir, 'legacy.json');
    const target = path.join(tempDir, 'state', 'douban-cli', 'auth.json');
    writeFileSync(source, 'invalid');

    expect(() => migratePrivateFile(source, target, () => {
      throw new Error('invalid cache');
    })).toThrow('invalid cache');

    expect(existsSync(source)).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});
