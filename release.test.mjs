import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))
const read = file => fs.readFileSync(path.join(root, file), "utf8")
const pkg = JSON.parse(read("package.json"))
const lock = JSON.parse(read("package-lock.json"))

const PACKAGE_NAME = "@myoldtime/opencode-codex-imagegen"
const PLUGIN_ID = "opencode-codex-imagegen"
const TOOL_NAME = "proxy_imagegen"
const REPO = "https://github.com/MyOldTime/opencode-codex-imagegen"
const NPM_REGISTRY = "https://registry.npmjs.org"
const GITHUB_REGISTRY = "https://npm.pkg.github.com"
const SCOPE_FLAG = "--@myoldtime:registry="

// Layout-independent view of the workflow: all runs/keys on one line.
const workflow = read(path.join(".github", "workflows", "publish.yml"))
const flat = workflow.replace(/\s+/g, " ")
// Comments may legitimately mention npm login (to say CI never uses it), so
// credential checks look at executable lines only.
const workflowCode = workflow.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join("\n")

function step(name) {
  const start = flat.indexOf(`name: ${name}`)
  assert.notEqual(start, -1, `workflow step "${name}" must exist`)
  const next = flat.indexOf("name: ", start + 1)
  return flat.slice(start, next === -1 ? undefined : next)
}

test("manifest publishes the scoped package name and lock stays in sync", () => {
  assert.equal(pkg.name, PACKAGE_NAME)
  assert.equal(pkg.version, "0.1.0")
  assert.equal(pkg.license, "MIT")
  assert.equal(lock.name, PACKAGE_NAME)
  assert.equal(lock.packages[""].name, PACKAGE_NAME)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[""].version, pkg.version)
})

test("repository, homepage and bugs all point at the renamed repository", () => {
  assert.equal(pkg.repository.url, `git+${REPO}.git`)
  assert.equal(pkg.homepage, `${REPO}#readme`)
  assert.equal(pkg.bugs.url, `${REPO}/issues`)
  const readme = read("README.md")
  assert.ok(readme.includes(REPO), "README must link the repository")
  assert.ok(!readme.includes("MyOldTime/codex-proxy-imagegen"), "README must not keep the old repository link")
})

test("plugin id uses the project name and the tool name stays stable", () => {
  assert.match(read("index.js"), new RegExp(`id:\\s*"${PLUGIN_ID}"`))
  assert.match(read("index.js"), new RegExp(`name:\\s*"${TOOL_NAME}"`))
  assert.match(read("test.mjs"), new RegExp(`assert\\.equal\\(plugin\\.id, "${PLUGIN_ID}"\\)`))
  assert.doesNotMatch(read("index.js"), /myoldtime\.codex-proxy-imagegen/)
})

test("README presents the current id and tool name without legacy names", () => {
  const readme = read("README.md")
  assert.ok(readme.includes(PLUGIN_ID), "README must document the current plugin id")
  assert.ok(readme.includes(TOOL_NAME), "README must document the tool name")
  assert.ok(!readme.includes("codex-proxy-imagegen"), "README must not mention legacy ids")
  assert.ok(!readme.includes("从本地插件迁移"), "README must not keep the migration section")
  assert.ok(!readme.includes("保持不变"), "README must not keep development-time naming notes")
  // Installation must document all four supported sources with pinned versions.
  const install = readme.slice(readme.indexOf("## 安装"), readme.indexOf("## 配置"))
  const codeBlocks = (install.match(/```(?:sh|powershell)\n([\s\S]*?)```/g) ?? [])
    .map(block => block.replace(/^```[a-z]*\n|```$/g, ""))
  const pinnedNpm = `opencode plugin add "${PACKAGE_NAME}@0.1.0"`
  const pinnedTag = 'opencode plugin add "github:MyOldTime/opencode-codex-imagegen#v0.1.0"'
  assert.ok(codeBlocks.some(block => block.includes(pinnedNpm)), "npm install must pin the published version")
  assert.ok(codeBlocks.some(block => block.includes(pinnedTag)), "tag install must use the repository tag")
  assert.ok(
    codeBlocks.filter(block => block.includes("opencode plugin list")).length >= 3,
    "npm, tag and GitHub Packages installs must verify with plugin list"
  )
  assert.ok(install.includes("read:packages"), "GitHub Packages install must state the token permission")
  assert.ok(install.includes("personal access token (classic)"), "GitHub Packages install must name the classic PAT")
  assert.ok(install.includes("npm login --scope=@myoldtime"), "GitHub Packages install must log in to the scoped registry")
  assert.ok(install.includes("/reload"), "install must mention the in-TUI reload")
  assert.ok(install.includes("git clone https://github.com/MyOldTime/opencode-codex-imagegen.git"), "local install must clone the documented repository")
  assert.ok(install.includes("npm ci --ignore-scripts"), "local install must install without running scripts")
  assert.ok(/绝对路径/.test(install) && /不能指向单个文件/.test(install), "local install must require an absolute directory path")
  assert.ok(install.includes(`${PACKAGE_NAME}@0.1.0`), "README config example must pin the released version")
  assert.doesNotMatch(install, /autotitle/i, "install section must not copy another plugin's instructions")
  assert.doesNotMatch(install, /迁移|保持不变/, "install section must not keep migration or naming notes")
  // The read-only check block must not tell users to publish.
  const section = readme.slice(readme.indexOf("只读检查"))
  const fenceStart = section.indexOf("```powershell")
  const fenceEnd = section.indexOf("```", fenceStart + 3)
  const readOnly = section.slice(fenceStart, fenceEnd)
  assert.ok(readOnly.includes("npm pack --dry-run"), "read-only block must keep the pack check")
  assert.doesNotMatch(readOnly, /npm run publish|npm publish/, "read-only block must not contain a publish command")
  assert.ok(section.indexOf("实际发布命令") > -1, "publish command needs its own labelled block")
  // Every OpenCode config example must parse and carry the schema hint.
  const jsonBlocks = readme.match(/```json\n([\s\S]*?)```/g) ?? []
  const openCodeConfigs = jsonBlocks.filter(block => block.includes('"plugins"'))
  assert.ok(openCodeConfigs.length >= 1, "README must keep at least one OpenCode config example")
  for (const block of openCodeConfigs) {
    const config = JSON.parse(block.replace(/^```json\n|```$/g, ""))
    assert.equal(config.$schema, "https://opencode.ai/config.json", "each OpenCode config example needs $schema")
    assert.ok(Array.isArray(config.plugins) && config.plugins.length > 0, "each OpenCode config example needs a plugins entry")
  }
})

