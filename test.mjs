import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CODEX_RESPONSES_URL,
  OPENAI_RESPONSES_URL,
  generateImage,
  pluginConfig,
  readImageResponse,
  requestHeaders,
  resolveRoute,
  responsesURL,
  savePNG,
  validateInput,
} from "./core.mjs"
import plugin from "./index.js"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
const event = { type: "response.output_item.done", item: { type: "image_generation_call", result: png } }

function sse(text, chunk = 7) {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) return controller.close()
    controller.enqueue(bytes.slice(offset, offset += chunk))
  } }), { headers: { "content-type": "text/event-stream" } })
}

function okStream() {
  return sse("data: " + JSON.stringify(event) + "\n\n")
}

async function temporary(fn) {
  const roots = [process.env.OPENCODE_TEST_TMP, "Z:/windows-tmp/opencode"].filter(Boolean)
  let root = tmpdir()
  for (const candidate of roots) {
    try { await access(candidate); root = candidate; break } catch {}
  }
  const directory = await mkdtemp(path.join(root, "codex-proxy-imagegen-test-"))
  try { await fn(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

function fakeCtx({ credential, connection = { type: "credential", id: "cred-1", label: "OpenAI", method: "oauth" }, calls = [] } = {}) {
  return {
    calls,
    integration: {
      connection: {
        async active(id) { calls.push(["active", id]); return connection },
        async resolve(value) { calls.push(["resolve", value]); if (credential instanceof Error) throw credential; return credential },
      },
    },
  }
}

const tokenSharing = { type: "oauth", methodID: "chatgpt-token-sharing", access: "sharing-token", refresh: "r", expires: Date.now() + 3600_000, metadata: { clientID: "client" } }
const browser = { type: "oauth", methodID: "chatgpt-browser", access: "browser-token", refresh: "r", expires: Date.now() + 3600_000, metadata: { accountID: "acct-browser" } }
const headless = { type: "oauth", methodID: "chatgpt-headless", access: "device-token", refresh: "r", expires: Date.now() + 3600_000, metadata: {} }
const managedKey = { type: "key", key: "managed-key" }

function capture(routes, config = pluginConfig({})) {
  const calls = []
  return {
    calls,
    fetcher: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body), headers: options.headers })
      routes?.push(url)
      return okStream()
    },
  }
}

test("URL normalization preserves configured path", () => {
  assert.equal(responsesURL("https://example.com/v1/"), "https://example.com/v1/responses")
  assert.equal(responsesURL("https://example.com/backend-api/codex/responses"), "https://example.com/backend-api/codex/responses")
  assert.throws(() => responsesURL("https://user:pass@example.com/v1"))
  assert.throws(() => responsesURL("ftp://example.com/v1"))
})

test("input validation happens before network", () => {
  assert.throws(() => validateInput({ prompt: "", out: "a.png" }))
  assert.throws(() => validateInput({ prompt: "x", out: "a.jpg" }))
  assert.throws(() => validateInput({ prompt: "x", out: "a.png", size: "12x12" }))
  validateInput({ prompt: "x", out: "a.png", size: "1024x1024" })
})

test("partial or unresolved options fail loudly", () => {
  for (const options of [
    { base_url: "https://example.com/v1" },
    { base_url: "https://example.com/v1", key: "" },
    { base_url: "https://example.com/v1", key: "   " },
    { base_url: "https://example.com/v1", key: null },
    { base_url: "", key: "FAKE-KEY" },
    { base_url: "  ", key: "FAKE-KEY" },
    { base_url: null, key: "FAKE-KEY" },
    { base_url: 42, key: "k" },
    { base_url: "ftp://example.com/v1", key: "k" },
    { key: "" },
    { key: "   " },
    { key: null },
    { key: 42 },
    { key: "{env:MISSING}" },
  ]) {
    assert.throws(() => pluginConfig(options), Error, `expected rejection for ${JSON.stringify(options)}`)
  }
  assert.throws(() => pluginConfig({ base_url: "https://example.com/v1", key: "  " }), /non-empty/)
  assert.throws(() => pluginConfig({ base_url: "https://example.com/v1", key: "  " }), /omit options\.base_url/)
  assert.throws(() => pluginConfig({ key: "{env:MISSING}" }), /unresolved environment substitution/)
  assert.throws(() => pluginConfig({ key: "k", fast_mode: "true" }), /boolean/)
  assert.throws(() => pluginConfig({ key: "k", reasoning_effort: "ultra" }), /reasoning_effort/)
  assert.throws(() => pluginConfig({ key: "k", timeout_ms: 0 }), /positive integer/)
  assert.throws(() => pluginConfig({ base_url: "ftp://example.com/v1", key: "k" }), /HTTP\(S\)/)
  // Only a fully omitted pair is host-managed.
  const keyOnly = pluginConfig({ key: "k" })
  assert.equal(keyOnly.mode, "explicit")
  assert.equal(keyOnly.baseURL, "https://api.openai.com/v1")
  const managed = pluginConfig({})
  assert.equal(managed.mode, "managed")
  assert.equal(managed.baseURL, undefined)
  assert.equal(pluginConfig(undefined).mode, "managed")
})

