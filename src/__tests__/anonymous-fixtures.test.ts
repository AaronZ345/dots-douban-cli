import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parseRecordForm} from '../api/record.ts';
describe('anonymous Douban form fixtures',()=>{
  it('parses current movie and book forms using synthetic content only',()=>{
    for(const kind of ['movie','book'] as const){
      const payload=JSON.parse(readFileSync(new URL(`./fixtures/record-${kind}-current.json`,import.meta.url),'utf8'));
      const record=parseRecordForm(payload,kind,'42','fixture-only-csrf').record;
      expect(record.status).toBe('collect');expect(record.private).toBe(kind==='book');expect(record.tags).toEqual(['合成标签']);
    }
  });
});
