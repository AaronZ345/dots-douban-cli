<div align="center">

# douban-cli

**在终端查书影、读片单，管理自己的评分和短评。**

也可作为本地工具，供 ChatGPT Dots 和支持 MCP 的助手调用。

[![CI](https://github.com/AaronZ345/douban-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/AaronZ345/douban-cli/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AaronZ345/douban-cli)](https://github.com/AaronZ345/douban-cli/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-43853d)](https://nodejs.org/)
[![MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

[安装](#安装) · [常用命令](#常用命令) · [Dots 接入](#dots-接入) · [浏览器](#浏览器) · [开发](CONTRIBUTING.md)

</div>

## 能做什么

| 功能 | 内容 |
|---|---|
| 电影与剧集 | 搜索、详情、热门、类型排行、Top250、口碑榜、待上映、评分与评论 |
| 图书 | 书名、作者和 ISBN 搜索，详情、榜单、新书、书评与读书笔记 |
| 豆列 | 按 ID 或地址读取，自动翻页，按作品类型和关键词筛选 |
| 个人记录 | 想看／在看／看过、想读／在读／读过；按日期、星级和文字筛选，导出 JSON 或 CSV |
| 记录编辑 | 修改短评、评分、状态、标签和可见性；预览改动，提交后读回核对 |
| 助手接入 | Agent Skill、6 个 MCP 工具，以及本地诊断命令 |

## 安装

需要 **Node.js 22.13 或更新版本**。安装已构建的发行包：

```bash
npm install -g https://github.com/AaronZ345/douban-cli/releases/download/v0.2.1/douban-cli-0.2.1.tgz
douban-cli --version
douban-cli doctor --json
```

也可以从源码安装：

```bash
git clone https://github.com/AaronZ345/douban-cli.git
cd douban-cli
npm ci
npm run build
npm link --ignore-scripts
```

使用已安装的 Chrome 或 Edge 时，不必下载额外浏览器。需要 Playwright 的 Chromium、Firefox、WebKit 运行时，可以在源码目录执行：

```bash
npm run install:browsers
```

此脚本保留其他项目已经安装的 Playwright 浏览器。

## 常用命令

### 查电影和书

```bash
douban-cli search 沙丘 --limit 10 --json
douban-cli movie 1292052 --json
douban-cli rank 科幻 --limit 10
douban-cli top250 --page 1
douban-cli weekly

douban-cli book search 三体 --json
douban-cli book info 9787536692930 --json
douban-cli book chart 小说
douban-cli book new 科学新知
```

### 读片单和书单

```bash
douban-cli list 240962 --limit 30 --json
douban-cli list https://www.douban.com/doulist/240962/ --kind movie --json
douban-cli records --user USER_ID --kind book --status collect --limit 30 --json
```

`list --all` 默认最多读取 10000 条。日期、星级和关键词筛选作用于已读取的数据；需要更多结果时，调整 `--limit` 或使用返回的续读位置。

### 登录并编辑记录

```bash
douban-cli login --launch --browser chromium
douban-cli record get 1292052 --kind movie --json
douban-cli record edit 1292052 --comment "短评内容" --dry-run --json
```

在打开的窗口中自行登录。确认预览后，移除 `--dry-run` 才会提交。图书使用 `--kind book`；`--clear-comment`、`--clear-rating`、`--clear-tags` 分别清空对应字段。

未指定的字段会保留。提交前再次读取原值，发现变化就停止；提交后核对状态、评分、短评、标签和可见性。写入失败不自动重试，批量操作失败后，剩余条目标记为 `skipped`。

兼容 `mark`、`rate`、`comment`、`unmark`、`review`、`stats`、`export`、`follow`、`unfollow`。图书另有 `book mark`、`book rate`、`book comment`、`book unmark`。具体参数见各命令的 `--help`。

## Dots 接入

**支持 ChatGPT Dots 通过已连接的电脑使用本工具。** CLI 和技能安装在这台电脑上；Dot 需要被允许访问该电脑，使用期间电脑要在线，ChatGPT 桌面应用要保持打开。[连接电脑的说明](https://learn.chatgpt.com/docs/dots/computers-and-apps)

在源码目录安装技能：

```bash
npm run install:skill
```

技能文件也随发行包提供，位于 `skills/douban-cli/SKILL.md`。可以让 Dot 读取这份说明，再调用本机命令。例如：

> 使用这台电脑上的 douban-cli，查豆瓣科幻榜前 10 部电影，列出片名、年份、评分和 ID。

> 读取我指定的片单。把获取失败的页面和因数量上限而没读到的部分说明白。

CLI 和本地技能通过电脑连接使用。MCP 则供支持 stdio 的客户端接入：

```json
{
  "mcpServers": {
    "douban-cli": {
      "command": "douban-cli",
      "args": ["mcp"]
    }
  }
}
```

MCP 写工具默认 `dryRun=true`。公开查询不读取浏览器登录态；账号操作只在明确请求时使用 CLI 已保存的登录态。[工具和参数说明](docs/MCP.md)

## 浏览器

| 浏览器 | 使用方式 |
|---|---|
| Chromium、Chrome、Edge | 独立登录窗口和浏览器查询；Chrome、Edge 使用本机程序 |
| Brave、Arc | 常见程序路径或 `--executable`；直接导入登录态目前限 macOS |
| Firefox | 原版浏览器可导入登录态；自动化使用 Playwright Firefox |
| WebKit | 使用 Playwright WebKit；与原版 Safari 分开 |
| Safari | macOS 登录态导入；没有原版 Safari 自动操作 |

默认使用 HTTP。页面需要执行 JavaScript 时切到浏览器模式：

```bash
douban-cli --transport browser --read-browser chromium top250 --json
```

CI 在 Linux、macOS、Windows 上检查 Node 22/24，并运行 Chromium、Firefox、WebKit 的匿名页面测试。真实站点登录和写入受豆瓣页面、限流和验证码影响；各浏览器的验收范围见 [兼容性记录](docs/COMPATIBILITY.md)。

## 看懂结果

- `partial` / `warnings`：部分页面或来源读取失败。
- `limited`：到了读取数量上限，仍有内容未读取。
- `nextStart` 等游标：继续读取的位置。
- `null`：数值未知，不用 0 代替。

登录缓存加密保存在本机独立应用目录。`doctor` 默认只检查运行时、文件类型和权限，不读取登录文件内容。测试使用公开查询或合成夹具，不操作真实账号。

## 许可证

这是非官方豆瓣工具，采用 [MIT License](LICENSE)。问题和复现步骤请提交到 [Issues](https://github.com/AaronZ345/douban-cli/issues)。