test("explicit options win and never touch the integration API", () => temporary(async directory => {
  const ctx = {
    integration: {
      get connection() { throw new Error("integration must not be read") },
    },
  }
  const seen = capture()
  const config = pluginConfig({ base_url: "https://proxy.example/v1/", key: "proxy-key" })
  const result = await generateImage({ prompt: "x", out: "out.png" }, config, directory, { ctx, fetcher: seen.fetcher })
  assert.equal(seen.calls[0].url, "https://proxy.example/v1/responses")
  assert.equal(seen.calls[0].headers.Authorization, "Bearer proxy-key")
  assert.equal(seen.calls[0].headers["session-id"], undefined)
  assert.equal(result.route, "proxy")
  assert.equal(result.method, "options")
}))

test("key-only options use the public OpenAI endpoint", () => temporary(async directory => {
  const seen = capture()
  const config = pluginConfig({ key: "only-key" })
  await generateImage({ prompt: "x", out: "out.png" }, config, directory, { ctx: undefined, fetcher: seen.fetcher })
  assert.equal(seen.calls[0].url, OPENAI_RESPONSES_URL)
  assert.equal(seen.calls[0].headers.Authorization, "Bearer only-key")
}))

test("token-sharing route uses Responses API with session headers", () => temporary(async directory => {
  const ctx = fakeCtx({ credential: tokenSharing })
  const seen = capture()
  const result = await generateImage({ prompt: "draw", out: "out.png", quality: "high", size: "1024x1024" }, pluginConfig({}), directory, { ctx, sessionID: "ses_1", fetcher: seen.fetcher })
  const call = seen.calls[0]
  assert.equal(call.url, "https://api.openai.com/v1/responses")
  assert.equal(call.headers.Authorization, "Bearer sharing-token")
  assert.equal(call.headers["session-id"], "ses_1")
  assert.equal(call.headers["thread-id"], "ses_1")
  assert.equal(call.headers["x-client-request-id"], "ses_1")
  assert.equal(call.headers.originator, undefined)
  assert.equal(call.headers["ChatGPT-Account-Id"], undefined)
  assert.equal(call.body.model, "gpt-6.1-sol")
  assert.equal(call.body.stream, true)
  assert.equal(call.body.store, false)
  assert.deepEqual(call.body.tool_choice, { type: "image_generation" })
  assert.deepEqual(call.body.tools, [{ type: "image_generation", output_format: "png", quality: "high", size: "1024x1024" }])
  assert.match(call.body.instructions, /image_generation/)
  assert.equal(result.route, "chatgpt-token-sharing")
  assert.equal(result.method, "chatgpt-token-sharing")
}))

test("legacy browser and device-code routes use the Codex endpoint", () => temporary(async directory => {
  for (const [credential, route] of [[browser, "chatgpt-browser"], [headless, "chatgpt-headless"]]) {
    const ctx = fakeCtx({ credential })
    const seen = capture()
    const result = await generateImage({ prompt: "x", out: `${route}.png` }, pluginConfig({}), directory, { ctx, sessionID: "ses_2", fetcher: seen.fetcher })
    const call = seen.calls[0]
    assert.equal(call.url, CODEX_RESPONSES_URL)
    assert.equal(call.headers.Authorization, `Bearer ${credential.access}`)
    assert.equal(call.headers.originator, "opencode")
    assert.equal(call.headers["session-id"], "ses_2")
    assert.equal(call.headers["thread-id"], undefined)
    assert.equal(call.headers["x-client-request-id"], undefined)
    assert.equal(call.headers["ChatGPT-Account-Id"], credential.metadata.accountID)
    assert.equal(result.route, route)
  }
}))

test("managed API key uses the OpenAI endpoint without session headers", () => temporary(async directory => {
  const ctx = fakeCtx({ credential: managedKey })
  const seen = capture()
  const result = await generateImage({ prompt: "x", out: "key.png" }, pluginConfig({}), directory, { ctx, sessionID: "ses_3", fetcher: seen.fetcher })
  assert.equal(seen.calls[0].url, OPENAI_RESPONSES_URL)
  assert.equal(seen.calls[0].headers.Authorization, "Bearer managed-key")
  assert.equal(seen.calls[0].headers["session-id"], undefined)
  assert.equal(result.route, "openai-key")
}))

