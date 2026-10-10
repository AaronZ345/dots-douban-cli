<div align="center">

# douban-cli

豆瓣命令行工具，支持电影和图书搜索、片单查询、个人评分与短评管理。

支持 ChatGPT Dots 和 MCP 客户端调用。

[![CI](https://github.com/AaronZ345/douban-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/AaronZ345/douban-cli/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AaronZ345/douban-cli)](https://github.com/AaronZ345/douban-cli/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-43853d)](https://nodejs.org/)
[![MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

[安装](#安装) · [常用命令](#常用命令) · [Dots 接入](#dots-接入) · [浏览器](#浏览器) · [开发](CONTRIBUTING.md)

</div>

## 功能

| 功能 | 内容 |
|---|---|
| 电影与剧集 | 搜索、详情、热门、类型排行、Top250、口碑榜、待上映、评分与评论 |
| 图书 | 书名、作者和 ISBN 搜索，详情、榜单、新书、书评与读书笔记 |
| 豆列 | 按 ID 或地址读取，自动翻页，按作品类型和关键词筛选 |
| 个人记录 | 想看／在看／看过、想读／在读／读过；按日期、星级和文字筛选，导出 JSON 或 CSV |
| 记录编辑 | 修改短评、评分、状态、标签和可见性；支持预览，提交后读取记录核对 |
| 助手接入 | Agent Skill、6 个 MCP 工具，以及本地诊断命令 |

## 安装

需要 Node.js 22.13 或更新版本。

```bash
npm install -g https://github.com/AaronZ345/douban-cli/releases/download/v0.3.0/douban-cli-0.3.0.tgz
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

Chrome 和 Edge 使用本机已安装的浏览器。在源码目录安装 Playwright 的 Chromium、Firefox、WebKit 运行时：

```bash
npm run install:browsers
```

此脚本保留其他项目已经安装的 Playwright 浏览器。

## 常用命令

### 电影与图书

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

### 片单与书单

```bash
douban-cli list 240962 --limit 30 --json
douban-cli list https://www.douban.com/doulist/240962/ --kind movie --json
douban-cli records --user USER_ID --kind book --status collect --limit 30 --json
```

`list --all` 默认最多读取 10000 条。日期、星级和关键词筛选只处理已读取的数据。增加 `--limit` 或使用返回的分页位置可继续读取。

### 登录与记录编辑

```bash
douban-cli login --launch --browser chromium
douban-cli record get 1292052 --kind movie --json
douban-cli record edit 1292052 --comment "短评内容" --dry-run --json
```

在浏览器窗口中登录。`--dry-run` 仅预览改动，检查预览后移除该参数提交。图书使用 `--kind book`；`--clear-comment`、`--clear-rating`、`--clear-tags` 分别清空对应字段。

未指定的字段保留原值。提交前重新读取记录，记录有变化时停止提交；提交后核对状态、评分、短评、标签和可见性。写入失败不自动重试，批量操作失败后，剩余条目标记为 `skipped`。

兼容 `mark`、`rate`、`comment`、`unmark`、`review`、`stats`、`export`、`follow`、`unfollow`。图书另有 `book mark`、`book rate`、`book comment`、`book unmark`。具体参数见各命令的 `--help`。

## Dots 接入

ChatGPT Dots 可通过已连接的电脑调用 `douban-cli`。CLI 和技能需安装在该电脑上，并授予 Dot 访问权限。使用时电脑需在线，ChatGPT 桌面应用需保持打开。[电脑连接文档](https://learn.chatgpt.com/docs/dots/computers-and-apps)

在源码目录安装技能：

```bash
npm run install:skill
```

发行包包含技能文件 `skills/douban-cli/SKILL.md`。Dot 读取技能后可调用本机命令，例如：

> 使用这台电脑上的 douban-cli，查豆瓣科幻榜前 10 部电影，列出片名、年份、评分和 ID。

> 使用 douban-cli 读取指定片单，并注明读取失败的页面和超过数量上限的部分。

支持 stdio 的 MCP 客户端可使用以下配置：

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

| 浏览器 | macOS | Linux | Windows | 使用方式 |
|---|---|---|---|---|
| Chromium、Chrome、Edge | 支持 | 支持 | 支持 | 本机程序、独立登录窗口、浏览器查询、登录态导入 |
| Brave、Vivaldi、Opera | 支持 | 支持 | 支持 | 自动查找常见安装路径，也可用 `--executable` 指定程序 |
| Arc | 支持 | 无 Linux 版 | 支持 | 独立登录窗口、浏览器查询、登录态导入 |
| Firefox | 支持 | 支持 | 支持 | 原版浏览器登录态导入；自动化使用 Playwright Firefox |
| WebKit | 支持 | 支持 | 支持 | Playwright WebKit |
| Safari | 登录态导入 | 无 Linux 版 | 无 Windows 版 | 原版 Safari 自动操作未实现 |

Linux Chromium 支持发行版软件包、Snap 和 Flatpak 配置目录；程序检测也搜索 `PATH`。macOS 检测系统和用户的 Applications 目录，Windows 检测用户安装、Program Files 和 x86 安装路径。

登录态导入需要系统钥匙串可用且 Cookie 格式受支持。Linux 支持 GNOME Keyring 和 KWallet；Windows 的 App-Bound 加密 Cookie 无法直接导入时，使用独立登录窗口。

```bash
douban-cli login --browser chromium
douban-cli login --launch --browser chromium
douban-cli login --launch --browser vivaldi
```

Chromium 系浏览器的 `--profile` 可指定配置名、配置目录或 Cookie 数据库路径。自定义安装位置使用 `login --launch --executable <绝对路径>`，浏览器查询对应 `--read-executable <绝对路径>`。

默认通过 HTTP 查询。需要执行 JavaScript 的页面使用浏览器模式：

```bash
douban-cli --transport browser --read-browser chromium top250 --json
```

CI 在 Linux、macOS、Windows 上检查 Node 22/24，测试 Playwright Chromium、Firefox、WebKit，以及原版 Chrome、Edge；另在 Debian 容器中测试 `/usr/bin/chromium`。真实站点登录和写入受豆瓣页面、限流和验证码影响；已完成的测试见 [兼容性记录](docs/COMPATIBILITY.md)。

## 输出说明

| 字段或值 | 含义 |
|---|---|
| `partial` / `warnings` | 部分页面或数据来源读取失败 |
| `limited` | 已达数量上限，仍有未读取的数据 |
| `nextStart` 等分页游标 | 下一次读取的起始位置 |
| `null` | 数值未知，以 `null` 返回，不填 0 |

登录缓存加密保存在本机独立应用目录。`doctor` 默认只检查运行时、文件类型和权限，不读取登录文件内容。测试使用公开查询或合成夹具，不操作真实账号。

## 许可证

这是非官方豆瓣工具，采用 [MIT License](LICENSE)。问题和复现步骤请提交到 [Issues](https://github.com/AaronZ345/douban-cli/issues)。
