# 兼容性矩阵

日期：2026-10-09。只记录已完成的测试；适配入口、启动成功、匿名解析和完整站点读写是不同层次。

| 浏览器 | 现有登录态导入 | 启动 / 匿名解析 | 真实站点范围 |
|---|---|---|---|
| Chromium | macOS 专用入口；其他系统可用独立登录窗口 | 本机启动；匿名解析测试纳入 CI | 公开查询已有在线验收 |
| Chrome | macOS / Windows / Linux 适配 | 本机启动 | 公开查询已有在线验收 |
| Firefox | 原版浏览器 Cookie 适配 | 自动化使用 Playwright Firefox | 未声明原版 Firefox 自动化支持 |
| WebKit | 可导入标准 state 文件 | 自动化使用 Playwright WebKit | 不等于 Safari |
| Edge | 多系统适配 | channel=msedge；须安装对应程序 | 尚未在本机完整验收 |
| Brave / Arc | macOS 专用 Cookie 入口 | 常见路径或显式程序路径 | 尚未在本机完整验收 |
| Safari | macOS Cookie 导入入口 | 原版 Safari 自动操作未实现 | 未声明完整自动化支持 |

GitHub CI 配置了 Ubuntu、macOS、Windows，以及 Node 22/24 的离线检查；另配置 Chromium、Firefox、WebKit 匿名 DOM 检查。远端矩阵的执行结果以对应提交的 GitHub Actions 为准；矩阵配置本身不等于跨系统实测通过。

`npm run test:browsers` 使用合成网页与合成记录，网络请求通过浏览器 route 拦截，既不访问真实账户，也不加载日常浏览器配置。真实公开来源检查使用 `npm run test:live`，默认不启用账号读取。

Windows 不用 POSIX mode 数值证明 ACL 安全。权限断言只在 POSIX 系统执行；Windows 仍检查文件类型、格式与命令行为。
