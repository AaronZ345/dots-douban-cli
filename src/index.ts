#!/usr/bin/env node
import { Command, Help } from 'commander';
import { createRequire } from 'node:module';
import { registerBookCommands } from './commands/book.js';

import { registerListCommands } from './commands/list.js';
import { registerMovieCommands } from './commands/movie.js';
import { registerUserCommands } from './commands/user.js';
import { registerMarkCommands } from './commands/mark.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerSocialCommands } from './commands/social.js';
import { handleProgramError } from './utils/error.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

const program = new Command();

program
  .name('douban')
  .description('豆瓣命令行工具（电影 / 书籍 / 用户）')
  .version(pkg.version || '0.0.0', '-V, --version', '显示版本')
  .helpOption('-h, --help', '显示帮助')
  .exitOverride()
  .configureOutput({
    // Commander errors are rendered by the shared CLI error handler below.
    outputError: () => undefined
  });

registerMovieCommands(program);
const bookCommand = registerBookCommands(program);
registerUserCommands(program);

registerListCommands(program);
registerAuthCommands(program);
registerMarkCommands(program);
registerSocialCommands(program);

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

program.addHelpText('beforeAll', () => `douban - 豆瓣命令行工具 v${program.version()}\n`);
program.addHelpText('after', () => `
示例:
  douban hot             查看热门电影
  douban search 沙丘     搜索电影
  douban top250          豆瓣 Top 250
  douban movie 1292052   查看电影详情
  douban book chart      查看当前热门图书榜
  douban book info 三体  查看书籍详情
`);

program.parseAsync().catch((error) => {
  handleProgramError(error);
});
