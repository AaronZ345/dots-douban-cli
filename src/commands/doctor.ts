import { Command } from 'commander';
import { doctor } from '../doctor.js';
import { withErrorHandler } from '../utils/error.js';
export function registerDoctorCommand(program: Command): void {
  program.command('doctor').helpGroup('诊断与集成:').description('检查运行时、浏览器、文件权限及可选网络检查')
    .option('--online', '检查公开豆瓣页面连接与解析')
    .option('--verify-login', '显式校验登录，仅报告结果')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({ command: 'doctor' }, async (opts) => {
      const result = await doctor({ online: Boolean(opts.online), verifyLogin: Boolean(opts.verifyLogin) });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else for (const check of result.checks) console.log(`[${check.status}] ${check.name}: ${check.message}`);
      if (!result.ok) process.exitCode = 1;
    }));
}
