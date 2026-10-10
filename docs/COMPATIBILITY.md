# 浏览器兼容性

更新日期：2026-10-10。

## 平台与入口

| 浏览器 | macOS | Linux | Windows | 独立登录与查询 | 现有登录态导入 |
|---|---|---|---|---|---|
| Chromium | 支持 | 支持 | 支持 | 本机 Chromium，未安装时使用 Playwright Chromium | 各平台独立配置目录 |
| Chrome / Edge | 支持 | 支持 | 支持 | 本机程序或 Playwright 对应 channel | 对应浏览器配置目录 |
| Brave | 支持 | 支持 | 支持 | 本机 Chromium 协议 | 对应浏览器配置目录 |
| Vivaldi / Opera | 支持 | 支持 | 支持 | 本机 Chromium 协议 | 对应浏览器配置目录 |
| Arc | 支持 | 无 Linux 版 | 支持 | 本机 Chromium 协议 | macOS Keychain / Windows 配置路径 |
| Firefox | 支持 | 支持 | 支持 | Playwright Firefox | 原版 Firefox 配置目录 |
| WebKit | 支持 | 支持 | 支持 | Playwright WebKit | 标准 storage state 文件 |
| Safari | 支持导入 | 无 Linux 版 | 无 Windows 版 | 未实现原版 Safari 自动操作 | macOS Safari |

“支持”表示提供对应适配路径，不表示每个浏览器版本都完成了真实豆瓣账号读写验收。

## 程序与配置目录

- macOS：检测 `/Applications` 和 `~/Applications`。
- Linux：检测常见系统目录、`/snap/bin`、Flatpak 导出程序与 `PATH`；Chromium 配置目录包括 XDG、Snap 和 Flatpak。
- Windows：检测 LocalAppData、Program Files、Program Files (x86)、程序别名与 `PATH`。
- Chromium 系浏览器的 `--profile` 接受配置目录名、显示名称、配置目录或 Cookie 数据库路径。只有明确选择的浏览器和配置会被读取；找不到时不会改读 Chrome。
- 自定义程序路径使用 `login --launch --executable <绝对路径>`；查询使用 `--read-executable <绝对路径>`。

独立窗口使用临时浏览器上下文，不加载日常浏览器配置。已有登录态仅在显式执行 `login --browser ...` 时导入。

## Cookie 格式与系统限制

Linux CBC Cookie 支持 v10/basic 和 v11/keyring，按所选浏览器查询 GNOME Keyring 或 KWallet。macOS 使用对应浏览器的 Keychain 项。数据库版本 24 及以上会核对域名哈希。

Windows 的经典加密格式通过当前用户的 DPAPI 读取。App-Bound v20 Cookie 不绕过系统保护，无法导入时使用 `login --launch --browser <名称>`。浏览器锁定数据库、钥匙串不可用或 Cookie 格式不受支持时，会报告失败，不保存未验证的登录态。

Playwright Firefox 和 WebKit 是专用构建，分别区别于原版 Firefox 和 Safari。[Playwright 浏览器文档](https://playwright.dev/docs/browsers)

Windows 的文件权限检查不以 POSIX mode 数值证明 ACL 安全；仍检查文件类型、格式和命令行为。

## 测试范围

| 检查 | 内容 |
|---|---|
| 单元测试 | 三平台路径解析、指定浏览器路由、合成 SQLite Cookie、v10/v11、域名哈希、钥匙串参数、CLI 与 MCP |
| 本地 macOS | Chromium、Chrome、Playwright Firefox、WebKit 的启动、DOM 和记录解析 |
| 三平台 CI | Node 22/24；Playwright Chromium、Firefox、WebKit；原版 Chrome、Edge |
| Linux Chromium CI | Debian 发行版 `/usr/bin/chromium` 启动、合成页面解析、临时配置内的合成 Cookie 保存与读取 |

CI 结果以对应提交的 [GitHub Actions](https://github.com/AaronZ345/douban-cli/actions/workflows/ci.yml) 为准。Brave、Arc、Vivaldi、Opera 的路径与参数已使用合成数据测试，原版程序的完整豆瓣登录和写入尚未逐项验收。

浏览器检查只访问拦截后的合成网页，不读取真实账号、私人记录或日常浏览器 Cookie：

```bash
npm run test:browsers
npm run test:browsers -- --browser chromium --browser chrome --browser edge
```

公开站点检查使用 `npm run test:live`，默认不启用账号读取。真实账号写入不纳入自动测试。