test("credentials are re-resolved on every call", () => temporary(async directory => {
  const ctx = fakeCtx({ credential: tokenSharing })
  const seen = capture()
  const config = pluginConfig({})
  await generateImage({ prompt: "x", out: "a.png" }, config, directory, { ctx, fetcher: seen.fetcher })
  await generateImage({ prompt: "x", out: "b.png" }, config, directory, { ctx, fetcher: seen.fetcher })
  assert.equal(ctx.calls.filter(call => call[0] === "resolve").length, 2)
  assert.equal(ctx.calls.filter(call => call[0] === "active").length, 2)
}))

test("missing, failing or unsupported connections fail safely", async () => {
  const config = pluginConfig({})
  await assert.rejects(resolveRoute(config, undefined), /did not expose an OpenAI connection/)
  await assert.rejects(resolveRoute(config, fakeCtx({ connection: null })), /No OpenAI account is connected/)
  await assert.rejects(resolveRoute(config, fakeCtx({ credential: new Error("upstream body with secret") })), error =>
    /could not provide a usable OpenAI credential/.test(error.message) && !error.message.includes("upstream body"))
  await assert.rejects(resolveRoute(config, fakeCtx({ credential: undefined })), /no OpenAI credential/)
  await assert.rejects(resolveRoute(config, fakeCtx({ credential: { type: "external", methodID: "x" } })), /unsupported credential type/)
  await assert.rejects(resolveRoute(config, fakeCtx({ credential: { ...tokenSharing, methodID: "chatgpt-unknown" } })), /Unsupported OpenAI sign-in method/)
  await assert.rejects(resolveRoute(config, fakeCtx({ credential: { ...tokenSharing, access: "" } })), /empty or expired/)
  await assert.rejects(resolveRoute(config, fakeCtx({ credential: { ...tokenSharing, expires: Date.now() - 1000 } })), /expired/)
  await assert.rejects(resolveRoute(config, fakeCtx({ credential: { type: "key", key: " " } })), /empty API key/)
})

