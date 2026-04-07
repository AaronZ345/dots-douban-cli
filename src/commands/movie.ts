import { Command } from 'commander';
import {
  CITIES,
  GENRES,
  getComing,
  getComments,
  getHot,
  getMovieDetail,
  getNowPlaying,
  getRank,
  getRatingStats,
  getReviews,
  getTop250,
  getWeekly,
  searchMovies
} from '../api/index.js';
import { withErrorHandler } from '../utils/error.js';
import { isNumericId, parseNonNegativeInt, parsePositiveInt } from '../utils/parsing.js';
import { withSpinner } from '../utils/spinner.js';
import { withPagination } from '../utils/pagination.js';

interface TableColumn<Row> {
  header: string;
  value: (row: Row, index: number) => string;
  minWidth?: number;
}

function getDisplayWidth(text: string): number {
  let width = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (
      (code >= 0x1f300 && code <= 0x1f5ff) ||
      (code >= 0x1f600 && code <= 0x1f64f) ||
      (code >= 0x1f680 && code <= 0x1f6ff) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x1fa70 && code <= 0x1faff) ||
      (code >= 0x2600 && code <= 0x27bf)
    ) {
      width += 2;
      continue;
    }

    if (
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
      continue;
    }

    width += 1;
  }

  return width;
}

function padCell(text: string, width: number): string {
  const padding = Math.max(0, width - getDisplayWidth(text));
  return text + ' '.repeat(padding);
}

function renderTable<Row>(rows: Row[], columns: TableColumn<Row>[]): void {
  if (rows.length === 0) {
    return;
  }

  const widths = columns.map((col) => {
    let maxWidth = Math.max(getDisplayWidth(col.header), col.minWidth ?? 0);

    rows.forEach((row, index) => {
      const valueWidth = getDisplayWidth(col.value(row, index));
      if (valueWidth > maxWidth) {
        maxWidth = valueWidth;
      }
    });

    return maxWidth;
  });

  console.log(columns.map((col, i) => padCell(col.header, widths[i])).join('   '));

  rows.forEach((row, rowIndex) => {
    console.log(
      columns
        .map((col, i) => padCell(col.value(row, rowIndex), widths[i]))
        .join('   ')
    );
  });
}

function compactNumber(value: number | undefined): string {
  if (value === 0) return '0';
  if (!value || value < 0) return '-';
  if (value >= 10000) {
    const n = Math.round((value / 10000) * 10) / 10;
    return Number.isInteger(n) ? `${n.toFixed(0)}万` : `${n.toFixed(1)}万`;
  }
  return value.toLocaleString();
}

