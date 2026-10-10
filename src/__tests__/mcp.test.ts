import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { createMcpServer,type CliRunner } from '../mcp.ts';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
async function connect(runner:CliRunner){const server=createMcpServer(runner);const client=new Client({name:'anonymous-contract-test',version:'1.0'});const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);cleanups.push(()=>client.close(),()=>server.close());return client;}
describe('MCP contracts',()=>{
 it('lists tools and reuses CLI read commands',async()=>{
  const runner=vi.fn<CliRunner>().mockResolvedValue({items:[]});const client=await connect(runner);
  const tools=await client.listTools();expect(tools.tools.some(t=>t.name==='douban_record_edit')).toBe(true);
  const result=await client.callTool({name:'douban_query',arguments:{operation:'search',query:'--malicious-option'}});
  expect(result.isError).not.toBe(true);expect(runner.mock.calls[0][1]).toContain('--');expect(runner.mock.calls[0][1].at(-1)).toBe('--malicious-option');
 });
 it('defaults edits to preview and omits raw login tools',async()=>{
  const runner=vi.fn<CliRunner>().mockResolvedValue({dryRun:true});const client=await connect(runner);
  await client.callTool({name:'douban_record_edit',arguments:{id:'42',comment:'合成预览'}});
  expect(runner.mock.calls[0][1]).toContain('--dry-run');
  const tools=await client.listTools();expect(tools.tools.some(t=>/cookie|login|backup|sync/.test(t.name))).toBe(false);
 });
 it('rejects invalid IDs and serializes concurrent requests',async()=>{
  let active=0,maxActive=0;
  const runner=vi.fn<CliRunner>(async()=>{active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setTimeout(r,15));active--;return {ok:true};});
  const client=await connect(runner);
  const invalid=await client.callTool({name:'douban_record_get',arguments:{id:'not-an-id'}}).catch(()=>({isError:true}));
  expect(invalid.isError).toBe(true);expect(runner).not.toHaveBeenCalled();
  await Promise.all([client.callTool({name:'douban_doctor',arguments:{}}),client.callTool({name:'douban_doctor',arguments:{}})]);expect(maxActive).toBe(1);
 });
});