test("no-store/no-retry: HTTP failures only expose status and whitelisted codes", () => temporary(async directory => {
  const args = [{ prompt: "x", out: "out.png" }, pluginConfig({ key: "k" }), directory]
  const secret = "sk-live-SECRET-body"
  await assert.rejects(
    generateImage(...args, { fetcher: async () => new Response(secret, { status: 401 }) }),
    error => error.message === "Image request failed: HTTP 401",
  )
  await assert.rejects(
    generateImage(...args, { fetcher: async () => new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", message: secret } }), { status: 403 }) }),
    error => error.message === "Image request failed: HTTP 403 (subscription_sharing_unsupported_capability)" && !error.message.includes(secret),
  )
  await assert.rejects(
    generateImage(...args, { fetcher: async () => new Response(JSON.stringify({ error: { code: "arbitrary_internal_code", message: secret } }), { status: 500 }) }),
    error => error.message === "Image request failed: HTTP 500",
  )
  let attempts = 0
  await assert.rejects(
    generateImage(...args, { fetcher: async () => { attempts++; return Response.json({ error: { code: "subscription_sharing_unsupported_capability", message: secret } }, { status: 400 }) } }),
    error => error.message === "Image request failed: HTTP 400 (subscription_sharing_unsupported_capability)",
  )
  assert.equal(attempts, 1)
}))

test("SSE errors, missing images and invalid JSON never leak payloads", async () => {
  const secret = "sk-live-SECRET-body"
  await assert.rejects(readImageResponse(sse(`data: {"type":"response.failed","response":{"error":{"code":"${secret}"}}}\n\n`)), error => error.message === "Image response failed")
  await assert.rejects(
    readImageResponse(sse('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_route_not_supported"}}}\n\n')),
    /subscription_sharing_route_not_supported/,
  )
  await assert.rejects(readImageResponse(sse("data: " + secret + "\n\n")), error => error.message === "Image response contained invalid JSON")
  await assert.rejects(readImageResponse(sse("data: [DONE]\n\n")), /without an image/)
  await assert.rejects(readImageResponse(Response.json({ output: [] })), /No image/)
  await assert.rejects(readImageResponse(Response.json({ broken: true })), /No image/)
  const badJson = new Response(secret, { headers: { "content-type": "application/json" } })
  await assert.rejects(readImageResponse(badJson), error => error.message === "Image response contained invalid JSON")
})

test("fragmented SSE, CRLF and multiline data", async () => {
  const text = ': keepalive\r\ndata: {"type":"response.created"}\r\n\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n'
  assert.equal(await readImageResponse(sse(text, 1)), png)
  assert.equal(await readImageResponse(sse('data: {"type":"response.output_item.done",\ndata: "item":' + JSON.stringify(event.item) + "}\n\n")), png)
  // Multi-byte characters split across chunks must survive.
  const unicode = 'data: {"type":"response.created","note":"水彩🦊"}\n\ndata: ' + JSON.stringify(event) + "\n\n"
  assert.equal(await readImageResponse(sse(unicode, 1)), png)
  // Completed-only SSE and plain JSON both resolve to the same image.
  assert.equal(await readImageResponse(sse("data: " + JSON.stringify({ type: "response.completed", response: { output: [event.item] } }) + "\n\n")), png)
  assert.equal(await readImageResponse(Response.json({ output: [event.item] })), png)
})

test("Codex SSE without Content-Type is detected across single-byte chunks", async () => {
  const text = '\n: keepalive\ndata: {"type":"response.created"}\n\ndata: ' + JSON.stringify(event) + '\n\n'
  for (const headers of [{}, { "content-type": "application/octet-stream" }, { "content-type": "text/plain" }]) {
    const stream = sse(text, 1)
    assert.equal(await readImageResponse(new Response(stream.body, { headers })), png)
  }
  assert.equal(await readImageResponse(new Response(JSON.stringify({ output: [event.item] }))), png)
  await assert.rejects(readImageResponse(new Response("<html>private error page</html>")), error =>
    /invalid JSON or SSE/.test(error.message) && !error.message.includes("private"))
})

test("reference images are inlined and PNGs are never overwritten", () => temporary(async directory => {
  await savePNG("reference.png", directory, png)
  const seen = capture()
  await generateImage({ prompt: "x", out: "out.png", images: ["reference.png"] }, pluginConfig({ key: "k" }), directory, { fetcher: seen.fetcher })
  assert.equal(seen.calls[0].body.input[0].content[1].image_url, `data:image/png;base64,${png}`)
  const results = await Promise.all([savePNG("image.png", directory, png), savePNG("image.png", directory, png)])
  assert.equal(new Set(results.map(item => item.out)).size, 2)
  assert.deepEqual(await readFile(path.join(directory, "image.png")).then(buffer => buffer.toString("base64")), png)
  await assert.rejects(savePNG("bad.png", directory, "bm90LWEtcG5n"), /PNG/)
}))

test("pre-cancel and cancel-during-resolve never reach the network or disk", async () => {
  let fetched = 0
  const fetcher = async () => { fetched++; return okStream() }
  await temporary(async directory => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      generateImage({ prompt: "x", out: "pre.png" }, pluginConfig({ key: "k" }), directory, { signal: controller.signal, fetcher }),
      { name: "AbortError" },
    )
    assert.equal(fetched, 0)
    assert.equal(await exists(path.join(directory, "pre.png")), false)
  })
  await temporary(async directory => {
    const controller = new AbortController()
    const ctx = fakeCtx({ credential: tokenSharing })
    const abortsOnResolve = {
      integration: { connection: {
        async active(id) { return ctx.integration.connection.active(id) },
        async resolve(connection) { controller.abort(); return ctx.integration.connection.resolve(connection) },
      } },
    }
    await assert.rejects(
      generateImage({ prompt: "x", out: "later.png" }, pluginConfig({}), directory, { ctx: abortsOnResolve, signal: controller.signal, fetcher }),
      { name: "AbortError" },
    )
    assert.equal(fetched, 0)
    assert.equal(await exists(path.join(directory, "later.png")), false)
  })
})

test("timeout aborts without writing a file", async () => temporary(async directory => {
  const fetcher = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true })
  })
  await assert.rejects(
    generateImage({ prompt: "x", out: "slow.png" }, pluginConfig({ key: "k", timeout_ms: 20 }), directory, { fetcher }),
    /timed out/,
  )
  assert.equal(await exists(path.join(directory, "slow.png")), false)
}))

test("a fetcher that ignores the signal cannot save a late result", async () => temporary(async directory => {
  // This timer is ref'd on purpose: it keeps the event loop alive on Linux, where the
  // AbortSignal.timeout timer itself is unref'd.
  const late = new Promise(resolve => setTimeout(() => resolve(okStream()), 40))
  const fetcher = async () => {
    const response = await late
    return response
  }
  await assert.rejects(
    generateImage({ prompt: "x", out: "late.png" }, pluginConfig({ key: "k", timeout_ms: 10 }), directory, { fetcher }),
    /timed out/,
  )
  assert.equal(await exists(path.join(directory, "late.png")), false)
}))

