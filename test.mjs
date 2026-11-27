import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { EventEmitter, on, once } from "node:events"
import { setImmediate as tick } from "node:timers/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin from "./index.js"
import { configuredProviders, connection as providerConnection, parameters, validateOptions } from "./parameters.js"
import { generate } from "./images.js"

const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8kAAAAASUVORK5CYII="
const picture = { b64_json: b64, media_type: "image/png" }
const connection = (options, env) => providerConnection("aihubmix", options, env)
const completed = (...output) => ({ id: "task_abc", status: "completed", output })
const context = (sessionID = "ses_A") => ({ sessionID, messageID: "msg_input", id: "call_1", agent: "build", signal: new AbortController().signal })

// Each queue can be awaited before or after its value arrives.
function queue() {
  const values = [], waiters = []
  return {
    put(value) { if (waiters.length) waiters.shift()(value); else values.push(value) },
    take() { return values.length ? Promise.resolve(values.shift()) : new Promise(resolve => waiters.push(resolve)) },
  }
}

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "auto-imagegen-test-"))
  const incoming = queue(), notifications = queue()
  const requests = [], permissions = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    const call = {
      method: req.method, url: req.url, headers: req.headers, body: req.headers["content-type"]?.startsWith("application/json") ? JSON.parse(bytes) : bytes,
      reply(json, status = 200) { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json)) },
      raw(data, status = 200, headers = {}) { res.writeHead(status, headers).end(data) },
    }
    requests.push(call)
    incoming.put(call)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const base_url = `http://127.0.0.1:${server.address().port}/proxy/${overrides.compat ? "v1" : "ai/v1"}`
  const emitter = new EventEmitter()
  let tool
  const unload = await plugin.setup({
    options: Object.hasOwn(overrides, "options") ? overrides.options : {
      ...(overrides.codex && { codex: { ...(overrides.codex.key && { base_url: `http://127.0.0.1:${server.address().port}/codex/v1` }), ...overrides.codex } }),
      openrouter: { base_url: `http://127.0.0.1:${server.address().port}/router/v1`, key: overrides.router ? "router-key" : "", ...overrides.openrouter },
      aihubmix: { base_url, key: overrides.mix === false ? "  " : "fixture-key", ...overrides.aihubmix },
      google: { base_url: `http://127.0.0.1:${server.address().port}/gemini`, key: "", ...overrides.google },
    },
    integration: overrides.integration,
    event: {
      async *subscribe({ types, signal }) {
        for await (const [event] of on(emitter, "event", { signal })) if (types.includes(event.type)) yield event
      },
    },
    session: {
      get: async () => ({ location: { directory: dir } }),
      synthetic: async msg => { await overrides.synthetic?.(msg); notifications.put(msg) },
    },
    permission: { assert: async rule => { permissions.push(rule); await overrides.permission?.(rule) } },
    tool: { transform: async cb => cb({ add: def => { tool = def } }) },
  })
  t.after(async () => {
    server.closeAllConnections()
    await unload()
    await new Promise(done => server.close(done))
    await rm(dir, { recursive: true, force: true })
  })
  assert.equal(tool.name, "auto_imagegen")
  const emit = async (type, sessionID) => { emitter.emit("event", { type, data: { sessionID } }); await tick() }
  return { dir, base_url, requests, permissions, incoming, notifications, unload, emit, submit: (input, ctx = context()) => tool.execute(input, ctx) }
}

test("connection and per-call settings have independent defaults", () => {
  const env = { AIHUBMIX_API_KEY: "fixture-key" }
  const official = { model: "gpt-image-2.5-sunburst", endpoint: "https://aihubmix.com/ai/v1/images/generations", native: true, key: "fixture-key" }
  for (const base_url of ["https://aihubmix.com", "https://aihubmix.com/ai/v1/", official.endpoint])
    assert.deepEqual(connection({ base_url }, env), official)
  assert.deepEqual(connection({}, env), official)
  assert.throws(() => connection({ base_url: "https://custom.test" }, env), /key/)
  assert.equal(connection({ base_url: "https://custom.test/v1/images/generations/", key: "explicit" }).endpoint, "https://custom.test/v1/images/generations")
  assert.throws(() => connection({}, {}), /key/)
  assert.throws(() => validateOptions({ openrouter: { quality: "low" } }), /tool call/)
  assert.throws(() => validateOptions({ key: "oops" }), /Unknown provider/)
  assert.deepEqual(providerConnection("openrouter", {}, { OPENROUTER_API_KEY: "router" }), { key: "router", endpoint: "https://openrouter.ai/api/v1/images", model: "openai/gpt-image-2.5-sunburst" })
  assert.throws(() => providerConnection("openrouter", {base_url: "https://proxy.test/v1"}, {OPENROUTER_API_KEY:"router"}), /key/)
  for (const key of ["quality", "size", "n", "aspect_ratio"]) assert.throws(() => connection({ [key]: 1 }, env), /tool call/)
  assert.deepEqual(parameters({ prompt: "fox" }), { prompt: "fox", n: 1, size: "auto", quality: "auto", output_format: "png", background: "auto" })
  const jpeg = parameters({ prompt: "proof", size: "1536x1024", quality: "max", out: "a.jpg", output_compression: 0 })
  assert.equal(jpeg.output_format, "jpeg")
  assert.equal(jpeg.output_compression, 0)
  assert.equal(jpeg.size, "1536x1024")
  assert.ok(!("aspect_ratio" in jpeg))
  for (const size of ["256x256", "1080x1920", "3840x3840", "2048x512", "4096x2048"]) assert.throws(() => parameters({prompt: "test", size}), /size/)
  assert.throws(() => parameters({prompt: "test", mask: "mask.png"}), /mask/)
  assert.equal(parameters({prompt: "4K wallpaper", size: "3840x2160"}).size, "3840x2160")
  for (const args of [{ n: 0 }, { n: 11 }, { n: 1.5 }, { quality: "4K" }, { size: "2K" }, { size: "512x512", aspect_ratio: "1:1" }, { out: "x.jpg", background: "transparent" }, { out: "x.jpeg", output_format: "png" }, { output_compression: 101 }, { images: Array(17).fill("x.png") }, { base_url: "https://elsewhere.test" }])
    assert.throws(() => parameters({ prompt: "fox", ...args }))
})

