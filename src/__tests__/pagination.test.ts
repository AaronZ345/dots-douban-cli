import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('utils/pagination', () => {
  it('loads one page and exits when user enters q', async () => {
    const question = vi.fn((_: string, cb: (answer: string) => void) => cb('q'));
    const close = vi.fn();

    vi.doMock('node:readline', () => ({
      createInterface: () => ({ question, close })
    }));

    const { withPagination } = await import('../utils/pagination.ts');
    const fetchPage = vi.fn().mockResolvedValue({ items: ['a'], total: 2, hasMore: true });
    const renderPage = vi.fn();

    await withPagination({ fetchPage, renderPage, prompt: 'next?' });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledWith(['a'], 1, 2, true);
    expect(question).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when page has no more items', async () => {
    const question = vi.fn((_: string, cb: (answer: string) => void) => cb(''));
    const close = vi.fn();

    vi.doMock('node:readline', () => ({
      createInterface: () => ({ question, close })
    }));

    const { withPagination } = await import('../utils/pagination.ts');
    const fetchPage = vi.fn().mockResolvedValue({ items: ['x'], total: 1, hasMore: false });
    const renderPage = vi.fn();

    await withPagination({ fetchPage, renderPage, startPage: 3 });

    expect(fetchPage).toHaveBeenCalledWith(3);
    expect(renderPage).toHaveBeenCalledWith(['x'], 3, 1, false);
    expect(question).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
