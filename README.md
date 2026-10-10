# dots-douban-cli

豆瓣电影、图书、豆列与记录管理工具。主命令 `dots-douban-cli`，兼容别名 `douban-cli`。

版本：0.2.0。基于 [Marvae/douban-cli](https://github.com/Marvae/douban-cli) 的 MIT 代码开发，保留原许可证。项目示例、测试和文档仅使用公开或合成匿名数据。

## 安装

需要 Node.js >=22.13.0。

```bash
npm ci
npm run build
npm link --ignore-scripts
npm run install:browsers
npm run install:skill
```

浏览器安装关闭 Playwright 的旧缓存回收。技能安装到当前 Codex home 下的 `skills/dots-douban-cli`，只更新同名本地技能。

## 公开查询

```bash
dots-douban-cli search 沙丘 --json
dots-douban-cli movie 1292052 --json
dots-douban-cli hot --limit 10
dots-douban-cli tv 英剧 --limit 10
dots-douban-cli rank 科幻 --limit 10
dots-douban-cli top250 --page 1
dots-douban-cli weekly
dots-douban-cli coming

dots-douban-cli book search 三体 --json
dots-douban-cli book info 9787536692930 --json
dots-douban-cli book chart 小说
dots-douban-cli book new 科学新知
dots-douban-cli book top250 --limit 10

dots-douban-cli list 240962 --limit 30 --json
dots-douban-cli --transport browser --read-browser chromium list 240962 --limit 10 --json
```

搜索、详情、评分、短评、长评和读书笔记入口与上游命令兼容。`list` 支持数字 ID 和豆瓣 HTTPS 地址，可按类型或关键词筛选。分页串行执行，失败即停；`--all` 默认上限 10000，达到上限会保留续读游标。

`partial` / `warnings` 表示读取失败或残缺，`limited` 表示受到读取量限制，未知数值保留 `null`。不能把有限样本视为全量数据。

## 记录编辑能力

原有 `mark`、`rate`、`comment`、`unmark`、`review`、`stats`、`export`、`follow`、`unfollow` 和配置命令保留。图书额外支持 `book mark`、`book rate`、`book comment`、`book unmark`。

`record get` / `record edit` 只接受数字豆瓣 ID。编辑可指定短评、评分、状态、标签与可见性；未指定字段保留，支持分别清空。`--dry-run` 只预览。实际提交前检查原值，提交后读回核验；失败不自动重试，批量后续项标记 skipped。

账号功能仅在用户明确调用时使用现有登录态。项目验收不读取私人记录，不索取或展示登录凭据，不触发广播分享。不添加书影同步或备份功能。

## 诊断、技能与 MCP

```bash
dots-douban-cli doctor --json
dots-douban-cli --transport browser doctor --online --json
dots-douban-cli mcp
```

`doctor` 默认只检查运行时、文件类型和权限，不读取登录文件内容。可选公开网络检查。MCP 使用 stdio，6 个工具复用 CLI，按顺序调用，写工具默认预览。技能识别豆瓣相关请求，并保留现有授权范围。

详见 [MCP 接入](docs/MCP.md) 和 [浏览器兼容性](docs/COMPATIBILITY.md)。

## 验证与发布准备

```bash
npm run verify
npm run test:mcp
npm run test:browsers
npm run test:live
npm pack --dry-run --ignore-scripts
```

CI 配置 Ubuntu / macOS / Windows 与 Node 22/24；匿名浏览器检查覆盖 Chromium、Firefox、WebKit。标签发布流程会检查版本、执行测试并生成包。跨系统检查的运行结果以当前提交对应的 GitHub Actions 记录为准。

[测试记录](TEST_REPORT.md) 明确区分单元测试、匿名浏览器测试、公开在线读取和未经实际提交验证的写入。真实网页和非官方接口可能变化，测试结果只代表列明的范围。
