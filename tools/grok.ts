import { tool } from "@opencode-ai/plugin"

type JsonObject = Record<string, unknown>

type GrokUsage = {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  server_side_tool_usage_details?: {
    web_search_calls?: number
    x_search_calls?: number
  }
}

type GrokRequest = {
  model: string
  query: string
  includeX: boolean
  instructions: string
  timeoutMs: number
  signal: AbortSignal
}

type StreamState = {
  deltaText: string
  doneText: string[]
  completedResponse?: JsonObject
  usage?: GrokUsage
  terminal?: "completed"
}

const DEFAULT_SEARCH_MODEL = "grok-4.3"
const DEFAULT_DEEP_SEARCH_MODEL = "grok-4.20-multi-agent-medium"
const MAX_ERROR_BODY_BYTES = 4096
const MAX_ERROR_DETAILS = 600

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nestedObject(value: JsonObject, key: string) {
  const nested = value[key]
  return isObject(nested) ? nested : undefined
}

function nestedString(value: JsonObject | undefined, key: string) {
  const nested = value?.[key]
  return typeof nested === "string" ? nested : undefined
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseUsage(value: unknown): GrokUsage | undefined {
  if (!isObject(value)) return undefined
  const toolUsage = nestedObject(value, "server_side_tool_usage_details")
  return {
    input_tokens: optionalNumber(value.input_tokens),
    output_tokens: optionalNumber(value.output_tokens),
    total_tokens: optionalNumber(value.total_tokens),
    server_side_tool_usage_details: toolUsage
      ? {
          web_search_calls: optionalNumber(toolUsage.web_search_calls),
          x_search_calls: optionalNumber(toolUsage.x_search_calls),
        }
      : undefined,
  }
}

function cleanErrorDetails(value: string, apiKey: string) {
  let cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")

  if (apiKey) cleaned = cleaned.split(apiKey).join("[REDACTED]")
  cleaned = cleaned.replace(/\s+/g, " ").trim()
  return cleaned.slice(0, MAX_ERROR_DETAILS)
}

async function readLimitedErrorBody(response: Response) {
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let consumed = 0
  let result = ""

  while (consumed < MAX_ERROR_BODY_BYTES) {
    const { done, value } = await reader.read()
    if (done) break

    const remaining = MAX_ERROR_BODY_BYTES - consumed
    const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
    consumed += chunk.byteLength
    result += decoder.decode(chunk, { stream: consumed < MAX_ERROR_BODY_BYTES })

    if (consumed >= MAX_ERROR_BODY_BYTES) {
      await reader.cancel("error response body limit reached").catch(() => undefined)
      break
    }
  }

  result += decoder.decode()
  return result
}

function errorMessage(payload: JsonObject, fallback: string) {
  const response = nestedObject(payload, "response")
  const error = nestedObject(payload, "error") ?? nestedObject(response ?? {}, "error")
  const incomplete = nestedObject(payload, "incomplete_details") ?? nestedObject(response ?? {}, "incomplete_details")

  return (
    nestedString(error, "message") ??
    nestedString(payload, "message") ??
    nestedString(incomplete, "reason") ??
    fallback
  )
}

function configuredModel(name: string, fallback: string) {
  const value = process.env[name]?.trim()
  return value || fallback
}

function responsesEndpoint() {
  const configured = process.env.GROK_BASE_URL?.trim()
  if (!configured) throw new Error("缺少 GROK_BASE_URL 环境变量")

  let endpoint: URL
  try {
    endpoint = new URL(configured)
  } catch {
    throw new Error("GROK_BASE_URL 不是有效的绝对 URL")
  }

  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("GROK_BASE_URL 只允许 HTTP 或 HTTPS")
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("GROK_BASE_URL 不得包含用户名或密码")
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error("GROK_BASE_URL 不得包含查询参数或片段")
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
  if (endpoint.protocol === "http:" && !loopbackHosts.has(endpoint.hostname)) {
    throw new Error("非本机 GROK_BASE_URL 必须使用 HTTPS")
  }

  const basePath = endpoint.pathname.replace(/\/+$/, "")
  if (basePath.endsWith("/responses")) endpoint.pathname = basePath
  else if (basePath.endsWith("/v1")) endpoint.pathname = `${basePath}/responses`
  else endpoint.pathname = `${basePath}/v1/responses`

  return endpoint.toString()
}

function extractCompletedText(response: JsonObject | undefined) {
  const parts: string[] = []
  const output = response?.output
  if (!Array.isArray(output)) return ""

  for (const item of output) {
    if (!isObject(item) || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (isObject(content) && content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text)
      }
    }
  }
  return parts.join("")
}

