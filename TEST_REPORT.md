# douban-cli 验收记录

日期：2026-10-10。范围仅为豆瓣 CLI、豆瓣 MCP、诊断、技能与兼容性。

- 265 项单元测试通过，29 个测试文件；lint、类型检查、构建和命令检查通过。
- 豆瓣 MCP 保留 6 个工具，stdio 接口使用匿名协议检查。
- macOS 上的 Chromium、Chrome、Playwright Firefox、WebKit 使用合成页面检查启动、DOM 和记录解析。
- 新增三平台浏览器程序与配置路径、Linux v10/v11 Cookie、域名哈希、GNOME/KDE 钥匙串和指定浏览器路由测试。
- 技能包含本地来源与所有者元数据，已经安装并通过格式校验。
- 示例和夹具不包含真实账号、私人记录或登录内容；本轮未读取私人数据。
- CI 配置 Ubuntu/macOS/Windows 和 Node 22/24，增加原版 Chrome、Edge 和 Debian 发行版 Chromium。远端执行结果以当前提交的 GitHub Actions 为准。
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
