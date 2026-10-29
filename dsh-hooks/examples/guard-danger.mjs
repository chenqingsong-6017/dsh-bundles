/**
 * 示例钩子：拦住「不可逆」的破坏性命令。
 *
 * 用法（hooks.json 里）：
 *   {"event":"tool.pre","match":"^(bash|pwsh)$","run":"node \"<bundle>/examples/guard-danger.mjs\""}
 *
 * 契约：stdin 一行 JSON（payload.tool.arguments.command），
 *       命中危险模式 → stderr 写理由 + exit 2（hooks 插件视为 deny）。
 *
 * 只拦「删掉就回不来」的那几条；git reset --hard 这类可恢复的**不拦**，
 * 免得变成天天要点确认的噪音（真需要再加）。
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
  process.exit(0) // 读不懂就不管，别挡路
}

const command = String(payload?.tool?.arguments?.command ?? '')
if (command.trim() === '') process.exit(0)

const PATTERNS = [
  // 允许被引号/空白包住（echo "rm -rf /" 这种也要拦），但不误伤 rm -rf /tmp/x
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+["']?(\/|~|\*|[A-Za-z]:[\\/])(?:["'\s]|$)/i, why: '递归删除根目录 / 家目录 / 整个盘符' },
  { re: /\brm\s+-fr\s+["']?(\/|~|\*|[A-Za-z]:[\\/])(?:["'\s]|$)/i, why: '递归删除根目录 / 家目录 / 整个盘符' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bRemove-Item\b[^\n]*\b-Recurse\b[^\n]*\b[A-Za-z]:[\\/]?(?:["'\s]|$)/i, why: '递归强删整个盘符' },
  { re: /\b(mkfs|diskpart)\b/i, why: '建文件系统 / 分区操作' },
  { re: />\s*\/dev\/sd[a-z]\b/i, why: '直接写裸块设备' },
]

for (const { re, why } of PATTERNS) {
  if (re.test(command)) {
    console.error(`命中危险模式：${why}。这条命令不可逆，已被 dsh-hooks 拦下。`)
    process.exit(2)
  }
}

process.exit(0)