function consumeEvent(payload: unknown, state: StreamState, apiKey: string) {
  if (!isObject(payload) || typeof payload.type !== "string") {
    throw new Error("Grok 返回了无效的流式事件")
  }

  switch (payload.type) {
    case "response.output_text.delta":
      if (typeof payload.delta === "string") state.deltaText += payload.delta
      return

    case "response.output_text.done":
      if (typeof payload.text === "string") state.doneText.push(payload.text)
      return

    case "response.completed": {
      const response = nestedObject(payload, "response")
      if (!response) throw new Error("response.completed 缺少完整响应")
      if (response.status !== undefined && response.status !== "completed") {
        throw new Error("response.completed 携带了不一致的响应状态")
      }
      state.completedResponse = response
      state.usage = parseUsage(response.usage)
      state.terminal = "completed"
      return
    }

    case "response.failed":
      throw new Error(`Grok 请求失败: ${cleanErrorDetails(errorMessage(payload, "未知错误"), apiKey)}`)

    case "response.incomplete":
      throw new Error(`Grok 请求未完成: ${cleanErrorDetails(errorMessage(payload, "上游返回 incomplete"), apiKey)}`)

    case "error":
    case "response.error":
      throw new Error(`Grok 流式错误: ${cleanErrorDetails(errorMessage(payload, "未知错误"), apiKey)}`)

    default:
      return
  }
}

function consumeSseFrame(frame: string, state: StreamState, apiKey: string) {
  const dataLines: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const value = line.slice(5)
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value)
  }

  if (!dataLines.length) return
  const data = dataLines.join("\n").trim()
  if (!data || data === "[DONE]") return

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    throw new Error("Grok 返回了无法解析的 SSE JSON 事件")
  }
  consumeEvent(payload, state, apiKey)
}

function finalizeResponse(state: StreamState) {
  if (state.terminal !== "completed") {
    throw new Error("Grok 响应流结束，但没有收到 response.completed 终态")
  }

  const completedText = extractCompletedText(state.completedResponse)
  const answer = completedText || state.doneText.join("") || state.deltaText
  if (!answer.trim()) throw new Error("Grok 请求完成，但没有返回文本答案")
  return { answer, usage: state.usage }
}

async function readSseResponse(response: Response, apiKey: string) {
  if (!response.body) throw new Error("Grok API 未返回响应流")

  const state: StreamState = { deltaText: "", doneText: [] }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.match(/\r?\n\r?\n/)
    while (boundary?.index !== undefined) {
      consumeSseFrame(buffer.slice(0, boundary.index), state, apiKey)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      boundary = buffer.match(/\r?\n\r?\n/)
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) consumeSseFrame(buffer, state, apiKey)
  return finalizeResponse(state)
}

async function readJsonResponse(response: Response, apiKey: string) {
  const raw = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error("Grok 返回了无法解析的 JSON 响应")
  }

  if (!isObject(payload)) throw new Error("Grok 返回了无效的 JSON 响应")

  if (typeof payload.type === "string") {
    const state: StreamState = { deltaText: "", doneText: [] }
    consumeEvent(payload, state, apiKey)
    return finalizeResponse(state)
  }

  const status = payload.status
  if (status === "failed") {
    throw new Error(`Grok 请求失败: ${cleanErrorDetails(errorMessage(payload, "未知错误"), apiKey)}`)
  }
  if (status === "incomplete") {
    throw new Error(`Grok 请求未完成: ${cleanErrorDetails(errorMessage(payload, "上游返回 incomplete"), apiKey)}`)
  }
  if (status !== "completed") {
    throw new Error("Grok JSON 响应没有 completed 终态")
  }

  const answer = extractCompletedText(payload)
  if (!answer.trim()) throw new Error("Grok 请求完成，但没有返回文本答案")
  return { answer, usage: parseUsage(payload.usage) }
}

