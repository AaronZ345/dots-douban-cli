import { afterEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({exists:vi.fn(()=>false),stat:vi.fn(),auth:vi.fn()}));
vi.mock('node:fs',()=>({existsSync:mocks.exists,lstatSync:mocks.stat}));
vi.mock('../auth.js',()=>({ensureAuth:mocks.auth}));
import { doctor } from '../doctor.ts';
afterEach(()=>{vi.clearAllMocks();});
describe('diagnostic privacy',()=>{
 it('does not load account contents or verify login by default',async()=>{const report=await doctor();expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.stat).not.toHaveBeenCalled();expect(report.checks.some(c=>c.name==='node')).toBe(true);});
 it('returns only a boolean result when login verification is explicitly selected',async()=>{mocks.auth.mockResolvedValue({accountId:'synthetic-user',cookies:'synthetic-secret'});const result=await doctor({verifyLogin:true});expect(JSON.stringify(result)).not.toMatch(/synthetic-user|synthetic-secret/);});
});