test("returns before HTTP response, survives foreground abort and notifies the originating session after saving", { timeout: 5000 }, async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.dir, "ref.png"), Buffer.from(b64, "base64"))
  await writeFile(path.join(f.dir, "cover.png"), "original")
  const turn = new AbortController()
  const receipt = await f.submit({ prompt: "edit fox", out: "cover.png", images: ["ref.png"], quality: "high", aspect_ratio: "9:16", n: 2 }, { ...context(), signal: turn.signal })
  assert.equal(receipt.metadata.status, "submitted")
  turn.abort()
  const call = await f.incoming.take()
  assert.equal(call.url, "/proxy/ai/v1/images/generations")
  assert.equal(call.method, "POST")
  assert.equal(call.headers.authorization, "Bearer fixture-key")
  assert.deepEqual(call.body, {
    model: "gpt-image-2.5-sunburst", prompt: "edit fox", n: 2, size: "864x1536", output_format: "png", async: true,
    extra: { quality: "high", background: "auto" }, image: `data:image/png;base64,${b64}`,
  })
  call.reply(completed({ content_url: "/ai/v1/images/task_abc/content/result_a" }, picture))
  const download = await f.incoming.take()
  assert.equal(download.method, "GET")
  assert.equal(download.url, "/ai/v1/images/task_abc/content/result_a")
  assert.equal(download.headers.authorization, "Bearer fixture-key")
  download.raw(Buffer.from(b64, "base64"))
  const notice = await f.notifications.take()
  assert.deepEqual(notice.metadata.attempts, [{ provider: "aihubmix", status: "succeeded" }])
  assert.equal(notice.metadata.jobID, receipt.metadata.jobID)
  assert.equal(notice.metadata.upstreamID, "task_abc")
  assert.equal(notice.sessionID, "ses_A")
  assert.equal(notice.delivery, "queue")
  assert.equal(notice.resume, true)
  const outputs = ["cover-v2.png", "cover-2.png"].map(name => path.join(f.dir, name))
  assert.deepEqual(notice.metadata.saved, outputs)
  assert.deepEqual(f.permissions.map(p => [p.action, p.resources]), [["read", [path.join(f.dir, "ref.png")]], ["edit", outputs]])
  for (const file of outputs) assert.equal((await readFile(file)).toString("base64"), b64)
  assert.equal(await readFile(path.join(f.dir, "cover.png"), "utf8"), "original")
})

test("only listed providers can use environment keys, in the written order and only at their official origin", async () => {
  const env = { OPENROUTER_API_KEY: "router", AIHUBMIX_API_KEY: "mix", GEMINI_API_KEY: "gemini" }
  const names = async options => (await configuredProviders(options, { env })).map(x => x.provider)
  assert.deepEqual(await names({}), [])
  assert.deepEqual(await names({ aihubmix: {}, openrouter: {} }), ["aihubmix", "openrouter"])
  assert.deepEqual(await names({ openrouter: { key: " " } }), [])
  assert.deepEqual(await names({ aihubmix: { disabled: true }, openrouter: { disabled: false } }), ["openrouter"])
  assert.deepEqual(await names({ aihubmix: { base_url: "https://proxy.test/ai/v1" } }), [])
  assert.deepEqual(await names({ google: {} }), [])
})

test("disabled OpenRouter is absent from failover even with a key", { timeout: 5000 }, async t => {
  const f = await fixture(t, { codex: { key: "codex-key", disabled: false }, router: true, openrouter: { disabled: true }, aihubmix: { disabled: false } })
  await f.submit({ prompt: "test" })
  const codex = await f.incoming.take()
  assert.equal(codex.url, "/codex/v1/responses")
  codex.reply({}, 402)
  const backup = await f.incoming.take()
  assert.equal(backup.url, "/proxy/ai/v1/images/generations")
  backup.reply(completed(picture))
  assert.deepEqual((await f.notifications.take()).metadata.attempts.map(x => x.provider), ["codex", "aihubmix"])
})

test("all disabled: no managed credential lookup, permissions or generation", async t => {
  let lookups = 0
  const f = await fixture(t, {
    codex: { disabled: true }, router: true, openrouter: { disabled: true }, aihubmix: { disabled: true },
    google: { key: "google-key", disabled: true },
    integration: { connection: { active() { lookups++; return {} }, resolve() { lookups++; return { type: "key", key: "test" } } } },
  })
  await assert.rejects(f.submit({ prompt: "test" }), /没有可用的生图服务/)
  assert.equal(lookups, 0)
  assert.deepEqual(f.permissions, [])
  assert.deepEqual(f.requests, [])
  for (const name of ["codex", "openrouter", "aihubmix", "google"])
    assert.throws(() => validateOptions({ [name]: { disabled: "true" } }), /disabled must be boolean/)
})

