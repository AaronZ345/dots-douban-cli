#!/usr/bin/env node
import { Command, Help } from 'commander';
import { createRequire } from 'node:module';
import { registerBookCommands } from './commands/book.js';

import { registerListCommands } from './commands/list.js';
import { registerMovieCommands } from './commands/movie.js';
import { registerUserCommands } from './commands/user.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerRecordCommands } from './commands/records.js';
import { registerMarkCommands } from './commands/mark.js';
import { registerSocialCommands } from './commands/social.js';
import { handleProgramError } from './utils/error.js';
import { configureBrowserReads, closeReadBrowser } from './api/browser-transport.js';
import type { LaunchBrowserName } from './browser.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerMcpCommand } from './commands/mcp.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

const program = new Command();

program
  .name('dots-douban-cli')
  .description('豆瓣命令行工具（电影 / 书籍 / 用户）')
  .version(pkg.version || '0.0.0', '-V, --version', '显示版本')
  .helpOption('-h, --help', '显示帮助')
  .option('--transport <mode>', '查询方式：http 或 browser', 'http')
  .option('--read-browser <name>', '浏览器查询使用的浏览器', 'chromium')
  .option('--read-executable <path>', '浏览器查询使用的 Chromium 程序路径')
  .option('--headed', '浏览器查询显示窗口')
  .exitOverride()
  .configureOutput({
    // Commander errors are rendered by the shared CLI error handler below.
    outputError: () => undefined
  });

program.hook('preAction', () => {
  const opts = program.opts();
  if (!['http', 'browser'].includes(opts.transport)) throw new Error('--transport 必须为 http 或 browser');
  if (opts.transport === 'browser') {
    if (!['chromium', 'chrome', 'edge', 'brave', 'arc', 'firefox', 'webkit'].includes(opts.readBrowser)) throw new Error('浏览器查询支持 chromium、chrome、edge、brave、arc、firefox、webkit');
    configureBrowserReads({ browser: opts.readBrowser as LaunchBrowserName, executable: opts.readExecutable, headed: Boolean(opts.headed) });
  }
});

registerMovieCommands(program);
const bookCommand = registerBookCommands(program);
registerUserCommands(program);

registerListCommands(program);
registerAuthCommands(program);
registerRecordCommands(program);
registerMarkCommands(program);
registerMarkCommands(bookCommand, 'book');
registerSocialCommands(program);
registerDoctorCommand(program);
registerMcpCommand(program);

const defaultHelp = new Help();
program.configureHelp({
  visibleCommands: (command) => {
    const visibleCommands = defaultHelp.visibleCommands(command);
    const visibleBookCommands = new Set(defaultHelp.visibleCommands(bookCommand));

    return visibleCommands.flatMap((subcommand) => (
      subcommand === bookCommand
        ? bookCommand.commands.filter((bookSubcommand) => visibleBookCommands.has(bookSubcommand))
        : [subcommand]
    ));
  },
  subcommandTerm: (command) => (
    command.parent === bookCommand
      ? `book ${defaultHelp.subcommandTerm(command)}`
      : defaultHelp.subcommandTerm(command)
  )
});

program.addHelpText('beforeAll', () => `dots-douban-cli - 豆瓣命令行工具 v${program.version()}\n`);
program.addHelpText('after', () => `
示例:
  douban-cli hot             查看热门电影
  douban-cli search 沙丘     搜索电影
  douban-cli top250          豆瓣 Top 250
  douban-cli movie 1292052   查看电影详情
  douban-cli book chart      查看当前热门图书榜
  douban-cli book info 三体  查看书籍详情
`);

program.parseAsync().catch((error) => {
  handleProgramError(error);
}).finally(async () => {
  await closeReadBrowser().catch(() => undefined);
});
