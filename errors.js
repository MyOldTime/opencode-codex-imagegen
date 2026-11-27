// Only provider-side failures are eligible for routing. Filesystem and permission
// errors are deliberately not reclassified as provider failures.
export class ProviderFailure extends Error {
  constructor(message, { disable = false, fallback = true } = {}) {
    super(message)
    this.disable = disable
    this.fallback = fallback
  }
}

export function upstreamError(status, error = {}, submission = true) {
  const code = String(error?.code ?? "").toLowerCase()
  const source = error?.metadata?.limit_source
  const policy = status === 422 || /moderation|content[_ -]?(policy|filter)|safety|output_blocked|policy_violation/i.test(`${code} ${String(error?.message ?? "")}`)
  const temporary = source === "openrouter_in_flight_budget" || ["rate_limited", "upstream_rate_limited"].includes(code)
  const keyBlocked = status === 403 && /(?:key|account).{0,24}(?:disabled|suspended|spend(?:ing)? limit)|spend(?:ing)? limit.{0,16}reached/i.test(String(error?.message ?? ""))
  const account = status === 401 || status === 402 || keyBlocked || source === "openrouter_key_limit" ||
    ["invalid_api_key", "authentication_failed", "insufficient_quota", "insufficient_user_quota", "async_not_enabled", "key_disabled"].includes(code)
  const disable = submission && account && !temporary && !policy
  const hint = policy ? "内容或策略限制" : temporary || status === 429 ? "临时限流或预算限制" :
    code === "async_not_enabled" ? "账户未启用 AIHubMix 异步任务" :
    status === 401 ? "密钥无效" : status === 402 ? "额度不足" : status === 403 ? "访问受限" : "上游请求失败"
  return new ProviderFailure(`HTTP ${status}（${hint}）`, { disable, fallback: !policy })
}
