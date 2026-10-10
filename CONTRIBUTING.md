# 参与开发

Node.js >=22.13.0。克隆仓库后运行 `npm ci`。

- `src/commands/`：参数、流程与输出。
- `src/api/`：网络请求、数据解析和校验。
- `src/auth.ts`、`src/storage/`：本地登录态与文件处理。
- `src/mcp.ts`：MCP 调用到 CLI 的映射。
- `src/__tests__/fixtures/`：合成或脱敏样本。

提交前运行：

```bash
npm run verify
npm run test:mcp
npm run test:browsers
npm pack --dry-run --ignore-scripts
```

网页结构变化时，补一份合成或脱敏夹具，并验证实际字段。测试不要读取真实登录内容、修改真实记录，或使用私人资料。

解析失败要和空列表区分。保留已读结果时同时输出原因；达到数量上限时保留续读位置。账号写入不因网络错误自动重试。

发行版本先通过 main 分支的 CI，再推送与 package.json 一致的版本标签。Release 工作流构建 npm 格式的发行包并上传到 GitHub Releases。
