import { Command } from 'commander';
import { startMcp } from '../mcp.js';
export function registerMcpCommand(program:Command):void {
  program.command('mcp').helpGroup('诊断与集成:').description('启动本地 MCP stdio 接口').action(async()=>{await startMcp();});
}
