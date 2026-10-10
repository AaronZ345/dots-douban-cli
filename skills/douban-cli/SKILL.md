---
name: douban-cli
description: 查询豆瓣电影、图书、公开豆列与明确指定的账号记录，或编辑用户明确要求修改的短评和评分；使用本地 douban-cli，支持 MCP。普通口味推荐不触发。
metadata:
  origin: local
  owner: aaron
---

# 豆瓣 CLI

使用已安装的 `douban-cli`。排错先运行 `douban-cli doctor --json`，默认不读取登录内容。公开查询不用登录，也不扫描浏览器 Cookie。

## 路由

- 电影：`search`、`movie`、`hot`、`tv`、`rank`、`top250`、`coming`、`weekly`、`rating`、`comments`、`reviews`。
- 图书：`book search`、`book info`、`book top250`、`book chart`、`book new`、`book rating`、`book comments`、`book reviews`、`book notes`。
- 指定豆列：`list <数字ID或HTTPS地址> --limit <n> --json`。`--all` 默认上限 10000，仍须检查 `limited` 和续读游标。
- 明确指定的公开用户：`records --user <id> --kind movie|book --status collect|wish|do --json`。只有用户明确要求自己的记录时才省略 `--user`。
- 单条记录：`record get <数字ID> --kind movie|book --json`。
- 编辑：`record edit <数字ID> --kind movie|book --comment <正文> --dry-run --json`；可指定评分、状态、标签、隐私，未指定字段保留。`--clear-comment`、`--clear-rating`、`--clear-tags` 分别清空字段。

不确定参数时读取对应命令 `--help`。名称搜索用于查候选；编辑必须使用数字 ID。图书不同版本须核对 ISBN 和出版信息。

## 登录与写入

账号操作只复用 CLI 已保存并验证的登录态。需要登录时让用户在 `login --launch --browser chromium` 打开的窗口中自行完成；不索取密码或 Cookie，不读取其他来源的凭据。

只有明确的条目、字段和修改内容才进入写入。已有用户授权时直接完成任务，不追加审批步骤。预览使用 `--dry-run`；实际提交移除此选项。提交失败或结果未核验时停止，先重新读取，不盲目重试。批量失败即停，说明 `skipped` 条目。

CLI 编辑不触发广播分享。项目开发、演示与测试只用公开数据或合成样本，不读取私人记录，也不进行同步或备份。

## 结果与 MCP

读取 `--json` 的结果，保留 `partial`、`warnings`、`limited`、续读位置和未知值 `null`。不能把达到上限的结果说成完整数据。

需要执行网页 JavaScript 时使用 `--transport browser --read-browser chromium`；Firefox 和 WebKit 是 Playwright 构建，WebKit 不等于原版 Safari。浏览器支持范围以仓库兼容性文档为准。

本地 MCP 入口为 `douban-cli mcp`。写工具默认预览，只有用户明确要求实际修改时使用 `dryRun=false`。MCP 与 CLI 共用数据处理，不提供原始登录凭据读取接口。
