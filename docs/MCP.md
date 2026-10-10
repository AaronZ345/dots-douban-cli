# 本地 MCP

入口：`dots-douban-cli mcp`，传输为 stdio，标准输出仅承载 MCP 消息。

```json
{
  "mcpServers": {
    "dots-douban-cli": {
      "command": "dots-douban-cli",
      "args": ["mcp"]
    }
  }
}
```

Codex 注册命令：

```bash
codex mcp add dots-douban-cli -- dots-douban-cli mcp
```

配置格式以 [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 和本机 `codex mcp --help` 为准。

工具：`douban_query`、`douban_records`、`douban_record_get`、`douban_record_edit`、`douban_account_action`、`douban_doctor`。

工具按顺序调用同一套 CLI，避免重新实现豆瓣解析。写工具默认 `dryRun=true`；明确的实际修改请求才使用 `false`。不提供原始 Cookie、密码或缓存密钥接口。网络与解析错误会返回工具错误；读取上限和部分结果保留在结果中。

示例、协议测试和持续集成仅使用公开查询或合成数据，不读取私人记录。不提供书影同步或备份工具。
