# Exa 与 Grok 搜索方案

## 目标

这套配置解决的是“不同问题应该由哪个搜索工具负责”，不是单纯增加一个搜索按钮：

- Exa 负责检索、定位和读取具体来源。
- Grok 负责开放式搜索、解释、比较和多来源研究。
- `AGENTS.md` 负责把问题路由到合适的工具，并控制升级条件。

## 组件关系

### Exa MCP

Exa 通过 OpenCode 的远程 MCP 配置接入。当前方案只依赖两个已在本机规则中使用的工具名：

- `web_search_exa`：搜索网页、官方文档、数据页和当前资料。
- `web_fetch_exa`：读取已经找到的 URL 的正文。

Exa 的价值是来源定位和正文获取。它不负责把多个来源整理成最终解释，也不应该被当成通用聊天模型。

### Grok Custom Tool

仓库中的 [`../tools/grok.ts`](../tools/grok.ts) 导出两个 OpenCode 工具：

- `grok_search`：常规联网搜索和综合回答，默认使用 Grok 4.3。
- `grok_deep_search`：更长的多来源研究，默认使用 Grok 4.20 Medium。

工具使用 Responses 风格端点，默认发送 `web_search`，只有 `include_x=true` 才发送 `x_search`。模型名、端点和密钥均通过环境变量覆盖，不写入源码。

## 路由决策

| 场景 | 首选 | 升级条件 |
|---|---|---|
| 找官方页面、文档、数据页或单个事实 | `web_search_exa` | 结果没有可用来源时再换策略 |
| 已知 URL，需要正文和上下文 | `web_fetch_exa` | 页面不可抓取时换其他公开来源 |
| 比较多个来源并解释差异 | `grok_search` | 需要更大范围核验时升级 |
| 来源冲突、争议事实、深度调查 | `grok_deep_search` | 仅在确有必要时调用 |
| X 帖子、舆情、实时讨论 | Grok + `include_x=true` | 问题不涉及 X 时保持关闭 |

### 典型协作流程

1. 先判断用户要的是“找到页面”，还是“理解问题”。
2. 要找页面时调用 `web_search_exa`；需要正文时继续调用 `web_fetch_exa`。
3. 如果用户还需要比较、解释或综合，再使用 `grok_search`，并把已找到的关键来源、时间范围和争议点写入查询约束。
4. 如果来源互相矛盾或用户明确要求系统调查，改用 `grok_deep_search`。
5. 最终回答区分来源事实、推断和社区观点，并保留可访问链接。

这里的“协作”是模型按照 `AGENTS.md` 顺序进行工具调用，不是 Exa 和 Grok 之间存在隐式数据管道。工具返回的来源不能因为经过 Grok 就自动变成已核实事实。

## 配置边界

### Exa

将 [`../examples/opencode-search-config.jsonc`](../examples/opencode-search-config.jsonc) 的 `experimental.mcp_timeout` 和 `mcp.exa` 合并到现有 `opencode.json`。设置 `EXA_API_KEY` 后再启动 OpenCode。不要把真实 Key 留在 JSON、备份、日志或截图中。

### Grok

设置：

- `GROK_BASE_URL`：Responses 兼容服务地址。
- `GROK_API_KEY`：服务凭据。
- `GROK_SEARCH_MODEL`：可选的普通搜索模型覆盖。
- `GROK_DEEP_SEARCH_MODEL`：可选的深度搜索模型覆盖。

非本机 HTTP 端点必须使用 HTTPS；工具不跟随重定向，也不会在收到 `response.failed`、`response.incomplete` 或无明确终态时返回部分答案。

### 路由

将 [`../examples/AGENTS.search-routing.md`](../examples/AGENTS.search-routing.md) 合并到目标 `AGENTS.md`。它不应包含 API Key、完整本机配置、真实 Provider 名称或用户路径。

## 成本与隐私

- Exa 和 Grok 都会接收用户问题；`web_fetch_exa` 还会把目标页面内容交给服务端处理。
- Grok 深度搜索通常比普通搜索更耗时、更昂贵；不要把它当作默认搜索。
- 环境变量比源码硬编码好，但同一用户权限下的进程仍可能读取环境变量。
- 只把必要的查询发送给可信服务，不要发送凭据、私密文档或未脱敏内部资料。

## 验证与排错

1. `opencode mcp list` 应显示 `exa` 已启用。
2. 工具列表应包含 `web_search_exa`、`web_fetch_exa`、`grok_search` 和 `grok_deep_search`。
3. 用一个公开官方 URL 验证 Exa 搜索和正文读取。
4. 用一个需要来源比较的问题验证 Grok 普通搜索。
5. 仅在冲突或明确深度调查时验证 Grok 深度搜索。

如果 Exa 可连接但工具名或字段变化，以当前 OpenCode MCP 工具列表为准；如果 Grok 失败，先检查环境变量、Responses 路径、模型名和服务商能力，不要把 Exa 的问题误判成 Grok 的问题。
