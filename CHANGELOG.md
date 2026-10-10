# 更新记录

## 0.3.0 — 2026-10-10

- 补齐 Linux Chromium 登录态导入，支持发行版、Snap、Flatpak 和自定义配置目录。
- 按浏览器读取 GNOME Keyring、KWallet 和 macOS Keychain，处理 Chromium v10/v11 Cookie 与域名哈希。
- 完善 macOS、Linux、Windows 的浏览器程序检测，补充用户安装、PATH 和 Windows x86 路径。
- 增加 Vivaldi、Opera，以及 Windows Brave、Chromium、Arc 的登录和查询适配。
- doctor 检查实际程序是否存在；CLI 与 MCP 共用浏览器选项。
- CI 增加三平台原版 Chrome、Edge 和 Debian 发行版 Chromium 测试。

## 0.2.1 — 2026-10-10

- 项目、命令、技能和 MCP 接口统一使用 douban-cli。
- 重写安装与使用说明，补充 ChatGPT Dots 的本机接入方式。
- 修正 Windows 导出测试中的绝对路径断言。
- 提供已构建的 GitHub Release 发行包。

## 0.2.0 — 2026-10-09

- 增加图书记录编辑和指定豆列分页。
- 增加本地浏览器登录、doctor、Agent Skill 与 MCP 接口。
- 增加匿名夹具、浏览器检查和多系统 CI。
