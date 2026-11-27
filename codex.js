import { ProviderFailure, upstreamError } from "./errors.js"

const official = "https://api.openai.com/v1/responses"
const legacy = "https://chatgpt.com/backend-api/codex/responses"
const defaultChatModel = "gpt-6.2-sol"
const legacyMethods = new Set(["chatgpt-browser", "chatgpt-headless"])
const usableKey = key => typeof key === "string" && key.trim() && !key.trim().startsWith("{env:")

export function codexUnsupported(params, mask) {
  if (mask || params.output_format !== "png" || params.background !== "auto" || !["auto", "low", "medium", "high"].includes(params.quality))
    return "Codex 通道支持无蒙版、自动背景的 PNG，质量为 auto/low/medium/high；本次参数交给下一家。"
}

async function codexConnection(candidate, sessionID) {
  const { settings, resolveCredential } = candidate
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" }
  let endpoint = official, access
  if (settings.key !== undefined) {
    let url
    try { url = new URL(settings.base_url ?? official) } catch { throw new ProviderFailure("Codex base_url 无效。") }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
      throw new ProviderFailure("Codex base_url 必须为不含凭据、查询参数或片段的 HTTP(S) 地址。")
    const prefix = url.pathname.replace(/\/+$/, "")
    url.pathname = prefix.endsWith("/responses") ? prefix : `${prefix}/responses`
    endpoint = url.href
    access = settings.key
  } else {
    const cred = await resolveCredential()
    if (cred?.type === "key") access = cred.key
    else if (cred?.type === "oauth" && (legacyMethods.has(cred.methodID) || cred.methodID === "chatgpt-token-sharing")) {
      if (typeof cred.expires === "number" && cred.expires <= Date.now()) throw new ProviderFailure("Codex 登录凭据已过期。")
      access = cred.access
      headers["session-id"] = sessionID
      if (legacyMethods.has(cred.methodID)) {
        endpoint = legacy
        headers.originator = "opencode"
        if (typeof cred.metadata?.accountID === "string" && cred.metadata.accountID) headers["ChatGPT-Account-Id"] = cred.metadata.accountID
      } else {
        headers["thread-id"] = sessionID
        headers["x-client-request-id"] = sessionID
      }
    } else throw new ProviderFailure("不支持的 OpenAI 登录方式。")
  }
  if (!usableKey(access) || /[^\x21-\x7e]/.test(access.trim())) throw new ProviderFailure("Codex 凭据无效。", { disable: true })
  return { endpoint, headers: { ...headers, Authorization: `Bearer ${access.trim()}` } }
}

function failure(status, error) {
  if (["subscription_sharing_unsupported_capability", "subscription_sharing_route_not_supported",
    "subscription_sharing_user_not_eligible", "subscription_sharing_usage_limit_exceeded",
    "chatpass_v2_scope_not_authorized"].includes(error?.code))
    return new ProviderFailure(`Codex 账号不可用（${error.code}）。`, { disable: true })
  return upstreamError(status, error)
}

function result(event) {
  const response = event?.response ?? event
  if (event?.type === "error" || response?.error || ["failed", "incomplete", "cancelled"].includes(response?.status) ||
    ["response.failed", "response.incomplete"].includes(event?.type)) {
    const error = response?.error ?? (response?.incomplete_details ? { code: response.incomplete_details.reason } : event)
    throw failure(Number(error?.status) || 200, error)
  }
  const items = event?.type === "response.output_item.done" ? [event.item] : response?.output
  if (event?.type?.startsWith("response.refusal.") || (Array.isArray(items) && items.some(i => i?.content?.some?.(c => c?.type === "refusal"))))
    throw new ProviderFailure("Codex 拒绝了本次请求。", { fallback: false })
  if (Array.isArray(items)) return items.find(i => i?.type === "image_generation_call" && typeof i.result === "string" && i.result)?.result
}

// Some Codex gateways omit Content-Type. Accept both full Responses JSON and
// SSE, dispatching complete frames (not individual TCP chunks or partial images).
async function imageResult(response) {
  if (!response.body) throw new ProviderFailure("Codex 返回空响应。")
  const ct = response.headers.get("content-type") ?? ""
  let mode = ct.includes("text/event-stream") ? "sse" : ct.includes("application/json") ? "json" : null
  let pending = "", data = []
  const reader = response.body.getReader(), decoder = new TextDecoder()
  function line(value) {
    if (!value) {
      const text = data.join("\n")
      data = []
      if (text && text !== "[DONE]") return result(JSON.parse(text))
    } else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""))
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (!mode) {
        const prefix = pending.trimStart()
        if (prefix.startsWith("{") || prefix.startsWith("[")) mode = "json"
        else if (/^(?:(?:data|event|id|retry)(?::|\r?\n)|:)/.test(prefix)) { mode = "sse"; pending = prefix }
        else if (done || pending.length > 65536 || prefix.includes("\n")) break
        else continue
      }
      if (mode === "json") {
        if (!done) continue
        const image = result(JSON.parse(pending))
        if (image) return image
        break
      }
      let i
      while ((i = pending.indexOf("\n")) >= 0) {
        const image = line(pending.slice(0, i).replace(/\r$/, ""))
        pending = pending.slice(i + 1)
        if (image) return image
      }
      if (done) {
        const image = (pending && line(pending.replace(/\r$/, ""))) || line("")
        if (image) return image
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  throw new ProviderFailure("Codex 响应中没有 image_generation_call.result。")
}

// One hosted tool call produces one image. Yield each result before requesting
// the next, so a later failure cannot cause the paid batch to be regenerated.
export async function* codexOutputs({ candidate, sessionID, params, refs, signal }) {
  const { settings } = candidate
  const model = settings.model === undefined ? defaultChatModel : settings.model
  if (typeof model !== "string" || !model.trim()) throw new ProviderFailure("codex.model 必须是非空对话模型 ID。")
  const { endpoint, headers } = await codexConnection(candidate, sessionID)
  const content = [{ type: "input_text", text: params.prompt }, ...refs.map(ref => ({
    type: "input_image", image_url: `data:image/${ref.type};base64,${ref.bytes.toString("base64")}`,
  }))]
  const body = JSON.stringify({
    model: model.trim(), instructions: "Generate the requested image by invoking image_generation exactly once. Do not respond with text only.",
    input: [{ role: "user", content }],
    tools: [{ type: "image_generation", output_format: "png", quality: params.quality, size: params.size }],
    tool_choice: { type: "image_generation" }, stream: true, store: false,
    ...(settings.reasoning_effort !== undefined && { reasoning: { effort: settings.reasoning_effort } }),
    ...(settings.fast_mode && { service_tier: "priority" }),
  })
  for (let i = 0; i < params.n; i++) {
    let base64
    try {
      signal.throwIfAborted()
      const res = await fetch(endpoint, { method: "POST", body, headers, redirect: "error", signal })
      if (!res.ok) throw failure(res.status, (await res.json().catch(() => null))?.error)
      base64 = await imageResult(res)
    } catch (error) {
      if (error instanceof ProviderFailure) throw error
      throw new ProviderFailure(signal.aborted ? "Codex 请求超时或已中止。" : "Codex 请求或响应流异常。")
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) throw new ProviderFailure("Codex 返回无效的图片数据。")
    yield { b64_json: base64 }
  }
}
