import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { configuredProviders, validateOptions, parameters, schema } from "./parameters.js"
import { reserveOutputs } from "./images.js"
import { route } from "./routing.js"

const pluginID = "opencode-auto-imagegen"

async function notify(ctx, message) {
  // A stable message ID makes retry safe even if the first admission succeeded
  // but its acknowledgement was lost. Never repeat the paid generation request.
  for (let attempt = 1; ; attempt++) {
    try {
      await ctx.session.synthetic(message)
      return
    } catch (error) {
      if (attempt === 3) throw error
      await delay(250 * attempt)
    }
  }
}

async function run(ctx, job, sessionID, jobID, disabled, active) {
  const saved = [], attempts = []
  let reason, upstreamID, provider
  try {
    provider = await route({ ...job, sessionID, saved, onTaskID: id => { upstreamID = id } }, disabled, active, attempts)
    if (saved.length < job.params.n) reason = "上游返回的图片少于请求数量。"
  } catch (error) {
    reason = job.signal.aborted ? job.signal.reason?.message ?? "任务已取消。" : error.message
  }
  const status = saved.length === job.params.n ? "完成" : saved.length ? "部分完成" : "失败"
  const summary = `生图${status}（${saved.length}/${job.params.n}），任务 ${jobID}`
  const routes = attempts.map(x => `${x.provider}: ${x.status}${x.reason ? `（${x.reason}）` : ""}`).join(" → ")
  const text = [summary, routes, reason, upstreamID && `AIHubMix 任务：${upstreamID}`, ...saved.map(file => `已保存：${file}`)].filter(Boolean).join("\n")
  await notify(ctx, {
    sessionID, id: `msg_${jobID}`, delivery: "queue", resume: true,
    text: `${text}\n请告知用户结果；无需再次调用生图工具。`,
    metadata: { plugin: pluginID, jobID, saved, attempts, ...(provider && { provider }), requested: job.params.n, ...(upstreamID && { upstreamID }) },
  })
}

export default {
  id: pluginID,
  async setup(ctx) {
    const options = ctx.options ?? {}
    validateOptions(options)
    const sessions = new Map()
    const reserved = new Set()
    const running = new Set()
    const lifecycle = new AbortController()
    await ctx.tool.transform(editor => {
      editor.add({
        name: "auto_imagegen",
        options: { codemode: false },
        description: "Generate or edit images in the background. Default: Codex then Google Gemini using OpenCode connections. When providers are configured, try only those providers in configuration order. Choose parameters from the user's intent. Submit once; the originating session receives the actual provider, paths or failure. Do not poll or resubmit.",
        input: schema,
        async execute(input, context) {
          const params = parameters(input)
          const { sessionID } = context
          const active = await configuredProviders(options, { integration: ctx.integration?.connection, sessionDisabled: sessions.get(sessionID) })
          if (!active.length) throw new Error("没有可用的生图服务：默认使用 OpenCode 的 OpenAI 或 Google 连接；若已配置 options，请确认列出的服务至少有一家已启用且有可用凭据。")
          const jobID = randomUUID()
          const { location } = await ctx.session.get({ sessionID })
          const sources = (input.images ?? []).map(file => path.resolve(location.directory, file))
          const mask = input.mask && path.resolve(location.directory, input.mask)
          const assert = (action, resources) => ctx.permission.assert({
            sessionID, agent: context.agent, action, resources,
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })
          if (sources.length) await assert("read", mask ? [...sources, mask] : sources)
          const first = path.resolve(location.directory, input.out ?? `images/imagegen-${jobID}.${params.output_format}`)
          const { paths, release } = await reserveOutputs(first, params.n, reserved)
          try {
            await assert("edit", paths)
            context.signal.throwIfAborted()
            lifecycle.signal.throwIfAborted()
          } catch (error) {
            release()
            throw error
          }

          // The tool call's signal ends with the foreground turn. Only plugin
          // unload and the job's own deadline should stop an admitted job.
          if (!sessions.has(sessionID)) sessions.set(sessionID, new Map())
          const aspect = input.size && input.size !== "auto" ? undefined : input.aspect_ratio ?? "auto"
          const task = run(ctx, { params, aspect, imageSize: input.image_size, sources, mask, paths, signal: lifecycle.signal }, sessionID, jobID, sessions.get(sessionID), active)
            .catch(() => console.error(`[${pluginID}] Could not notify session ${sessionID} for job ${jobID}. Planned outputs: ${paths.join(", ")}`))
            .finally(() => { release(); running.delete(task) })
          running.add(task)
          return {
            content: `后台生图任务已提交：${jobID}（请求 ${params.n} 张）。完成后会通知本会话，无需等待或轮询。`,
            metadata: { jobID, status: "submitted", requested: params.n },
          }
        },
      })
    })
    // Archive/delete clear this session only. A detached job retains its old
    // map, so even a late 401 cannot recreate state for a removed session.
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.archived", "session.deleted"], signal: lifecycle.signal })) {
        sessions.delete(event.data.sessionID)
      }
    })().catch(() => { if (!lifecycle.signal.aborted) console.error(`[${pluginID}] Session lifecycle subscription ended.`) })
    return async () => {
      lifecycle.abort(new Error("插件已卸载，后台任务已取消。"))
      sessions.clear()
      await Promise.allSettled([...running, events])
    }
  },
}