test("body read failures are normalized and never echo upstream messages", async () => temporary(async directory => {
  const marker = "SENSITIVE_TEST_MARKER"
  const sseFailure = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(marker)) } }), {
    headers: { "content-type": "text/event-stream" },
  })
  const jsonFailure = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(marker)) } }), {
    headers: { "content-type": "application/json" },
  })
  for (const [name, fetcher] of [["sse", sseFailure], ["json", jsonFailure]]) {
    await assert.rejects(
      generateImage({ prompt: "x", out: `${name}.png` }, pluginConfig({ key: "k" }), directory, { fetcher }),
      error => error.message === "Image response stream failed" && !error.message.includes(marker),
    )
    assert.equal(await exists(path.join(directory, `${name}.png`)), false)
  }
}))

test("timeout while reading the stream is reported as a timeout", async () => temporary(async directory => {
  const keepAlive = setTimeout(() => {}, 500)
  try {
    const fetcher = (url, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => {
          try { controller.error(options.signal.reason) } catch {}
        }, { once: true })
      },
    }), { headers: { "content-type": "text/event-stream" } })
    await assert.rejects(
      generateImage({ prompt: "x", out: "stream.png" }, pluginConfig({ key: "k", timeout_ms: 20 }), directory, { fetcher }),
      /timed out/,
    )
    assert.equal(await exists(path.join(directory, "stream.png")), false)
  } finally {
    clearTimeout(keepAlive)
  }
}))

test("cancellation while reading the stream aborts without writing", async () => temporary(async directory => {
  const controller = new AbortController()
  const keepAlive = setTimeout(() => {}, 500)
  try {
    const fetcher = (url, options) => new Response(new ReadableStream({
      start(stream) {
        options.signal.addEventListener("abort", () => {
          try { stream.error(options.signal.reason) } catch {}
        }, { once: true })
      },
    }), { headers: { "content-type": "text/event-stream" } })
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(
      generateImage({ prompt: "x", out: "cancelled.png" }, pluginConfig({ key: "k", timeout_ms: 5000 }), directory, { signal: controller.signal, fetcher }),
      { name: "AbortError" },
    )
    assert.equal(await exists(path.join(directory, "cancelled.png")), false)
  } finally {
    clearTimeout(keepAlive)
  }
}))

test("cancellation while persisting removes only the new file", async () => temporary(async directory => {
  await savePNG("keep.png", directory, png)
  const before = await readFile(path.join(directory, "keep.png"))
  // First read reports "not aborted", the read after the write reports "aborted".
  const lateAbort = { count: 0, get aborted() { return ++this.count > 1 } }
  await assert.rejects(savePNG("new.png", directory, png, lateAbort), { name: "AbortError" })
  assert.equal(await exists(path.join(directory, "new.png")), false)
  assert.deepEqual(await readFile(path.join(directory, "keep.png")), before)
}))

test("reasoning effort and priority are still serialized independently", async () => temporary(async directory => {
  for (const fast of [false, true]) {
    const config = pluginConfig({ key: "k", model: "custom-model", reasoning_effort: "high", fast_mode: fast })
    const seen = capture()
    await generateImage({ prompt: "x", out: `params-${fast}.png` }, config, directory, { fetcher: seen.fetcher })
    const body = seen.calls[0].body
    assert.equal(body.model, "custom-model")
    assert.deepEqual(body.reasoning, { effort: "high" })
    assert.equal(body.service_tier, fast ? "priority" : undefined)
    assert.equal(body.tools[0].quality, "auto")
    assert.equal(body.instructions.length > 0, true)
  }
}))

test("plugin exposes the namespaced id, tool and permissions", () => temporary(async directory => {
  const order = []
  let definition
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { order.push("fetch"); return okStream() }
  try {
    await savePNG("reference.png", directory, png)
    await plugin.setup({
      options: { base_url: "https://proxy.example/v1", key: "proxy-key" },
      session: { get: async () => ({ location: { directory } }) },
      permission: { assert: async input => { order.push(`permission:${input.action}`) } },
      tool: { transform: async callback => callback({ add: value => { definition = value } }) },
    })
    assert.equal(plugin.id, "opencode-codex-imagegen")
    assert.equal(definition.name, "proxy_imagegen")
    const result = await definition.execute({ prompt: "x", out: "plugin.png", images: ["reference.png"] }, { sessionID: "ses_9", agent: "build", messageID: "msg_1", id: "call_1" })
    assert.deepEqual(order, ["permission:read", "permission:edit", "fetch"])
    assert.deepEqual(Object.keys(result.metadata).sort(), ["bytes", "method", "model", "out", "route", "versioned"])
    assert.equal(result.metadata.route, "proxy")
    assert.match(result.content, /Saved PNG/)
  } finally {
    globalThis.fetch = originalFetch
  }
}))

