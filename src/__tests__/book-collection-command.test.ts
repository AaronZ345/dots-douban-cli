import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

type PagerOptions = {
  startPage?: number;
  fetchPage: (page: number) => Promise<{
    items: unknown[];
    total?: number;
    hasMore: boolean;
  }>;
  renderPage: (
    items: unknown[],
    page: number,
    total: number | undefined,
    hasMore: boolean
  ) => void;
};

const mocks = vi.hoisted(() => ({
  getUserCollectionPage: vi.fn(),
  secureAtomicWriteFile: vi.fn(),
  withPagination: vi.fn(async (options: PagerOptions) => {
    const page = options.startPage ?? 1;
    const result = await options.fetchPage(page);
    options.renderPage(result.items, page, result.total, result.hasMore);
  })
}));

vi.mock('../api/collection.js', () => ({
  getUserCollectionPage: mocks.getUserCollectionPage
}));
vi.mock('../storage/secure-file.js', () => ({
  secureAtomicWriteFile: mocks.secureAtomicWriteFile
}));
vi.mock('../utils/pagination.js', () => ({
  withPagination: mocks.withPagination
}));
vi.mock('../utils/spinner.js', () => ({
  withSpinner: vi.fn(async (_message: string, task: () => Promise<unknown>) => task())
}));

import { registerBookCollectionCommands } from '../commands/book-collection.ts';

const originalArgv = process.argv;

function collectionItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'book',
    id,
    title: `Book ${id}`,
    url: `https://book.douban.com/subject/${id}/`,
    rating: 4,
    date: '2026-08-10',
    comment: `Comment ${id}`,
    cover: '',
    ...overrides
  };
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  const book = program.command('book');
  registerBookCollectionCommands(book);
  return program;
}

async function run(args: string[]): Promise<void> {
  process.argv = ['node', 'douban', ...args];
  await createProgram().parseAsync(process.argv);
}

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('book collection commands', () => {
  it('uses the requested page offset and book collection status', async () => {
    mocks.getUserCollectionPage.mockResolvedValue({
      items: [collectionItem('42')],
      total: 50,
      nextStart: 30,
      partial: false,
      warnings: []
    });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['book', 'user', 'alice', '--reading', '--page', '3', '--limit', '10']);

    expect(mocks.getUserCollectionPage).toHaveBeenCalledWith({
      kind: 'book',
      userId: 'alice',
      status: 'do',
      start: 20,
      count: 10
    });
    expect(mocks.withPagination).toHaveBeenCalledOnce();
    expect(stdout.mock.calls.flat().join('\n')).toContain('ID: 42');
  });

  it('rejects conflicting book collection status flags before fetching', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await run(['book', 'user', 'alice', '--wish', '--reading', '--json']);

    expect(mocks.getUserCollectionPage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
  });

  it('follows nextStart while exporting a shareable Markdown list', async () => {
    mocks.getUserCollectionPage
      .mockResolvedValueOnce({
        items: [
          collectionItem('1', { title: '# First [Edition]' }),
          collectionItem('2', { rating: 0, comment: '' })
        ],
        total: 3,
        nextStart: 2,
        partial: false,
        warnings: []
      })
      .mockResolvedValueOnce({
        items: [collectionItem('3')],
        total: 3,
        nextStart: null,
        partial: false,
        warnings: []
      });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['book', 'export', 'alice', '--wish', '--limit', '3', '--output', '/tmp/books.md']);

    expect(mocks.getUserCollectionPage).toHaveBeenNthCalledWith(1, {
      kind: 'book',
      userId: 'alice',
      status: 'wish',
      start: 0,
      count: 3
    });
    expect(mocks.getUserCollectionPage).toHaveBeenNthCalledWith(2, {
      kind: 'book',
      userId: 'alice',
      status: 'wish',
      start: 2,
      count: 1
    });

    const [outputPath, contents] = mocks.secureAtomicWriteFile.mock.calls[0] as [string, string];
    expect(outputPath).toBe(path.resolve('/tmp/books.md'));
    expect(contents).toContain('# 豆瓣读书清单');
    expect(contents).toContain('- 状态：想读');
    expect(contents).toContain('- 数量：3');
    expect(contents).toContain('1. **\\# First \\[Edition\\]**');
    expect(contents).toContain('星级：★★★★');
    expect(contents).toContain('短评：Comment 1');
  });

  it('neutralizes spreadsheet formulas in CSV exports', async () => {
    mocks.getUserCollectionPage.mockResolvedValue({
      items: [collectionItem('1', {
        title: '=HYPERLINK("https://example.com")',
        comment: ' \t+SUM(1,2)'
      })],
      total: 1,
      nextStart: null,
      partial: false,
      warnings: []
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['book', 'export', 'alice', '--limit', '1', '--output', '/tmp/books.csv']);

    const contents = String(mocks.secureAtomicWriteFile.mock.calls[0]?.[1]);
    expect(contents).toContain('"\'=HYPERLINK(""https://example.com"")"');
    expect(contents).toContain('"\' \t+SUM(1,2)"');
  });

  it('writes collected items and reports a warning when a later export page fails', async () => {
    mocks.getUserCollectionPage
      .mockResolvedValueOnce({
        items: [collectionItem('1')],
        total: 2,
        nextStart: 1,
        partial: false,
        warnings: []
      })
      .mockRejectedValueOnce(new Error('temporary failure'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await run(['book', 'export', 'alice', '--limit', '2', '--output', '/tmp/partial.json']);

    const payload = JSON.parse(String(mocks.secureAtomicWriteFile.mock.calls[0]?.[1]));
    expect(payload.metadata).toMatchObject({ count: 1, partial: true });
    expect(payload.items).toHaveLength(1);
    expect(stderr.mock.calls.flat().join('\n')).toContain('temporary failure');
  });

  it('rejects an unknown export format without fetching or writing', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await run([
      'book',
      'export',
      'alice',
      '--output',
      '/tmp/books.txt',
      '--format',
      'yaml'
    ]);

    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join('\n')).toContain('仅支持 json、csv、markdown');
    expect(mocks.getUserCollectionPage).not.toHaveBeenCalled();
    expect(mocks.secureAtomicWriteFile).not.toHaveBeenCalled();
  });
});
