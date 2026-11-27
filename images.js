import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ProviderFailure, upstreamError } from "./errors.js"
import { codexOutputs } from "./codex.js"
import { googleOutputs, jpegToPNG } from "./google.js"

const png = Buffer.from("89504e470d0a1a0a", "hex")
function format(bytes) {
  if (bytes.subarray(0, 8).equals(png)) return "png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp"
}

const pathKey = file => process.platform === "win32" ? file.toLowerCase() : file

// Reserve exact filenames across this plugin's concurrent jobs. The exclusive open at
// write time also protects against a different process creating an approved path.
export async function reserveOutputs(first, n, reserved) {
  const { dir, name, ext } = path.parse(first)
  const paths = []
  const release = () => paths.forEach(file => reserved.delete(pathKey(file)))
  try {
    for (let i = 1; i <= n; i++) {
      const stem = i === 1 ? name : `${name}-${i}`
      for (let v = 1; ; v++) {
        const file = path.join(dir, `${stem}${v === 1 ? "" : `-v${v}`}${ext}`)
        try {
          await lstat(file)
          continue
        } catch (error) {
          if (error.code !== "ENOENT") throw error
        }
        const key = pathKey(file)
        if (reserved.has(key)) continue
        reserved.add(key)
        paths.push(file)
        break
      }
    }
    return { paths, release }
  } catch (error) {
    release()
    throw error
  }
}

async function writeImage(file, bytes, signal) {
  signal.throwIfAborted()
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, "wx")
  try {
    try {
      await handle.writeFile(bytes, { signal })
    } finally {
      await handle.close()
    }
  } catch (error) {
    await unlink(file)
    throw error
  }
}

const safeID = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const auth = config => ({ Authorization: `Bearer ${config.key}` })

function errorInfo(error, key) {
  // Do not echo provider messages: they can contain prompts, URLs or keys.
  const fields = [error?.code, error?.tid].filter(x => safeID(x) && !x.includes(key))
  if (error?.code === "async_not_enabled") fields.push("请在 AIHubMix 控制台启用异步任务，或将 base_url 设为 https://aihubmix.com/v1。")
  return fields.length ? ` (${fields.join("; ")})` : ""
}

async function check(response, key, stage) {
  if (response.ok) return
  const body = await response.json().catch(() => null)
  const error = upstreamError(response.status, body?.error, stage === "提交")
  error.message = `${stage} ${error.message}${errorInfo(body?.error, key)}`
  throw error
}

async function api(config, url, init, signal) {
  const response = await fetch(url, { ...init, headers: { ...auth(config), ...init.headers }, redirect: "error", signal })
  await check(response, config.key, init.method === "POST" ? "提交" : "查询")
  try {
    return await response.json()
  } catch {
    signal.throwIfAborted()
    throw new ProviderFailure("AIHubMix returned invalid JSON.")
  }
}

async function source(file, signal, mask = false) {
  const bytes = await readFile(file, { signal })
  const type = format(bytes)
  if (!type || (mask && type !== "png")) throw new Error(`Expected ${mask ? "PNG mask" : "PNG, JPEG or WebP reference"}: ${file}`)
  return { bytes, type, name: path.basename(file) }
}
const dataURI = file => `data:image/${file.type};base64,${file.bytes.toString("base64")}`
const jsonPost = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

async function nativeOutputs(job, common, refs, mask, wait) {
  const { config, params, signal, onTaskID } = job
  const extra = { quality: params.quality, background: params.background, output_compression: params.output_compression }
  const init = jsonPost({
    ...common, async: true, extra,
    ...(refs.length === 1 ? { image: dataURI(refs[0]) } : refs.length ? { images: refs.map(dataURI) } : {}),
    ...(mask && { mask: dataURI(mask) }),
  })
  if (Buffer.byteLength(init.body) > 32 * 1024 * 1024) throw new ProviderFailure("AIHubMix 请求体超过 32 MiB，请缩小参考图。")
  let task = await api(config, config.endpoint, init, signal)
  const id = task?.id
  if (safeID(id)) onTaskID?.(id)
  while (task?.status === "pending" || task?.status === "in_progress") {
    if (!safeID(id)) throw new ProviderFailure("AIHubMix returned an active task without a valid ID.")
    await wait(15000, undefined, { signal })
    task = await api(config, new URL(id, config.endpoint), { method: "GET" }, signal)
    if (task?.id !== id) throw new ProviderFailure("AIHubMix returned a different task ID.")
  }
  if (task?.status === "failed" || task?.status === "cancelled") {
    const error = upstreamError(200, task.error)
    error.message = `AIHubMix task ${task.status}${errorInfo(task.error, config.key)}`
    throw error
  }
  if (task?.status !== "completed") throw new ProviderFailure("AIHubMix returned an unrecognized task status.")
  return task.output
}