function normalizeDate(value: string | undefined): string {
  if (!value) return '-';
  const trimmed = value.trim();

  const cnMatch = trimmed.match(/(\d{1,2})月(\d{1,2})日?/);
  if (cnMatch) {
    return `${cnMatch[1].padStart(2, '0')}-${cnMatch[2].padStart(2, '0')}`;
  }

  const dashMatch = trimmed.match(/\d{4}[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (dashMatch) {
    return `${dashMatch[1].padStart(2, '0')}-${dashMatch[2].padStart(2, '0')}`;
  }

  return trimmed;
}

function normalizeYear(value: string | undefined): string {
  if (!value) return '-';
  const match = value.match(/(19|20)\d{2}/);
  return match ? match[0] : '-';
}

function formatTags(values: string[] | undefined): string {
  if (!values || values.length === 0) return '-';
  return values.join('/');
}

function formatRegion(values: string[] | undefined): string {
  if (!values || values.length === 0) return '-';
  return values.join('/');
}

function formatDetailList(values: string[] | undefined): string {
  if (!values || values.length === 0) return '-';
  return values.join(' / ');
}

function normalizeMovieIdInput(value: string, fieldName = '电影 ID'): string {
  const id = value.trim();
  if (!isNumericId(id)) {
    throw new Error(`${fieldName} 必须是纯数字: ${value}`);
  }
  return id;
}

export function registerMovieCommands(program: Command): void {
  program
    .command('hot')
    .description('获取热门电影或剧集')
    .option('--tv', '显示剧集而非电影')
    .option('-t, --tag <tag>', '按标签筛选（热门/美剧/日剧/韩剧/国产剧/综艺/最新）', '热门')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'hot',
      options: '标签：热门、美剧、日剧、韩剧、国产剧、综艺、最新',
      suggestion: '可尝试：douban hot -t 热门'
    }, async (opts) => {
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const type = opts.tv ? 'tv' : 'movie';
      const items = await withSpinner(
        `正在获取热门${opts.tv ? '剧集' : '电影'}...`,
        () => getHot(type, opts.tag, limit),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(`\n🔥 热门${opts.tv ? '剧集' : '电影'} (${opts.tag})\n`);
        renderTable(items, [
          { header: '#', value: (_, i) => String(i + 1), minWidth: 2 },
          { header: '片名', value: (item) => item.title, minWidth: 18 },
          { header: '评分', value: (item) => (item.rate && item.rate !== '0' ? item.rate : '-') }
        ]);
      }
    }));

  program
    .command('tv [tag]')
    .description('按标签获取剧集列表（美剧/日剧/韩剧/国产剧/综艺）')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'tv',
      target: `标签: ${String(args[0] || '未指定')}`,
      options: '标签：美剧、日剧、韩剧、国产剧、综艺',
      suggestion: '可尝试：douban tv 美剧'
    }), async (tag, opts) => {
      if (!tag) {
        console.log('\n📺 剧集 - 请指定标签\n');
        console.log('用法: douban tv <标签>\n');
        console.log('可选标签: 美剧  日剧  韩剧  国产剧  综艺  热门  最新\n');
        console.log('示例: douban tv 美剧');
        return;
      }
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const items = await withSpinner(
        `正在获取${tag}剧集...`,
        () => getHot('tv', tag, limit),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(`\n📺 ${tag}\n`);
        renderTable(items, [
          { header: '#', value: (_, i) => String(i + 1), minWidth: 2 },
          { header: '片名', value: (item) => item.title, minWidth: 18 },
          { header: '评分', value: (item) => (item.rate && item.rate !== '0' ? item.rate : '-') }
        ]);
      }
    }));

  program
    .command('rank [genre]')
    .description('按类型查看高分电影排行（科幻/动作/爱情/动画/悬疑...）')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'rank',
      target: `类型: ${String(args[0] || '未指定')}`,
      options: `可用类型：${Object.keys(GENRES).join('、')}`,
      suggestion: '可尝试：douban rank 科幻'
    }), async (genre, opts) => {
      if (!genre) {
        console.log('\n🏆 电影排行 - 请指定类型\n');
        console.log('用法: douban rank <类型>\n');
        console.log('可选类型:');
        const genres = Object.keys(GENRES);
        const rows = [];
        for (let i = 0; i < genres.length; i += 6) {
          rows.push(genres.slice(i, i + 6).join('  '));
        }
        rows.forEach(row => console.log(`  ${row}`));
        console.log('\n示例: douban rank 科幻');
        return;
      }
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const typeId = GENRES[genre];
      if (!typeId) {
        console.log(`\n❌ 未知类型: ${genre}\n`);
        console.log('可选类型:');
        const genres = Object.keys(GENRES);
        const rows = [];
        for (let i = 0; i < genres.length; i += 6) {
          rows.push(genres.slice(i, i + 6).join('  '));
        }
        rows.forEach(row => console.log(`  ${row}`));
        return;
      }

      const items = await withSpinner(
        `正在获取${genre}排行...`,
        () => getRank(typeId, limit),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(`\n🏆 ${genre}片排行\n`);
        renderTable(items, [
          { header: '#', value: (_, i) => String(i + 1), minWidth: 2 },
          { header: '片名', value: (item) => item.title, minWidth: 18 },
          { header: '年份', value: (item) => normalizeYear(item.release_date) },
          { header: '类型', value: (item) => formatTags(item.types), minWidth: 14 },
          { header: '评分', value: (item) => item.score || '-' },
          { header: '评价', value: (item) => compactNumber(item.vote_count) }
        ]);
      }
    }));

  program
    .command('top250')
    .description('获取豆瓣 Top 250 电影')
    .option('-p, --page <n>', '页码（从 1 开始）', '1')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'top250',
      suggestion: '可尝试：douban top250 --page 2'
    }, async (opts) => {
      const page = parsePositiveInt(opts.page, '--page', 1);
      const total = 250;
      const limit = 25;

      if (opts.json) {
        const start = (page - 1) * limit;
        const items = await withSpinner(
          '正在获取豆瓣 Top 250...',
          () => getTop250(start, limit),
          false
        );
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      await withPagination({
        startPage: page,
        prompt: '\n按回车加载下一页，输入 q 退出: ',
        fetchPage: async (currentPage) => {
          const start = (currentPage - 1) * limit;
          const items = await withSpinner(
            '正在获取豆瓣 Top 250...',
            () => getTop250(start, limit),
            true
          );
          return {
            items,
            total,
            hasMore: start + items.length < total
          };
        },
        renderPage: (items, currentPage) => {
          const start = (currentPage - 1) * limit;
          const from = items.length > 0 ? start + 1 : 0;
          const to = start + items.length;

          console.log(`
🎬 豆瓣 Top 250，当前显示第 ${from}-${to} 条
`);
          renderTable(items, [
            { header: '#', value: (item) => String(item.rank), minWidth: 3 },
            { header: '片名', value: (item) => item.title, minWidth: 14 },
            { header: '年份', value: (item) => item.year || '-', minWidth: 4 },
            { header: '评分', value: (item) => item.rating || '-', minWidth: 4 },
            { header: '导演', value: (item) => item.director || '-', minWidth: 10 },
            { header: '金句', value: (item) => item.quote || '-', minWidth: 16 }
          ]);

          if (to >= total) {
            console.log('\n已到最后一页');
          }
        }
      });
    }));

  program
    .command('now')
    .description('获取正在热映电影')
    .option('-c, --city <city>', '城市名称（北京/上海/苏州/...）', '北京')
    .option('-n, --limit <n>', '返回数量')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'now',
      target: `城市: ${String((args[0] as { city?: string }).city ?? '')}`,
      suggestion: '可尝试：douban now -c 上海'
    }), async (opts) => {
      const cityInput = String(opts.city || '').trim();
      const cityCode = CITIES[cityInput] || cityInput;
      if (!cityCode) {
        throw new Error('城市不能为空');
      }
      let items = await withSpinner(
        `正在获取${cityInput}热映电影...`,
        () => getNowPlaying(cityCode),
        !opts.json
      );

      if (opts.limit) {
        const limit = parsePositiveInt(opts.limit, '--limit', items.length);
        items = items.slice(0, limit);
      }

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(`\n🎬 ${cityInput}正在热映\n`);
        renderTable(items, [
          { header: '#', value: (_, i) => String(i + 1), minWidth: 2 },
          { header: '片名', value: (item) => item.title, minWidth: 14 },
          { header: '评分', value: (item) => {
            const score = item.score && item.score !== '0' && item.score !== '-' ? item.score : '-';
            const count = item.vote_count > 0 ? (item.vote_count > 10000 ? `${(item.vote_count / 10000).toFixed(1)}万` : String(item.vote_count)) : '';
            return count ? `${score} (${count})` : score;
          }, minWidth: 10 },
          { header: '导演', value: (item) => item.director || '-', minWidth: 8 },
          { header: '时长', value: (item) => item.duration || '-', minWidth: 6 },
          { header: '地区', value: (item) => item.region || '-', minWidth: 6 }
        ]);
      }
    }));

  program
    .command('search [keyword]')
    .description('按关键词搜索电影')
    .option('-s, --start <n>', '起始偏移', '0')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'search',
      target: `关键词: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban search 沙丘'
    }), async (keyword, opts) => {
      if (!keyword) {
        console.log('\n🔍 搜索电影 - 请指定关键词\n');
        console.log('用法: douban search <关键词>\n');
        console.log('示例: douban search 沙丘');
        return;
      }
      const start = parseNonNegativeInt(opts.start, '--start', 0);
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const items = await withSpinner(
        `正在搜索“${keyword}”...`,
        () => searchMovies(keyword, start, limit),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(`\n🔍 搜索: ${keyword}\n`);
        if (items.length === 0) {
          console.log('未找到相关结果。');
          return;
        }

        renderTable(items, [
          { header: '#', value: (_, i) => String(i + 1), minWidth: 2 },
          { header: '片名', value: (item) => item.title, minWidth: 18 },
          { header: '年份', value: (item) => normalizeYear(item.year) },
          { header: '评分', value: (item) => (item.rating && item.rating !== '-' ? item.rating : '-') },
          { header: 'ID', value: (item) => item.id || '-' }
        ]);
      }
    }));

  program
    .command('movie [id]')
    .description('按电影 ID 或片名获取详情')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'movie',
      target: `ID: ${String(args[0] || '未指定')}`,
      suggestion: '确认 ID 是否正确，可使用 douban search 搜索'
    }), async (id, opts) => {
      if (!id) {
        console.log('\n🎬 电影详情 - 请指定 ID\n');
        console.log('用法: douban movie <ID>\n');
        console.log('获取 ID: douban search <关键词>\n');
        console.log('示例: douban movie 1292052');
        return;
      }

      let movieId = id.trim();
      if (!isNumericId(movieId)) {
        const result = await searchMovies(movieId, 0, 1);
        const matched = result[0];
        if (!matched?.id) {
          throw new Error(`未找到电影：${movieId}`);
        }
        movieId = normalizeMovieIdInput(matched.id, '匹配到的电影 ID');
        if (!opts.json) {
          console.log(`\n🔎 已匹配为: ${matched.title} (${movieId})`);
        }
      }

      const detail = await withSpinner(
        '正在获取电影详情...',
        () => getMovieDetail(movieId),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(detail, null, 2));
      } else {
        const titleSuffix = detail.year ? ` (${detail.year})` : '';
        const originalTitle = detail.original_title ? ` / ${detail.original_title}` : '';
        console.log(`\n🎬 ${detail.title}${titleSuffix}${originalTitle}`);
        console.log(`ID: ${detail.id}`);
        console.log(`评分: ${detail.rating || '-'}`);
        console.log(`类型: ${formatDetailList(detail.genres)}`);
        console.log(`国家: ${formatDetailList(detail.countries)}`);
        console.log(`时长: ${formatDetailList(detail.durations)}`);
        if (detail.episodes_info) {
          console.log(`集数: ${detail.episodes_info}`);
        } else if (detail.episodes_count) {
          console.log(`集数: ${detail.episodes_count}`);
        }
        console.log(`语言: ${formatDetailList(detail.languages)}`);
        console.log(`短评: ${detail.comment_count.toLocaleString()}`);
        console.log(`影评: ${detail.review_count.toLocaleString()}`);
        console.log(`别名: ${formatDetailList(detail.aka)}`);
        console.log(`导演: ${detail.directors.length > 0 ? detail.directors.join(' / ') : '-'}`);
        console.log(`演员: ${detail.actors.length > 0 ? detail.actors.join(' / ') : '-'}`);
        console.log(`\n简介:\n${detail.summary || '-'}`);
        console.log(`\n链接: ${detail.url}`);
      }
    }));

  program
    .command('rating [id]')
    .description('获取电影评分分布')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'rating',
      target: `ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban rating 1292052'
    }), async (id, opts) => {
      if (!id) {
        console.log('\n⭐ 评分分布 - 请指定电影 ID\n');
        console.log('用法: douban rating <ID>\n');
        console.log('示例: douban rating 1292052');
        return;
      }
      const movieId = normalizeMovieIdInput(id);
      const stats = await withSpinner(
        '正在获取评分分布...',
        () => getRatingStats(movieId),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(`\n⭐ 评分分布 (${stats.value}分，${stats.count.toLocaleString()}人评价)\n`);

        const labels = ['5星', '4星', '3星', '2星', '1星'];
        const maxPercent = Math.max(...stats.stars);

        stats.stars.slice().reverse().forEach((percent, i) => {
          const barLen = maxPercent > 0 ? Math.round((percent / maxPercent) * 30) : 0;
          const bar = '█'.repeat(barLen);
          console.log(`${labels[i]} ${bar} ${percent}%`);
        });

        console.log('\n📊 统计');
        console.log(`想看: ${stats.wish_count.toLocaleString()}`);
        console.log(`看过: ${stats.done_count.toLocaleString()}`);

        if (stats.type_ranks.length > 0) {
          console.log('\n🏆 类型排名');
          stats.type_ranks.forEach((r) => {
            console.log(`${r.type}: 超过 ${Math.round(r.rank * 100)}% 同类作品`);
          });
        }
      }
    }));

  program
    .command('coming')
    .description('获取即将上映电影')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'coming',
      suggestion: '可尝试：douban coming -n 30'
    }, async (opts) => {
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const items = await withSpinner(
        '正在获取即将上映电影...',
        () => getComing(limit),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log('\n📅 即将上映\n');
        renderTable(items, [
          { header: '#', value: (_, i) => String(i + 1), minWidth: 2 },
          { header: '片名', value: (item) => item.title, minWidth: 18 },
          { header: '日期', value: (item) => normalizeDate(item.release_date) },
          { header: '类型', value: (item) => formatTags(item.types), minWidth: 16 },
          { header: '地区', value: (item) => formatRegion(item.regions), minWidth: 10 },
          { header: '想看', value: (item) => compactNumber(item.wish_count) }
        ]);
      }
    }));

  program
    .command('weekly')
    .description('获取一周口碑榜')
    .option('-n, --limit <n>', '返回数量', '10')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'weekly',
      suggestion: '可尝试：douban weekly'
    }, async (opts) => {
      const limit = parsePositiveInt(opts.limit, '--limit', 10);
      const items = await withSpinner(
        '正在获取一周口碑榜...',
        () => getWeekly(limit),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log('\n📈 一周口碑榜\n');
        items.forEach((item) => {
          let trendDisplay = '—';
          if (item.trend.startsWith('up')) {
            const num = item.trend.replace('up ', '').trim();
            trendDisplay = `🔺${num}`;
          } else if (item.trend.startsWith('down')) {
            const num = item.trend.replace('down ', '').trim();
            trendDisplay = `🔻${num}`;
          }
          console.log(`${item.rank.toString().padStart(2)}. ${item.title} ${trendDisplay}`);
        });
      }
    }));

  program
    .command('reviews [movieId]')
    .description('按电影 ID 获取热门影评')
    .option('-p, --page <n>', '页码（从 1 开始）', '1')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'reviews',
      target: `ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban reviews 1292052 --page 2'
    }), async (movieId, opts) => {
      if (!movieId) {
        console.log('\n📝 热门影评 - 请指定电影 ID\n');
        console.log('用法: douban reviews <ID>\n');
        console.log('示例: douban reviews 1292052');
        return;
      }
      const id = normalizeMovieIdInput(movieId);
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const page = parsePositiveInt(opts.page, '--page', 1);

      if (opts.json) {
        // JSON 模式：单次输出
        const start = (page - 1) * limit;
        const { items, total } = await withSpinner(
          '正在获取热门影评...',
          () => getReviews(id, start, limit),
          false
        );
        console.log(JSON.stringify({ items, total }, null, 2));
        return;
      }

      await withPagination({
        startPage: page,
        fetchPage: async (currentPage) => {
          const start = (currentPage - 1) * limit;
          const { items, total } = await withSpinner(
            '正在获取热门影评...',
            () => getReviews(id, start, limit),
            true
          );
          return {
            items,
            total,
            hasMore: start + items.length < total
          };
        },
        renderPage: (items, currentPage, total) => {
          const start = (currentPage - 1) * limit;
          const from = items.length > 0 ? start + 1 : 0;
          const to = start + items.length;

          console.log(`
