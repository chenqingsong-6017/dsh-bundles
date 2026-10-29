import { apply } from 'file:///D:/AI/dsh-bundles/dsh-skill-forge/index.js'

const tools = new Map()
const providers = []
const ctx = {
  tools: { register(def) { tools.set(def.name, def); return () => {} } },
  skills: { registerProvider(factory) { providers.push(factory()); return () => {} } },
  effect(fn) {
    const ret = fn()
    if (ret && typeof ret.next === 'function') { let s = ret.next(); while (!s.done) s = ret.next(s.value) }
    return () => {}
  },
}

apply(ctx, { storeDir: 'D:\\AI\\dsh-data\\skills' })

const body = `## 何时用

需要升级 NVIDIA 显卡驱动、修复驱动异常，或新卡首次装驱动时使用。目标：装得上、验得清、退得回。

## 步骤

1. **记基线**：\`nvidia-smi\` 看当前版本；\`Get-CimInstance Win32_VideoController | Select Name,DriverVersion,Status\` 记下驱动号与状态。
2. **定版本与直链**：确认目标版本（如 621.01），拼官方直链
   \`https://us.download.nvidia.com/Windows/<版本>/<版本>-desktop-win10-win11-64bit-international-dch-whql.exe\`，
   用 HEAD 核 \`Content-Length\` 与 \`Last-Modified\`。
3. **下载**：curl 必须带 \`--ssl-no-revoke\`（Windows schannel 吊销检查会报错 35）与浏览器 UA/Referer（否则 403）。
   慢就分片并发（4 路为宜，8 路会被镜像限流到 0）。
4. **验包**：\`Get-AuthenticodeSignature\` 必须 \`Valid\` 且签署者 \`CN=NVIDIA Corporation\`；比对外层 exe 大小与 \`Content-Length\` 一致。
5. **建还原点**（管理员）：\`Checkpoint-Computer -Description "Before <版本>" -RestorePointType MODIFY_SETTINGS\`。
6. **静默安装**（管理员）：\`<包>.exe -s -noreboot\`。**不要加 -clean**——保留旧驱动包，才有回滚余地。
7. **装后自验**：驱动号、\`nvidia-smi\` 首行、签名、分辨率/刷新率、System 日志事件 4101（TDR）。
8. **确认重启要求**：查 \`PendingFileRenameOperations\`、CBS \`RebootPending\`、WU \`RebootRequired\` 三处标记。

## 坑

- 直链裸 curl 一律 403：必须带 UA + Referer。
- GitHub API 未认证限 60 次/小时，查得太勤会导致 Releases 资产下载返回 279 字节的 rate-limit JSON。
- 621.01 这种整包默认会**顺带装 NVIDIA App**（含 ShadowPlay、遥测）。只要裸驱动需另择最小化安装。
- 安装器退出码 0 不等于已生效：必须以 \`nvidia-smi\` 与 \`Win32_VideoController.DriverVersion\` 双向核对。
- 不带 \`-clean\` 时旧驱动仍在 DriverStore，设备管理器「回滚驱动程序」可用；带了就基本没退路。

## 验证

- \`nvidia-smi\` 首行显示目标版本（如 \`621.01\`），CUDA 版本随之更新。
- \`Win32_VideoController.Status\` 为 \`OK\`，分辨率与刷新率未变。
- 近 10 分钟 System 日志无事件 4101（显示驱动超时恢复）。
- 旧驱动包仍在 \`DriverStore\\FileRepository\\nv_disp*\`，可回滚。
- 无三处「必须重启」标记（或明确告知用户择时重启）。`

const forge = tools.get('skill_forge')
const result = await forge.execute({
  name: 'nvidia-driver-upgrade',
  description: '升级 NVIDIA 显卡驱动并保留回滚路径。',
  body,
  category: 'windows',
})
console.log(JSON.stringify(result, null, 2))

const provider = providers[0]
const listed = await provider.list()
console.log('技能目录现有条目:', listed.length)
for (const item of listed) console.log(' -', item.name, '| rank', item.rank, '|', item.description)

const got = await provider.get(listed[0], {})
console.log('provider.get 正文首行:', got.content.split('\n')[0])
