/**
 * 通用插件合规冒烟检查。
 *
 * 给「没有行为单测」的插件用：只验证「装得上、结构齐、能挂载」，不做行为断言。
 * 行为断言应该由插件自己导出纯函数后再写（见 staleness-watch.test.mjs）。
 *
 * 检查项：
 *   1. package.json 有 name / version / dsh.bundle.patch
 *   2. patch 文件存在且含 insert 行
 *   3. locale/zh.json 与 locale/en.json 都有 meta.title + meta.description
 *   4. icon.svg 或 icon.png 存在
 *   5. 入口能 import 且导出 name(string) + apply(function)
 *   6. apply 能在最小 mock ctx 上跑通（不抛）
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BUNDLES = 'D:\\AI\\dsh-bundles'

/** package.json exports['.'] 可能是字符串，也可能是 { default } 对象。 */
function entryOf(pkg, dir) {
  const exported = pkg?.exports?.['.']
  const rel = typeof exported === 'string' ? exported : (exported?.default ?? exported?.import ?? './index.js')
  return path.join(dir, rel)
}

/** 最小 ctx：够让 apply 挂载工具 / 事件 / guard 而不抛。 */
export function makeMockContext() {
  const registered = []
  const guards = []
  const listeners = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name, handler) {
      listeners.push({ name, handler })
      return () => {}
    },
    get() {
      return undefined
    },
    /**
     * Cordis 的 `ctx.inject(deps, callback)`：依赖就绪时才调 callback。
     * 冒烟测试里这些服务都不存在，所以按真实语义**不调用**回调 ——
     * 这既避免假装有服务，也能验证 apply 在「依赖缺失」时不崩。
     */
    inject() {
      return () => {}
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
  }
  return { ctx, registered, guards, listeners }
}

export async function runSmoke(name, options = {}) {
  const { expectClient = false, allowMissingLocale = false, allowMissingIcon = false } = options
  const warnings = []
  const dir = path.join(BUNDLES, name)
  assert.ok(existsSync(dir), `${name}: 目录不存在`)

  // ---- package.json + patch ----
  const pkgFile = path.join(dir, 'package.json')
  assert.ok(existsSync(pkgFile), `${name}: 缺 package.json`)
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  assert.equal(typeof pkg.name, 'string', `${name}: package.json 缺 name`)
  assert.equal(typeof pkg.version, 'string', `${name}: package.json 缺 version`)

  const patchRel = pkg?.dsh?.bundle?.patch
  assert.equal(typeof patchRel, 'string', `${name}: 缺 dsh.bundle.patch`)
  const patchFile = path.join(dir, patchRel)
  assert.ok(existsSync(patchFile), `${name}: patch 文件不存在 ${patchRel}`)
  const patchText = readFileSync(patchFile, 'utf8')
  assert.match(patchText, /insert:/, `${name}: patch 里没有 insert 行`)

  // ---- locale ----
  for (const lang of ['zh', 'en']) {
    const file = path.join(dir, 'locale', `${lang}.json`)
    if (!existsSync(file)) {
      if (allowMissingLocale) {
        warnings.push(`缺 locale/${lang}.json（已知缺口，Plugin Manager 会回落到 package.json）`)
        continue
      }
      assert.fail(`${name}: 缺 locale/${lang}.json`)
    }
    const locale = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof locale?.meta?.title, 'string', `${name}: locale/${lang}.json 缺 meta.title`)
    assert.equal(typeof locale?.meta?.description, 'string', `${name}: locale/${lang}.json 缺 meta.description`)
  }

  // ---- icon ----
  const hasIcon = existsSync(path.join(dir, 'icon.svg')) || existsSync(path.join(dir, 'icon.png'))
  if (!hasIcon) {
    if (allowMissingIcon) warnings.push('缺 icon（已知缺口，Plugin Manager 会显示默认图）')
    else assert.fail(`${name}: 缺 icon.svg / icon.png`)
  }

  // ---- 入口可加载 + 导出形状 ----
  const entry = entryOf(pkg, dir)
  assert.ok(existsSync(entry), `${name}: 入口不存在 ${entry}`)
  const mod = await import(pathToFileURL(entry).href)
  assert.equal(typeof mod.name, 'string', `${name}: 缺 export const name`)
  assert.equal(typeof mod.apply, 'function', `${name}: 缺 export function apply`)

  // ---- apply 能在最小 ctx 上挂载 ----
  const { ctx } = makeMockContext()
  mod.apply(ctx, {})

  // ---- UI 插件额外要求 client 半体存在 ----
  if (options.expectClient) {
    const client = path.join(dir, 'lib', 'client.js')
    assert.ok(existsSync(client), `${name}: UI 插件缺 lib/client.js`)
  }

  return { dir, pkg, mod, warnings }
}
