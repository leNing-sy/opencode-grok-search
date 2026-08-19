# 🔎 OpenCode Exa + Grok Search

一套面向 OpenCode 的联网搜索配置方案：用 Exa 定位和读取具体来源，用 Grok 做开放式综合和深度研究，再用 `AGENTS.md` 规则决定什么时候调用哪一个。

这不是把两个搜索工具无条件串起来。关键是职责分离和按问题升级：简单事实先找准来源，真正需要解释和比较时再综合，来源冲突时才进入深度研究。

> [!WARNING]
> 搜索问题、页面内容和生成结果会发送到相应的第三方服务，并可能产生费用。不要把 API Key 写入源码、配置示例、提交记录、截图或日志。第三方服务可以看到请求内容，只应使用你信任的端点。

| 📦 内容 | 当前状态 |
|---|---|
| Exa MCP | ✅ 负责检索网页、文档和指定页面正文 |
| Grok Custom Tool | ✅ 负责联网综合与按需深度研究 |
| OpenCode 路由规则 | ✅ 用问题类型决定调用和升级路径 |
| 兼容性边界 | ⚠️ 以当前端点、模型和 OpenCode 版本的实际验证为准 |

> [!TIP]
> 推荐工作流：先用 Exa 找到一手来源，再让 Grok 解释或比较；只有证据冲突、范围很大或明确要求时，才升级到深度搜索。

## 🧩 工具分工

| 工具 | 作用 | 适合的问题 |
|---|---|---|
| `web_search_exa` | 搜索并定位网页、文档、数据页 | 明确页面、官方资料、当前版本、简单事实 |
| `web_fetch_exa` | 读取指定页面正文 | 已知 URL，需要核对正文、参数或上下文 |
| `grok_search` | Grok 4.3 联网搜索并综合回答 | 开放式解释、比较、带证据的总结 |
| `grok_deep_search` | Grok 4.20 Medium 多来源研究 | 来源冲突、广泛交叉验证、明确的深度调查 |

Grok 工具还支持按次启用 `include_x=true`，仅用于明确涉及 X 帖子、舆情或实时讨论的问题。

## 🧭 推荐路由

```text
问题
  -> 明确页面/事实?       -> web_search_exa
  -> 已知 URL 要读正文?    -> web_fetch_exa
  -> 需要解释/比较/综合?   -> grok_search
  -> 证据冲突或深度调查?   -> grok_deep_search
```

两者的搭配由 OpenCode 的路由规则完成，不是一个隐藏的自动流水线：Exa 负责找准来源，模型根据 Exa 结果决定是否需要 Grok 综合或升级。不要因为两个工具都可用，就对一个简单问题重复调用全部工具。

可直接复制的规则见 [`examples/AGENTS.search-routing.md`](examples/AGENTS.search-routing.md)，完整配置片段见 [`examples/opencode-search-config.jsonc`](examples/opencode-search-config.jsonc)，设计和边界见 [`docs/search-stack.md`](docs/search-stack.md)。

## ⚙️ 配置

### 1. 🌐 Exa MCP

把 [`examples/opencode-search-config.jsonc`](examples/opencode-search-config.jsonc) 中的 `experimental.mcp_timeout` 和 `mcp.exa` 合并到自己的 `opencode.json`，不要用示例文件覆盖已有配置。示例使用 OpenCode 的环境变量占位符：

```powershell
$env:EXA_API_KEY = "your-exa-api-key"
```

```bash
export EXA_API_KEY="your-exa-api-key"
```

必须在启动 OpenCode 的同一环境中设置变量。Exa 远程 MCP 地址是 `https://mcp.exa.ai/mcp`，请求头使用 `x-api-key`。不要把真实 Key 写回 JSON。

### 2. 🤖 Grok Custom Tool

把 [`tools/grok.ts`](tools/grok.ts) 放到 OpenCode 的全局工具目录，或项目的 `.opencode/tools/grok.ts`：

- Windows：`%USERPROFILE%\.config\opencode\tools\grok.ts`
- macOS / Linux：`~/.config/opencode/tools/grok.ts`

设置 Grok 端点和凭据：

```powershell
$env:GROK_BASE_URL = "https://your-responses-endpoint.example"
$env:GROK_API_KEY = "your-grok-api-key"
```

```bash
export GROK_BASE_URL="https://your-responses-endpoint.example"
export GROK_API_KEY="your-grok-api-key"
```

可用 `GROK_SEARCH_MODEL` 和 `GROK_DEEP_SEARCH_MODEL` 覆盖默认模型。端点必须支持 Responses 风格的 `/v1/responses`、服务端 `web_search`，以及 SSE 或完整 JSON 响应。工具拒绝跨端点重定向，详细边界见 [`docs/protocol-and-security.md`](docs/protocol-and-security.md)。

### 3. 🧠 路由规则

把 [`examples/AGENTS.search-routing.md`](examples/AGENTS.search-routing.md) 合并到自己的 `AGENTS.md`，保留你已有的其他规则。它只负责工具选择，不会修改 Provider、模型或密钥。

## ✅ 验证

1. 启动 OpenCode 后运行 `opencode mcp list`，确认 `exa` 已启用并能连接。
2. 检查工具列表中有 `web_search_exa`、`web_fetch_exa`、`grok_search` 和 `grok_deep_search`。
3. 用 Exa 查找一个明确的官方页面，并用 `web_fetch_exa` 核对正文。
4. 用 `grok_search` 回答一个需要比较多个来源的问题，确认关键结论带来源链接。
5. 仅在来源冲突或明确要求时测试 `grok_deep_search`；明确涉及 X 时再测试 `include_x=true`。

验证时不要使用真实隐私、内部资料或凭据。最初 Grok 工具曾在 OpenCode 1.18.12 与特定 Responses 兼容端点完成端到端验证；这不构成对其他端点、模型版本或未来 OpenCode 版本的兼容承诺。Exa MCP 的工具名和返回字段也应以当前连接状态为准。

## 🛠️ 故障排查

- Exa 未出现：检查 `mcp.exa.enabled`、`EXA_API_KEY` 是否在启动进程中可见，再运行 `opencode mcp list`。
- Exa 能搜索但无法读正文：确认使用 `web_fetch_exa` 并检查目标页面是否允许抓取；不要立刻升级到深度搜索。
- Grok 工具未出现：确认 `grok.ts` 位于正确的工具目录，并重启 OpenCode。
- Grok 报端点或模型错误：检查 `GROK_BASE_URL`、模型覆盖变量和服务商当前 Responses 能力。
- 结果不够可靠：先用 Exa 找官方或一手来源，再视需要调用 `grok_search`；有冲突才升级 `grok_deep_search`。

## ↩️ 卸载与回滚

删除复制到 `.opencode/tools/` 或全局工具目录的 `grok.ts`，移除 `GROK_*` 环境变量，并从 `opencode.json` 删除 `mcp.exa` 配置后重启 OpenCode。回滚前先恢复你自己的配置备份；本方案不会要求删除会话、数据库或其他项目文件。

## 📄 License

[MIT](LICENSE)
