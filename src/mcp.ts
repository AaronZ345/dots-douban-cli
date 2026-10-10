import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type CliRunner = (entry: 'douban', args: string[]) => Promise<unknown>;
export const runCli: CliRunner = (entry, args) => new Promise((resolve, reject) => {
  const script = './index.js';
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let stdout = '', stderr = '', size = 0;
  const timer = setTimeout(() => { child.kill(); reject(new Error('CLI 请求超时；未自动重试')); }, 120000);
  const collect = (chunk: Buffer, target: 'stdout' | 'stderr') => {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) { child.kill(); reject(new Error('CLI 输出超出上限')); return; }
    if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
  };
  child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timer);
    try {
      if (code !== 0 && code !== 2) {
        let message = 'CLI 请求失败';
        try { message = JSON.parse(stderr).error?.message ?? message; } catch { /* Raw stderr is not forwarded. */ }
        throw new Error(message);
      }
      const value: unknown = JSON.parse(stdout);
      resolve(code === 2 ? { partial: true, result: value } : value);
    } catch (error) { reject(error); }
  });
});

const browsers = z.enum(['chromium','chrome','edge','brave','arc','firefox','webkit']);
const kind = z.enum(['movie','book']);
const identifier = z.string().regex(/^\d+$/);
const limit = z.number().int().min(1).max(100).default(10);
const transport = z.enum(['http','browser']).default('http');
const readOptions = { transport, browser: browsers.default('chromium') };
function readPrefix(input: {transport:string;browser:string}):string[] { return ['--transport',input.transport,'--read-browser',input.browser]; }
function required(value: string | undefined, label: string): string { if (!value?.trim()) throw new Error(`${label}不能为空`); return value; }
function response(value: unknown): CallToolResult {
  const structuredContent = Array.isArray(value) ? { items:value } : value && typeof value==='object' ? value as Record<string, unknown> : { value };
  return { content:[{type:'text',text:JSON.stringify(structuredContent)}], structuredContent };
}

