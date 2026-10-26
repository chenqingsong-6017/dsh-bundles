import assert from 'node:assert/strict'
import { extractSymbols } from '../../dsh-repomap/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const js = ['export function alpha() {}', 'const beta = (x) => x', 'export class Gamma {}', 'export interface Delta {}'].join('\n')
const jsNames = extractSymbols('.ts', js).map((symbol) => symbol.name).join(',')
assert.equal(jsNames, 'alpha,beta,Gamma,Delta')
ok('JS/TS 符号抽取顺序正确')

assert.equal(extractSymbols('.ts', js)[0].line, 1)
ok('行号从 1 开始')

const py = ['class Alpha:', '    def beta(self):', '        pass', '', 'def gamma():'].join('\n')
assert.equal(extractSymbols('.py', py).map((symbol) => symbol.name).join(','), 'Alpha,beta,gamma')
ok('Python 符号抽取')

assert.equal(extractSymbols('.go', 'package main\nfunc helper() {}').map((symbol) => symbol.name).join(','), 'helper')
ok('Go 符号抽取')

assert.equal(extractSymbols('.txt', 'function nope() {}').length, 0)
ok('不支持的扩展名不产出符号')

// 打包器 interop 噪音必须被过滤
const bundled = 'function __export() {}\nfunction __toESM() {}\nexport function real() {}'
assert.equal(extractSymbols('.js', bundled).map((symbol) => symbol.name).join(','), 'real')
ok('打包器辅助函数被过滤')

console.log(`repomap: ${passed} 项通过`)
