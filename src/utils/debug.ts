const DEBUG = process.env.DOUBAN_DEBUG === '1';

export function debug(tag: string, msg: string): void {
  if (DEBUG) console.error(`[${tag}] ${msg}`);
}
