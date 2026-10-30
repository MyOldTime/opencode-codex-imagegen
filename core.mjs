import { readFile, mkdir, open, unlink } from "node:fs/promises"
import path from "node:path"

// OpenAI Responses endpoints. Image generation always uses the hosted `image_generation`
// tool on a Responses request, never the Images API.
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"

// OAuth sign-in methods that this plugin knows how to route. Anything else is rejected
// instead of guessing an endpoint.
export const SUPPORTED_OAUTH_METHODS = ["chatgpt-token-sharing", "chatgpt-browser", "chatgpt-headless"]
const LEGACY_METHODS = new Set(["chatgpt-browser", "chatgpt-headless"])

// Only these upstream codes may appear in an error message. Everything else is reported
// as a generic upstream failure so account data never leaks.
const SAFE_ERROR_CODES = new Set([
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
])

const DEFAULT_MODEL = "gpt-6.1-sol"
const DEFAULT_TIMEOUT_MS = 240000
const INSTRUCTIONS = "Generate the requested image by invoking image_generation exactly once. Do not respond with text only."

const OMIT_HINT = "omit options.base_url and options.key entirely to use the OpenAI account signed in to OpenCode"

export function pluginConfig(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error("Plugin options must be an object")
  // Presence is explicit: an empty, null, blank or unresolved value is a configuration error,
  // never a silent fallback. Only a fully omitted pair uses the host-managed account.
  const hasBase = options.base_url !== undefined
  const hasKey = options.key !== undefined
  if (hasBase && (typeof options.base_url !== "string" || !options.base_url.trim())) {
    throw new Error(`options.base_url must be a non-empty string; ${OMIT_HINT}`)
  }
  if (hasKey && (typeof options.key !== "string" || !options.key.trim())) {
    throw new Error(`options.key must be a non-empty string; ${OMIT_HINT}`)
  }
  const baseURL = hasBase ? options.base_url.trim() : ""
  const apiKey = hasKey ? options.key.trim() : ""
  if (apiKey.startsWith("{env:")) {
    throw new Error("options.key contains an unresolved environment substitution; load the variable into the OpenCode environment configuration (or the current session) and try again, or omit key to use the signed-in OpenAI account")
  }
  if (hasBase && !hasKey) {
    throw new Error("options.base_url requires options.key; configure both or omit both to use the signed-in OpenAI account")
  }
  const model = options.model ?? DEFAULT_MODEL
  if (typeof model !== "string" || !model.trim()) throw new Error("model must be a nonempty string")
  if (options.reasoning_effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(options.reasoning_effort)) {
    throw new Error("reasoning_effort must be none, minimal, low, medium, high or xhigh (model support varies)")
  }
  if (options.fast_mode !== undefined && typeof options.fast_mode !== "boolean") throw new Error("fast_mode must be boolean")
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeout_ms must be a positive integer")
  // key only: fall back to the public OpenAI endpoint. Both present: explicit proxy. Neither: host-managed.
  const explicit = Boolean(apiKey)
  const explicitBase = explicit ? baseURL || DEFAULT_OPENAI_BASE_URL : undefined
  // Fail on a malformed proxy URL before any session, permission or network work happens.
  if (explicitBase) responsesURL(explicitBase)
  return {
    mode: explicit ? "explicit" : "managed",
    baseURL: explicitBase,
    apiKey: explicit ? apiKey : undefined,
    model: model.trim(),
    reasoningEffort: options.reasoning_effort,
    fastMode: options.fast_mode ?? false,
    timeoutMs,
  }
}

export function responsesURL(baseURL) {
  const url = new URL(baseURL)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("baseURL must be an HTTP(S) URL without credentials, query or fragment")
  }
  url.pathname = url.pathname.replace(/\/+$/, "")
  if (!url.pathname.endsWith("/responses")) url.pathname += "/responses"
  return url.toString()
}

export function abortError() {
  const error = new Error("Image generation aborted")
  error.name = "AbortError"
  return error
}

