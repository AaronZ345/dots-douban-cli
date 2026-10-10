import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromiumStoragePassword, decryptChromiumCookie, readChromiumCookies, resolveCookieDatabases } from '../browser-cookies.js';

const temporary: string[] = [];
afterEach(() => { for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function encrypt(value: string, host = '.douban.com', version = 24, prefix = 'v11', password = 'synthetic-keyring', platform = 'linux'): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', platform === 'darwin' ? 1003 : 1, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([version >= 24 ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(value)]);
  return Buffer.concat([Buffer.from(prefix), cipher.update(plaintext), cipher.final()]);
}

describe('Chromium cookie compatibility with synthetic data', () => {
  it('decrypts Linux v10/basic, v11/keyring and macOS v10/keychain formats', () => {
    expect(decryptChromiumCookie(encrypt('fixture-basic', '.douban.com', 24, 'v10', 'peanuts'), '.douban.com', 24, 'linux')).toBe('fixture-basic');
    expect(decryptChromiumCookie(encrypt('fixture-keyring'), '.douban.com', 24, 'linux', 'synthetic-keyring')).toBe('fixture-keyring');
    expect(decryptChromiumCookie(encrypt('fixture-mac', '.douban.com', 23, 'v10', 'synthetic-keyring', 'darwin'), '.douban.com', 23, 'darwin', 'synthetic-keyring')).toBe('fixture-mac');
  });
  it('rejects wrong keys, mismatched host hashes and unsupported formats', () => {
    expect(decryptChromiumCookie(encrypt('fixture'), '.douban.com', 24, 'linux', 'wrong-key')).toBeNull();
    expect(decryptChromiumCookie(encrypt('fixture'), 'www.douban.com', 24, 'linux', 'synthetic-keyring')).toBeNull();
    expect(decryptChromiumCookie(Buffer.from('v20unsupported'), '.douban.com', 24, 'linux')).toBeNull();
    expect(decryptChromiumCookie(encrypt('fixture'), '.douban.com', 24, 'linux')).toBeNull();
  });
  it('looks up Chromium rather than Chrome in GNOME keyring', async () => {
    const reader = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('synthetic-keyring');
    expect(await chromiumStoragePassword('chromium', { platform: 'linux', home: '/test', env: {} }, 10000, reader)).toBe('synthetic-keyring');
    expect(reader.mock.calls[0].slice(0, 2)).toEqual(['secret-tool', ['lookup', 'service', 'Chromium Safe Storage', 'account', 'Chromium']]);
    expect(reader.mock.calls[1].slice(0, 2)).toEqual(['secret-tool', ['lookup', 'application', 'chromium']]);
  });
  it('uses the selected browser and KDE wallet instead of another browser key', async () => {
    const reader = vi.fn().mockResolvedValueOnce('"test-wallet"').mockResolvedValueOnce('synthetic-keyring');
    await chromiumStoragePassword('brave', { platform: 'linux', home: '/test', env: { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' } }, 10000, reader);
    expect(reader.mock.calls[1].slice(0, 2)).toEqual(['kwallet-query', ['--read-password', 'Brave Safe Storage', '--folder', 'Brave Keys', 'test-wallet']]);
  });
  it('uses macOS keychain for Vivaldi', async () => {
    const reader = vi.fn().mockResolvedValue('synthetic-keyring');
    await chromiumStoragePassword('vivaldi', { platform: 'darwin', home: '/test', env: {} }, 10000, reader);
    expect(reader).toHaveBeenCalledWith('security', ['find-generic-password', '-w', '-s', 'Vivaldi Safe Storage', '-a', 'Vivaldi'], 10000);
  });
  it.skipIf(process.platform === 'win32')('selects native, Snap and Flatpak profiles and resolves display names', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'douban-profiles-'));
    temporary.push(home);
    const root = path.join(home, '.config', 'chromium');
    for (const profile of ['Default', 'Profile 2']) {
      mkdirSync(path.join(root, profile, 'Network'), { recursive: true });
      writeFileSync(path.join(root, profile, 'Network', 'Cookies'), 'synthetic database marker');
    }
    writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work' } } } }));
    const target = { platform: 'linux' as const, home, env: {} };
    expect(resolveCookieDatabases('chromium', 'Work', target).map(item => item.profile)).toEqual(['Profile 2']);
    expect(resolveCookieDatabases('chromium', 'Missing', target)).toEqual([]);
    expect(resolveCookieDatabases('brave', undefined, target)).toEqual([]);
    expect(resolveCookieDatabases('chromium', root, target).map(item => item.profile)).toEqual(['Default']);
    const snap = path.join(home, 'snap', 'chromium', 'common', 'chromium', 'Default');
    mkdirSync(snap, { recursive: true }); writeFileSync(path.join(snap, 'Cookies'), 'synthetic');
    expect(resolveCookieDatabases('chromium', undefined, target)).toHaveLength(2);
  });
  it.skipIf(process.platform === 'win32')('reads only active Douban auth cookies from a real synthetic SQLite database', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'douban-cookie-db-'));
    temporary.push(home);
    const profile = path.join(home, '.config', 'chromium', 'Default');
    mkdirSync(profile, { recursive: true });
    const dbPath = path.join(profile, 'Cookies');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES (\'version\', \'24\'); CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER)');
    const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('.douban.com', 'dbcl2', '', encrypt('fixture-account'), '/', 0);
    insert.run('.douban.com', 'ck', 'fixture-csrf', Buffer.alloc(0), '/', 0);
    insert.run('.douban.com', 'bid', 'unrelated', Buffer.alloc(0), '/', 0);
    insert.run('.example.com', 'dbcl2', 'foreign', Buffer.alloc(0), '/', 0);
    insert.run('.douban.com', 'ck', 'expired', Buffer.alloc(0), '/', 1);
    db.close();
    const reader = vi.fn().mockResolvedValue('synthetic-keyring');
    const result = await readChromiumCookies('chromium', undefined, 10000, { platform: 'linux', home, env: {} }, reader);
    expect(result.cookies.map(cookie => [cookie.name, cookie.value])).toEqual([['dbcl2', 'fixture-account'], ['ck', 'fixture-csrf']]);
    expect(result.warnings).toEqual([]);
    expect(result.cookies[0].source.profile).toBe('Default');
  });
});
