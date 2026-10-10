import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), publicRead: vi.fn(), privateRead: vi.fn() }));
vi.mock('../auth.js', () => ({ ensureAuth: mocks.auth }));
vi.mock('../api/collection.js', () => ({ getUserCollectionPage: mocks.publicRead, loadAuthenticatedUserCollectionPage: mocks.privateRead }));
import { registerRecordCommands } from '../commands/records.ts';

const originalArgv = process.argv;
let output: ReturnType<typeof vi.spyOn>;
let originalExitCode: typeof process.exitCode;
const item = { kind: 'book', id: '42', title: '书名', url: 'https://book.douban.com/subject/42/', comment: '内容', date: '2026-10-09', rating: 4, cover: '' };
beforeEach(() => {
  vi.clearAllMocks();
  originalExitCode = process.exitCode; process.exitCode = undefined;
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue({ accountId: 'owner', cookies: 'fixture-session' });
});
afterEach(() => { process.argv = originalArgv; process.exitCode = originalExitCode; vi.restoreAllMocks(); });
async function run(args: string[]) {
  const program = new Command(); program.exitOverride(); registerRecordCommands(program);
  process.argv = ['node', 'douban-cli', ...args]; await program.parseAsync(process.argv);
}
function result() { return JSON.parse(String(output.mock.calls[0][0])); }
describe('record command routing', () => {
  it('reads private book records using the verified account', async () => {
    mocks.privateRead.mockResolvedValue({ items: [item], nextStart: null, total: 1, partial: false, warnings: [] });
    await run(['records', '--kind', 'book', '--json']);
    expect(mocks.privateRead).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', kind: 'book' }), 'fixture-session');
    expect(mocks.publicRead).not.toHaveBeenCalled();
    expect(result().metadata).toMatchObject({ userId: 'owner', partial: false, count: 1 });
  });
  it('reads a specified public user without inspecting login state', async () => {
    mocks.publicRead.mockResolvedValue({ items: [item], nextStart: null, partial: false, warnings: [] });
    await run(['records', '--user', 'public-user', '--kind', 'book', '--json']);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.privateRead).not.toHaveBeenCalled();
    expect(result().metadata.userId).toBe('public-user');
  });
  it('keeps earlier records and stops all groups after a failed page', async () => {
    mocks.privateRead.mockResolvedValueOnce({ items: [item], nextStart: 15, partial: false, warnings: [] }).mockRejectedValueOnce(new Error('page failed'));
    await run(['records', '--kind', 'all', '--delay', '0', '--json']);
    expect(result().metadata).toMatchObject({ partial: true, fetched: 1 });
    expect(process.exitCode).toBe(2);
    expect(mocks.privateRead).toHaveBeenCalledTimes(2);
  });
  it('stops repeated pages without an unbounded request loop', async () => {
    mocks.privateRead.mockResolvedValueOnce({ items: [item], nextStart: 15, partial: false, warnings: [] }).mockResolvedValueOnce({ items: [item], nextStart: 30, partial: false, warnings: [] });
    await run(['records', '--kind', 'book', '--delay', '0', '--json']);
    expect(result().metadata.partial).toBe(true);
    expect(mocks.privateRead).toHaveBeenCalledTimes(2);
  });
  it('validates impossible dates and conflicting edits before login', async () => {
    await run(['records', '--from', '2026-02-30', '--json']);
    expect(mocks.auth).not.toHaveBeenCalled();
    await run(['record', 'edit', '42', '--comment', 'x', '--clear-comment', '--json']);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
