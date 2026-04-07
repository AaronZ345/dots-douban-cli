export interface PaginationPage<T> {
  items: T[];
  total?: number;
  hasMore: boolean;
}

interface PaginationOptions<T> {
  fetchPage: (page: number) => Promise<PaginationPage<T>>;
  renderPage: (items: T[], page: number, total: number | undefined, hasMore: boolean) => void;
  startPage?: number;
  prompt?: string;
}

export async function withPagination<T>({
  fetchPage,
  renderPage,
  startPage = 1,
  prompt = '按回车加载下一页，输入 q 退出: '
}: PaginationOptions<T>): Promise<void> {
  // Non-interactive mode: just show first page
  if (!process.stdin.isTTY) {
    const { items, total, hasMore } = await fetchPage(startPage);
    renderPage(items, startPage, total, hasMore);
    return;
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string) => new Promise<string>((resolve, reject) => {
    rl.question(q, resolve);
    rl.once('close', () => reject(new Error('readline closed')));
  });

  let page = startPage;

  try {
    let running = true;
    while (running) {
      const { items, total, hasMore } = await fetchPage(page);
      renderPage(items, page, total, hasMore);

      if (items.length === 0 || !hasMore) {
        break;
      }

      try {
        const answer = await question(prompt);
        if (answer.toLowerCase() === 'q') {
          running = false;
        } else {
          page++;
        }
      } catch {
        // readline closed (e.g., piped input ended)
        break;
      }
    }
  } finally {
    rl.close();
  }
}
