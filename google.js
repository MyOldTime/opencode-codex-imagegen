import { ProviderFailure, upstreamError } from "./errors.js"

export const googleRatios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"]
const inlineLimit = 20_000_000

export function googleUnsupported({ params, aspect }, { refs, mask }) {
  if (refs.length > 14) return "Google 最多支持 14 张参考图。"
  if (!aspect || (aspect !== "auto" && !googleRatios.includes(aspect))) return "Google 不支持指定的精确像素尺寸或画幅。"
  if (mask || params.quality !== "auto" || params.background !== "auto" || params.output_compression !== undefined || params.output_format === "webp")
    return "Google 支持无蒙版的 PNG/JPEG 输出，不支持显式质量、背景或压缩参数。"
}

function interactionBody({ config, params, refs, aspect, imageSize }) {
  const limitError = "Google 内联请求不能超过 20 MB，请缩小参考图。"
  const encodedLength = refs.reduce((total, ref) => total + 4 * Math.ceil(ref.bytes.length / 3), 0)
  if (encodedLength > inlineLimit) throw new ProviderFailure(limitError)
  const format = {
    ...(aspect !== "auto" && { aspect_ratio: aspect }),
    ...(imageSize && { image_size: imageSize }),
    ...(params.output_format === "jpeg" && { mime_type: "image/jpeg" }),
  }
  const body = JSON.stringify({
    model: config.model,
    input: [{ type: "text", text: params.prompt }, ...refs.map(ref => ({
      type: "image", mime_type: `image/${ref.type}`, data: ref.bytes.toString("base64"),
    }))],
    ...(Object.keys(format).length && { response_format: { type: "image", ...format } }),
  })
  if (Buffer.byteLength(body) > inlineLimit) throw new ProviderFailure(limitError)
  return body
}

function googleFailure(status, error) {
  if (/blocked due to copyright\/recitation/i.test(error?.message ?? ""))
    return new ProviderFailure("Google 拒绝了本次请求（版权或内容复现限制）。", { fallback: false })
  const invalidKey = Array.isArray(error?.details) && error.details.some(item => item?.reason === "API_KEY_INVALID")
  if (invalidKey || /API key not valid/i.test(error?.message ?? ""))
    return new ProviderFailure("Google API key 无效。", { disable: true })
  return upstreamError(status, { code: error?.status ?? error?.code, message: error?.message })
}

export async function* googleOutputs(job) {
  const { config, params, signal } = job
  const body = interactionBody(job)
  const headers = { "x-goog-api-key": config.key, "Content-Type": "application/json", "Api-Revision": "2026-05-20" }
  for (let i = 0; i < params.n; i++) {
    let response, payload
    try {
      signal.throwIfAborted()
      response = await fetch(config.endpoint, { method: "POST", headers, body, signal, redirect: "error" })
      payload = await response.json().catch(() => null)
    } catch {
      throw new ProviderFailure("Google 请求超时、中止或网络异常。")
    }
    if (!response.ok || payload?.error) {
      const status = response.ok && Number.isInteger(payload?.error?.code) ? payload.error.code : response.status
      throw googleFailure(status, payload?.error)
    }
    if (payload?.status !== "completed") throw new ProviderFailure("Google 图像交互未完成。")
    let image
    for (const step of Array.isArray(payload.steps) ? payload.steps : []) {
      if (step?.type !== "model_output" || !Array.isArray(step.content)) continue
      for (const part of step.content) {
        if (part?.type === "image" && typeof part.data === "string" && part.data) image = part
      }
    }
    if (!image) throw new ProviderFailure("Google model_output 未返回图片。")
    if (image.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new ProviderFailure("Google 返回无效的图片数据。")
    yield { b64_json: image.data, mime_type: image.mime_type }
  }
}

// Gemini may return JPEG even for the default (PNG) request.
export async function jpegToPNG(bytes) {
  const [{ default: jpeg }, { PNG }] = await Promise.all([import("jpeg-js"), import("pngjs")])
  try {
    return PNG.sync.write(jpeg.decode(bytes, { maxResolutionInMP: 20, maxMemoryUsageInMB: 384, tolerantDecoding: false }))
  } catch {
    throw new ProviderFailure("Google 返回的 JPEG 无法转为 PNG。")
  }
}
