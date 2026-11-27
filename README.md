# opencode-auto-imagegen

一个 OpenCode V2 后台生图工具 `auto_imagegen`，按 **Codex → OpenRouter → AIHubMix → Google Gemini** 的顺序选择有凭据且支持本次参数的服务。前台拿到本地任务 ID 后可继续对话，完成时原会话收到实际服务商、切换原因及保存路径。

## 安装

在 OpenCode V2 中安装 [npm 包](https://www.npmjs.com/package/@myoldtime/opencode-codex-imagegen)：

```sh
opencode plugin add "@myoldtime/opencode-codex-imagegen@1.0.0"
opencode plugin list
```

也可从 [GitHub 仓库](https://github.com/MyOldTime/opencode-codex-imagegen) 的 `v1.0.0` 标签加载源码：在插件目录运行 `npm ci --ignore-scripts`，将下方 `package` 改为该目录的绝对路径。

## 配置

在项目或全局 `opencode.jsonc` 的 `plugins` 中配置插件；已安装时直接编辑同一条目。**只需一家可用凭据**，示例中不使用的服务段可以省略。Codex 可以复用 OpenCode 已连接的 OpenAI 账号，也可以使用独立 key；其余服务使用各自的 key。没有可用凭据时不创建后台任务。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@myoldtime/opencode-codex-imagegen@1.0.0",
      "options": {
        "codex": {
          "disabled": false,
          "model": "gpt-6.2-sol" // 对话模型 ID；不填 key 和 base_url 时使用 OpenCode 的 OpenAI 登录
        },
        "openrouter": {
          "disabled": false,
          "base_url": "https://openrouter.ai/api/v1",
          "key": "{env:OPENROUTER_API_KEY}",
          "model": "openai/gpt-image-2.5-sunburst" // 可选：填写 OpenRouter 上的生图模型 ID
        },
        "aihubmix": {
          "disabled": false,
          "base_url": "https://aihubmix.com/ai/v1",
          "key": "{env:AIHUBMIX_API_KEY}",
          "model": "gpt-image-2.5-sunburst" // 可选：填写 AIHubMix 上的生图模型 ID
        },
        "google": {
          "disabled": false,
          "base_url": "https://generativelanguage.googleapis.com",
          "key": "{env:GEMINI_API_KEY}",
          "model": "gemini-nano-banana-2.1"
        }
      }
    }
  ]
}
```

每个服务的 `disabled` 都是可选布尔值，默认 `false`。设为 `true` 后，该服务完全不参与首选或容错，不需要删除 key，也不会读取它的环境密钥或宿主登录。其余服务保持原有顺序；若全部禁用，工具会直接提示，不提交任务。

`model` 的含义按服务区分：

- **`codex.model` 是对话模型**，省略时默认 `gpt-6.2-sol`。它作为 Responses 请求的顶层 `model`，由 `tool_choice: {"type":"image_generation"}` 指定调用托管生图工具。实际生图模型由后端选择。`size` 和 `quality` 传给工具，不作为对话模型的配置。
- **`openrouter.model` 和 `aihubmix.model` 是生图模型**，默认分别是 `openai/gpt-image-2.5-sunburst` 和 `gpt-image-2.5-sunburst`。切换时使用目标服务自己的模型，不会带入 Codex 对话模型 ID。
- **`google.model` 是支持图片输出的 Gemini 模型**，默认 `gemini-nano-banana-2.1`。

**Codex 的凭据**：省略 `codex` 整段或只填写 `codex.model` 时，插件通过宿主查询当前 OpenAI 连接。支持宿主管理的 API key、Sign in with ChatGPT 和 legacy Codex 登录；账号不具备生图能力时进入容错流程。要用显式 API key 或 Responses 代理，可以改成：

```jsonc
"codex": {
  "base_url": "https://api.openai.com/v1", // 可换成支持 Responses 托管生图工具的代理
  "key": "{env:OPENAI_API_KEY}",
  "model": "gpt-6.2-sol"
}
```

显式 Codex key 不读取宿主凭据，只给 key 时使用官方 `/v1/responses`。配置代理地址却没给 key 时跳过 Codex，不会向代理发送宿主 token。若已登录但想跳过 Codex，写 `"codex": {"disabled": true}`。Codex 另支持可选的 `reasoning_effort` 和 `fast_mode`。

OpenRouter、AIHubMix 和 Google 使用官方地址时，省略服务配置也可读取 OpenCode 服务进程中对应的环境变量；显式填写空字符串或纯空白 `key` 则不启用该服务。使用代理时须显式指定 `key`。

AIHubMix 默认接口需要在[控制台开启异步任务](https://console.aihubmix.com/async-tasks)。也可填 `https://aihubmix.com/v1` 使用兼容端点（文生图及单图编辑）。两种接口都不会阻塞前台。

### Google Gemini