async function runGrokSearch(request: GrokRequest) {
  const apiKey = process.env.GROK_API_KEY?.trim()
  if (!apiKey) throw new Error("缺少 GROK_API_KEY 环境变量")

  const controller = new AbortController()
  const abortFromSession = () => controller.abort(request.signal.reason)
  if (request.signal.aborted) abortFromSession()
  else request.signal.addEventListener("abort", abortFromSession, { once: true })

  const timeout = setTimeout(
    () => controller.abort(new Error(`Grok 请求超过 ${request.timeoutMs / 1000} 秒`)),
    request.timeoutMs,
  )

  try {
    const searchTools: Array<{ type: "web_search" | "x_search" }> = [{ type: "web_search" }]
    if (request.includeX) searchTools.push({ type: "x_search" })

    const response = await fetch(responsesEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({
        model: request.model,
        instructions: request.instructions,
        input: request.query,
        tools: searchTools,
        stream: true,
      }),
      redirect: "error",
      signal: controller.signal,
    })

    if (!response.ok) {
      const details = cleanErrorDetails(await readLimitedErrorBody(response), apiKey)
      throw new Error(`Grok API 返回 HTTP ${response.status}${details ? `: ${details}` : ""}`)
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
    if (contentType === "text/event-stream") return await readSseResponse(response, apiKey)
    if (contentType === "application/json" || contentType?.endsWith("+json")) {
      return await readJsonResponse(response, apiKey)
    }
    throw new Error(`Grok API 返回了不支持的响应 Content-Type: ${contentType || "缺失"}`)
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw new Error(reason instanceof Error ? reason.message : "Grok 请求已取消")
    }
    throw error
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener("abort", abortFromSession)
  }
}

const includeXArgument = tool.schema
  .boolean()
  .default(false)
  .describe("是否同时搜索 X。仅在问题明确涉及 X 帖子、舆情或实时讨论时启用。")

export const search = tool({
  description:
    "使用 Grok 进行常规开放式联网搜索并综合回答。适合边搜索边解释的问题；查找明确网页、文档或结构化数据时应优先使用对应的定位工具。",
  args: {
    query: tool.schema.string().min(2).max(12000).describe("需要联网搜索并回答的问题"),
    include_x: includeXArgument,
  },
  async execute(args, context) {
    const model = configuredModel("GROK_SEARCH_MODEL", DEFAULT_SEARCH_MODEL)
    context.metadata({ title: "Grok 联网搜索", metadata: { model } })
    const result = await runGrokSearch({
      model,
      query: args.query,
      includeX: args.include_x,
      timeoutMs: 180_000,
      signal: context.abort,
      instructions:
        "你是严谨的联网研究助手。使用搜索工具查找最新且可访问的来源，优先官方资料和一手来源。证据充分后停止搜索，用与用户相同的语言简洁回答；明确区分事实、推断和社区观点，并为关键结论提供可点击的来源链接。不要编造来源。",
    })

    return {
      title: "Grok 搜索结果",
      output: result.answer,
      metadata: {
        model,
        total_tokens: result.usage?.total_tokens,
        web_search_calls: result.usage?.server_side_tool_usage_details?.web_search_calls,
        x_search_calls: result.usage?.server_side_tool_usage_details?.x_search_calls,
      },
    }
  },
})

export const deep_search = tool({
  description:
    "使用 Grok 进行复杂的多来源研究。仅在来源冲突、需要广泛交叉验证或用户明确要求深入调查时使用；简单问题不要调用。",
  args: {
    query: tool.schema.string().min(2).max(12000).describe("需要深入、多来源调查的问题"),
    include_x: includeXArgument,
  },
  async execute(args, context) {
    const model = configuredModel("GROK_DEEP_SEARCH_MODEL", DEFAULT_DEEP_SEARCH_MODEL)
    context.metadata({ title: "Grok 深度搜索", metadata: { model } })
    const result = await runGrokSearch({
      model,
      query: args.query,
      includeX: args.include_x,
      timeoutMs: 240_000,
      signal: context.abort,
      instructions:
        "你是严谨的多来源研究助手。围绕问题进行充分但不过度的网页调查，优先官方资料和一手来源，交叉核验有争议的说法。用与用户相同的语言给出结构清晰的结论，区分事实、推断和社区观点，并为关键结论提供可点击的来源链接。不要编造来源。",
    })

    return {
      title: "Grok 深度搜索结果",
      output: result.answer,
      metadata: {
        model,
        total_tokens: result.usage?.total_tokens,
        web_search_calls: result.usage?.server_side_tool_usage_details?.web_search_calls,
        x_search_calls: result.usage?.server_side_tool_usage_details?.x_search_calls,
      },
    }
  },
})
