# douban-cli

[![npm version](https://img.shields.io/npm/v/%40marvae24%2Fdouban-cli.svg)](https://www.npmjs.com/package/@marvae24/douban-cli)
[![npm downloads](https://img.shields.io/npm/dm/%40marvae24%2Fdouban-cli.svg)](https://www.npmjs.com/package/@marvae24/douban-cli)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Unofficial Douban CLI for movies, TV shows, books, collections, and authenticated movie actions.

在终端里浏览豆瓣电影、剧集、图书和用户收藏，也可以登录后管理自己的电影记录。

`douban-cli` 不只是一个搜索命令：它覆盖影视发现、Top250、热映与口碑榜、电影和图书详情、评分分布、短评/长评/读书笔记、公开片单与书单、交互翻页、JSON 输出、批量标记和数据导出。

> 公开电影、图书、豆列和用户收藏查询无需登录。只有账号身份、关注动态、电影标记/评分/评论、个人统计与私有导出需要显式运行 `douban login`。
>
> 当前登录后的写操作仅支持电影；图书功能为公开查询、阅读内容和公开书单导出。

**导航：** [快速开始](#-快速开始) · [电影与剧集](#-电影与剧集) · [图书](#-图书) · [用户收藏](#-用户收藏豆列与配置) · [账号操作](#-登录个人数据与账号操作) · [批量操作](#-批量操作) · [JSON](#-json-输出与脚本化)

## ✨ 功能亮点

- 🎬 **电影与剧集发现**：热门、剧集标签、类型排行、电影 Top250、正在热映、即将上映、一周口碑榜。
- 🔎 **条目深度查询**：电影支持 ID 或片名；图书支持豆瓣 ID、ISBN 或关键词自动解析。
- 📚 **完整图书链路**：图书 Top250、当前热门榜、新书速递、标签浏览、评分、短评、书评、读书笔记。
- 🗂️ **用户收藏与导出**：查看公开的想看/在看/看过、想读/在读/读过，并导出书单或个人观影记录。
- 🔐 **登录后账号操作**：标记、评分、短评、长评、关注、动态、观影统计；支持批量文件。
- 🤖 **适合脚本化**：42 个操作命令中有 40 个支持 `--json`；错误也提供稳定的结构化输出。
- ⌨️ **终端友好**：表格输出、加载状态、交互翻页、已访问页面缓存，以及 partial result warning。

## 🚀 快速开始

```bash
# 发现一部电影
douban hot
douban rank 科幻 --limit 10
douban movie "沙丘"

# 找一本书并继续查看内容
douban book search "三体"
douban book info 9787536692930
douban book comments 三体 --latest

# 查看或导出公开收藏
douban user USER_ID --wish
douban book user USER_ID --reading
douban book export USER_ID --wish -o books.md

# 给脚本消费
douban search "奥本海默" --json
```

## 📦 安装

需要 Node.js 22 或更高版本。

```bash
npm install -g @marvae24/douban-cli
```

安装后使用 `douban`：

```bash
douban hot
douban --help
douban book --help
```

也可以不安装，直接通过 `npx` 运行：

```bash
npx @marvae24/douban-cli hot
```

## 🎬 电影与剧集

这一组命令都是公开只读请求，无需登录，并且全部支持 `--json`。

| 命令 | 能做什么 | 常用参数 |
|---|---|---|
| `douban hot` | 热门电影；加 `--tv` 查看剧集 | `--tv`、`--tag`、`--limit` |
| `douban tv <tag>` | 按标签查看剧集 | `热门/美剧/英剧/日剧/韩剧/国产剧/综艺/最新` |
| `douban rank <genre>` | 按类型查看高分电影 | `--limit` |
| `douban top250` | 豆瓣电影 Top250，每页 25 条 | `--page`，支持交互翻页 |
| `douban now` | 指定城市正在热映 | `--city`、`--limit` |
| `douban coming` | 即将上映 | `--limit` |
| `douban weekly` | 一周口碑榜与排名趋势 | `--limit` |
| `douban search <keyword>` | 搜索电影 | `--start`、`--limit` |
| `douban movie <id-or-title>` | 电影/剧集详情，可直接传 ID 或片名 | `--json` |
| `douban rating <id>` | 评分分布、想看/看过统计和类型排名 | 只接受数字 ID |
| `douban comments <id>` | 热门或最新短评 | `--latest`、`--page`、`--limit` |
| `douban reviews <id>` | 热门影评 | `--page`、`--limit` |

类型排行支持：剧情、喜剧、动作、爱情、科幻、动画、悬疑、惊悚、恐怖、纪录片、短片、情色、同性、音乐、歌舞、家庭、儿童、传记、历史、战争、犯罪、西部、奇幻、冒险、灾难、武侠、古装、运动、黑色电影。

```bash
douban hot --tv --tag 英剧 --limit 10
douban top250 --page 2
douban now --city 上海
douban search "奥本海默" --start 20 --limit 20
douban movie 35593344
douban movie "沙丘"
douban rating 1291546
douban comments 1291546 --latest
douban reviews 1291546 --limit 5
```

电影详情会尽量展示中文名/原名、年份、评分、评分人数、导演、编剧、主演、类型、制片国家/地区、语言、片长、上映日期、别名、IMDb、集数、简介和评分分布。上游部分来源不可用时，CLI 会合并仍然可用的数据。

## 📚 图书

图书命令都是公开只读请求，无需登录。详情、评分、短评、书评和笔记命令均可接受豆瓣条目 ID、ISBN 或关键词。

| 命令 | 能做什么 | 常用参数 |
|---|---|---|
| `douban book hot` | 旧版兼容入口，等同图书 Top250 | `--start`、`--limit` |
| `douban book top250` | 豆瓣图书 Top250 | `--start`、`--limit` |
| `douban book chart [category]` | 当前热门图书榜，最多 20 条 | `--limit` |
| `douban book new [category]` | 新书速递，最多 20 条 | `--limit`；别名 `latest` |
| `douban book tag <tag>` | 按标签浏览图书 | `--sort 综合/出版/评价`、`--start`、`--limit` |
| `douban book search <keyword>` | 按书名、作者或 ISBN 搜索 | `--start`、`--limit` |
| `douban book info <query>` | 图书完整详情 | ID、ISBN 或关键词 |
| `douban book rating <query>` | 五星分布与想读/在读/读过统计 | ID、ISBN 或关键词 |
| `douban book comments <query>` | 热门或最新短评 | `--latest`、`--page`、`--limit` |
| `douban book reviews <query>` | 热门书评 | `--page`、`--limit` |
| `douban book notes <query>` | 热门读书笔记 | `--page`、`--limit` |
| `douban book user <userId>` | 公开的想读/在读/读过书单 | `--wish`、`--reading`、`--page`、`--limit` |
| `douban book export <userId>` | 将公开书单导出到文件 | `--wish`、`--reading`、`--limit`、`--output`、`--format` |

`book chart` 和 `book new` 支持：全部、文学、小说、历史文化、社会纪实、科学新知、艺术设计、商业经管、绘本漫画。

```bash
# 榜单与发现
douban book chart 小说 --limit 10
douban book top250 --start 25 --limit 20
douban book latest 科学新知
douban book tag 科幻 --sort 评价 --limit 30

# 搜索、详情与内容
douban book search "三体" --limit 20
douban book info 三体
douban book info 9787536692930
douban book rating 三体
douban book comments 三体 --latest
douban book reviews 三体 --limit 5
douban book notes 三体 --limit 5

# 公开书单
douban book user USER_ID --wish --page 2
douban book user USER_ID --reading
douban book export USER_ID --wish --limit 100 -o books.md
douban book export USER_ID --reading -f csv -o reading.csv
```

图书详情覆盖作者、译者、出版社、出品方、出版年、页数、装帧、定价、ISBN、丛书、标签、电子书、短评/书评/笔记数量、内容简介、作者简介和目录等字段。字段来自多个公开来源，某个来源失败时仍会保留其他来源的结果。

## 🗂️ 用户收藏、豆列与配置

| 命令 | 能做什么 | 登录要求 |
|---|---|---|
| `douban user <userId>` | 指定用户的电影看过/想看/在看 | 无需登录；默认看过，使用 `--wish` 或 `--doing` 切换 |
| `douban book user <userId>` | 指定用户的图书读过/想读/在读 | 无需登录；默认读过，使用 `--wish` 或 `--reading` 切换 |
| `douban config` | 查看本地配置；`--user <id>` 设置 `me` 的默认用户 | 无需登录 |
| `douban me` | 默认用户或当前登录账号的电影收藏 | 配置过用户 ID 时无需登录，否则使用缓存登录态 |
| `douban list` | 热门豆列推荐 | 无需登录 |

```bash
douban user USER_ID
douban user USER_ID --wish --page 2
douban user USER_ID --doing

douban config --user USER_ID
douban config
douban me --wish
douban list --limit 10
```

## 🔐 登录、个人数据与账号操作

首次使用账号功能时运行：

```bash
douban login
douban whoami
```

`login` 会打开豆瓣登录页；完成登录并回到终端确认后，CLI 才从本机浏览器读取豆瓣所需的 `dbcl2` / `ck` Cookie。默认检查 Chrome、Edge、Firefox 和 Safari；多浏览器或多账号环境建议明确选择来源：

```bash
douban login --browser chrome --profile "Profile 2"
```

`--profile` 必须与 `--browser` 一起使用，Safari 不支持指定 profile。登录缓存会加密保存在本地，账号写操作前会重新核对身份。

### 电影标记、评分与评论

以下操作会修改当前豆瓣账号，而且目前只支持电影：

```bash
douban mark 1292052 --wish
douban mark 1292052 --watched
douban mark 1292052 --watching
douban unmark 1292052

douban rate 1292052 --score 5
douban comment 1292052 "值得二刷"
douban review 1292052 "标题" "长评正文"
douban review 1292052 "标题" --file review.md
```

`rate` 和 `comment` 会按“看过”状态提交。`mark` 的 `--wish`、`--watched`、`--watching` 三种状态必须且只能选择一个。

### 动态、统计、导出与关注

```bash
douban feed --limit 10
douban stats --year 2026
douban export --format json -o douban-export.json
douban export --format csv -o douban-export.csv

douban follow USER_ID
douban unfollow USER_ID
douban logout
```

`stats` 基于最近最多 1000 条“看过”记录统计总数、月份分布和平均分，因此较早年份可能不完整。账号 `export --limit` 分别应用于看过、想看和在看三种状态，总条数最多可能接近 `3 × limit`。

## 📦 两种导出

| 命令 | 数据 | 登录 | 格式 | 说明 |
|---|---|---|---|---|
| `douban book export <userId>` | 指定用户的公开想读/在读/读过 | 不需要 | Markdown、CSV、JSON | 必须指定 `--output`；未传 `--format` 时按扩展名推断；最多 5000 条 |
| `douban export` | 当前账号的电影看过/想看/在看 | 需要 | CSV、JSON | 必须指定 `--output`；可能包含评分、短评和用户信息 |

图书导出在后续页面请求失败时会保留已经取得的数据，并在导出元数据和 stderr 中标记 `partial` / warning。

## 🧰 批量操作

电影标记、取消标记、评分和短评支持 `--file`。默认在每次写入之间随机等待 1–2 秒，也可以通过 `--delay` 指定固定间隔。

```bash
douban mark --file ids.txt --wish
douban unmark --file ids.txt --delay 1.5
douban rate --file ratings.csv
douban comment --file comments.tsv --delay 1.5
```

文件格式：

- `mark` / `unmark`：每行一个电影 ID。
- `rate`：每行 `<id>,<score>`，`score` 为 1–5。
- `comment`：每行 `<id>,<comment>`，逗号或制表符分隔。
- 空行和以 `#` 开头的注释会被忽略。

批量任务会逐项继续执行；如果部分条目失败，结果会同时给出成功和失败明细，并以非零退出码结束。

## 🤖 JSON 输出与脚本化

除两个文件导出命令外，所有操作命令都支持 `--json`：

```bash
douban weekly --json
douban book info 三体 --json
douban user USER_ID --wish --json
douban whoami --json
```

- `--json` 将命令结果写到 stdout；失败时向 stderr 写结构化 JSON，并返回非零退出码。
- `export --format json` 与 `book export --format json` 是文件格式选项，不会把 JSON 打到 stdout。
- 需要稳定脚本行为时，以具体命令的 `--help` 和 JSON 字段为准，不要解析人类可读表格。

## ⌨️ 交互翻页

以下命令在交互终端中支持翻页：

- 电影：`top250`、`comments`、`reviews`、`user`。
- 图书：`book comments`、`book reviews`、`book notes`、`book user`。

按回车或 `n` 下一页，`p` 上一页，`g <页码>` 跳转，`q` 退出。已经访问过的页面会在本次会话中复用。

使用 `--json`、管道或重定向时不会进入交互模式，只返回 `--page` 指定的页面。`search`、`book search`、`book top250` 和 `book tag` 使用 `--start` 偏移量，不使用交互分页。

## 🛡️ 登录与隐私

- 公开只读命令不会隐式读取浏览器 Cookie；只有显式运行 `douban login` 才会访问本机浏览器登录态。
- 登录缓存位于 `~/.douban-cli-auth.json`，使用 AES-256-GCM 加密、文件权限 `0600`，30 天后失效；`douban logout` 会删除本地缓存，不会退出浏览器中的豆瓣账号。
- 多浏览器登录不同账号时，请使用 `--browser` 和 `--profile` 明确选择，避免操作错误账号。
- 导出文件可能包含用户 ID、收藏、评分和短评。请保存到合适的位置，不要误提交到 Git 或上传到公开服务。

## 🩺 排查问题

先查看根命令或子命令帮助：

```bash
douban --help
douban book --help
douban book comments --help
```

需要排查网络、解析或登录问题时，可以临时启用调试日志：

```bash
DOUBAN_DEBUG=1 douban book info 三体
```

豆瓣页面可能出现限流、验证码或结构变化。CLI 会对只读 GET 请求进行有限重试，并尽量返回已经取得的 partial results；如果页面结构无法可靠识别，会明确报错而不是把解析失败伪装成空列表。

## 🧪 开发

```bash
npm ci
npm run verify
```

`npm run verify` 会依次执行 lint、源代码与测试类型检查、单元测试、构建和 CLI smoke tests。

## License

MIT