test("no registry is pinned by config, so each publish target stays explicit", () => {
  assert.equal(pkg.publishConfig.registry, undefined)
  assert.equal(pkg.publishConfig.access, "public")
  assert.equal(fs.existsSync(path.join(root, ".npmrc")), false)
})

test("both publish scripts pin their own registry and override the scope", () => {
  assert.equal(pkg.scripts["publish:npm"], `npm publish --registry=${NPM_REGISTRY} ${SCOPE_FLAG}${NPM_REGISTRY} --access=public`)
  assert.equal(pkg.scripts["publish:github"], `npm publish --registry=${GITHUB_REGISTRY} ${SCOPE_FLAG}${GITHUB_REGISTRY} --access=public`)
  assert.equal(pkg.scripts.prepublishOnly, "npm run check && npm test")
  for (const name of ["publish:npm", "publish:github"]) {
    assert.doesNotMatch(pkg.scripts[name], /NPM_TOKEN|_authToken/, `${name} must not embed credentials`)
  }
})

test("test and check scripts cover the release test, files stay free of tests", () => {
  assert.match(pkg.scripts.check, /node --check release\.test\.mjs$/)
  assert.match(pkg.scripts.test, /release\.test\.mjs/)
  for (const file of pkg.files) {
    assert.doesNotMatch(file, /test|\.npmrc|\.github|auth|token|secret/i, `files entry ${file} must not ship tests, config or credentials`)
  }
  for (const required of ["index.js", "core.mjs", "README.md", "LICENSE", "CHANGELOG.md", "VALIDATION.md"]) {
    assert.ok(pkg.files.includes(required), `files must ship ${required}`)
  }
})

test("github workflow publishes only on release and verifies name, tag and access", () => {
  assert.match(flat, /on: release: types: \[published\]/)
  const verify = step("Verify release version")
  assert.ok(verify.includes(`assert.equal(p.name, '${PACKAGE_NAME}')`))
  assert.ok(verify.includes("assert.equal(process.env.RELEASE_TAG, 'v' + p.version"))
  assert.ok(verify.includes("assert.equal(p.publishConfig.access, 'public')"))
  assert.doesNotMatch(flat, /publishConfig\.registry/)
  assert.match(flat, /permissions: contents: read packages: write/)
})

test("github workflow pins the GitHub registry for publish and version checks", () => {
  const publish = step("Publish to GitHub Packages")
  assert.ok(publish.includes("npm publish --ignore-scripts"))
  assert.ok(publish.includes(`--registry=${GITHUB_REGISTRY}`))
  assert.ok(publish.includes(`${SCOPE_FLAG}${GITHUB_REGISTRY}`), "publish must override a user-level scope mapping")
  const view = step("Verify published version")
  assert.ok(view.includes("npm view"))
  assert.ok(view.includes(`--registry=${GITHUB_REGISTRY}`))
  assert.ok(view.includes(`${SCOPE_FLAG}${GITHUB_REGISTRY}`), "npm view must override a user-level scope mapping")
})

test("workflow tokens come only from the workflow env, never from a local npm login", () => {
  assert.ok(flat.includes("NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}"))
  assert.doesNotMatch(workflowCode, /NPM_TOKEN|_authToken/)
  assert.doesNotMatch(workflowCode, /npm (login|adduser|add-user)/)
  assert.doesNotMatch(workflowCode, /\b(ghp|npm)_[A-Za-z0-9]{16,}/)
  assert.doesNotMatch(flat, /setup-node[^;]*always-auth/)
})
