import { cpSync,existsSync,lstatSync,mkdirSync,readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../skills/dots-douban-cli',import.meta.url));
const destination=path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'skills','dots-douban-cli');
if(existsSync(destination)) {
 if(lstatSync(destination).isSymbolicLink())throw new Error('技能目标不能为符号链接');
 const content=readFileSync(path.join(destination,'SKILL.md'),'utf8');
 if(!/name: dots-douban-cli/.test(content)||!/origin: local/.test(content)||!/owner: aaron/.test(content))throw new Error('已存在其他来源的技能，未覆盖');
}
mkdirSync(path.dirname(destination),{recursive:true});cpSync(source,destination,{recursive:true});
console.log('已安装 dots-douban-cli 技能');
