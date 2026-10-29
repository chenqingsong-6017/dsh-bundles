/**
 * dsh-plugin-eva-theme 冒烟测试。
 *
 * UI 主题插件：Host 侧只有 194 行，真正的东西在 client 半体。
 * 这里保证「结构合规 + 入口可加载 + apply 能挂载」，防止改主题时把 manifest 弄坏。
 *
 * 2026-10-29 补齐：原来缺 locale/ 与 icon（上游作者没按 DSH 规范做）。
 * 已补 locale/{zh,en}.json、icon.svg，并在 package.json 的 exports / files 里登记，
 * 所以这里不再用 allowMissing* 放水，改为严格检查。
 */
import { runSmoke } from '../plugin-smoke.mjs'

await runSmoke('dsh-plugin-eva-theme', { expectClient: true })
console.log('plugin-eva-theme: 结构合规、apply 可挂载 ✓')
