# 协议与安全说明

## 请求协议

工具向 `GROK_BASE_URL` 对应的 Responses 端点发送 `POST` 请求：

```json
{
  "model": "configured-model",
  "instructions": "research instructions",
  "input": "user query",
  "tools": [{ "type": "web_search" }],
  "stream": true
}
```

只有调用参数 `include_x=true` 时，才会加入 `{ "type": "x_search" }`。

端点拼接规则：

- 完整路径以 `/responses` 结尾时直接使用；
- 地址以 `/v1` 结尾时追加 `/responses`；
- 其他地址追加 `/v1/responses`。

地址不得包含用户名、密码、查询参数或片段。非本机地址必须使用 HTTPS；HTTP 只允许 `localhost`、`127.0.0.1` 和 `::1`。

## 响应协议

实现接受两种响应：

- `text/event-stream`：按 SSE 帧解析一个或多个 `data:` 行，支持任意网络分块和 CRLF。
- `application/json` 或 `+json`：解析完整的非流式 Response。

流式响应仅在收到 `response.completed` 后成功。以下情况均直接失败，不返回已经累积的部分文本：

- `response.failed`；
- `response.incomplete`；
- `error` 或 `response.error`；
- 流结束但没有明确终态；
- SSE 中出现无法解析的 JSON 数据；
- 完成响应中没有文本输出。

最终答案优先取 `response.completed` 中的完整 `output_text`。只有完成事件没有携带完整文本时，才回退到 `response.output_text.done` 或已接收的 delta。

## 重定向与内容类型

请求使用 `redirect: "error"`，不会把 Authorization 请求头带到重定向目标。需要重定向的 API 地址应改成最终地址。

成功响应必须声明 SSE 或 JSON Content-Type。HTML、纯文本和缺少 Content-Type 的 200 响应会被拒绝，避免把代理登录页或网关错误页误当成模型输出。

HTTP 错误正文会经过以下处理后再显示：

- 删除控制字符并压缩空白；
- 隐去当前 API Key 和 Bearer 凭证形态；
- 最多读取 4 KiB，随后取消剩余响应体；
- 限制最大长度。

## 密钥与隐私

- 工具只从 `GROK_API_KEY` 读取密钥，不提供源码内默认值。
- 不要提交 `.env`、Shell 历史、调试日志或包含真实 Key 的截图。
- 环境变量并不是专用密钥保险库。同一用户权限下的其他进程可能有能力读取它。
- API 服务可以看到用户查询、系统指令、搜索请求和生成结果。不要通过不可信中转发送隐私数据、内部资料或凭证。
- 工具元数据只返回模型名、token 数和搜索调用次数，不主动记录 API Key 或 Base URL。

## 模型与成本

普通搜索和深度搜索使用不同模型，超时分别为 180 秒和 240 秒。深度搜索可能执行更多服务端搜索，耗时和费用通常更高。

默认模型名是一次已验证部署的映射，并非稳定 API 契约。公开端点可能改名、下架模型或不支持 X 搜索，因此提供了两个模型覆盖变量：

- `GROK_SEARCH_MODEL`
- `GROK_DEEP_SEARCH_MODEL`

使用前应查看服务商当前文档、价格和数据保留政策。

## 回滚

本方案不要求修改 `opencode.json`。回滚时删除安装到 `.opencode/tools/` 或全局工具目录的 `grok.ts`，移除四个可选/必需环境变量并重启 OpenCode 即可。
