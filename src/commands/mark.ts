import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { ensureAuth } from '../auth.js';
import { editPersonalRecord, removePersonalRecord, type RecordPatch } from '../api/record.js';
import type { SubjectActionKind } from '../api/mutations.js';
import { withErrorHandler } from '../utils/error.js';
import { parseKind } from './records.js';
import { parseDelaySeconds, sleep } from '../utils/timing.js';

type Item = { id: string; score?: number; text?: string };
type Result = { id: string; ok: boolean; score?: number; error?: string; skipped?: boolean; verified?: boolean; dryRun?: boolean };
function id(value: string): string {
  if (!/^\d+$/.test(value.trim())) throw new Error('条目 ID 必须是纯数字');
  return value.trim();
}
function lines(file: string): string[] {
  const contents = readFileSync(file);
  if (contents.length > 1024 * 1024) throw new Error('批量文件不能超过 1 MiB');
  const selected = contents.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!selected.length) throw new Error('批量文件没有条目');
  return selected;
}
function itemsFor(command: string, file: string | undefined, input: string | undefined, text: string | undefined, score: string | undefined): Item[] {
  if (file && (input || text || score)) throw new Error('--file 不能与单条模式参数同时使用');
  const rows = file ? lines(file) : [input ?? ''];
  return rows.map((row) => {
    if (command === 'mark' || command === 'unmark') return { id: id(row.split(/[\s,]/)[0]) };
    const split = row.search(/[,\t]/);
    if (file && split < 1) throw new Error('批量文件格式必须为 <id>,<内容>');
    const selectedId = id(file ? row.slice(0, split) : row);
    const value = file ? row.slice(split + 1).trim() : command === 'rate' ? score ?? '' : text ?? '';
    if (command === 'rate') {
      if (!/^[1-5]$/.test(value)) throw new Error('评分必须是 1-5 的整数');
      return { id: selectedId, score: Number(value) };
    }
    if (!value.trim()) throw new Error('短评不能为空；清空请使用 record edit --clear-comment');
    return { id: selectedId, text: value };
  });
}
export function registerMarkCommands(program: Command, defaultKind: SubjectActionKind = 'movie'): void {
  for (const name of ['mark', 'rate', 'comment', 'unmark']) {
    const command = program.command(`${name} [id]${name === 'comment' ? ' [text]' : ''}`)
      .helpGroup('写入操作:').description(({ mark: '标记收藏状态', rate: '评分', comment: '新增或修改短评', unmark: '取消收藏' } as Record<string, string>)[name] + '，保留其他字段并读回核验 [需登录]')
      .option('--kind <kind>', 'movie 或 book', defaultKind).option('--file <path>', '批量文件，每行 ID 或 ID,内容')
      .option('--delay <seconds>', '批量请求间隔，默认 1 秒', '1').option('--dry-run', '读取并预览，不提交').option('--json', '以 JSON 输出');
    if (name === 'mark') command.option('--wish', '想看／想读').option('--watched', '看过').option('--watching', '在看').option('--read', '读过').option('--reading', '在读');
    if (name === 'rate') command.option('--score <score>', '1-5 星');
    command.action(withErrorHandler({ command: name }, async (...args: unknown[]) => {
      const input = args[0] as string | undefined;
      const text = name === 'comment' ? args[1] as string | undefined : undefined;
      const opts = args[name === 'comment' ? 2 : 1] as Record<string, string | boolean | undefined>;
      const kind = parseKind(String(opts.kind));
      let status: RecordPatch['status'];
      if (name === 'mark') {
        const flags = [opts.wish, opts.watched, opts.watching, opts.read, opts.reading];
        if (flags.filter(Boolean).length !== 1) throw new Error('必须且只能选择一个收藏状态');
        status = opts.wish ? 'wish' : opts.watched || opts.read ? 'collect' : 'do';
      }
      const items = itemsFor(name, opts.file as string | undefined, input, text, opts.score as string | undefined);
      const delayMs = parseDelaySeconds(String(opts.delay), 1) * 1000;
      const auth = await ensureAuth();
      const results: Result[] = [];
      for (let index = 0; index < items.length; index++) {
        if (index) await sleep(delayMs);
        const item = items[index];
        try {
          const patch: RecordPatch = name === 'mark' ? { status } : name === 'rate' ? { rating: item.score } : { comment: item.text };
          const result = name === 'unmark'
            ? await removePersonalRecord(kind, item.id, auth.cookies, Boolean(opts.dryRun))
            : await editPersonalRecord(kind, item.id, patch, auth.cookies, Boolean(opts.dryRun), 'collect');
          results.push({ id: item.id, ok: true, ...(item.score === undefined ? {} : { score: item.score }), verified: result.verified, dryRun: result.dryRun });
        } catch (error) {
          results.push({ id: item.id, ok: false, error: error instanceof Error ? error.message : String(error) });
          results.push(...items.slice(index + 1).map((entry) => ({ id: entry.id, ok: false, skipped: true, error: '前一项失败，未执行' })));
          process.exitCode = 1; break;
        }
      }
      if (opts.json) console.log(JSON.stringify(results, null, 2));
      else results.forEach((result) => console.log(`${result.ok ? '✓' : '✗'} ${result.id}${result.dryRun ? '（预览）' : ''}${result.error ? ` ${result.error}` : ''}`));
    }));
  }
}
