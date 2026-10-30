# 验证记录

测试日期：2026-10-30。宿主 OpenCode 2.2.0，Node.js 24.18.0，Windows。

## 自动化测试

- `npm ci --ignore-scripts`：通过（无新增依赖，0 vulnerabilities）。
- `npm run check`：通过。
- `npm test`：36 项通过，无跳过（`test.mjs` 26 项 + `release.test.mjs` 10 项）。
- `npm pack --dry-run --json`：通过，`@myoldtime/opencode-codex-imagegen@0.1.0`，7 个文件（`package.json`、`index.js`、`core.mjs`、`README.md`、`VALIDATION.md`、`CHANGELOG.md`、`LICENSE`）。
- 包内容使用 `package.json` 的 `files` 白名单，不包含凭据、原始响应、测试图片、测试脚本、`.github` 或机器配置。
- 路由测试覆盖显式 API key、宿主托管 API key 和三种 OAuth 方法；另覆盖权限、凭据刷新委托、严格配置校验、错误脱敏、流式解析、取消与超时、引用图片以及文件不覆盖。

## 本轮重命名与双源发布准备（离线）

- 本轮只做元数据与文档重命名，未重新联网生成图片：`core.mjs` 逻辑未改动。改名前后的 SHA256 均为 `D04176C047A350BD2198A56EFE024385B1DDB6E862571293010D0EDEF7EFC896`；`index.js` 仅插件 ID 从 `myoldtime.codex-proxy-imagegen` 改为 `opencode-codex-imagegen`，工具名 `proxy_imagegen` 不变。
- 包名在 npmjs 与 GitHub Packages 统一为 `@myoldtime/opencode-codex-imagegen`，`package.json` 与 `package-lock.json` 同名同版本（0.1.0，MIT）。
- `publish:npm` / `publish:github` 各自显式给出 `--registry` 与 `--@myoldtime:registry`（同一目标 URL），`publishConfig` 只保留 `access: public`，项目不含 `.npmrc`；`release.test.mjs` 断言脚本、workflow 的 registry/scope override、tag 与版本、`access`、`NODE_AUTH_TOKEN` 仅来自 `secrets.GITHUB_TOKEN`、files 白名单不含凭据与测试。
- GitHub Actions 只在 Release `published` 时发布 GitHub Packages；npmjs 由本机已登录账号在用户未来单独确认后执行 `npm run publish:npm`。本机 npm 登录不会传入 Actions，因此没有配置 `NPM_TOKEN`，也未做 OIDC 自动授权。

## 真实请求（历史记录，本轮未重复执行）

下表是代码与账号能力的历史验证，不属于本轮离线重命名验证；本轮未再次联网生成，也未验证真实发布。

| 通道 | 当前证据 | 范围 |
|---|---|---|
| 显式 API 配置 | 成功生成 PNG，1536×1024 | 通过既有 Responses 兼容中转，非官方 API key 直连验证 |
| Codex browser (legacy) | 成功生成 PNG，1536×1024，约 21 秒 | 在隔离测试插件中调用生产核心，并使用真实宿主 `connection.active/resolve`，没有手动读取或刷新凭据文件；临时会话已清理 |
| Sign in with ChatGPT | 上游拒绝：HTTP 400 / `subscription_sharing_unsupported_capability`，约 1.8 秒 | 用户确认准备后，经真实宿主解析此登录方式并请求官方 Responses；没有生成图片，没有重试或换通道；不是生图成功 |
| Codex device code (legacy) | 成功生成 PNG，1536×1024，约 23 秒 | 用户确认准备后，经真实宿主 `connection.active/resolve` 解析 device-code 登录；临时会话已清理 |

实际图片尺寸可能由上游调整，不保证与请求尺寸完全一致。验证仅针对当次账号、模型和服务状态，不承诺所有订阅与未来上游版本均可用。

legacy 验证发现真实响应可能省略 Content-Type，已修复为有界前缀格式检测，并新增单字节分片回归；另外通过保留的真实响应离线重放恢复图片，未为重放重复发起请求。

## 发布与安装

**当前状态：尚未创建远端仓库、未 push、未打 tag、未发布 Release、未运行任何发布命令，也未切换正在使用的插件。** 本节命令只有用户未来单独确认后才会使用。

- npmjs：本机 `npm whoami` 已确认为 `myoldtime`（只读检查，未登录、未读取 token）；确认后执行 `npm run publish:npm`。发布前可先运行只读的 `npm view @myoldtime/opencode-codex-imagegen@0.1.0 version --registry=https://registry.npmjs.org --@myoldtime:registry=https://registry.npmjs.org` 与 `npm pack --dry-run`（查固定版本，并显式覆盖可能存在的 scope 映射）。
- GitHub Packages：在 <https://github.com/MyOldTime/opencode-codex-imagegen> 发布 Release（tag `v0.1.0`）后，由 [Actions](https://github.com/MyOldTime/opencode-codex-imagegen/actions) 中的 `publish.yml` 发布，并在同一 workflow 里做版本校验。实际发布状态以 Actions 与 [Release](https://github.com/MyOldTime/opencode-codex-imagegen/releases/tag/v0.1.0) 为准。
- 安装应使用固定版本，并确认宿主显示插件来源为 package 而非旧本地目录。README 中在线安装说明均标注为"发布后可用"。