test("only OpenRouter configured: a provider failure does not attempt an unconfigured backup", { timeout: 5000 }, async t => {
  const f = await fixture(t, { router: true, mix: false })
  await f.submit({ prompt: "test" })
  const req = await f.incoming.take()
  assert.equal(req.url, "/router/v1/images")
  req.reply({}, 402)
  const notice = await f.notifications.take()
  assert.deepEqual(notice.metadata.attempts.map(x => [x.provider, x.status]), [["openrouter", "failed"]])
  assert.equal(f.requests.length, 1)
})

test("no keys: reject before file permissions or job submission", async t => {
  const f = await fixture(t, { mix: false })
  await assert.rejects(f.submit({ prompt: "test", images: ["ref.png"] }), /没有可用的生图服务/)
  assert.deepEqual(f.permissions, [])
  assert.deepEqual(f.requests, [])
})

const codexImage = { type: "image_generation_call", result: b64 }
const googlePNG = { type: "image", mime_type: "image/png", data: b64 }
const interaction = (...content) => ({ status: "completed", steps: [{ type: "model_output", content }] })

test("omitted and empty options use only active OpenCode connections: OpenAI then Google", { timeout: 5000 }, async t => {
  const calls = [], resolved = []
  const integration = { connection: {
    async active(id) { return { id } },
    async resolve(account) {
      resolved.push(account.id)
      return { type: "key", key: `${account.id}-managed` }
    },
  } }
  t.mock.method(globalThis, "fetch", async (url, { headers }) => {
    calls.push(url)
    if (url === "https://api.openai.com/v1/responses") {
      assert.equal(headers.Authorization, "Bearer openai-managed")
      return Response.json({}, { status: 503 })
    }
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions")
    assert.equal(headers["x-goog-api-key"], "google-managed")
    assert.equal(headers.Authorization, undefined)
    return Response.json(interaction(googlePNG))
  })
  for (const options of [undefined, {}]) {
    const f = await fixture(t, { options, integration })
    await f.submit({ prompt: "test" })
    const result = await f.notifications.take()
    assert.deepEqual(result.metadata.attempts.map(a => [a.provider, a.status]), [["codex", "failed"], ["google", "succeeded"]])
    assert.equal(await readFile(result.metadata.saved[0], "base64"), b64)
  }
  assert.deepEqual(resolved, ["openai", "google", "openai", "google"])
  assert.equal(calls.length, 4)
})

test("explicit order routes Google → OpenRouter → Codex, resolving only credentials reached", { timeout: 5000 }, async t => {
  const options = { google: {}, openrouter: { key: "router-key" }, codex: {} }
  const resolved = []
  const f = await fixture(t, { options, integration: { connection: {
    active: async id => ({ id }),
    resolve: async ({ id }) => { resolved.push(id); return { type: "key", key: `${id}-key` } },
  } } })
  let fail = false
  t.mock.method(globalThis, "fetch", async url => {
    if (!fail) return Response.json(interaction(googlePNG))
    if (url === "https://api.openai.com/v1/responses") return Response.json({ output: [codexImage] })
    return Response.json({}, { status: 503 })
  })
  await f.submit({ prompt: "first" })
  assert.equal((await f.notifications.take()).metadata.provider, "google")
  assert.deepEqual(resolved, ["google"])
  fail = true
  await f.submit({ prompt: "again" })
  assert.deepEqual((await f.notifications.take()).metadata.attempts.map(a => [a.provider, a.status]),
    [["google", "failed"], ["openrouter", "failed"], ["codex", "succeeded"]])
  assert.deepEqual(resolved, ["google", "google", "openai"])
})

test("empty explicit chain never discovers unlisted accounts or sends managed credentials to a proxy", async t => {
  const lookups = []
  const f = await fixture(t, {
    options: { google: { base_url: "https://proxy.test" }, openrouter: { disabled: true } },
    integration: { connection: { active: async id => { lookups.push(id); return { id } }, resolve: async () => ({ type: "key", key: "host-key" }) } },
  })
  await assert.rejects(f.submit({ prompt: "test" }), /没有可用的生图服务/)
  assert.deepEqual(lookups, [])
  assert.deepEqual(f.permissions, [])
})

test("Google-first routing stops on an explicit copyright refusal without trying a backup", { timeout: 5000 }, async t => {
  const f = await fixture(t, { options: { google: { key: "g" }, codex: { key: "c" } } })
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "Image generation blocked due to copyright/recitation." } }, { status: 400 }))
  await f.submit({ prompt: "test" })
  const result = await f.notifications.take()
  assert.deepEqual(result.metadata.attempts.map(a => a.provider), ["google"])
  assert.match(result.text, /版权/)
  assert.equal(fetch.mock.callCount(), 1)
})