📝 热门影评 (${id})
`);
          console.log(`共 ${(total ?? 0).toLocaleString()} 条影评，当前显示第 ${from}-${to} 条
`);

          if (items.length === 0) {
            console.log('暂无更多影评');
            return;
          }

          items.forEach((item, i) => {
            console.log(`${(start + i + 1).toString().padStart(2)}. ${item.user} ⭐${item.rating} 👍${item.votes} ${item.time}`);
            console.log(`    ${item.content}
`);
          });

          if (to >= (total ?? 0)) {
            console.log('已到最后一页');
          }
        }
      });
    }));

  program
    .command('comments [movieId]')
    .description('按电影 ID 获取短评')
    .option('--latest', '按最新排序（默认按热门）')
    .option('-p, --page <n>', '页码（从 1 开始）', '1')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'comments',
      target: `ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban comments 1292052 --page 2'
    }), async (movieId, opts) => {
      if (!movieId) {
        console.log('\n💬 短评 - 请指定电影 ID\n');
        console.log('用法: douban comments <ID>\n');
        console.log('示例: douban comments 1292052');
        return;
      }
      const id = normalizeMovieIdInput(movieId);
      const orderBy = opts.latest ? 'latest' : 'hot';
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const page = parsePositiveInt(opts.page, '--page', 1);

      if (opts.json) {
        // JSON 模式：单次输出
        const start = (page - 1) * limit;
        const { items, total } = await withSpinner(
          `正在获取${opts.latest ? '最新' : '热门'}短评...`,
          () => getComments(id, orderBy, start, limit),
          false
        );
        console.log(JSON.stringify({ items, total }, null, 2));
        return;
      }

      await withPagination({
        startPage: page,
        fetchPage: async (currentPage) => {
          const start = (currentPage - 1) * limit;
          const { items, total } = await withSpinner(
            `正在获取${opts.latest ? '最新' : '热门'}短评...`,
            () => getComments(id, orderBy, start, limit),
            true
          );
          return {
            items,
            total,
            hasMore: start + items.length < total
          };
        },
        renderPage: (items, currentPage, total) => {
          const start = (currentPage - 1) * limit;
          const from = items.length > 0 ? start + 1 : 0;
          const to = start + items.length;

          console.log(`
💬 ${opts.latest ? '最新' : '热门'}短评 (${id})
`);
          console.log(`共 ${(total ?? 0).toLocaleString()} 条短评，当前显示第 ${from}-${to} 条
`);

          if (items.length === 0) {
            console.log('暂无更多短评');
            return;
          }

          items.forEach((item, i) => {
            const stars = item.rating ? '⭐'.repeat(item.rating) : '';
            console.log(`${(start + i + 1).toString().padStart(2)}. ${item.user} ${stars} 👍${item.votes}`);
            console.log(`    ${item.content}`);
            console.log(`    ${item.time}
`);
          });

          if (to >= (total ?? 0)) {
            console.log('已到最后一页');
          }
        }
      });
    }));
}
