/**
 * 工具输出 schema 自检（开发期脚本，不是插件）。
 *
 * 为什么有它：DSH 的工具输出 schema 是**严格校验**的（`additionalProperties:false`），
 * 返回值多/少一个字段、类型不符，整次调用都会以 `tool "x" returned invalid output` 失败。
 * 这一轮就为此白跑了好几轮 remove/install。
 *
 * 做法：用假的 ctx 加载每个 bundle 的 apply()，拿到**真实的**工具定义（render 闭包可用），然后：
 *   1. 基本形状：name / description / parameters / output.schema+render
 *   2. schema 结构：type 合法、required ⊆ properties、array 必有 items、enum 非空、
 *      additionalProperties 是布尔、没有未知关键字
 *   3. render 冒烟：按 schema 自动生成样例值喂给 render，必须返回 {type:'text',text}[] 数组
 *
 * 用法：node D:\AI\dsh-bundles\_selftest\schema-check.mjs [bundleDir...]
 */

import { readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:\\AI\\dsh-bundles'
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'oneOf',
  'description',
  'title',
  'default',
  'examples',
  'const',
  'minimum',
  'maximum',
])

function checkSchema(node, at, problems) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    problems.push(`${at}: schema 节点必须是对象`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) problems.push(`${at}: 未知 schema 关键字 "${key}"`)
  }
  if (node.type !== undefined && !ALLOWED_TYPES.has(node.type)) {
    problems.push(`${at}: 非法 type ${JSON.stringify(node.type)}`)
  }
  if (node.type === 'array' && node.items === undefined) problems.push(`${at}: type=array 但缺 items`)
  if (node.properties !== undefined || node.type === 'object') {
    const properties = node.properties ?? {}
    if (typeof properties !== 'object' || Array.isArray(properties)) problems.push(`${at}: properties 必须是对象`)
    if (node.required !== undefined) {
      if (!Array.isArray(node.required)) problems.push(`${at}: required 必须是数组`)
      else for (const name of node.required) if (!(name in properties)) problems.push(`${at}: required 里的 "${name}" 不在 properties 中`)
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      problems.push(`${at}: additionalProperties 必须是布尔`)
    }
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) problems.push(`${at}: enum 必须是非空数组`)
    else if (node.type !== undefined) {
      const allowed = node.enum.every((value) => {
        if (node.type === 'string') return typeof value === 'string'
        if (node.type === 'integer') return Number.isInteger(value)
        if (node.type === 'number') return typeof value === 'number'
        if (node.type === 'boolean') return typeof value === 'boolean'
        return true
      })
      if (!allowed) problems.push(`${at}: enum 取值与 type=${node.type} 不符`)
    }
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) checkSchema(child, `${at}.${key}`, problems)
  if (node.items !== undefined) checkSchema(node.items, `${at}[]`, problems)
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((child, index) => checkSchema(child, `${at}.oneOf[${index}]`, problems))
}

function sampleFor(node) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) return sampleFor(node.oneOf[0])
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0]
  switch (node.type) {
    case 'object': {
      const value = {}
      for (const [key, child] of Object.entries(node.properties ?? {})) value[key] = sampleFor(child)
      return value
    }
    case 'array':
      return node.items ? [sampleFor(node.items)] : []
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return true
    case 'string':
      return 'x'
    default:
      return null
  }
}

function fakeContext() {
  const registered = new Map()
  const dispose = () => {}
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return dispose
      },
      guard() {
        return dispose
      },
      restrict() {
        return dispose
      },
      schemas() {
        return []
      },
      get() {
        return undefined
      },
    },
    effect(callback) {
      callback()
      return dispose
    },
    on() {
      return dispose
    },
    provide() {
      return dispose
    },
    inject() {
      return dispose
    },
    get() {
      return undefined
    },
    systemPrompt: { context: () => dispose, section: () => dispose, tools: () => dispose, variable: () => dispose },
  }
  return { ctx, registered }
}

function bundleDirs(argv) {
  const targets = argv.slice(2)
  if (targets.length > 0) return targets.map((dir) => path.resolve(dir))
  return readdirSync(ROOT)
    .map((name) => path.join(ROOT, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(path.join(dir, 'index.js')))
    .filter((dir) => !path.basename(dir).startsWith('_'))
}

let failures = 0
let toolCount = 0
const report = []

for (const dir of bundleDirs(process.argv)) {
  const name = path.basename(dir)
  const entry = path.join(dir, 'index.js')
  const { ctx, registered } = fakeContext()
  try {
    const module = await import(pathToFileURL(entry).href + `?ts=${Date.now()}`)
    if (typeof module.apply !== 'function') {
      failures += 1
      report.push(`FAIL ${name}: 没有导出 apply()`)
      continue
    }
    module.apply(ctx, {})
  } catch (error) {
    failures += 1
    report.push(`FAIL ${name}: apply() 抛错 — ${error.message}`)
    continue
  }

  if (registered.size === 0) {
    report.push(`SKIP ${name}: 没注册工具（纯配置 bundle 属正常）`)
    continue
  }

  for (const [toolName, definition] of registered) {
    toolCount += 1
    const label = `${name}/${toolName}`
    const problems = []
    if (typeof definition.description !== 'string' || definition.description.trim() === '') problems.push('description 缺失')
    if (!definition.parameters || typeof definition.parameters !== 'object') problems.push('parameters 缺失')
    if (typeof definition.execute !== 'function') problems.push('execute 不是函数')
    const output = definition.output
    if (!output || typeof output !== 'object') problems.push('output 缺失（schema + render 必须成对）')
    else {
      if (!output.schema || typeof output.schema !== 'object') problems.push('output.schema 缺失')
      else checkSchema(output.schema, 'output.schema', problems)
      if (typeof output.render !== 'function') problems.push('output.render 不是函数')
      else if (output.schema) {
        try {
          const rendered = output.render(undefined, sampleFor(output.schema))
          if (!Array.isArray(rendered)) problems.push('render 没有返回数组')
          else
            for (const block of rendered) {
              if (!block || block.type !== 'text' || typeof block.text !== 'string') {
                problems.push('render 返回的块不是 {type:"text",text}')
                break
              }
            }
        } catch (error) {
          problems.push(`render 用样例值跑挂了 — ${error.message}`)
        }
      }
    }
    if (problems.length === 0) report.push(`PASS ${label}`)
    else {
      failures += 1
      report.push(`FAIL ${label}\n       - ${problems.join('\n       - ')}`)
    }
  }
}

console.log(report.join('\n'))
console.log(`\n共检查 ${toolCount} 个工具，失败 ${failures} 个`)
process.exitCode = failures === 0 ? 0 : 1
