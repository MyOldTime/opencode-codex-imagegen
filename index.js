import path from "node:path"
import { generateImage, validateInput, pluginConfig } from "./core.mjs"

export default {
  id: "opencode-codex-imagegen",
  async setup(ctx) {
    await ctx.tool.transform(editor => {
      editor.add({
        name: "proxy_imagegen",
        description: "Generate or edit an image with OpenAI's Responses hosted image_generation tool. Uses explicit options.base_url/options.key when configured; otherwise routes through the OpenAI account signed in to OpenCode (Sign in with ChatGPT, or the legacy Codex browser/device-code methods). Supports reference images; saves one PNG and never overwrites existing files. Size and quality are best-effort; the backend selects the actual image model.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Describe the image; when using references explain each image's role in order." },
            out: { type: "string", description: "PNG output path, relative to the current session directory or absolute." },
            quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
            size: { type: "string", description: "auto or WIDTHxHEIGHT; exact dimensions depend on the backend." },
            images: { type: "array", items: { type: "string" }, description: "Local reference image paths (PNG, JPEG, GIF, WebP)." },
          },
          required: ["prompt", "out"],
          additionalProperties: false,
        },
        async execute(input, context) {
          validateInput(input)
          // Options are validated before anything network- or credential-related happens.
          const config = pluginConfig(ctx.options)
          const session = await ctx.session.get({ sessionID: context.sessionID })
          const directory = session.location.directory
          // Respect normal OpenCode edit rules, including external-directory approval.
          const source = { type: "tool", messageID: context.messageID, id: context.id }
          if (input.images?.length) await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source,
            action: "read",
            resources: input.images.map(file => path.resolve(directory, file)),
          })
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source,
            action: "edit",
            resources: [path.resolve(directory, input.out), path.resolve(directory, input.out).slice(0, -4) + "-v*.png"],
          })
          const result = await generateImage(input, config, directory, { ctx, signal: context.signal, sessionID: context.sessionID })
          return {
            content: `Saved PNG: ${result.out}${result.versioned ? " (versioned; existing file preserved)" : ""}`,
            metadata: {
              out: result.out,
              versioned: result.versioned,
              bytes: result.bytes,
              route: result.route,
              method: result.method,
              model: result.model,
            },
          }
        },
      })
    })
  },
}
