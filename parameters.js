import path from "node:path"
import { ProviderFailure } from "./errors.js"
import { googleRatios } from "./google.js"

const defaultModel = "gpt-image-2.5-sunburst"
const providers = {
  openrouter: { origin: "https://openrouter.ai", envKey: "OPENROUTER_API_KEY" },
  aihubmix: { origin: "https://aihubmix.com", envKey: "AIHUBMIX_API_KEY" },
  google: { origin: "https://generativelanguage.googleapis.com", envKey: "GEMINI_API_KEY" },
}
// Sunburst accepts pixel dimensions rather than an API aspect_ratio field.
const ratioSizes = {
  auto: "auto", "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536",
  "4:3": "1280x960", "3:4": "960x1280", "16:9": "1536x864", "9:16": "864x1536",
  "21:9": "1792x768", "4:5": "1024x1280", "5:4": "1280x1024",
  "2:1": "1536x768", "1:2": "768x1536", "3:1": "1920x640", "1:3": "640x1920",
}
export const googleOnlyRatios = googleRatios.filter(ratio => !Object.hasOwn(ratioSizes, ratio))
const qualities = ["auto", "low", "medium", "high", "xhigh", "max"]
const formats = ["png", "jpeg", "webp"]
const backgrounds = ["auto", "opaque", "transparent"]
const pixels = "^(auto|[1-9][0-9]{0,3}x[1-9][0-9]{0,3})$"

export const schema = {
  type: "object",
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 32000, description: "Describe the desired image or edits. For multiple references, describe the role of each in order." },
    out: { type: "string", description: "Optional first output filename (.png, .jpg, .jpeg, .webp), absolute or relative to this session. Otherwise a unique name under images/ is used. Extra outputs are numbered." },
    images: { type: "array", maxItems: 16, items: { type: "string" }, description: "Local PNG, JPEG or WebP reference paths, in order. Omit for text-to-image." },
    mask: { type: "string", description: "Optional local PNG edit mask, with reference image(s). Masked edits require AIHubMix; omit for ordinary generation and unmasked edits." },
    quality: { type: "string", enum: qualities, default: "auto", description: "Use auto normally, low for a quick draft, high for a polished final. Reserve xhigh/max for an explicit request for maximum detail." },
    aspect_ratio: { type: "string", enum: [...Object.keys(ratioSizes), ...googleOnlyRatios], description: "16:9 for a banner, 9:16 for a phone wallpaper, 1:1 for an avatar. Omit when specifying exact pixels. 1:4, 4:1, 1:8, 8:1 require Google." },
    image_size: { type: "string", enum: ["1K", "2K", "4K"], description: "Google Gemini resolution tier, when explicitly requested. May accompany aspect_ratio. Omit for automatic provider selection; do not combine with exact pixel size." },
    size: { type: "string", pattern: pixels, description: "Default auto. For a specific size use WIDTHxHEIGHT, e.g. 1536x1024. Each side must be a multiple of 16 and at most 3840; area 655360–8294400 pixels; ratio between 1:3 and 3:1. Leave out if using aspect_ratio." },
    n: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "Number of variations of this prompt. Default 1. When the user asks for multiple versions, request them together (1–10). The provider may return fewer." },
    output_format: { type: "string", enum: formats, description: "Defaults to out's extension or PNG. Choose PNG for lossless graphics, JPEG for photographs, WebP for compact web assets." },
    background: { type: "string", enum: backgrounds, default: "auto", description: "Use transparent for a cutout or sticker (PNG/WebP only); otherwise leave auto unless a solid background is requested." },
    output_compression: { type: "integer", minimum: 0, maximum: 100, description: "Optional 0–100 API compression setting for JPEG/WebP. Omit for the provider default or for PNG." },
  },
  required: ["prompt"],
  additionalProperties: false,
}