test("plugin without options reports a missing account instead of guessing", async () => {
  let definition
  await plugin.setup({
    session: { get: async () => ({ location: { directory: tmpdir() } }) },
    permission: { assert: async () => {} },
    tool: { transform: async callback => callback({ add: value => { definition = value } }) },
  })
  await assert.rejects(definition.execute({ prompt: "x", out: "nope.png" }, { sessionID: "ses_x" }), /did not expose an OpenAI connection/)
})

test("requestHeaders keeps credentials out of metadata-relevant fields", () => {
  const headers = requestHeaders({ route: "proxy", method: "options", access: "k", url: OPENAI_RESPONSES_URL }, "ses")
  assert.deepEqual(headers, { Authorization: "Bearer k", "Content-Type": "application/json", Accept: "text/event-stream" })
})

// Interactions API wire response; output_image is a Google SDK helper, not a REST field.
const googleImage = { type: "image", mime_type: "image/png", data: png }
const jpeg = "/9j/7gAC/9k=" // JPEG signature fixture (no raster data needed for this test).
const googleJpeg = { type: "image", mime_type: "image/jpeg", data: jpeg }
const googleOptions = { provider: "google", key: "fake-gemini-key" }
const googleResponse = (parts = [googleImage]) => Response.json({ status: "completed", steps: [{ type: "model_output", content: parts }] })

test("Google configuration is opt-in and requires a dedicated key and supported options", () => {
  assert.equal(pluginConfig({}).provider, "openai")
  assert.equal(pluginConfig({ provider: "openai", key: "k" }).baseURL, "https://api.openai.com/v1")
  assert.equal(pluginConfig(googleOptions).model, "gemini-nano-banana-2.1")
  for (const key of [undefined, null, "  ", "{env:GEMINI_API_KEY}"]) {
    assert.throws(() => pluginConfig({ ...googleOptions, key }), /Google provider requires a valid options\.key/)
  }
  for (const options of [{ reasoning_effort: "low" }, { fast_mode: false }]) {
    assert.throws(() => pluginConfig({ ...googleOptions, ...options }), /only supported by the OpenAI provider/)
  }
  assert.throws(() => pluginConfig({ provider: "typo" }), /options\.provider/)
  const input = { prompt: "x", out: "out.png" }
  for (const options of [{ size: "1024x1024" }, { quality: "high" }, { aspect_ratio: "7:2" }, { image_size: "2k" }, { images: Array(15).fill("ref.png") }, { out: "out.gif" }]) {
    assert.throws(() => validateInput({ ...input, ...options }, "google"))
  }
  assert.throws(() => validateInput({ ...input, aspect_ratio: "16:9" }), /only supported by the Google provider/)
})

test("Google proxy URLs preserve prefixes and reject unsafe or unresolved addresses", async () => {
  for (const [baseURL, expected] of [
    ["https://proxy.example/", "https://proxy.example/v1beta/interactions"],
    ["http://127.0.0.1:8080/gemini", "http://127.0.0.1:8080/gemini/v1beta/interactions"],
    ["https://proxy.example/gemini/v1beta/", "https://proxy.example/gemini/v1beta/interactions"],
    ["https://proxy.example/gemini/v1", "https://proxy.example/gemini/v1/interactions"],
    [" https://proxy.example/gemini/v1beta/interactions/ ", "https://proxy.example/gemini/v1beta/interactions"],
  ]) {
    const route = await resolveRoute(pluginConfig({ ...googleOptions, base_url: baseURL }))
    assert.equal(route.url, expected)
  }
  for (const base_url of ["", "  ", null, 42, "{env:GEMINI_BASE_URL}", "https://", "ftp://proxy.example/", "https://user:secret@proxy.example", "https://proxy.example?v=secret", "https://proxy.example/#"]) {
    assert.throws(() => pluginConfig({ ...googleOptions, base_url }), {
      message: "Google options.base_url must be an HTTP(S) URL without credentials, query or fragment",
    })
  }
  assert.throws(() => pluginConfig({ provider: "google", base_url: "https://proxy.example" }), /Google provider requires a valid options\.key/)
})

