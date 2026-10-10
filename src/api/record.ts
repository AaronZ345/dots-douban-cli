import { load } from 'cheerio';
import { fetchJson, isRecord, UA, FETCH_TIMEOUT_MS, ResponseSchemaError } from './common.js';
import { decodeExplicitMutation, SUBJECT_ACTIONS, type SubjectActionKind, type SubjectInterest } from './mutations.js';

export interface PersonalRecord {
  kind: SubjectActionKind;
  id: string;
  url: string;
  status: SubjectInterest;
  rating: number | null;
  comment: string;
  tags: string[];
  private: boolean;
}

export interface RecordPatch {
  status?: Exclude<SubjectInterest, 'none'>;
  rating?: number | null;
  comment?: string;
  tags?: string[];
  private?: boolean;
}

interface RecordForm { record: PersonalRecord; fields: Record<string, string>; privateField: 'private' | 'privacy'; privateValue: string }
const STATUSES = new Set(['collect', 'wish', 'do', 'none']);

export function subjectRecordUrl(kind: SubjectActionKind, id: string): string {
  if (!/^\d+$/.test(id)) throw new Error('条目 ID 必须是纯数字');
  return `${SUBJECT_ACTIONS[kind].baseUrl}/j/subject/${id}/interest`;
}

export function parseRecordForm(payload: unknown, kind: SubjectActionKind, id: string, fallbackCk?: string): RecordForm {
  const url = subjectRecordUrl(kind, id);
  if (!isRecord(payload) || typeof payload.html !== 'string') throw new ResponseSchemaError('个人记录接口没有返回编辑表单', url);
  if ('r' in payload && payload.r !== 0) throw new Error('个人记录读取失败，请检查登录状态');
  const $ = load(payload.html);
  const form = $('form').filter((_, element) => {
    try { return new URL($(element).attr('action') ?? '', url).href === url; } catch { return false; }
  }).first();
  if (!form.length) throw new ResponseSchemaError('个人记录表单地址不匹配', url);
  const fields: Record<string, string> = {};
  form.find('input, textarea, select').each((_, element) => {
    const control = $(element);
    const name = control.attr('name');
    const type = control.attr('type');
    if (!name || control.is('[disabled]') || /^(?:share|sync)[-_]/.test(name) || ['submit', 'button', 'file', 'reset'].includes(type ?? '')) return;
    if ((type === 'checkbox' || type === 'radio') && !control.is('[checked]')) return;
    const value = control.val();
    fields[name] = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  });
  const privateControl = form.find('[name=private], [name=privacy]').first();
  const privateField = privateControl.attr('name') === 'private' ? 'private' : 'privacy';
  const privateValue = String(privateControl.val() ?? '1');
  fields.ck ||= fallbackCk ?? '';
  if (!form.find('[name=comment]').length || !form.find('[name=rating]').length || !form.find('[name=tags]').length || !privateControl.length || !fields.ck) {
    throw new ResponseSchemaError('编辑表单缺少短评、评分、标签、隐私或校验字段，无法安全保留原记录', url);
  }
  const checkedInterest = form.find('input[name=interest][checked]');
  if (checkedInterest.length > 1) throw new ResponseSchemaError('编辑表单存在多个选中的收藏状态', url);
  const rawStatus = Object.hasOwn(payload, 'interest_status') ? payload.interest_status : checkedInterest.val() ?? 'none';
  const status = rawStatus === null || rawStatus === '' ? 'none' : rawStatus;
  if (typeof status !== 'string' || !STATUSES.has(status)) throw new ResponseSchemaError('无法可靠识别原收藏状态', url);
  const rawRating = fields.rating ?? '';
  const rating = rawRating === '' || rawRating === '0' ? null : Number(rawRating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new ResponseSchemaError('原评分字段无效', url);
  let tags = (fields.tags ?? '').split(/\s+/).filter(Boolean);
  if (Array.isArray(payload.tags)) {
    if (payload.tags.some((tag) => typeof tag !== 'string')) throw new ResponseSchemaError('原记录标签格式无法识别', url);
    tags = payload.tags as string[];
  }
  return {
    record: {
      kind, id, url: `${SUBJECT_ACTIONS[kind].baseUrl}/subject/${id}/`,
      status: status as SubjectInterest, rating,
      comment: (fields.comment ?? '').replace(/\r\n/g, '\n'),
      tags,
      private: privateControl.attr('type') === 'checkbox' ? privateControl.is('[checked]') : fields[privateField] === '1'
    },
    fields, privateField, privateValue
  };
}

async function readRecordForm(kind: SubjectActionKind, id: string, cookies: string): Promise<RecordForm> {
  const url = subjectRecordUrl(kind, id);
  const payload = await fetchJson<unknown>(url, {
    Cookie: cookies, Referer: `${SUBJECT_ACTIONS[kind].baseUrl}/subject/${id}/`, 'X-Requested-With': 'XMLHttpRequest'
  });
  const cookieCk = cookies.match(/(?:^|;\s*)ck=([^;\s]+)/)?.[1];
  return parseRecordForm(payload, kind, id, cookieCk);
}

export async function getPersonalRecord(kind: SubjectActionKind, id: string, cookies: string): Promise<PersonalRecord> {
  return (await readRecordForm(kind, id, cookies)).record;
}

export function applyRecordPatch(before: PersonalRecord, patch: RecordPatch): PersonalRecord {
  if (!Object.keys(patch).length) throw new Error('至少指定一个需要修改的字段');
  if (patch.status !== undefined && !['collect', 'wish', 'do'].includes(patch.status)) throw new Error('状态必须为 collect、wish 或 do');
  if (patch.rating !== undefined && patch.rating !== null && (!Number.isInteger(patch.rating) || patch.rating < 1 || patch.rating > 5)) throw new Error('评分必须是 1-5 的整数，或清空评分');
  if (patch.tags !== undefined && patch.tags.some((tag) => !tag.trim() || /\s/.test(tag))) throw new Error('每个标签必须非空且不含空白');
  const after: PersonalRecord = { ...before, ...patch, tags: patch.tags ? [...new Set(patch.tags)] : [...before.tags] };
  if (after.status === 'none') throw new Error('此条目尚未收藏，新增短评时请显式指定 --status');
  if (patch.comment !== undefined) after.comment = patch.comment.replace(/\r\n/g, '\n');
  return after;
}

function sameRecord(a: PersonalRecord, b: PersonalRecord): boolean {
  return a.status === b.status && a.rating === b.rating && a.comment === b.comment && a.private === b.private
    && JSON.stringify([...a.tags].sort()) === JSON.stringify([...b.tags].sort());
}

export interface RecordEditResult {
  ok: true;
  dryRun: boolean;
  changed: boolean;
  verified: boolean;
  before: PersonalRecord;
  after: PersonalRecord;
}

export async function editPersonalRecord(kind: SubjectActionKind, id: string, patch: RecordPatch, cookies: string, dryRun = false, createStatus?: 'collect'): Promise<RecordEditResult> {
  const first = await readRecordForm(kind, id, cookies);
  const after = applyRecordPatch(first.record, first.record.status === 'none' && patch.status === undefined && createStatus ? { ...patch, status: createStatus } : patch);
  const changed = !sameRecord(first.record, after);
  if (dryRun || !changed) return { ok: true, dryRun, changed, verified: !dryRun, before: first.record, after };
  const current = await readRecordForm(kind, id, cookies);
  if (!sameRecord(first.record, current.record)) throw new Error('原记录在编辑期间发生变化，已停止提交；请重新读取');
  const fields: Record<string, string> = {
    ...current.fields,
    interest: after.status,
    rating: after.rating === null ? '' : String(after.rating),
    comment: after.comment,
    tags: after.tags.join(' ')
  };
  if (current.privateField === 'private') {
    if (after.private) fields.private = current.privateValue;
    else delete fields.private;
  } else fields.privacy = after.private ? '1' : '0';
  const url = subjectRecordUrl(kind, id);
  const response = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookies, 'User-Agent': UA, Referer: after.url, Origin: SUBJECT_ACTIONS[kind].baseUrl, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams(fields), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}：提交未确认成功，请先重新读取记录；不会自动重试写入`);
  let result: unknown;
  try { result = await response.json(); } catch { throw new Error('提交结果无法解析，请先重新读取记录；不会自动重试写入'); }
  if (!isRecord(result)) throw new Error('提交结果格式异常，请先重新读取记录');
  decodeExplicitMutation(result);
  const verified = await getPersonalRecord(kind, id, cookies);
  if (!sameRecord(verified, after)) throw new Error('提交后的记录与预期不一致；请重新读取核对，已停止后续写入');
  return { ok: true, dryRun: false, changed: true, verified: true, before: first.record, after: verified };
}

export async function removePersonalRecord(kind: SubjectActionKind, id: string, cookies: string, dryRun = false): Promise<RecordEditResult> {
  const first = await readRecordForm(kind, id, cookies);
  const after: PersonalRecord = { ...first.record, status: 'none', rating: null, comment: '', tags: [], private: false };
  if (dryRun || first.record.status === 'none') return { ok: true, dryRun, changed: first.record.status !== 'none', verified: !dryRun, before: first.record, after };
  const current = await readRecordForm(kind, id, cookies);
  if (!sameRecord(first.record, current.record)) throw new Error('原记录在取消收藏前发生变化，已停止提交');
  const response = await fetch(subjectRecordUrl(kind, id), {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookies, 'User-Agent': UA, Referer: first.record.url, Origin: SUBJECT_ACTIONS[kind].baseUrl, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ ck: current.fields.ck, interest: 'none' }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}：取消收藏未确认成功，请重新读取；不会自动重试`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error('取消收藏返回格式异常，请重新读取');
  decodeExplicitMutation(payload);
  const verified = await getPersonalRecord(kind, id, cookies);
  if (verified.status !== 'none') throw new Error('取消收藏后读回的状态不一致，已停止后续操作');
  return { ok: true, dryRun: false, changed: true, verified: true, before: first.record, after: verified };
}
