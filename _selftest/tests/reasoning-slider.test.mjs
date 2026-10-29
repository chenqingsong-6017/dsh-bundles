/**
 * dsh-reasoning-slider 冒烟测试。
 *
 * Host 半体只有 9 行（纯 UI 插件，apply 是空函数），所以测试价值全在
 * 「manifest / patch / locale / icon 是否还齐全」——这恰恰是改 UI 时最容易弄坏的部分。
 */
import { runSmoke } from '../plugin-smoke.mjs'

await runSmoke('dsh-reasoning-slider')
console.log('reasoning-slider: 结构合规、apply 可挂载 ✓')
