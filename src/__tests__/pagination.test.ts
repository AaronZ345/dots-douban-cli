import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('utils/pagination', () => {
  it('loads one page and exits when user enters q', async () => {
    const question = vi.fn((_: string, cb: (answer: string) => void) => cb('q'));
    const close = vi.fn();
    const once = vi.fn().mockReturnThis();
    const removeListener = vi.fn().mockReturnThis();

    const { withPagination } = await import('../utils/pagination.ts');
    const fetchPage = vi.fn().mockResolvedValue({ items: ['a'], total: 2, hasMore: true });
    const renderPage = vi.fn();

    await withPagination({
      fetchPage,
      renderPage,
      prompt: 'next?',
      interactive: true,
      createReadline: () => ({ question, close, once, removeListener })
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledWith(['a'], 1, 2, true);
    expect(question).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when page has no more items', async () => {
    const question = vi.fn((_: string, cb: (answer: string) => void) => cb(''));
    const close = vi.fn();
    const once = vi.fn().mockReturnThis();
    const removeListener = vi.fn().mockReturnThis();

    const { withPagination } = await import('../utils/pagination.ts');
    const fetchPage = vi.fn().mockResolvedValue({ items: ['x'], total: 1, hasMore: false });
    const renderPage = vi.fn();

    await withPagination({
      fetchPage,
      renderPage,
      startPage: 3,
      interactive: true,
      createReadline: () => ({ question, close, once, removeListener })
    });

    expect(fetchPage).toHaveBeenCalledWith(3);
    expect(renderPage).toHaveBeenCalledWith(['x'], 3, 1, false);
    expect(question).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('renders exactly one page in non-interactive mode', async () => {
    const { withPagination } = await import('../utils/pagination.ts');
    const fetchPage = vi.fn().mockResolvedValue({ items: ['first'], total: 10, hasMore: true });
    const renderPage = vi.fn();

    await withPagination({ fetchPage, renderPage, startPage: 2, interactive: false });

    expect(fetchPage).toHaveBeenCalledOnce();
    expect(fetchPage).toHaveBeenCalledWith(2);
    expect(renderPage).toHaveBeenCalledWith(['first'], 2, 10, true);
  });
});
