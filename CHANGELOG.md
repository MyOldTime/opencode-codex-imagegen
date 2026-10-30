# Changelog

## 0.1.0

- 首个发布版本，包名 `@myoldtime/opencode-codex-imagegen`，插件 id `opencode-codex-imagegen`，工具名 `proxy_imagegen`（不变）。历史本地版本的 id（`local.codex-proxy-imagegen`、`myoldtime.codex-proxy-imagegen`）仅存在于迁移说明中作为旧 id 出现。
- 双源发布：npmjs 与 GitHub Packages 使用同一个 scoped 包名，各自通过显式 `--registry` + `--@myoldtime:registry` 发布；GitHub Actions 在 Release `published` 时发布 GitHub Packages，npmjs 由本机已登录账号在确认后执行 `npm run publish:npm`。
- 显式 `options.base_url` + `options.key` 优先，且完全不读取宿主凭据；仅给有效的 `key` 时默认 `https://api.openai.com/v1`。**只要写了 `base_url` / `key`，空串、`null`、全空白、未解析的 `{env:...}` 一律报错**，只有两者都完全省略才走宿主账号。
- 未配置凭据时通过 `ctx.integration.connection.active("openai")` + `resolve(connection)` 使用 OpenCode 托管的 OpenAI 账号，每次调用重新解析，刷新由宿主负责。
- 支持三种登录方法的路由：`chatgpt-token-sharing` → `https://api.openai.com/v1/responses`；`chatgpt-browser` / `chatgpt-headless` → `https://chatgpt.com/backend-api/codex/responses`；未知方法明确报错。
- 仍只使用 Responses 托管 `image_generation` 工具（非 Images API）。
- 失败不重试、不换通道；错误只暴露 HTTP 状态与白名单错误码，不输出上游正文、token 或账号。
- 响应体/SSE 读取期间的网络错误统一归一为固定文案；超时或取消后的晚到结果在落盘前丢弃，落盘阶段取消只清理本次新建的文件。
- 保留模型/画质/尺寸/推理强度/优先级/超时/参考图/PNG 独占版本保存行为。
- 内置自动化测试全部离线；另已实际验证 API 中转、两种 legacy 登录均出图成功。新版 Sign in with ChatGPT 被上游以 `subscription_sharing_unsupported_capability` 拒绝，限制已在文档明确说明。
- 兼容缺失 Content-Type 的 Codex SSE 响应，支持单字节/UTF-8 分片格式检测。