使用官方接口时，只要 OpenCode 服务进程中有 `GEMINI_API_KEY`，就可以省略整个 `google` 配置。只有 Google 有凭据时，普通文生图和参考图编辑会直接使用 Google。要通过代理调用，设置 `google.base_url` 和 `google.key`；例如 `https://proxy.example/gemini` 会请求 `/gemini/v1beta/interactions`，也可以直接填完整的 Interactions 端点。代理需支持 [Gemini Interactions REST](https://aistudio.google.com/api-reference/interactions-api/create-interaction) 的 JSON 协议，并转发 `x-goog-api-key` 和 `Api-Revision` 请求头。

例如「用 `auto_imagegen` 参考 `街景.png` 画一张 16:9、2K 的水彩画，保存为 `街景水彩.jpg`」：工具可用 `aspect_ratio: "16:9"` 和 `image_size: "2K"`。显式指定 `image_size`（`1K` / `2K` / `4K`）或 Google 专用画幅（`1:4`、`4:1`、`1:8`、`8:1`）时，前三家会跳过，不会降低要求改用默认尺寸。

Google 支持最多 14 张按顺序传入的 PNG、JPEG 或 WebP 参考图；含提示词和 Base64 图片的整个请求最多 20 MB。输出支持 PNG、JPEG，目标为 PNG 而上游返回 JPEG 时会在本地转码。精确像素 `size`、蒙版、WebP 输出、非自动质量或背景、显式压缩参数均不走 Google。

## 切换和会话隔离

| 情况 | 本次 | 同一会话的下一次 |
| --- | --- | --- |
| 首选服务成功 | 保存并通知 | 从首个可用服务开始 |
| 只有一家有凭据 | 直接使用该服务；未配置的服务不参与路由，也不记为失败 | 按调用时的凭据选择服务 |
| 401、欠费 402、已识别的密钥额度/停用错误 | 标记失效；有已配置的备用服务时切换 | 跳过已确认失效的服务 |
| 限流 429、临时并发预算不足、5xx、网络异常、无可用图片 | 尚未保存图片时按顺序切到下一家 | 重新从首个可用服务开始 |
| 已配置服务均不可用 | 发一条失败通知，列出各自原因 | 仅尝试未被标记失效的服务 |
| 本地权限/文件错误、明确的内容策略拒绝、已有部分图片 | 报告错误或已保存的图片，不另开生成请求 | 不改变服务状态 |

失效标记仅在**当前插件实例的内存中按 `sessionID` 保存**。同一会话跨回合保留（空闲不清除）；新会话、分支会话互不继承。归档、删除会话或重载插件会清掉对应标记。没有写入磁盘的路由状态，也不修改全局配置。任务通知仍按 OpenCode 的普通会话历史保留。更新密钥/充值后，开新会话或重载插件即可重新尝试。

每个任务按顺序经过每家至多一次；Codex 和 Google 每次生成一张，`n > 1` 时逐张请求并立即保存。Codex 支持 PNG、自动背景、无蒙版，质量 `auto/low/medium/high`；其余需求直接交给后续支持的服务，不标记 Codex 失效。已保存部分图片时不切换去补单。每个服务总时限为 10 分钟。网络中断时远端是否已接单可能无法确认，自动切换有可能导致多个服务产生费用。卸载插件停止本地等待。

## 使用

> 用 `auto_imagegen` 画 3 张精细的 9:16 手机壁纸，主题是雨夜花店，第一张保存到 `壁纸.png`。

工具可以选择 `quality: "high"`、`n: 3`、`aspect_ratio: "9:16"`。OpenRouter 接收画幅比例；若发生切换，AIHubMix 收到相同提示词、数量、参考图及对应的 `size: "864x1536"`。没有特别要求时默认自动画幅、自动质量、1 张 PNG。输出默认位于会话目录 `images/`，支持指定 `out`，遇到同名文件自动使用新名字。

可传 `images`（最多 16 张本地 PNG/JPEG/WebP）、`size` 或 `aspect_ratio`、`n`（1–10）、`quality`、`output_format`、`background`、`output_compression`。带 PNG `mask` 的编辑直接使用支持蒙版的 AIHubMix，不会影响同会话其他请求的优先级。AIHubMix `/v1` 模式不支持多参考图、显式背景或压缩参数；如需这些能力请使用默认 `/ai/v1`。

## 验证

```sh
npm run check
npm test
npm pack --dry-run
```

测试模拟四家服务及宿主凭据，覆盖四方切换、会话隔离、部分成功、后台通知、Codex Responses、AIHubMix 异步下载、Gemini Interactions 及图片转码，不消耗真实额度。

协议参考：[OpenRouter Sunburst](https://openrouter.ai/openai/gpt-image-2.5-sunburst?output_modalities=image&view=api) · [AIHubMix Sunburst](https://aihubmix.com/model/gpt-image-2.5-sunburst/llms.txt) · [AIHubMix 端点 Schema](https://aihubmix.com/call/schema/models/gpt-image-2.5-sunburst/endpoints)
