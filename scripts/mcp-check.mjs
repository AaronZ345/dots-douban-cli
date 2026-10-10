import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url)),'mcp'],stderr:'pipe'});
const client=new Client({name:'anonymous-stdio-check',version:'1.0'});
try {
 await client.connect(transport);
 const catalog=await client.listTools();
 assert.equal(catalog.tools.length,6);
 const result=await client.callTool({name:'douban_doctor',arguments:{}});
 assert.notEqual(result.isError,true);
 const report=result.structuredContent??JSON.parse(result.content[0].text);
 assert.equal(typeof report.ok,'boolean');
 assert.equal(report.checks.some(check=>check.name==='login'),false);
 console.log(JSON.stringify({mcp:'stdio',tools:catalog.tools.length,doctor:true,accountRead:false}));
} finally {await client.close();}
