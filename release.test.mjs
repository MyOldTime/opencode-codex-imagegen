import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import plugin from "./index.js"

const root = path.dirname(fileURLToPath(import.meta.url))
const read = file => fs.readFileSync(path.join(root, file), "utf8")
const pkg = JSON.parse(read("package.json"))
const lock = JSON.parse(read("package-lock.json"))

const PACKAGE_NAME = "@myoldtime/opencode-codex-imagegen"
const PLUGIN_ID = "opencode-auto-imagegen"
const TOOL_NAME = "auto_imagegen"
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
  assert.equal(pkg.version, "1.1.0")
  assert.equal(pkg.license, "MIT")
  assert.equal(lock.name, PACKAGE_NAME)
  assert.equal(lock.packages[""].name, PACKAGE_NAME)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[""].version, pkg.version)
})

test("repository, homepage and bugs all point at the release repository", () => {
  assert.equal(pkg.repository.url, `git+${REPO}.git`)
  assert.equal(pkg.homepage, `${REPO}#readme`)
  assert.equal(pkg.bugs.url, `${REPO}/issues`)
  const readme = read("README.md")
  assert.ok(readme.includes(REPO), "README must link the repository")
})

test("public entry point registers exactly one image tool", async () => {
  assert.deepEqual(pkg.exports, { ".": "./index.js" })
  assert.equal(plugin.id, PLUGIN_ID)
  const tools = []
  const unload = await plugin.setup({
    tool: { transform: fn => fn({ add: def => tools.push(def.name) }) },
    event: { async *subscribe() {} },
  })
  try { assert.deepEqual(tools, [TOOL_NAME]) } finally { await unload() }
})

test("README documents the published package, actual tool and pinned plugin configuration", () => {
  const readme = read("README.md")
  const spec = `${PACKAGE_NAME}@${pkg.version}`
  assert.ok(readme.includes(PLUGIN_ID) && readme.includes(TOOL_NAME))
  assert.ok(readme.includes(`opencode plugin add "${spec}"`))
  const block = readme.match(/```jsonc\r?\n(\{[\s\S]*?)\r?\n```/)[1]
  const config = JSON.parse(block.replace(/[ \t]+\/\/.*$/gm, ""))
  assert.equal(config.$schema, "https://opencode.ai/config.json")
  assert.equal(config.plugins[0].package, spec)
  assert.deepEqual(Object.keys(config.plugins[0].options), ["codex", "openrouter", "aihubmix", "google"])
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
  for (const required of ["index.js", "parameters.js", "images.js", "routing.js", "codex.js", "google.js", "errors.js", "README.md", "LICENSE"]) {
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