// Messages that this plugin produced itself and may be shown verbatim.
class ImageResponseError extends Error {}

export function timeoutError() {
  return new Error("Image request timed out")
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw abortError()
}

function throwIfSettled(signal, combinedSignal) {
  if (signal?.aborted) throw abortError()
  if (combinedSignal?.aborted) throw timeoutError()
}

function connectionError(detail) {
  return new Error(`${detail} Configure options.base_url and options.key to use a proxy instead.`)
}

// Resolves the request route for this call. Explicit options never touch the host credential
// API; managed mode re-resolves the connection on every call so OpenCode owns refresh.
export async function resolveRoute(config, ctx) {
  if (config.mode === "explicit") {
    return { route: "proxy", method: "options", url: responsesURL(config.baseURL), access: config.apiKey }
  }
  const integration = ctx?.integration?.connection
  if (!integration || typeof integration.active !== "function" || typeof integration.resolve !== "function") {
    throw connectionError("OpenCode did not expose an OpenAI connection to this plugin.")
  }
  let connection
  try {
    connection = await integration.active("openai")
  } catch {
    throw connectionError("OpenCode could not read the OpenAI connection.")
  }
  if (!connection) {
    throw connectionError("No OpenAI account is connected in OpenCode. Sign in from OpenCode (Sign in with ChatGPT) or configure options.base_url and options.key.")
  }
  let credential
  try {
    credential = await integration.resolve(connection)
  } catch {
    throw connectionError("OpenCode could not provide a usable OpenAI credential; the sign-in may have expired or need attention. Sign in again.")
  }
  if (!credential || typeof credential !== "object") {
    throw connectionError("OpenCode returned no OpenAI credential for the connected account. Sign in again.")
  }
  if (credential.type === "key") {
    if (typeof credential.key !== "string" || !credential.key.trim()) {
      throw connectionError("The OpenAI connection returned an empty API key.")
    }
    return { route: "openai-key", method: "api-key", url: OPENAI_RESPONSES_URL, access: credential.key.trim() }
  }
  if (credential.type !== "oauth") {
    throw connectionError("The OpenAI connection returned an unsupported credential type.")
  }
  const methodID = credential.methodID
  if (!SUPPORTED_OAUTH_METHODS.includes(methodID)) {
    // Never echo the raw method value: it may carry arbitrary credential data.
    throw connectionError(`Unsupported OpenAI sign-in method. Supported methods: ${SUPPORTED_OAUTH_METHODS.join(", ")}.`)
  }
  if (typeof credential.access !== "string" || !credential.access.trim()) {
    throw connectionError("OpenCode returned an empty or expired OpenAI access token. Sign in again.")
  }
  if (typeof credential.expires === "number" && credential.expires <= Date.now()) {
    throw connectionError("The OpenAI access token has expired and could not be refreshed. Sign in again.")
  }
  const access = credential.access.trim()
  if (LEGACY_METHODS.has(methodID)) {
    const accountID = credential.metadata?.accountID
    return {
      route: methodID,
      method: methodID,
      url: CODEX_RESPONSES_URL,
      access,
      accountID: typeof accountID === "string" && accountID ? accountID : undefined,
    }
  }
  return { route: "chatgpt-token-sharing", method: methodID, url: OPENAI_RESPONSES_URL, access }
}