test("Google uses its own official key, model and Interactions endpoint; proxies require an explicit key", async () => {
  const env = { GEMINI_API_KEY: "google-key" }
  const google = (options) => providerConnection("google", options, env)
  assert.deepEqual(google({}), { endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions", key: "google-key", model: "gemini-nano-banana-2.1" })
  assert.deepEqual((await configuredProviders({ google: { base_url: "https://generativelanguage.googleapis.com" } }, { env })).map(x => x.provider), ["google"])
  for (const settings of [{ disabled: true }, { key: " " }, { key: "{env:MISSING}" }, { base_url: "https://proxy.test" }])
    assert.deepEqual(await configuredProviders({ google: settings }, { env }), [])
  for (const [prefix, target] of [["/gemini", "/gemini/v1beta/interactions"], ["/v1/", "/v1/interactions"], ["/v1beta/interactions/", "/v1beta/interactions"]]) {
    const config = google({ base_url: `https://proxy.test${prefix}`, key: "proxy-key", model: "another-image-model" })
    assert.deepEqual(config, { key: "proxy-key", model: "another-image-model", endpoint: `https://proxy.test${target}` })
  }
  for (const base_url of ["https://proxy.test/#", "https://proxy.test/?q=x", "https://user:key@proxy.test", "ftp://proxy.test"])
    assert.throws(() => google({ base_url, key: "proxy-key" }), /base_url/)
  for (const args of [{ image_size: "8K" }, { image_size: "1K", size: "1024x1024" }])
    assert.throws(() => parameters({ prompt: "test", ...args }), /image_size/)
})

test("Codex → OpenRouter → AIHubMix → Google: an upstream failure reaches Gemini without forwarding other credentials", { timeout: 5000 }, async t => {
  const f = await fixture(t, { codex: { key: "codex-key" }, router: true, google: { key: "google-key" } })
  const receipt = await f.submit({ prompt: "水彩狐狸" })
  for (const url of ["/codex/v1/responses", "/router/v1/images", "/proxy/ai/v1/images/generations"]) {
    const request = await f.incoming.take()
    assert.equal(request.url, url)
    assert.equal(request.headers["x-goog-api-key"], undefined)
    if (url.startsWith("/proxy")) request.raw("invalid JSON")
    else request.reply({}, 503)
  }
  const last = await f.incoming.take()
  assert.equal(last.url, "/gemini/v1beta/interactions")
  assert.equal(last.method, "POST")
  assert.equal(last.headers["x-goog-api-key"], "google-key")
  assert.equal(last.headers["api-revision"], "2026-05-20")
  assert.equal(last.headers.authorization, undefined)
  assert.deepEqual(last.body, { model: "gemini-nano-banana-2.1", input: [{ type: "text", text: "水彩狐狸" }] })
  last.reply(interaction({ ...googlePNG, data: "AAAA" }, googlePNG))
  const done = await f.notifications.take()
  assert.equal(done.metadata.jobID, receipt.metadata.jobID)
  assert.equal(done.metadata.provider, "google")
  assert.equal(await readFile(done.metadata.saved[0], "base64"), b64)
  assert.deepEqual(done.metadata.attempts.map(a => a.status), ["failed", "failed", "failed", "succeeded"])
})

test("Google-specific size and ratio skip incompatible providers, keep reference order and batch JPEG results", { timeout: 5000 }, async t => {
  const f = await fixture(t, { codex: { key: "codex-key" }, router: true, google: { key: "google-key", model: "gemini-custom" } })
  const jpeg = { type: "image", mime_type: "image/jpeg", data: "/9j/7gAC/9k=" }
  await writeFile(path.join(f.dir, "a.png"), b64, "base64")
  await writeFile(path.join(f.dir, "b.jpg"), jpeg.data, "base64")
  await f.submit({ prompt: "combine", images: ["a.png", "b.jpg"], out: "wide.jpg", image_size: "2K", aspect_ratio: "4:1", n: 2 })
  for (let i = 0; i < 2; i++) {
    const request = await f.incoming.take()
    assert.equal(request.url, "/gemini/v1beta/interactions")
    assert.deepEqual(request.body, {
      model: "gemini-custom", input: [{ type: "text", text: "combine" }, googlePNG, jpeg],
      response_format: { type: "image", aspect_ratio: "4:1", image_size: "2K", mime_type: "image/jpeg" },
    })
    request.reply(interaction(jpeg))
  }
  const done = await f.notifications.take()
  assert.deepEqual(done.metadata.attempts.map(a => a.status), ["skipped", "skipped", "skipped", "succeeded"])
  assert.deepEqual(done.metadata.saved, ["wide.jpg", "wide-2.jpg"].map(file => path.join(f.dir, file)))
  for (const file of done.metadata.saved) assert.equal(await readFile(file, "base64"), jpeg.data)
})

test("Google converts a returned JPEG to real PNG; mismatched MIME cannot overwrite or complete the batch", { timeout: 5000 }, async t => {
  const f = await fixture(t, { mix: false, google: { key: "google-key" } })
  const { default: codec } = await import("jpeg-js")
  const { PNG } = await import("pngjs")
  const bytes = codec.encode({ width: 1, height: 1, data: Buffer.from([180, 80, 20, 255]) }).data
  await f.submit({ prompt: "test", out: "cover.png", n: 3 })
  ;(await f.incoming.take()).reply(interaction({ type: "image", mime_type: "image/jpeg", data: bytes.toString("base64") }))
  ;(await f.incoming.take()).reply(interaction({ ...googlePNG, mime_type: "image/jpeg" }))
  const done = await f.notifications.take()
  assert.match(done.text, /部分完成（1\/3）/)
  assert.match(done.text, /MIME/)
  assert.deepEqual(PNG.sync.read(await readFile(done.metadata.saved[0])).data, codec.decode(bytes).data)
  assert.deepEqual(await readdir(f.dir), ["cover.png"])
  assert.equal(f.requests.length, 2)
})

test("Google skips unsupported inputs without calling Gemini or disabling the account", { timeout: 5000 }, async t => {
  const f = await fixture(t, { mix: false, google: { key: "google-key" } })
  await writeFile(path.join(f.dir, "ref.png"), b64, "base64")
  for (const args of [{ images: Array(15).fill("ref.png") }, { images: ["ref.png"], mask: "ref.png" }, { quality: "high" },
    { background: "transparent" }, { output_format: "webp" }, { output_format: "jpeg", output_compression: 80 },
    { size: "1024x1024" }, { aspect_ratio: "2:1" }]) {
    await f.submit({ prompt: "test", ...args })
    const done = await f.notifications.take()
    assert.equal(done.metadata.attempts[0].status, "skipped")
    assert.doesNotMatch(done.text, /本会话已停用/)
  }
  const large = Buffer.alloc(15_000_000)
  Buffer.from(b64, "base64").copy(large)
  await writeFile(path.join(f.dir, "large.png"), large)
  await f.submit({ prompt: "test", images: ["large.png"] })
  assert.match((await f.notifications.take()).text, /20 MB/)
  assert.equal(f.requests.length, 0)
})

test("Google retries transient failures next turn, scopes an invalid key to one session and redacts upstream text", { timeout: 5000 }, async t => {
  const f = await fixture(t, { mix: false, google: { key: "google-key" } })
  for (const [status, error] of [[429, { status: "RESOURCE_EXHAUSTED" }], [400, { details: [{ reason: "API_KEY_INVALID" }] }]]) {
    await f.submit({ prompt: "test" })
    ;(await f.incoming.take()).reply({ error: { ...error, message: "google-key" } }, status)
    const done = await f.notifications.take()
    assert.equal(done.metadata.attempts[0].status, "failed")
    assert.doesNotMatch(JSON.stringify(done), /google-key/)
  }
  await f.submit({ prompt: "same session" })
  assert.match((await f.notifications.take()).text, /本会话已停用/)
  await f.submit({ prompt: "new session" }, context("ses_B"))
  ;(await f.incoming.take()).reply(interaction(googlePNG))
  assert.equal((await f.notifications.take()).metadata.provider, "google")
  assert.equal(f.requests.length, 3)
})

test("Codex is first: explicit proxy, chat model, hosted tool, refs and SSE/JSON batch", { timeout: 5000 }, async t => {
  let hostLookups = 0
  const f = await fixture(t, {
    router: true, codex: { key: "codex-secret", model: "custom-chat", reasoning_effort: "medium", fast_mode: true },
    integration: { connection: { active() { hostLookups++ }, resolve() { hostLookups++ } } },
  })
  await writeFile(path.join(f.dir, "ref.png"), Buffer.from(b64, "base64"))
  await f.submit({ prompt: "edit", images: ["ref.png"], out: "answer.png", quality: "high", aspect_ratio: "9:16", n: 2 })
  const call = await f.incoming.take()
  assert.equal(call.url, "/codex/v1/responses")
  assert.equal(call.headers.authorization, "Bearer codex-secret")
  assert.equal(call.headers["session-id"], undefined)
  assert.equal(call.body.model, "custom-chat")
  assert.deepEqual(call.body.reasoning, { effort: "medium" })
  assert.equal(call.body.service_tier, "priority")
  assert.deepEqual(call.body.tool_choice, { type: "image_generation" })
  assert.deepEqual(call.body.tools, [{ type: "image_generation", size: "864x1536", output_format: "png", quality: "high" }])
  assert.equal(call.body.input[0].content[1].image_url, `data:image/png;base64,${b64}`)
  call.raw(`: ping\r\n\r\ndata: ${JSON.stringify({ type: "response.output_item.done", item: codexImage })}\r\n\r\n`)
  const second = await f.incoming.take()
  assert.equal(second.url, call.url)
  second.reply({ output: [codexImage] })
  const notice = await f.notifications.take()
  assert.equal(notice.metadata.provider, "codex")
  assert.equal(notice.metadata.saved.length, 2)
  assert.deepEqual(notice.metadata.attempts, [{ provider: "codex", status: "succeeded" }])
  assert.doesNotMatch(JSON.stringify(notice), /codex-secret/)
  assert.equal(hostLookups, 0)
})

test("Codex → OpenRouter → AIHubMix marks only the originating session on account failures", { timeout: 5000 }, async t => {
  const f = await fixture(t, { router: true, codex: { key: "codex-key" } })
  await f.submit({ prompt: "A" })
  const first = await f.incoming.take()
  assert.equal(first.url, "/codex/v1/responses")
  assert.equal(first.body.model, "gpt-6.2-sol")
  first.reply({ error: { code: "subscription_sharing_unsupported_capability" } }, 400)
  const next = await f.incoming.take()
  assert.equal(next.url, "/router/v1/images")
  next.reply({}, 402)
  ;(await f.incoming.take()).reply(completed(picture))
  const sent = await f.notifications.take()
  assert.deepEqual(sent.metadata.attempts.map(a => [a.provider,a.status]), [["codex","failed"],["openrouter","failed"],["aihubmix","succeeded"]])
  await f.submit({ prompt: "again" })
  const direct = await f.incoming.take()
  assert.equal(direct.url, "/proxy/ai/v1/images/generations")
  direct.reply(completed(picture))
  assert.deepEqual((await f.notifications.take()).metadata.attempts.map(a=>a.status), ["skipped","skipped","succeeded"])
  await f.submit({ prompt: "fresh session" }, context("ses_B"))
  const fresh = await f.incoming.take()
  assert.equal(fresh.url, first.url)
  fresh.reply({ output: [codexImage] })
  assert.equal((await f.notifications.take()).sessionID, "ses_B")
})

test("managed Codex resolves current credentials per call and confines token and session headers to their route", { timeout: 5000 }, async t => {
  let cred, resolutions = 0
  const f = await fixture(t, { options: { codex: {} }, integration: { connection: {
    async active(name) { assert.equal(name, "openai"); return { id: "test-account" } },
    async resolve(account) { assert.equal(account.id, "test-account"); resolutions++; return cred },
  } } })
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return Response.json({ output: [codexImage] })
  })
  for (const method of ["key", "chatgpt-browser", "chatgpt-headless", "chatgpt-token-sharing"]) {
    cred = method === "key" ? { type: "key", key: "api-secret" } : { type: "oauth", methodID: method, access: `token-${method}`, metadata: { accountID: "account-id" } }
    await f.submit({ prompt: "test" })
    const notice = await f.notifications.take()
    assert.equal(notice.metadata.provider, "codex")
    const { url, headers, body } = calls.at(-1)
    const legacy = method === "chatgpt-browser" || method === "chatgpt-headless"
    assert.equal(url, legacy ? "https://chatgpt.com/backend-api/codex/responses" : "https://api.openai.com/v1/responses")
    assert.equal(headers.Authorization, `Bearer ${cred.key ?? cred.access}`)
    assert.equal(headers["ChatGPT-Account-Id"], legacy ? "account-id" : undefined)
    assert.equal(headers["session-id"], method !== "key" ? "ses_A" : undefined)
    assert.equal(headers["thread-id"], method === "chatgpt-token-sharing" ? "ses_A" : undefined)
    assert.equal(body.stream, true)
    assert.equal(body.store, false)
    assert.doesNotMatch(JSON.stringify(notice), /api-secret|token-chatgpt|account-id/)
  }
  assert.equal(resolutions, 4)
})