test("Google custom proxy receives the same Gemini request with no fallback to Google", () => temporary(async directory => {
  const calls = []
  const config = pluginConfig({ ...googleOptions, base_url: "https://proxy.example/gemini/v1beta" })
  const env = {
    ctx: { get integration() { assert.fail("must not consult OpenCode credentials") } },
    fetcher: async (url, options) => {
      calls.push({ url, options })
      return calls.length === 1 ? googleResponse() : new Response("PRIVATE_PROXY_BODY", { status: 502 })
    },
  }
  const result = await generateImage({ prompt: "x", out: "proxy.png" }, config, directory, env)
  assert.equal(await readFile(result.out, "base64"), png)
  await assert.rejects(generateImage({ prompt: "x", out: "failed.png" }, config, directory, env), { message: "Image request failed: HTTP 502" })
  assert.equal(calls.length, 2)
  for (const { url, options } of calls) {
    assert.equal(url, "https://proxy.example/gemini/v1beta/interactions")
    assert.equal(options.headers["x-goog-api-key"], googleOptions.key)
    assert.equal(options.headers["Api-Revision"], "2026-05-20")
    assert.equal(options.headers.Authorization, undefined)
    assert.equal(options.redirect, "error")
    assert.equal(JSON.parse(options.body).model, "gemini-nano-banana-2.1")
  }
  assert.equal(await exists(path.join(directory, "failed.png")), false)
}))