export function createMcpServer(runner: CliRunner = runCli): McpServer {
  const server = new McpServer({name:'douban-cli',version:'0.2.1'},{capabilities:{tools:{}}});
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = (entry:'douban',args:string[]) => {
    const result=queue.then(()=>runner(entry,args));
    queue=result.catch(()=>undefined);
    return result;
  };
  const call = async (entry:'douban',args:string[]):Promise<CallToolResult> => {
    try { return response(await serialized(entry,args)); }
    catch(error) { return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'工具请求失败'}]}; }
  };
  const safe = async (build:()=>Promise<CallToolResult>):Promise<CallToolResult> => {
    try { return await build(); } catch(error) { return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'参数无效'}]}; }
  };
  server.registerTool('douban_query',{
    description:'公开书影查询。支持搜索、详情、榜单、评分、短评、长评与读书笔记；不读取浏览器登录态。',
    inputSchema:z.object({operation:z.enum(['search','info','hot','tv','rank','top250','coming','weekly','rating','comments','reviews','notes','chart','new','doulist']),kind:kind.default('movie'),query:z.string().optional(),limit,page:z.number().int().min(1).default(1),...readOptions}),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}
  },async(input)=>safe(async()=>{
    const prefix=input.kind==='book'?['book']:[];
    const positional:string[]=[];
    let command:string=input.operation;
    if(input.operation==='info'){command=input.kind==='book'?'info':'movie';positional.push(required(input.query,'条目 ID 或查询'));}
    if(['search','tv','rank','chart'].includes(input.operation))positional.push(required(input.query,'查询'));
    if(['rating','comments','reviews','notes'].includes(input.operation))positional.push(required(input.query,'条目 ID'));
    if(input.operation==='doulist'){command='list';prefix.length=0;positional.push(required(input.query,'豆列 ID 或地址'));}
    if(input.kind==='book'&&['tv','rank','coming','weekly'].includes(input.operation))throw new Error('此操作只支持电影');
    if(input.kind==='movie'&&['notes','chart','new'].includes(input.operation))throw new Error('此操作只支持图书');
    const options=['--json'];
    if(!['info','rating'].includes(input.operation)) {
      if(input.operation==='top250'&&input.kind==='movie')options.push('--page',String(input.page));
      else options.push('--limit',String(input.limit));
    }
    if(['comments','reviews','notes'].includes(input.operation))options.push('--page',String(input.page));
    return call('douban',[...readPrefix(input),...prefix,command,...options,...(positional.length?['--',...positional]:[])]);
  }));
  server.registerTool('douban_records',{
    description:'读取显式指定的公开用户记录，或省略 user 使用现有登录态。仅返回当前调用请求的数据。',
    inputSchema:z.object({kind:z.enum(['movie','book','all']).default('movie'),status:z.enum(['collect','wish','do','all']).default('collect'),user:z.string().optional(),keyword:z.string().optional(),limit,...readOptions}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}
  },async(input)=>{
    const args=[...readPrefix(input),'records','--kind',input.kind,'--status',input.status,'--limit',String(input.limit),'--json'];
    if(input.user)args.push('--user',input.user);if(input.keyword)args.push('--keyword',input.keyword);
    return call('douban',args);
  });
  server.registerTool('douban_record_get',{description:'查询当前登录账号的单条记录；不得在项目验收中读取私人记录。',inputSchema:z.object({id:identifier,kind:kind.default('movie'),...readOptions}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},async(input)=>call('douban',[...readPrefix(input),'record','get','--kind',input.kind,'--json','--',input.id]));
  server.registerTool('douban_record_edit',{
    description:'仅修改指定字段并读回核验。默认 dryRun=true；用户明确要求写入时才使用 dryRun=false。',
    inputSchema:z.object({id:identifier,kind:kind.default('movie'),comment:z.string().optional(),clearComment:z.boolean().default(false),rating:z.number().int().min(1).max(5).optional(),clearRating:z.boolean().default(false),status:z.enum(['collect','wish','do']).optional(),tags:z.array(z.string()).optional(),clearTags:z.boolean().default(false),private:z.boolean().optional(),dryRun:z.boolean().default(true),...readOptions}),annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}
  },async(input)=>{
    const args=[...readPrefix(input),'record','edit','--kind',input.kind,'--json'];
    if(input.comment!==undefined)args.push(`--comment=${input.comment}`);
    if(input.rating!==undefined)args.push('--rating',String(input.rating));
    if(input.status)args.push('--status',input.status);
    if(input.tags)args.push('--tags',input.tags.join(','));
    if(input.clearComment)args.push('--clear-comment');if(input.clearRating)args.push('--clear-rating');if(input.clearTags)args.push('--clear-tags');
    if(input.private!==undefined)args.push(input.private?'--private':'--public');if(input.dryRun)args.push('--dry-run');
    args.push('--',input.id);return call('douban',args);
  });
  server.registerTool('douban_account_action',{
    description:'兼容标记、评分、短评、取消收藏、长评和关注操作。默认仅预览；不提供登录 Cookie 导入或导出。',
    inputSchema:z.object({operation:z.enum(['mark','rate','comment','unmark','review','follow','unfollow']),id:z.string().min(1),kind:kind.default('movie'),status:z.enum(['collect','wish','do']).optional(),score:z.number().int().min(1).max(5).optional(),text:z.string().optional(),title:z.string().optional(),dryRun:z.boolean().default(true)}),annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}
  },async(input)=>safe(async()=>{
    const args=[input.operation,'--json']; if(input.dryRun)args.push('--dry-run');
    if(['mark','rate','comment','unmark'].includes(input.operation))args.push('--kind',input.kind);
    if(input.operation==='mark'){if(!input.status)throw new Error('标记必须指定 status');args.push(input.status==='wish'?'--wish':input.status==='do'?'--watching':'--watched');}
    if(input.operation==='rate'){if(input.score===undefined)throw new Error('评分必须指定 score');args.push('--score',String(input.score));}
    const positional=[input.id];
    if(input.operation==='comment')positional.push(required(input.text,'短评'));
    if(input.operation==='review'){if(input.kind!=='movie')throw new Error('长评发布只支持电影');positional.push(required(input.title,'标题'),required(input.text,'正文'));}
    args.push('--',...positional);return call('douban',args);
  }));
  server.registerTool('douban_doctor',{description:'检查运行时、浏览器和文件权限；默认不读取登录内容或进行账号校验。',inputSchema:z.object({online:z.boolean().default(false),...readOptions}),annotations:{readOnlyHint:true,destructiveHint:false}},async(input)=>call('douban',[...readPrefix(input),'doctor','--json',...(input.online?['--online']:[])]));
  return server;
}

export async function startMcp():Promise<void> { await serveStdio(()=>createMcpServer()); }
