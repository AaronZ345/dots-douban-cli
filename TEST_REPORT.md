# douban-cli 验收记录

日期：2026-10-10。范围仅为豆瓣 CLI、豆瓣 MCP、诊断、技能与兼容性。

- 231 项单元测试通过，25 个测试文件；lint、类型检查、构建和命令检查通过。
- 豆瓣 MCP 保留 6 个工具，stdio 接口使用匿名协议检查。
- Chromium、Firefox、WebKit 使用合成页面检查启动、DOM 和记录解析。
- 技能包含本地来源与所有者元数据，已经安装并通过格式校验。
- 示例和夹具不包含真实账号、私人记录或登录内容；本轮未读取私人数据。
- CI 配置 Ubuntu/macOS/Windows 和 Node 22/24。远端执行结果以当前提交的 GitHub Actions 为准。
- 非官方接口的真实写入仍只有模拟验证，不能把预览或浏览器启动等同于完整写入验收。

## 可复现检查

```bash
npm run verify
npm run test:mcp
npm run test:browsers
npm run test:live
npm pack --dry-run --ignore-scripts
```

公开在线检查串行、限速、失败即停。真实写入与完整浏览器读写仍未列为已验收。
