---
name: douban-cli
description: 豆瓣电影/书籍/影人/用户收藏查询与标记 CLI。触发词：豆瓣、电影推荐、热门电影、想看什么、top250、美剧日剧韩剧、影评短评、标记看过、评分、好书推荐、书籍、豆列、关注、导出观影记录、影人、演员导演。
---

# douban-cli

豆瓣电影/书籍/影人/用户收藏查询与标记命令行工具。

## 安装

```bash
npm i -g @marvae24/douban-cli
```

需要 Node.js >= 22。

## 场景指引

根据用户意图选择合适的命令：

| 用户意图 | 推荐命令 |
|---------|---------|
| "最近有啥好看的" / "推荐电影" | `douban hot` 或 `douban weekly` |
| "经典电影推荐" / "必看电影" | `douban top250` |
| "有什么美剧/日剧/韩剧" | `douban tv 美剧` / `日剧` / `韩剧` |
| "想看科幻/动作/悬疑片" | `douban rank 科幻` / `动作` / `悬疑` |
| "XX电影怎么样" / "介绍一下XX" | 先 `douban search XX` 拿 ID，再 `douban movie <id>` |
| "XX电影评价如何" | `douban comments <id>` 看短评，`douban reviews <id>` 看长评 |
| "有什么好书" | `douban book chart`、`douban book top250` 或 `douban book tag <标签>` |
| "最近出了什么书" | `douban book new` |
| "这本书怎么样" | `douban book info <书名或ISBN>`，再看 `book rating/comments/reviews` |
| "我看过的电影" / "我的片单" | `douban me`（需登录） |
| "帮我标记看过/想看" | `douban mark <id> --watched` / `--wish`（需登录） |
| "导出我的观影记录" | `douban export --format csv -o records.csv`（需登录） |

### 常见工作流

**查一部电影的完整信息：**
```bash
douban search 盗梦空间          # 拿到 ID（如 3541415）
douban movie 3541415            # 看详情
douban rating 3541415           # 看评分分布
douban comments 3541415         # 看热门短评
douban reviews 3541415          # 看热门影评
```

**批量标记/评分（从文件读取）：**
```bash
douban mark --file ids.txt --wish              # 批量标记想看（每行一个 ID）
douban rate --file scores.txt --delay 3        # 批量评分（每行: ID,分数）
douban comment --file comments.txt --delay 3   # 批量短评（每行: ID,评论内容）
```

## 命令参考

### 浏览（无需登录）

| 命令 | 说明 |
|-----|------|
| `douban hot` | 热门电影 |
| `douban hot --tv` | 热门剧集（综合） |
| `douban tv 美剧` | 分类剧集。可选：美剧、英剧、日剧、韩剧、国产剧 |
| `douban rank 科幻` | 类型排行。可选：科幻、动作、爱情、悬疑、喜剧、恐怖、动画等 |
| `douban top250` | 豆瓣 Top 250 |
| `douban now` | 正在热映。`-c 上海` 指定城市 |
| `douban coming` | 即将上映 |
| `douban weekly` | 一周口碑榜 |
| `douban search <关键词>` | 搜索电影 |
| `douban movie <id或片名>` | 电影详情。支持数字 ID 或片名（片名会自动搜索匹配） |
| `douban comments <id>` | 热门短评。`--latest` 按时间排序 |
| `douban reviews <id>` | 热门影评 |
| `douban rating <id>` | 评分分布（星级柱状图） |

### 书籍（无需登录）

| 命令 | 说明 |
|-----|------|
| `douban book hot` | 热门书籍（兼容旧版，等同 Top250） |
| `douban book chart [分类]` | 当前热门图书榜 |
| `douban book top250` | 豆瓣图书 Top250 |
| `douban book new [分类]` | 新书速递 |
| `douban book tag <标签>` | 按标签浏览，支持综合/出版/评价排序 |
| `douban book search <关键词>` | 按书名、作者或 ISBN 搜索 |
| `douban book info <ID/ISBN/关键词>` | 书籍详情 |
| `douban book rating <ID/ISBN/关键词>` | 评分分布与阅读状态统计 |
| `douban book comments <ID/ISBN/关键词>` | 热门/最新短评 |
| `douban book reviews <ID/ISBN/关键词>` | 热门书评 |
| `douban book notes <ID/ISBN/关键词>` | 读书笔记 |

### 用户与配置

| 命令 | 说明 | 需登录 |
|-----|------|-------|
| `douban user <userId>` | 查看用户片单 | 否 |
| `douban me` | 我的片单 | 是 |
| `douban config --user <id>` | 设置默认用户 ID | 否 |

### 登录

| 命令 | 说明 |
|-----|------|
| `douban login` | 登录（自动从浏览器提取 Cookie，支持 Chrome/Edge/Firefox/Safari） |
| `douban whoami` | 查看当前登录用户 |
| `douban logout` | 退出登录 |

### 标记（需登录）

| 命令 | 说明 |
|-----|------|
| `douban mark <id> --wish` | 标记想看 |
| `douban mark <id> --watched` | 标记看过 |
| `douban mark <id> --watching` | 标记在看 |
| `douban unmark <id>` | 取消标记 |
| `douban rate <id> --score <1-5>` | 评分（1-5 星） |
| `douban comment <id> "评论内容"` | 发布短评 |
| `douban review <id> "标题" "正文"` | 发布长评 |

### 社交与统计（需登录）

| 命令 | 说明 |
|-----|------|
| `douban feed` | 关注动态 |
| `douban stats --year 2024` | 年度观影统计 |
| `douban export -o records.csv -f csv` | 导出记录。格式：json（默认）/ csv |
| `douban follow <userId>` | 关注用户 |
| `douban unfollow <userId>` | 取消关注 |

## 通用选项

| 选项 | 说明 |
|-----|------|
| `--json` | 以 JSON 格式输出，便于程序处理 |
| `--limit N` / `-n N` | 控制返回数量 |
| `--start N` / `-s N` | 分页偏移（从 0 开始） |
| `--delay <秒>` | 批量操作的请求间隔，避免触发反爬（默认随机 1-2 秒） |

## 故障排除

| 问题 | 解决方式 |
|-----|---------|
| "反爬挑战" 错误 | 豆瓣临时封禁，等几分钟后重试，或降低请求频率（加大 `--delay`） |
| "ck token" / 登录失效 | 通常会自动重试刷新。若仍失败，再运行 `douban logout` 然后 `douban login` |
| 搜索无结果 | 尝试更短的关键词，或直接用豆瓣 ID |
| "未配置默认用户" | 运行 `douban login` 或 `douban config --user <id>` |
| 批量操作部分失败 | 检查输出的错误信息，常见原因：ID 不存在、评分不在 1-5 范围、重复标记 |