export function requestHeaders(route, sessionID) {
  const headers = {
    Authorization: `Bearer ${route.access}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  }
  if (LEGACY_METHODS.has(route.route)) {
    headers.originator = "opencode"
    if (route.accountID) headers["ChatGPT-Account-Id"] = route.accountID
  }
  if (route.route !== "proxy" && route.route !== "openai-key" && typeof sessionID === "string" && sessionID) {
    headers["session-id"] = sessionID
    if (route.route === "chatgpt-token-sharing") {
      headers["thread-id"] = sessionID
      headers["x-client-request-id"] = sessionID
    }
  }
  return headers
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif"
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp"
  throw new Error("Unsupported reference image: use PNG, JPEG, GIF or WebP")
}

export function validateInput(input) {
  if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("prompt is required")
  if (typeof input.out !== "string" || !input.out.trim() || path.extname(input.out).toLowerCase() !== ".png") {
    throw new Error("out must be a .png file path")
  }
  if (input.quality !== undefined && !["auto", "low", "medium", "high"].includes(input.quality)) throw new Error("Invalid quality")
  if (input.images !== undefined && (!Array.isArray(input.images) || input.images.some(p => typeof p !== "string"))) throw new Error("images must be file paths")
  if (input.size !== undefined && input.size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(input.size)
    const w = Number(match?.[1]), h = Number(match?.[2])
    if (!match || !w || !h || w % 16 || h % 16 || Math.max(w, h) > 3840 || Math.max(w, h) / Math.min(w, h) > 3 || w * h < 655360 || w * h > 8294400) {
      throw new Error("size must be auto or WIDTHxHEIGHT (16px multiples, max edge 3840, aspect <= 3:1, pixels 655360–8294400)")
    }
  }
}

function safeCode(value) {
  return typeof value === "string" && SAFE_ERROR_CODES.has(value) ? value : undefined
}

function safeCodeFrom(payload) {
  return safeCode(payload?.error?.code) ?? safeCode(payload?.response?.error?.code)
}

function resultFromEvent(event) {
  if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
    const code = safeCodeFrom(event)
    throw new ImageResponseError(`Image response failed${code ? ` (${code})` : ""}`)
  }
  if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call" && event.item.result) return event.item.result
  return event.response?.output?.find(item => item.type === "image_generation_call" && item.result)?.result
}

export function parseEvent(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new ImageResponseError("Image response contained invalid JSON")
  }
}

async function httpError(response, { signal, combinedSignal } = {}) {
  let text = ""
  try {
    text = await response.text()
  } catch {
    text = ""
  }
  throwIfSettled(signal, combinedSignal)
  let payload
  try {
    payload = text ? JSON.parse(text) : undefined
  } catch {
    payload = undefined
  }
  const code = safeCodeFrom(payload)
  return new ImageResponseError(`Image request failed: HTTP ${response.status}${code ? ` (${code})` : ""}`)
}

// SSE frames may be split anywhere, including inside UTF-8 characters and CRLF.
export async function readImageResponse(response) {
  if (!response.body) throw new ImageResponseError("Empty image response")
  // Some Codex gateways return valid SSE without a Content-Type header. Detect
  // the wire format from a bounded prefix instead of mistaking that stream for JSON.
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  let format = contentType.includes("text/event-stream") ? "sse" : contentType.includes("application/json") ? "json" : "detect"
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = "", data = []
  const dispatch = () => {
    const text = data.join("\n")
    data = []
    if (!text || text === "[DONE]") return
    return resultFromEvent(parseEvent(text))
  }
  const line = text => {
    if (!text) return dispatch()
    if (text === "data") data.push("")
    else if (text.startsWith("data:")) data.push(text.slice(5).replace(/^ /, ""))
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (format === "detect") {
        const prefix = pending.trimStart()
        if (/^[\[{]/.test(prefix)) format = "json"
        else if (/^(?:(?:data|event|id|retry)(?::|\r?\n)|:)/.test(prefix)) {
          format = "sse"
          pending = prefix
        } else if (done || pending.length > 65536 || prefix.includes("\n")) {
          throw new ImageResponseError("Image response contained invalid JSON or SSE")
        } else continue
      }
      if (format === "json") {
        if (!done) continue
        const result = resultFromEvent({ type: "response.completed", response: parseEvent(pending) })
        if (!result) throw new ImageResponseError("No image_generation_call.result in JSON response")
        return result
      }
      let index
      while ((index = pending.indexOf("\n")) !== -1) {
        const text = pending.slice(0, index).replace(/\r$/, "")
        pending = pending.slice(index + 1)
        const result = line(text)
        if (result) return result
      }
      if (done) {
        if (pending) line(pending.replace(/\r$/, ""))
        const result = dispatch()
        if (result) return result
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  throw new ImageResponseError("Response ended without an image_generation_call.result")
}

export async function savePNG(out, directory, base64, signal) {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) throw new Error("Invalid image base64")
  const bytes = Buffer.from(base64, "base64")
  if (imageType(bytes) !== "image/png") throw new Error("Backend did not return PNG")
  abortIfNeeded(signal)
  const target = path.resolve(directory, out)
  await mkdir(path.dirname(target), { recursive: true })
  const stem = target.slice(0, -4)
  for (let version = 1; ; version++) {
    const file = version === 1 ? target : `${stem}-v${version}.png`
    let handle
    try { handle = await open(file, "wx") } catch (error) {
      if (error.code === "EEXIST") continue
      throw error
    }
    // Only files created by this call (open "wx") are ever removed; pre-existing files stay untouched.
    let stillOpen = true
    try {
      await handle.writeFile(bytes)
      await handle.close()
      stillOpen = false
    } catch (error) {
      if (stillOpen) await handle.close().catch(() => {})
      await unlink(file).catch(() => {})
      throw error
    }
    if (signal?.aborted) {
      // Cancelled while persisting: remove the file we just created, never a pre-existing one.
      await unlink(file).catch(() => {})
      throw abortError()
    }
    return { out: file, versioned: version > 1, bytes: bytes.length }
  }
}

export async function generateImage(input, config, directory, env = {}) {
  const { ctx, signal, sessionID, fetcher = fetch } = env
  validateInput(input)
  abortIfNeeded(signal)
  // Credentials are resolved per call; explicit options never consult the host.
  const route = await resolveRoute(config, ctx)
  abortIfNeeded(signal)
  const content = [{ type: "input_text", text: input.prompt }]
  for (const file of input.images ?? []) {
    const bytes = await readFile(path.resolve(directory, file), { signal })
    content.push({ type: "input_image", image_url: `data:${imageType(bytes)};base64,${bytes.toString("base64")}` })
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer")
  const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  abortIfNeeded(signal)
  let response
  try {
    response = await fetcher(route.url, {
      method: "POST",
      signal: combinedSignal,
      redirect: "error",
      headers: requestHeaders(route, sessionID),
      body: JSON.stringify({
        model: config.model,
        instructions: INSTRUCTIONS,
        input: [{ role: "user", content }],
        tools: [{ type: "image_generation", output_format: "png", quality: input.quality ?? "auto", ...(input.size ? { size: input.size } : {}) }],
        tool_choice: { type: "image_generation" },
        stream: true,
        store: false,
        ...(config.reasoningEffort !== undefined ? { reasoning: { effort: config.reasoningEffort } } : {}),
        ...(config.fastMode ? { service_tier: "priority" } : {}),
      }),
    })
  } catch {
    if (signal?.aborted) throw abortError()
    if (combinedSignal.aborted) throw timeoutError()
    throw new Error("Image request failed before a response was received")
  }
  // A fetcher may resolve after the deadline or after cancellation; discard that late result.
  if (signal?.aborted || combinedSignal.aborted) {
    await response?.body?.cancel().catch(() => {})
    throwIfSettled(signal, combinedSignal)
  }
  if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
    throw new Error("Image request failed before a response was received")
  }
  if (!response.ok) throw await httpError(response, { signal, combinedSignal })
  let base64
  try {
    base64 = await readImageResponse(response)
  } catch (error) {
    // Our own messages pass through; every transport/stream failure is normalized.
    if (error instanceof ImageResponseError) throw error
    throwIfSettled(signal, combinedSignal)
    throw new Error("Image response stream failed")
  }
  throwIfSettled(signal, combinedSignal)
  const saved = await savePNG(input.out, directory, base64, combinedSignal)
  return { ...saved, route: route.route, method: route.method, model: config.model }
}