test("Google text-to-image uses the official Interactions REST contract", () => temporary(async directory => {
  const calls = []
  const ctx = { get integration() { assert.fail("must not consult OpenCode credentials") } }
  const result = await generateImage({ prompt: "水彩狐狸", out: "fox.png" }, pluginConfig(googleOptions), directory, {
    ctx, sessionID: "not-sent-to-google", fetcher: async (url, options) => {
      calls.push({ url, ...options, body: JSON.parse(options.body) })
      return googleResponse([{ type: "text", text: "ignored" }, googleJpeg, googleImage])
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions")
  assert.equal(calls[0].method, "POST")
  assert.equal(calls[0].redirect, "error")
  assert.deepEqual(calls[0].headers, {
    "x-goog-api-key": "fake-gemini-key",
    "Api-Revision": "2026-05-20",
    "Content-Type": "application/json",
  })
  assert.deepEqual(calls[0].body, {
    model: "gemini-nano-banana-2.1",
    input: [{ type: "text", text: "水彩狐狸" }],
  })
  assert.deepEqual(result, { out: path.join(directory, "fox.png"), versioned: false, bytes: Buffer.from(png, "base64").length, route: "google", method: "api-key", model: "gemini-nano-banana-2.1" })
  assert.equal(await readFile(result.out, "base64"), png)
}))

test("Google edits multiple images in order, requests JPEG and preserves an existing file", () => temporary(async directory => {
  const placeholder = path.join(directory, "snow.jpeg")
  await savePNG("fox.png", directory, png)
  await writeFile(path.join(directory, "scene.jpg"), jpeg, "base64")
  await writeFile(placeholder, "existing")
  let body
  const result = await generateImage({ prompt: "改成雪景", images: ["fox.png", "scene.jpg"], out: "snow.jpeg", aspect_ratio: "16:9", image_size: "2K" }, pluginConfig({ ...googleOptions, model: "gemini-3.1-flash-image" }), directory, {
    fetcher: async (_, request) => {
      body = JSON.parse(request.body)
      return googleResponse([googleJpeg])
    },
  })
  assert.equal(body.model, "gemini-3.1-flash-image")
  assert.deepEqual(body.input, [{ type: "text", text: "改成雪景" }, googleImage, googleJpeg])
  assert.deepEqual(body.response_format, { type: "image", mime_type: "image/jpeg", aspect_ratio: "16:9", image_size: "2K" })
  assert.equal(result.out, path.join(directory, "snow-v2.jpeg"))
  assert.equal(result.versioned, true)
  assert.equal(await readFile(placeholder, "utf8"), "existing")
  assert.equal(await readFile(result.out, "base64"), jpeg)
}))

test("Google rejects unsupported and oversized reference images before fetching", () => temporary(async directory => {
  const oversized = Buffer.alloc(15_000_001)
  Buffer.from(png, "base64").copy(oversized)
  await writeFile(path.join(directory, "huge.png"), oversized)
  await writeFile(path.join(directory, "ref.gif"), "GIF89a")
  let calls = 0
  const env = { fetcher: async () => { calls++; return googleResponse() } }
  const config = pluginConfig(googleOptions)
  await assert.rejects(generateImage({ prompt: "x", out: "out.png", images: ["ref.gif"] }, config, directory, env), /Unsupported Google reference image/)
  await assert.rejects(generateImage({ prompt: "x", out: "out.png", images: ["huge.png"] }, config, directory, env), /at most 20 MB/)
  assert.equal(calls, 0)
  assert.equal(await exists(path.join(directory, "out.png")), false)
}))

test("Google HTTP and response errors do not leak payloads, retry, or write a file", () => temporary(async directory => {
  const marker = "PRIVATE_GOOGLE_PAYLOAD"
  const cases = [
    [new Response(marker, { status: 429 }), "Image request failed: HTTP 429"],
    [new Response(marker), "Image response contained invalid JSON"],
    [Response.json({ status: "failed", error: { message: marker }, steps: [{ type: "model_output", content: [googleImage] }] }), "Google image interaction did not complete"],
    [Response.json({ status: "completed", steps: [{ type: "thought", content: [googleImage] }, { type: "model_output", content: [{ type: "text", text: marker }] }] }), "Google response contained no generated image"],
    [googleResponse([googleJpeg]), "Could not convert Google JPEG to PNG"],
    [googleResponse([{ ...googleImage, data: jpeg }]), "Google image MIME type does not match its bytes"],
    [googleResponse([{ ...googleImage, data: marker }]), "Invalid image base64"],
  ]
  const config = pluginConfig(googleOptions)
  for (const [response, expected] of cases) {
    let calls = 0
    await assert.rejects(generateImage({ prompt: "x", out: "out.png" }, config, directory, {
      fetcher: async () => { calls++; return response },
    }), error => error.message === expected && !error.message.includes(marker))
    assert.equal(calls, 1)
    assert.equal(await exists(path.join(directory, "out.png")), false)
  }
}))

test("Google default JPEG from JSON becomes a real PNG with the decoded pixels", () => temporary(async directory => {
  const { default: codec } = await import("jpeg-js")
  const { PNG } = await import("pngjs")
  const jpg = codec.encode({ width: 2, height: 1, data: Buffer.from([240, 120, 20, 255, 210, 100, 15, 255]) }).data
  const result = await generateImage({ prompt: "fox", out: "fox.png" }, pluginConfig(googleOptions), directory, {
    fetcher: async () => googleResponse([{ ...googleJpeg, data: jpg.toString("base64") }]),
  })
  const decoded = PNG.sync.read(await readFile(result.out))
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 1)
  assert.deepEqual(decoded.data, codec.decode(jpg).data)
}))

test("Google discards a late JSON response after cancellation or timeout", () => temporary(async directory => {
  for (const cancel of [true, false]) {
    const controller = new AbortController()
    const out = cancel ? "cancel.png" : "timeout.png"
    const config = pluginConfig({ ...googleOptions, timeout_ms: cancel ? 5_000 : 15 })
    const fetcher = async (url, { signal }) => {
      if (cancel) controller.abort()
      else await new Promise(resolve => setTimeout(resolve, 40))
      assert.equal(signal.aborted, true)
      return googleResponse()
    }
    await assert.rejects(generateImage({ prompt: "x", out }, config, directory, { fetcher, signal: controller.signal }),
      cancel ? { name: "AbortError" } : /timed out/)
    assert.equal(await exists(path.join(directory, out)), false)
  }
}))

test("Google tool advertises native options and checks read/edit permissions before fetching", () => temporary(async directory => {
  const order = []
  let definition
  let denied = true
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { order.push("fetch"); return googleResponse([googleJpeg]) }
  try {
    await savePNG("reference.png", directory, png)
    await plugin.setup({
      options: googleOptions,
      session: { get: async () => ({ location: { directory } }) },
      permission: { assert: async ({ action, resources }) => {
        order.push([action, resources])
        if (denied && action === "edit") throw new Error("edit denied")
      } },
      tool: { transform: async callback => callback({ add: value => { definition = value } }) },
    })
    assert.equal(definition.name, "proxy_imagegen")
    assert.match(definition.description, /Google Gemini/)
    assert.deepEqual(Object.keys(definition.input.properties).sort(), ["aspect_ratio", "image_size", "images", "out", "prompt"])
    const args = [{ prompt: "x", out: "out.jpg", images: ["reference.png"] }, { sessionID: "ses_9" }]
    const permissions = [["read", [path.join(directory, "reference.png")]], ["edit", [path.join(directory, "out.jpg"), path.join(directory, "out-v*.jpg")]]]
    await assert.rejects(definition.execute(...args), /edit denied/)
    assert.deepEqual(order, permissions)
    order.length = 0
    denied = false
    const result = await definition.execute(...args)
    assert.deepEqual(order, [...permissions, "fetch"])
    assert.match(result.content, /Saved JPEG/)
    assert.equal(result.metadata.route, "google")
    assert.ok(!JSON.stringify(result).includes(googleOptions.key))
  } finally {
    globalThis.fetch = originalFetch
  }
}))