test("Codex skips unsupported requests, falls back after text-only replies, stops on refusal or partial batch", { timeout: 5000 }, async t => {
  const f = await fixture(t, { router: true, codex: { key: "codex-key" } })
  await f.submit({ prompt: "max", quality: "max" })
  const capable = await f.incoming.take()
  assert.equal(capable.url, "/router/v1/images")
  capable.reply({ data: [picture] })
  assert.equal((await f.notifications.take()).metadata.attempts[0].status, "skipped")
  await f.submit({ prompt: "test" })
  ;(await f.incoming.take()).reply({ output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] })
  ;(await f.incoming.take()).reply({ data: [picture] })
  assert.equal((await f.notifications.take()).metadata.provider, "openrouter")
  await f.submit({ prompt: "refusal" })
  ;(await f.incoming.take()).raw('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n')
  assert.match((await f.notifications.take()).text, /策略限制/)
  await f.submit({ prompt: "partial", n: 2 })
  ;(await f.incoming.take()).reply({output:[codexImage]})
  ;(await f.incoming.take()).reply({}, 503)
  const partial = await f.notifications.take()
  assert.match(partial.text, /部分完成（1\/2）/)
  assert.equal(partial.metadata.attempts.length, 1)
  assert.equal(f.requests.length, 6)
})

