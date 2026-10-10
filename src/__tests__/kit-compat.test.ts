import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),edit:vi.fn(),remove:vi.fn()}));
vi.mock('../auth.js',()=>({ensureAuth:mocks.auth}));
vi.mock('../api/record.js',()=>({editPersonalRecord:mocks.edit,removePersonalRecord:mocks.remove,applyRecordPatch:vi.fn(),getPersonalRecord:vi.fn()}));
import { registerMarkCommands } from '../commands/mark.ts';
let output: ReturnType<typeof vi.spyOn>, temp='';
const argv=process.argv;
beforeEach(()=>{vi.clearAllMocks();temp=mkdtempSync(path.join(os.tmpdir(),'douban-compat-'));process.exitCode=undefined;output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);mocks.auth.mockResolvedValue({cookies:'fixture-session'});mocks.edit.mockResolvedValue({verified:true,dryRun:false});mocks.remove.mockResolvedValue({verified:true,dryRun:false});});
afterEach(()=>{rmSync(temp,{recursive:true,force:true});process.argv=argv;process.exitCode=undefined;vi.restoreAllMocks();});
async function run(args:string[],kind:'movie'|'book'='movie'){const program=new Command();program.exitOverride();registerMarkCommands(program,kind);process.argv=['node','douban-cli',...args];await program.parseAsync(process.argv);}
describe('original mark/score/comment compatibility',()=>{
 it.each([
  ['mark',['42','--wish'],{status:'wish'}],
  ['rate',['42','--score','4'],{rating:4}],
  ['comment',['42','短评'],{comment:'短评'}]
 ] as const)('routes %s through verified record editing',async(name,args,patch)=>{await run([name,...args,'--json']);expect(mocks.edit).toHaveBeenCalledWith('movie','42',patch,'fixture-session',false,'collect');expect(JSON.parse(String(output.mock.calls[0][0]))[0]).toMatchObject({ok:true,verified:true});});
 it('adds book actions and removal preview',async()=>{await run(['mark','42','--read','--json'],'book');expect(mocks.edit).toHaveBeenCalledWith('book','42',{status:'collect'},'fixture-session',false,'collect');await run(['unmark','42','--dry-run','--json'],'book');expect(mocks.remove).toHaveBeenCalledWith('book','42','fixture-session',true);});
 it('stops a batch after a failed write and labels remaining items skipped',async()=>{const file=path.join(temp,'ids.txt');writeFileSync(file,'1\n2\n3\n');mocks.edit.mockResolvedValueOnce({verified:true,dryRun:false}).mockRejectedValueOnce(new Error('unverified'));await run(['mark','--file',file,'--wish','--delay','0','--json']);const results=JSON.parse(String(output.mock.calls[0][0]));expect(mocks.edit).toHaveBeenCalledTimes(2);expect(results[2]).toMatchObject({id:'3',ok:false,skipped:true});expect(process.exitCode).toBe(1);});
 it('validates all batch rows before inspecting login state',async()=>{const file=path.join(temp,'ratings.csv');writeFileSync(file,'1,4\n2,9\n');await run(['rate','--file',file,'--json']);expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.edit).not.toHaveBeenCalled();});
});