async function compatibleOutputs({ config, params, signal }, common, refs, mask) {
  const body = { ...common, quality: params.quality }
  if (!refs.length) return (await api(config, config.endpoint, jsonPost(body), signal))?.data
  const form = new FormData()
  for (const [key, value] of Object.entries(body)) form.set(key, String(value))
  for (const [key, file] of [["image", refs[0]], ["mask", mask]]) {
    if (file) form.set(key, new Blob([file.bytes], { type: `image/${file.type}` }), file.name)
  }
  return (await api(config, new URL("edits", config.endpoint), { method: "POST", body: form }, signal))?.data
}

async function download(raw, config, signal) {
  let url = new URL(raw, config.endpoint)
  const origin = new URL(config.endpoint).origin
  let authenticated = true
  for (let redirects = 0; redirects <= 5; redirects++) {
    authenticated &&= url.origin === origin
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && url.origin === origin)))
      throw new ProviderFailure("AIHubMix returned an invalid image download URL.")
    const response = await fetch(url, { signal, redirect: "manual", headers: authenticated ? auth(config) : {} })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location")
      await response.body?.cancel()
      if (!next) throw new ProviderFailure("AIHubMix image download redirect has no location.")
      url = new URL(next, url)
      continue
    }
    await check(response, config.key, "下载")
    return Buffer.from(await response.arrayBuffer())
  }
  throw new ProviderFailure("AIHubMix returned too many image download redirects.")
}

export async function loadInputs({ sources, mask, signal }) {
  const refs = []
  for (const file of sources) refs.push(await source(file, signal))
  return { refs, mask: mask && await source(mask, signal, true) }
}

async function openRouterOutputs({ config, params, aspect, signal }, refs) {
  const { size, ...rest } = params
  const init = jsonPost({
    model: config.model, ...rest, ...(aspect ? { aspect_ratio: aspect } : { size }),
    response_format: "b64_json",
    ...(refs.length && { input_references: refs.map(file => ({ type: "image_url", image_url: { url: dataURI(file) } })) }),
  })
  let response, body
  try {
    response = await fetch(config.endpoint, { ...init, headers: { ...init.headers, ...auth(config) }, redirect: "error", signal })
    body = await response.json().catch(() => null)
  } catch {
    throw new ProviderFailure(signal.aborted ? "请求超时或已中止" : "网络请求失败")
  }
  if (!response.ok || body?.error) {
    const status = response.ok ? Number(body.error.code) || response.status : response.status
    throw upstreamError(status, body?.error)
  }
  return body?.data
}

async function imageAPIOutputs(job, wait) {
  const { provider, config, params, refs, mask, paths } = job
  const common = { model: config.model, prompt: params.prompt, n: params.n, output_format: params.output_format, size: params.size }
  const router = provider === "openrouter"
  if (!router && !config.native && (refs.length > 1 || params.background !== "auto" || params.output_compression !== undefined))
    throw new ProviderFailure("Use AIHubMix /ai/v1 for multiple references, explicit background or output_compression.")
  const outputs = router ? await openRouterOutputs(job, refs) :
    config.native ? await nativeOutputs(job, common, refs, mask, wait) : await compatibleOutputs(job, common, refs, mask)
  if (!Array.isArray(outputs) || !outputs.length) throw new ProviderFailure("上游未返回图片。")
  if (outputs.length > paths.length) throw new ProviderFailure("上游返回图片数超过请求数量。")
  return outputs
}

function aiHubMixFailure(error) {
  if (error instanceof ProviderFailure) throw error
  throw new ProviderFailure("AIHubMix 网络请求失败或返回了无效的响应。")
}

async function providerOutputs(job, wait) {
  if (job.provider === "codex") return codexOutputs(job)
  if (job.provider === "google") return googleOutputs(job)
  if (job.provider === "aihubmix") return imageAPIOutputs(job, wait).catch(aiHubMixFailure)
  return imageAPIOutputs(job, wait)
}

export async function generate(job, wait = delay) {
  const { provider, config, params, paths, signal, saved } = job
  const outputs = await providerOutputs(job, wait)
  for await (const image of outputs) {
    const index = saved.length
    const raw = config?.native ? image?.content_url : image?.url
    let bytes
    if (typeof image?.b64_json === "string" && image.b64_json) bytes = Buffer.from(image.b64_json, "base64")
    else if (provider === "aihubmix" && typeof raw === "string" && raw) bytes = await download(raw, config, signal).catch(aiHubMixFailure)
    else throw new ProviderFailure(`Image ${index + 1} has no usable image data.`)
    const actual = format(bytes)
    if (provider === "google" && image.mime_type !== undefined && image.mime_type !== `image/${actual}`)
      throw new ProviderFailure("Google 返回的图片 MIME 类型与文件内容不符。")
    if (provider === "google" && actual === "jpeg" && params.output_format === "png") {
      signal.throwIfAborted()
      bytes = await jpegToPNG(bytes)
    } else if (actual !== params.output_format)
      throw new ProviderFailure(`Image ${index + 1} does not match the requested ${params.output_format.toUpperCase()} format.`)
    await writeImage(paths[index], bytes, signal)
    saved.push(paths[index])
  }
}