test("overlapping sessions get distinct paths and separate success/failure notifications", { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const a = await f.submit({ prompt: "A", out: "icon.png" })
  const reqA = await f.incoming.take()
  const b = await f.submit({ prompt: "B", out: "icon.png" }, context("ses_B"))
  const reqB = await f.incoming.take()
  reqB.reply(completed(picture))
  const doneB = await f.notifications.take()
  assert.equal(doneB.sessionID, "ses_B")
  assert.equal(doneB.metadata.jobID, b.metadata.jobID)
  assert.deepEqual(doneB.metadata.saved, [path.join(f.dir, "icon-v2.png")])
  reqA.reply({ error: { message: "fixture-key" } }, 402)
  const doneA = await f.notifications.take()
  assert.equal(doneA.sessionID, "ses_A")
  assert.equal(doneA.metadata.jobID, a.metadata.jobID)
  assert.match(doneA.text, /失败.*0\/1/s)
  assert.match(doneA.text, /HTTP 402/)
  assert.doesNotMatch(doneA.text, /fixture-key/)
  assert.equal(f.requests.length, 2)
})

test("partial results retain actual paths and notification retries do not regenerate", { timeout: 5000 }, async t => {
  const ids = []
  const f = await fixture(t, { synthetic: msg => { ids.push(msg.id); if (ids.length === 1) throw Error("transient") } })
  await f.submit({ prompt: "variants", n: 3 })
  ;(await f.incoming.take()).reply(completed(picture))
  const notice = await f.notifications.take()
  assert.match(notice.text, /部分完成（1\/3）/)
  assert.equal((await readFile(notice.metadata.saved[0])).toString("base64"), b64)
  assert.deepEqual(ids, [notice.id, notice.id])
  assert.equal(f.requests.length, 1)
})

test("permission denial and pre-admission cancellation do not enqueue or reserve filenames", { timeout: 5000 }, async t => {
  let deny = true
  const f = await fixture(t, { permission: rule => { if (deny && rule.action === "edit") throw Error("denied") } })
  const args = { prompt: "test", out: "test.png" }
  await assert.rejects(f.submit(args), /denied/)
  deny = false
  await assert.rejects(f.submit(args, { ...context(), signal: AbortSignal.abort() }), /abort/i)
  await f.submit(args)
  ;(await f.incoming.take()).reply(completed(picture))
  const notice = await f.notifications.take()
  assert.equal(f.requests.length, 1)
  assert.deepEqual(notice.metadata.saved, [path.join(f.dir, "test.png")])
})