const text = value => typeof value === "string" && value.trim().length > 0
function rejectUnknown(value, keys, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.")
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${message}: ${key}`)
}

export function validateOptions(options = {}) {
  rejectUnknown(options, ["codex", ...Object.keys(providers)], "Unknown provider")
  for (const [provider, value] of Object.entries(options)) {
    const keys = ["base_url", "key", "model", "disabled"]
    if (provider === "codex") keys.push("reasoning_effort", "fast_mode")
    rejectUnknown(value, keys, "Unknown plugin option (generation settings belong in the tool call)")
    if (value.disabled !== undefined && typeof value.disabled !== "boolean") throw new Error(`${provider}.disabled must be boolean.`)
  }
  const codex = options.codex
  if (codex?.reasoning_effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(codex.reasoning_effort))
    throw new Error("Invalid codex.reasoning_effort.")
  if (codex?.fast_mode !== undefined && typeof codex.fast_mode !== "boolean") throw new Error("codex.fast_mode must be boolean.")
}

function effectiveKey(provider, options, env) {
  if (options.key != null) return options.key
  const { origin, envKey } = providers[provider]
  // Only the official origin may inherit a key from the server environment.
  try { if (new URL(options.base_url ?? origin).origin === origin) return env[envKey] } catch {}
}

export function configuredProviders(options = {}, env = process.env) {
  const active = []
  for (const provider of Object.keys(providers)) {
    const { disabled = false, ...settings } = options[provider] ?? {}
    if (disabled) continue
    const key = effectiveKey(provider, settings, env)
    if (text(key) && !key.trim().startsWith("{env:")) active.push({ provider, settings: { ...settings, key } })
  }
  return active
}

export function connection(provider, options = {}, env = process.env) {
  rejectUnknown(options, ["base_url", "key", "model"], "Unknown plugin option (generation settings belong in the tool call)")
  const router = provider === "openrouter"
  const { origin: baseURL, envKey: keyName } = providers[provider]
  for (const [name, value] of Object.entries(options)) if (name !== "key" && !text(value)) throw new ProviderFailure(`options.${provider}.${name} must be a non-empty string.`)
  const address = options.base_url?.trim() ?? baseURL
  let url
  try { url = new URL(address) }
  catch { throw new ProviderFailure("Invalid base_url.") }
  if (!/^https?:\/\//i.test(address) || url.username || url.password || /[?#]/.test(address))
    throw new ProviderFailure("base_url must be an HTTP(S) API base without credentials, query or fragment.")
  const key = effectiveKey(provider, options, env)
  if (!text(key) || key.trim().startsWith("{env:") || /[^\x21-\x7e]/.test(key.trim())) throw new ProviderFailure(`缺少或无效的 key（${keyName}）。`, { disable: true })
  if (provider === "google") {
    const prefix = url.pathname.replace(/\/+$/, "")
    if (prefix.endsWith("/interactions")) url.pathname = prefix
    else if (/\/v1(?:beta)?$/.test(prefix)) url.pathname = `${prefix}/interactions`
    else url.pathname = `${prefix}/v1beta/interactions`
    return { endpoint: url.href, key: key.trim(), model: options.model?.trim() ?? "gemini-nano-banana-2.1" }
  }
  if (router) {
    const prefix = url.pathname.replace(/\/+$/, "")
    url.pathname = prefix.endsWith("/images") ? prefix : `${prefix || "/api/v1"}/images`
    return { endpoint: url.href, key: key.trim(), model: options.model?.trim() ?? `openai/${defaultModel}` }
  }
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/images(?:\/(?:generations|edits))?$/, "") || "/ai/v1"
  if (!prefix.endsWith("/v1")) throw new ProviderFailure("Use the AIHubMix host, /ai/v1, /v1, or a full image endpoint as base_url.")
  url.pathname = `${prefix}/images/generations`
  return { endpoint: url.href, native: prefix.endsWith("/ai/v1"), key: key.trim(), model: options.model?.trim() ?? defaultModel }
}

// Validate again at execution: a tool can also be called by a programmatic client.
export function parameters(input) {
  rejectUnknown(input, Object.keys(schema.properties), "Unknown image generation argument")
  if (!text(input.prompt)) throw new Error("prompt is required.")
  if ([...input.prompt].length > 32000) throw new Error("prompt must not exceed 32000 characters.")
  if (input.out !== undefined && !text(input.out)) throw new Error("out must be a filename.")
  if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 16 || !input.images.every(text)))
    throw new Error("images must be a list of up to 16 local image paths.")
  if (input.mask !== undefined && (!text(input.mask) || !input.images?.length)) throw new Error("mask requires a local path and at least one reference image.")
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (input[key] === undefined) continue
    if (spec.enum && !spec.enum.includes(input[key])) throw new Error(`${key} must be one of ${spec.enum.join(", ")}.`)
    if (spec.type === "integer" && !(Number.isInteger(input[key]) && input[key] >= spec.minimum && input[key] <= spec.maximum))
      throw new Error(`${key} must be an integer from ${spec.minimum} to ${spec.maximum}.`)
  }
  if (input.size !== undefined && (typeof input.size !== "string" || !new RegExp(pixels).test(input.size)))
    throw new Error("size must be auto or WIDTHxHEIGHT.")
  if (input.size && input.aspect_ratio) throw new Error("Choose either size or aspect_ratio.")
  if (input.image_size && input.size && input.size !== "auto") throw new Error("Choose either image_size or exact pixel size.")
  const size = input.size ?? ratioSizes[input.aspect_ratio ?? "auto"] ?? "auto"
  if (size !== "auto") {
    const [w, h] = size.split("x").map(Number)
    if (w % 16 || h % 16 || Math.max(w,h) > 3840 || w*h < 655360 || w*h > 8294400 || w > 3*h || h > 3*w)
      throw new Error("size is outside the Sunburst pixel, aspect ratio or multiple-of-16 limits.")
  }
  const ext = input.out && path.extname(input.out).slice(1).toLowerCase()
  const fromPath = ext === "jpg" ? "jpeg" : ext
  if (input.out && !formats.includes(fromPath)) throw new Error("out must end in .png, .jpg, .jpeg or .webp.")
  const output_format = input.output_format ?? fromPath ?? "png"
  if (fromPath && fromPath !== output_format) throw new Error("out extension must match output_format.")
  if (output_format === "jpeg" && input.background === "transparent") throw new Error("Transparent images require PNG or WebP.")
  if (output_format === "png" && input.output_compression !== undefined) throw new Error("output_compression requires JPEG or WebP.")
  return {
    prompt: input.prompt, n: input.n ?? 1, quality: input.quality ?? "auto",
    output_format, background: input.background ?? "auto",
    size,
    ...(input.output_compression === undefined ? {} : { output_compression: input.output_compression }),
  }
}
