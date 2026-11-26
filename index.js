import path from "node:path"
import { generateImage, validateInput, pluginConfig, GOOGLE_ASPECT_RATIOS, GOOGLE_IMAGE_SIZES, GOOGLE_MAX_REFERENCES } from "./core.mjs"

export default {
  id: "opencode-codex-imagegen",
  async setup(ctx) {
    const google = ctx.options?.provider === "google"
    await ctx.tool.transform(editor => {
      editor.add({
        name: "proxy_imagegen",
        description: google
          ? "Generate or edit an image through the Google Gemini API (Nano Banana by default). Omit images for text-to-image; pass local reference images to edit or combine them. Saves one PNG or JPEG without overwriting existing files."
          : "Generate or edit an image with OpenAI's Responses hosted image_generation tool. Uses explicit options.base_url/options.key when configured; otherwise routes through the OpenAI account signed in to OpenCode (Sign in with ChatGPT, or the legacy Codex browser/device-code methods). Supports reference images; saves one PNG and never overwrites existing files. Size and quality are best-effort; the backend selects the actual image model.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Describe the image; when using references explain each image's role in order." },
            out: { type: "string", description: `${google ? "PNG or JPEG" : "PNG"} output path, relative to the current session directory or absolute.` },
            images: { type: "array", items: { type: "string" }, ...(google ? { maxItems: GOOGLE_MAX_REFERENCES } : {}), description: `Local reference image paths (PNG, JPEG, ${google ? "" : "GIF, "}WebP).` },
            ...(google ? {
              aspect_ratio: { type: "string", enum: GOOGLE_ASPECT_RATIOS, description: "Optional width:height ratio; model support varies." },
              image_size: { type: "string", enum: GOOGLE_IMAGE_SIZES, description: "Optional output resolution tier; model support varies." },
            } : {
              quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
              size: { type: "string", description: "auto or WIDTHxHEIGHT; exact dimensions depend on the backend." },
            }),
          },
          required: ["prompt", "out"],
          additionalProperties: false,
        },
        async execute(input, context) {
          // Options are validated before anything network- or credential-related happens.
          const config = pluginConfig(ctx.options)
          validateInput(input, config.provider)
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
          const output = path.resolve(directory, input.out)
          const extension = path.extname(output)
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source,
            action: "edit",
            resources: [output, `${output.slice(0, -extension.length)}-v*${extension.toLowerCase()}`],
          })
          const result = await generateImage(input, config, directory, { ctx, signal: context.signal, sessionID: context.sessionID })
          return {
            content: `Saved ${extension.toLowerCase() === ".png" ? "PNG" : "JPEG"}: ${result.out}${result.versioned ? " (versioned; existing file preserved)" : ""}`,
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
