# douban-cli

Douban CLI - browse movies, TV shows, books, and personal collections from the terminal.

豆瓣命令行工具：在终端查看热门电影/剧集、排行榜、Top250、用户片单、书籍搜索与详情，并支持登录后进行标记、评分、评论、长评、导出和社交操作。

## Features / 功能

### Movies / 电影
- `hot` 热门电影/剧集
- `tv` 按标签查看剧集
- `rank` 类型高分排行
- `top250` 豆瓣 Top 250
- `now` 正在热映
- `coming` 即将上映
- `weekly` 一周口碑榜
- `search` 电影搜索
- `movie` 电影详情（支持 ID 或片名）
- `rating` 评分分布
- `comments` 短评
- `reviews` 热门影评

### Books / 书籍
- `book hot` 热门书籍
- `book search` 搜索书籍
- `book info` 书籍详情

### User / 用户
- `user` 指定用户片单
- `me` 我的片单（配置用户 ID 或登录态自动识别）
- `config` 本地配置
- `list` 热门豆列

### Auth & Social / 登录与社交
- `login` 登录并缓存 Cookie
- `whoami` 查看当前登录用户
- `logout` 清除本地登录态
- `mark` 标记想看/看过/在看
- `unmark` 取消标记
- `rate` 评分（1-5）
- `comment` 发送短评
- `review` 发布长评
- `feed` 查看关注动态
- `stats` 观影统计
- `export` 导出观影记录
- `follow` 关注用户
- `unfollow` 取消关注

## Installation / 安装

需要 Node.js 22 或更高版本。

```bash
npm install -g @marvae24/douban-cli
```

或直接运行：

```bash
npx @marvae24/douban-cli hot
```

## Requirements / 运行要求

- Node.js `>= 22`
- 支持的浏览器（用于自动提取登录态）：Chrome / Edge / Firefox / Safari

## Usage / 常用命令

### 基础查询

```bash
douban hot
douban hot --tv
douban tv 美剧 --limit 10
douban rank 科幻 --limit 20
douban top250 --limit 50
douban now --city 上海
douban coming --limit 10
douban weekly
```

### 搜索与详情

```bash
douban search "奥本海默"
douban movie 35593344
douban movie "沙丘"
douban rating 1291546
douban comments 1291546 --latest
douban reviews 1291546 --limit 5
```

### 书籍

```bash
douban book hot --limit 10
douban book search "三体"
douban book info 2567698
```

### 用户与配置

```bash
douban user USER_ID
douban user USER_ID --wish
douban config --user USER_ID
douban me
douban me --doing
douban list --limit 10
```

### 登录与身份

```bash
douban login
douban whoami
douban logout
```

### 标记/评分/评论（需登录）

```bash
douban mark 1292052 --wish
douban mark 1292052 --watched
douban mark 1292052 --watching
douban unmark 1292052

douban rate 1292052 --score 5
douban comment 1292052 "值得二刷"
douban review 1292052 "标题" "长评正文"
```

### 批量操作（需登录）

```bash
douban mark --file ids.txt --wish
douban unmark --file ids.txt --delay 1.5
douban rate --file rate.csv
douban comment --file comments.csv --delay 1.5
```

文件格式：
- `ids.txt`: 每行一个电影 ID
- `rate.csv`: 每行 `<id>,<score>`（`score` 为 `1-5`）
- `comments.csv`: 每行 `<id>,<comment>`（也支持制表符分隔）

### 社交与数据（需登录）

```bash
douban feed --limit 10
douban stats --year 2026
douban export --format json -o douban-export.json
douban export --format csv -o douban-export.csv

douban follow USER_ID
douban unfollow USER_ID
```

### JSON 输出

所有命令都支持 `--json`：

```bash
douban search "沙丘" --json
douban whoami --json
douban export --format json --output export.json
```

## License

MIT
