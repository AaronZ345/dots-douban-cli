import { afterEach, describe, expect, it, vi } from 'vitest';
import { withPagination } from '../utils/pagination.ts';

afterEach(() => {
  vi.clearAllMocks();
});

function createReadline(answers: string[]) {
  const pending = [...answers];
  const question = vi.fn((_: string, callback: (answer: string) => void) => {
    callback(pending.shift() ?? 'q');
  });
  const close = vi.fn();
  const once = vi.fn().mockReturnThis();
  const removeListener = vi.fn().mockReturnThis();

  return {
    readline: { question, close, once, removeListener },
    question,
    close
  };
}

describe('utils/pagination', () => {
  it('loads one page and exits when the user enters q', async () => {
    const { readline, question, close } = createReadline(['q']);
    const fetchPage = vi.fn().mockResolvedValue({ items: ['a'], total: 2, hasMore: true });
    const renderPage = vi.fn();

    await withPagination({
      fetchPage,
      renderPage,
      prompt: 'next?',
      interactive: true,
      createReadline: () => readline
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledWith(['a'], 1, 2, true);
    expect(question).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('supports next, previous, and jump while caching visited pages', async () => {
    const { readline, close } = createReadline(['n', 'p', '', 'g 3', 'q']);
    const fetchPage = vi.fn(async (page: number) => ({
      items: [`page-${page}`],
      total: 3,
      hasMore: page < 3
    }));
    const renderPage = vi.fn();

    await withPagination({
      fetchPage,
      renderPage,
      interactive: true,
      createReadline: () => readline
    });

    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
    expect(renderPage.mock.calls.map(([, page]) => page)).toEqual([1, 2, 1, 2, 3]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the current page for boundary and invalid input', async () => {
    const { readline } = createReadline(['n', 'p', 'p', 'invalid', 'q']);
    const fetchPage = vi.fn(async (page: number) => ({
      items: [`page-${page}`],
      total: 2,
      hasMore: page < 2
    }));
    const renderPage = vi.fn();
    const writeMessage = vi.fn();

    await withPagination({
      fetchPage,
      renderPage,
      startPage: 2,
      interactive: true,
      createReadline: () => readline,
      writeMessage
    });

    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([2, 1]);
    expect(writeMessage).toHaveBeenCalledWith('已到最后一页');
    expect(writeMessage).toHaveBeenCalledWith('已经是第一页');
    expect(writeMessage).toHaveBeenCalledWith('无效操作。请使用回车/n、p、g <页码> 或 q。');
  });

  it('does not prompt when the first page is also the last page', async () => {
    const { readline, question, close } = createReadline([]);
    const fetchPage = vi.fn().mockResolvedValue({ items: ['x'], total: 1, hasMore: false });
    const renderPage = vi.fn();

    await withPagination({
      fetchPage,
      renderPage,
      interactive: true,
      createReadline: () => readline
    });

    expect(question).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('renders exactly one page in non-interactive mode', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: ['first'], total: 10, hasMore: true });
    const renderPage = vi.fn();

    await withPagination({ fetchPage, renderPage, startPage: 2, interactive: false });

    expect(fetchPage).toHaveBeenCalledOnce();
    expect(fetchPage).toHaveBeenCalledWith(2);
    expect(renderPage).toHaveBeenCalledWith(['first'], 2, 10, true);
  });
});
