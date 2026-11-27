import { imageAPIConnection, googleOnlyRatios } from "./parameters.js"
import { generate, loadInputs } from "./images.js"
import { ProviderFailure } from "./errors.js"
import { codexUnsupported } from "./codex.js"
import { googleUnsupported } from "./google.js"

function unsupportedReason(provider, job, inputs) {
  if (provider === "google") return googleUnsupported(job, inputs)
  if (job.imageSize || googleOnlyRatios.includes(job.aspect)) return "本次分辨率档位或画幅需要 Google。"
  if (provider === "codex") return codexUnsupported(job.params, inputs.mask)
  if (provider === "openrouter" && inputs.mask) return "OpenRouter Sunburst 不支持蒙版。"
}

// The caller owns this map per session. Keep only redacted diagnostic strings,
// never clients, keys, request bodies, or an installation-wide "current" provider.
export async function route(job, disabled, active, attempts) {
  const inputs = await loadInputs(job)
  for (const candidate of active) {
    const { provider } = candidate
    job.signal.throwIfAborted()
    const entry = { provider }
    attempts.push(entry)
    if (disabled.has(provider)) {
      Object.assign(entry, { status: "skipped", reason: `本会话已停用：${disabled.get(provider)}` })
      continue
    }
    const unsupported = unsupportedReason(provider, job, inputs)
    if (unsupported) {
      Object.assign(entry, { status: "skipped", reason: unsupported })
      continue
    }
    const timeout = AbortSignal.timeout(10 * 60_000)
    try {
      const config = provider === "codex" ? undefined : await imageAPIConnection(candidate)
      await generate({ ...job, ...inputs, signal: AbortSignal.any([job.signal, timeout]), provider, config, candidate })
      entry.status = "succeeded"
      return provider
    } catch (error) {
      job.signal.throwIfAborted()
      Object.assign(entry, { status: "failed", reason: timeout.aborted ? "请求超时。" : error.message })
      if (error instanceof ProviderFailure && error.disable) disabled.set(provider, entry.reason)
      if (job.saved.length || !(error instanceof ProviderFailure) || !error.fallback) throw error
    }
  }
  throw new Error("没有可完成本次请求的服务。")
}