test("an external writer wins a filename race and a failed batch reports earlier saved files", { timeout: 5000 }, async t => {
  const f = await fixture(t)
  await f.submit({ prompt: "two", n: 2, out: "page.png" })
  const call = await f.incoming.take()
  await writeFile(path.join(f.dir, "page-2.png"), "external")
  call.reply(completed(picture, picture))
  const result = await f.notifications.take()
  assert.match(result.text, /部分完成（1\/2）/)
  assert.deepEqual(result.metadata.saved, [path.join(f.dir, "page.png")])
  assert.equal(await readFile(path.join(f.dir, "page-2.png"), "utf8"), "external")
})

test("unload cancels outstanding work, and failure is delivered without a spurious file", { timeout: 5000 }, async t => {
  const f = await fixture(t)
  await f.submit({ prompt: "pending" })
  await f.incoming.take()
  await f.unload()
  assert.match((await f.notifications.take()).text, /已取消/)
  assert.deepEqual(await readdir(f.dir), [])
})

test("pending task is polled on its own authenticated media endpoint, never resubmitted", { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const config = connection({ base_url: f.base_url, key: "fixture-key" })
  const saved = [], ids = [], waits = []
  const paths = [path.join(f.dir, "polled.png")]
  const done = generate({
    config, provider: "aihubmix", params: parameters({ prompt: "test" }), refs: [], paths, signal: context().signal,
    saved, onTaskID: id => ids.push(id),
  }, async ms => { waits.push(ms) })
  ;(await f.incoming.take()).reply({ status: "pending", id: "task_abc", output: [] }, 202)
  for (const response of [{ status: "in_progress", id: "task_abc" }, completed(picture)]) {
    const poll = await f.incoming.take()
    assert.equal(poll.method, "GET")
    assert.equal(poll.url, "/proxy/ai/v1/images/task_abc")
    assert.equal(poll.headers.authorization, "Bearer fixture-key")
    poll.reply(response)
  }
  await done
  assert.deepEqual(saved, paths)
  assert.deepEqual(ids, ["task_abc"])
  assert.deepEqual(waits, [15000, 15000])
  assert.equal(f.requests.length, 3)
})

test("native multi-reference edits and masks use approved local files and vendor extra fields", { timeout: 5000 }, async t => {
  const f = await fixture(t)
  for (const name of ["a", "b", "mask"]) await writeFile(path.join(f.dir, `${name}.png`), Buffer.from(b64, "base64"))
  await f.submit({ prompt: "combine", images: ["a.png", "b.png"], mask: "mask.png", output_format: "webp", background: "transparent", output_compression: 75 })
  const call = await f.incoming.take()
  const uri = `data:image/png;base64,${b64}`
  assert.deepEqual(call.body.images, [uri, uri])
  assert.equal(call.body.mask, uri)
  assert.deepEqual(call.body.extra, { background: "transparent", quality: "auto", output_compression: 75 })
  assert.deepEqual(f.permissions[0].resources, ["a.png","b.png","mask.png"].map(x => path.join(f.dir, x)))
  call.reply({ id: "task_xyz", status: "failed", error: { code: "upstream_rejected", message: "fixture-key" } })
  const result = await f.notifications.take()
  assert.match(result.text, /upstream_rejected/)
  assert.match(result.text, /task_xyz/)
  assert.doesNotMatch(result.text, /fixture-key/)
})

test("v1 uses documented JSON for generation and multipart for edits", { timeout: 5000 }, async t => {
  const f = await fixture(t, { compat: true })
  await f.submit({ prompt: "square", out: "ref.png" })
  const create = await f.incoming.take()
  assert.equal(create.url, "/proxy/v1/images/generations")
  assert.deepEqual(create.body, { model: "gpt-image-2.5-sunburst", prompt: "square", n: 1, quality: "auto", size: "auto", output_format: "png" })
  create.reply({ data: [picture] })
  await f.notifications.take()
  await f.submit({ prompt: "edit", images: ["ref.png"], mask: "ref.png", quality: "xhigh" })
  const edit = await f.incoming.take()
  assert.equal(edit.url, "/proxy/v1/images/edits")
  const form = await new Response(edit.body, { headers: { "content-type": edit.headers["content-type"] } }).formData()
  assert.equal(form.get("quality"), "xhigh")
  assert.equal(form.get("model"), "gpt-image-2.5-sunburst")
  for (const name of ["image", "mask"])
    assert.equal(Buffer.from(await form.get(name).arrayBuffer()).toString("base64"), b64)
  edit.reply({ data: [{ url: "/result.png" }] })
  ;(await f.incoming.take()).raw(Buffer.from(b64, "base64"))
  assert.equal((await f.notifications.take()).metadata.saved.length, 1)
  await f.submit({ prompt: "test", images: ["ref.png", "ref.png"] })
  assert.match((await f.notifications.take()).text, /ai\/v1/)
  assert.equal(f.requests.length, 3)
})

test("signed cross-origin downloads receive no Bearer key, even after a same-origin redirect", { timeout: 5000 }, async t => {
  const realFetch = globalThis.fetch
  let cdnRequest
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (new URL(url).hostname !== "cdn.test") return realFetch(url, init)
    cdnRequest = init
    return Promise.resolve(new Response(Buffer.from(b64, "base64")))
  })
  const f = await fixture(t)
  await f.submit({ prompt: "download" })
  ;(await f.incoming.take()).reply(completed({ content_url: "/content/1" }))
  const redirect = await f.incoming.take()
  assert.equal(redirect.headers.authorization, "Bearer fixture-key")
  redirect.raw("", 302, { Location: "https://cdn.test/out?signature=mock" })
  assert.equal((await f.notifications.take()).metadata.saved.length, 1)
  assert.equal(new Headers(cdnRequest.headers).has("authorization"), false)
})

