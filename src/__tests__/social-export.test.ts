import { describe, expect, it } from 'vitest';
import { serializeExportCsv } from '../commands/social.ts';

describe('social export CSV', () => {
  it('escapes quotes, commas, newlines, and Unicode text', () => {
    const csv = serializeExportCsv([{
      id: '1',
      title: '书名, "特别版"',
      status: 'collect',
      date: '2026-08-10',
      rating: 5,
      comment: '第一行\n第二行 😊',
      url: 'https://movie.douban.com/subject/1/'
    }]);

    expect(csv).toContain('"书名, ""特别版"""');
    expect(csv).toContain('"第一行\n第二行 😊"');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it.each([
    '=HYPERLINK("https://example.com")',
    '+cmd',
    '-2+3',
    '@SUM(1,2)',
    ' \t=1+1',
    '\uFEFF=1+1'
  ])('neutralizes spreadsheet formula input: %s', (formula) => {
    const csv = serializeExportCsv([{
      id: '1',
      title: formula,
      status: 'collect',
      url: 'https://movie.douban.com/subject/1/'
    }]);

    expect(csv.split('\n')[1]).toContain(`"'${formula.replace(/"/g, '""')}"`);
  });

  it('does not modify ordinary text or URLs', () => {
    const csv = serializeExportCsv([{
      id: '1',
      title: '普通标题',
      status: 'wish',
      url: 'https://movie.douban.com/subject/1/'
    }]);

    expect(csv).toContain('"普通标题"');
    expect(csv).toContain('"https://movie.douban.com/subject/1/"');
    expect(csv).not.toContain("'普通标题");
  });
});
