export interface PaginationPage<T> {
  items: T[];
  total?: number;
  hasMore: boolean;
}

interface ReadlineLike {
  question(query: string, callback: (answer: string) => void): void;
  close(): void;
  once(event: 'close', listener: () => void): this;
  removeListener(event: 'close', listener: () => void): this;
}

interface PaginationOptions<T> {
  fetchPage: (page: number) => Promise<PaginationPage<T>>;
  renderPage: (items: T[], page: number, total: number | undefined, hasMore: boolean) => void;
  startPage?: number;
  pageSize?: number;
  prompt?: string;
  interactive?: boolean;
  createReadline?: () => ReadlineLike;
  writeMessage?: (message: string) => void;
}

export async function withPagination<T>({
  fetchPage,
  renderPage,
  startPage = 1,
  pageSize,
  prompt = '回车/n 下一页，p 上一页，g <页码> 跳转，q 退出: ',
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  createReadline,
  writeMessage = console.log
}: PaginationOptions<T>): Promise<void> {
  // Non-interactive mode renders exactly one deterministic page.
  if (!interactive) {
    const { items, total, hasMore } = await fetchPage(startPage);
    renderPage(items, startPage, total, hasMore);
    return;
  }

  const rl = createReadline
    ? createReadline()
    : (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string) => new Promise<string>((resolve, reject) => {
    const onClose = () => reject(new Error('readline closed'));
    rl.once('close', onClose);
    rl.question(q, (answer) => {
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });

  let page = startPage;
  const cache = new Map<number, PaginationPage<T>>();

  const loadPage = async (targetPage: number): Promise<PaginationPage<T>> => {
    const cached = cache.get(targetPage);
    if (cached) return cached;

    const result = await fetchPage(targetPage);
    cache.set(targetPage, result);
    return result;
  };

  const render = async (): Promise<PaginationPage<T>> => {
    const result = await loadPage(page);
    renderPage(result.items, page, result.total, result.hasMore);
    return result;
  };

  const buildPrompt = (current: PaginationPage<T>): string => {
    const totalPages = current.total === undefined || pageSize === undefined
      ? undefined
      : Math.max(1, Math.ceil(current.total / pageSize));
    const pageLabel = totalPages === undefined ? `第 ${page} 页` : `第 ${page}/${totalPages} 页`;
    return `[${pageLabel}] ${prompt}`;
  };

  try {
    let current = await render();
    if (!current.hasMore && page === 1) {
      return;
    }

    let running = true;
    while (running) {
      let answer: string;
      try {
        answer = (await question(buildPrompt(current))).trim().toLowerCase();
      } catch {
        // Piped input can close while readline is waiting.
        break;
      }

      if (answer === 'q') {
        running = false;
        continue;
      }

      if (answer === '' || answer === 'n') {
        if (!current.hasMore) {
          writeMessage('已到最后一页');
          continue;
        }
        page += 1;
        current = await render();
        continue;
      }

      if (answer === 'p') {
        if (page === 1) {
          writeMessage('已经是第一页');
          continue;
        }
        page -= 1;
        current = await render();
        continue;
      }

      const jump = answer.match(/^g\s+(\d+)$/);
      if (jump) {
        const targetPage = Number.parseInt(jump[1], 10);
        if (!Number.isSafeInteger(targetPage) || targetPage < 1) {
          writeMessage('页码必须是安全范围内的正整数');
          continue;
        }

        const maxPage = current.total === undefined || pageSize === undefined
          ? undefined
          : Math.max(1, Math.ceil(current.total / pageSize));
        if (maxPage !== undefined && targetPage > maxPage) {
          writeMessage(`页码超出范围，共 ${maxPage} 页`);
          continue;
        }
        page = targetPage;
        current = await render();
        continue;
      }

      writeMessage('无效操作。请使用回车/n、p、g <页码> 或 q。');
    }
  } finally {
    rl.close();
  }
}