test("OpenRouter 402 switches this job, remembers only that session, and archive clears it", { timeout: 5000 }, async t => {
  const f = await fixture(t, { router: true, openrouter: { model: "fixture/primary-image" }, aihubmix: { model: "backup-image" } })
  const args = { prompt: "两张竖屏壁纸", n: 2, aspect_ratio: "9:16", quality: "high", images: ["ref.png"] }
  await writeFile(path.join(f.dir, "ref.png"), Buffer.from(b64, "base64"))
  await f.submit(args)
  const primary = await f.incoming.take()
  assert.equal(primary.url, "/router/v1/images")
  assert.equal(primary.headers.authorization, "Bearer router-key")
  assert.deepEqual(primary.body, {
    model: "fixture/primary-image", prompt: args.prompt, n: 2, quality: "high", aspect_ratio: "9:16", output_format: "png",
    response_format: "b64_json", background: "auto", input_references: [{type:"image_url",image_url:{url:`data:image/png;base64,${b64}`}}],
  })
  primary.reply({ error: { message: "router-key" } }, 402)
  const backup = await f.incoming.take()
  assert.equal(backup.url, "/proxy/ai/v1/images/generations")
  assert.equal(backup.headers.authorization, "Bearer fixture-key")
  assert.equal(backup.body.model, "backup-image")
  assert.equal(backup.body.size, "864x1536")
  assert.equal(backup.body.image, primary.body.input_references[0].image_url.url)
  assert.equal(backup.body.n, 2)
  assert.equal(backup.body.extra.quality, "high")
  backup.reply(completed(picture, picture))
  const result = await f.notifications.take()
  assert.equal(result.metadata.provider, "aihubmix")
  assert.deepEqual(result.metadata.attempts.map(a => a.status), ["failed", "succeeded"])
  assert.doesNotMatch(JSON.stringify(result), /router-key|fixture-key/)
  await f.submit({ prompt: "again" })
  const again = await f.incoming.take()
  assert.equal(again.url, backup.url)
  again.reply(completed(picture))
  assert.equal((await f.notifications.take()).metadata.attempts[0].status, "skipped")
  async function succeedsOnPrimary(sid) {
    await f.submit({ prompt: "fresh", size: "1536x1024" }, context(sid))
    const req = await f.incoming.take()
    assert.equal(req.url, primary.url)
    assert.equal(req.body.size, "1536x1024")
    assert.ok(!("aspect_ratio" in req.body))
    req.reply({ data: [picture] })
    const notice = await f.notifications.take()
    assert.equal(notice.sessionID, sid)
    assert.deepEqual(notice.metadata.attempts, [{provider:"openrouter",status:"succeeded"}])
  }
  await succeedsOnPrimary("ses_B")
  await f.emit("session.archived", "ses_A")
  await succeedsOnPrimary("ses_A")
  assert.equal(f.requests.length, 5)
})

test("temporary 429, 5xx and in-flight budget failures fail over without marking the key invalid", { timeout: 5000 }, async t => {
  const f = await fixture(t, { router: true })
  for (const [status, metadata] of [[429,{}],[503,{}],[402,{limit_source:"openrouter_in_flight_budget"}]]) {
    await f.submit({ prompt: "test" })
    const primary = await f.incoming.take()
    assert.equal(primary.url, "/router/v1/images")
    primary.reply({error:{code:status,metadata}}, status)
    const backup = await f.incoming.take()
    assert.equal(backup.url, "/proxy/ai/v1/images/generations")
    backup.reply(completed(picture))
    assert.equal((await f.notifications.take()).metadata.provider, "aihubmix")
  }
})

test("both keys invalid: single failure notice; no further POSTs in the session, including after idle", { timeout: 5000 }, async t => {
  const f = await fixture(t, { router: true })
  await f.submit({ prompt: "test" })
  ;(await f.incoming.take()).reply({}, 401)
  ;(await f.incoming.take()).reply({error:{code:"insufficient_user_quota",message:"fixture-key"}},403)
  const fail = await f.notifications.take()
  assert.match(fail.text,/HTTP 401/)
  assert.match(fail.text,/HTTP 403/)
  await f.emit("session.idle", "ses_A")
  await f.submit({ prompt: "again" })
  assert.deepEqual((await f.notifications.take()).metadata.attempts.map(x=>x.status), ["skipped","skipped"])
  assert.equal(f.requests.length, 2)
  await f.emit("session.deleted", "ses_A")
  await f.submit({ prompt: "new state" })
  const recovered = await f.incoming.take()
  assert.equal(recovered.url, "/router/v1/images")
  recovered.reply({data:[picture]})
  assert.equal((await f.notifications.take()).metadata.provider, "openrouter")
})

test("no backup after partial output, a local write failure, or explicit policy rejection", { timeout: 5000 }, async t => {
  const f = await fixture(t, { router: true })
  await f.submit({ prompt: "two", n: 2 })
  ;(await f.incoming.take()).reply({ data: [picture, {}] })
  assert.match((await f.notifications.take()).text, /部分完成（1\/2）/)
  await f.submit({ prompt: "race", out:"race.png" })
  const pending = await f.incoming.take()
  await writeFile(path.join(f.dir, "race.png"), "external")
  pending.reply({ data:[picture] })
  assert.match((await f.notifications.take()).text, /失败（0\/1）/)
  await f.submit({ prompt: "blocked" })
  ;(await f.incoming.take()).reply({error:{code:"content_policy_violation"}},403)
  assert.match((await f.notifications.take()).text, /策略限制/)
  assert.deepEqual(f.requests.map(r => r.url), Array(3).fill("/router/v1/images"))
})
