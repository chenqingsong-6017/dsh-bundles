/**
 * 示例钩子：在每次 shell 调用之后回灌一句提醒。
 *
 * 用法（hooks.json 里）：
 *   {"event":"tool.post","match":"^(bash|pwsh)$","run":"node \"<bundle>/examples/post-reminder.mjs\""}
 *
 * 契约：stdin 一行 JSON；stdout 的纯文本会被 hooks 插件当作提示，
 *       追加到工具结果前面回灌给模型（exit 0）。
 *
 * 为什么用 node 而不是 echo：Windows 的 cmd.exe 按控制台代码页输出，
 * 中文会乱码；node 写管道固定是 UTF-8，跨平台干净。
 */
const raw = await new Promise((resolve) => {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
  })
  process.stdin.on('end', () => resolve(buffer))
})

let payload = {}
try {
  payload = JSON.parse(raw)
} catch {
  // 读不懂就静默放行
}

const tool = payload?.tool?.name ?? 'shell'
const command = String(payload?.tool?.arguments?.command ?? '')
const short = command.replace(/\s+/g, ' ').slice(0, 80)

console.log(`(dsh-hooks) 刚跑了 ${tool}${short ? `：${short}` : ''} —— 先看输出、再下结论；失败要修而不是重跑。`)
