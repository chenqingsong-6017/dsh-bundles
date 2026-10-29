# dsh-memory v3.8 检索 / 相关性门槛 —— 独立审查报告 A

- 审查对象：`D:\AI\dsh-bundles\dsh-memory\index.js`（2374 行，ESM，2026-10-29 的 v3.8 改动）
- 审查人：memory-reviewer-a（只报告，未改 index.js / 未改测试）
- 环境：Windows，Node v26.12.1（模块可独立 import，不依赖 DSH 运行时）
- 方法：**每条都真跑过**。除注明「合成库」外，均用本机真实记忆库快照
  `D:\AI\dsh-data\memory\memory.json`（active 34 条 / 正文 5055 字，平均 148.7 字）+ 旁路别名 `aliases.json`（34 条，按 applyAliases() 方式合并）。
  Query 口径与线上一致：`currentQuery()` 取「最后一条 user 消息」整体（index.js:1169-1188，截断 400 字）。
- 既有绿线不重复报：单测 84 项全绿、21 条负例 0 误注入。本报告另跑 30 条真实无关提问，确实 0 条 ≥0.16（见文末「跑过但不成立」）。

## 结论概览

| 编号 | 一句话结论 | 严重度 | 状态 |
|---|---|---|---|
| A1 | 负例的常见「缩短版」直接越过 0.16 门并注入全文（21 条负例只覆盖长句形态） | 高 | 已复现 |
| A2 | 门与相关层不同源：门由 A 通过，注入全文的却是与 query 零内容单元重合的 B，真正相关的条目反被 dropped | 高 | 已复现 |
| A3 | 门槛对 query 长度敏感：同一意图的自然长句 0.118–0.134 < 0.16 → 相关层在真实消息上基本失效 | 高 | 已复现 |
| A4 | 覆盖率可以 > 1（实测 1.10–1.75），tf 饱和系数可 > 1，「比例」语义失真；单内容单元 query 恒过门 | 中 | 已复现 |
| A5 | 英文/数字 token 把句点吞进词里：`chrome.` 不等 `chrome`、`3.8` 不等 `3.8.0`，两条检索路径同时失效 | 中 | 已复现 |
| A6 | bigram 跨词边界假命中：「本地部署」命中「基本｜地址」拼出的「本地」，0.2375 过门并注入全文 | 中 | 已复现 |
| A7 | 分类 `tags` 被算进覆盖率分子：query「research」覆盖率 1.10，条目正文根本不含该词 | 中 | 已复现 |
| A8 | 预算仍会超支：`maxInjectChars` 不超过 1000 时最多 +181 字（诊断行不受预算约束），v3.6「削到装得下」不成立 | 中 | 已复现 |
| A9 | 单字符拉丁/数字被整体丢掉：`C`/`R` 零单元，「D 盘」「E 盘」「F 盘」全塌成「盘」，三者覆盖率完全相同 1.6243 | 低 | 已复现 |
| A10 | 停用字表整词误伤，且注释自己举的「不是」实际被丢：不是/可以/已经/没有/不要/一个 全变空 | 低 | 已复现 |
| A11 | `relevanceFloor` 可配 0/负数 → 门静默失效：覆盖率 0 也照样注入全文 | 低 | 已复现 |
| A12 | v3.6「过期条目只进索引」对 `pinned` 不生效：过期硬规则仍全文注入 | 低 | 已复现 |
| A13 | `relevanceCoverage` 对 `null` 条目直接抛 TypeError（load 已过滤，线上可达性低） | 低 | 已复现 |
| A14 | `cordis.patch.yml` 的配置注释与 v3.8 代码不一致（0.15 vs 0.16、0.186/0.128 vs 0.161/0.147、「0-1」实则大于 1） | 低 | 已复现 |

复现方式统一为（PowerShell / cmd 均可直接跑）：

```powershell
node --input-type=module -e "<各条 repro 的内容>"
```

---

## A1 · 「电脑蓝屏」这类缩短版负例直接越门并注入全文

- 严重度：高
- 状态：【已复现】
- 位置：index.js:49（RELEVANCE_FLOOR=0.16）、index.js:438-440（门）、index.js:455-464（相关层）
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const fs=await import('node:fs');const E=JSON.parse(fs.readFileSync('D:/AI/dsh-data/memory/memory.json','utf8')).entries.filter(e=>!e.supersededBy&&e.status!=='deprecated');const q='电脑蓝屏';const st={};m.renderMemory(E,{maxInjectChars:1200,query:q,stats:st});console.log('coverage',m.relevanceCoverage(E,q).coverage.toFixed(4),'relevant',JSON.stringify(st.relevant),'长句',m.relevanceCoverage(E,'电脑为什么会蓝屏').coverage.toFixed(4));"
```

- 期望 vs 实际：注释（index.js:47-48）说「负例最高「电脑为什么会蓝屏」= 0.147，0.16 落在缝里」→ 期望同一问题的短形态也被挡住；实际「电脑蓝屏」= **0.2012 ≥ 0.16**，`stats.relevant=["m76"]`，把「工作区地图」那条记忆**全文注入**（m76 正文只有一处「电脑」，主题是 workspace.json 地图）。长句 0.1474 / 短句 0.2012，差 0.054。
- 根因：分母 = 查询全部内容单元的 idf 之和（index.js:811-815），短句单元少 → 分母塌 → 同一处命中被放大。
- 建议修法：负例基准必须覆盖每个负例的短/中/长三种形态，并对分母设置最小单元数下限（如少于 4 个内容单元时按 4 个计，或直接降级为「只出索引」）。

---

## A2 · 门由 A 通过，注入全文的却是与 query 零内容单元重合的 B（真正相关的条目被 dropped）

- 严重度：高
- 状态：【已复现】
- 位置：index.js:424-430（`scored` = scoreEntries，含 alias ×2.5 / 同义扩展 / unigram）、index.js:434-439（注释声称不受 alias 污染，实际只对门成立）、index.js:442-451（合成排序用 raw）、index.js:455-464（按合成排序取前 2 条给全文）
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const fs=await import('node:fs');const E=JSON.parse(fs.readFileSync('D:/AI/dsh-data/memory/memory.json','utf8')).entries.filter(e=>!e.supersededBy&&e.status!=='deprecated');const q='python快排';const st={};m.renderMemory(E,{maxInjectChars:1200,query:q,stats:st});const e=E.find(x=>x.id===st.relevant[0]);console.log('coverage',m.relevanceCoverage(E,q).coverage.toFixed(4),'relevant',JSON.stringify(st.relevant),'dropped 含 m77',st.dropped.includes('m77'),'注入正文',e&&e.text.slice(0,40));"
```

- 期望 vs 实际：
  - 期望：门（覆盖率）按「内容单元」判相关，那么被给全文的条目至少应与 query 有内容单元交集；注释 index.js:434-435 明确写「分子分母都不用带 alias 加权 / 同义扩展的分数：否则负例误注入 0%→75%」。
  - 实际：coverage **0.3907**（由 m77 的 python 撑起）过门，`stats.relevant=["m67"]`；m67（GlassBoard 便携版 / 桌面图标）与 query 的内容单元交集 **[]**，它进相关层靠的是 `tokenize()` 的单字「快」（来自 m67 正文「快捷方式」）；**真正含 python 的 m77 既不在 relevant 也不在 indexed，落在 `stats.dropped` 里**。
  - 合成库同样的复现：B 只靠旁路 alias「抖音」命中 → `scoreEntries` = 3.31 > A 的 1.62 → B 拿全文、真正相关的 A 只拿索引行。
- 根因：判定层（relevanceCoverage：无 alias、无 unigram、丢虚词）与选择层（scoreEntries：alias ×2.5、同义扩展 ×0.5、unigram+bigram 三重计数）**口径不同**；且合成排序 raw/topRaw + 0.5·imp + 0.3·recency 里 importance+recency 合计 0.8，足以把真相关压到第二。
- 建议修法：相关层选择改用与门同一把尺（contentUnits 严格分），或至少要求「内容单元交集 > 0」才可进 relevant；合成排序里 raw 项应占绝对权（如 ≥0.6）。

---

## A3 · 门槛对 query 长度敏感：真实自然语言消息系统性低于 0.16，相关层基本失效

- 严重度：高
- 状态：【已复现】
- 位置：index.js:811-815（分母随查询单元线性增长）、index.js:43 与 1169-1188（线上 query = 整条用户消息，不是关键词）、index.js:436-440
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const fs=await import('node:fs');const E=JSON.parse(fs.readFileSync('D:/AI/dsh-data/memory/memory.json','utf8')).entries.filter(e=>!e.supersededBy&&e.status!=='deprecated');const pairs=[['抖音快捷键','我在用抖音 PC 客户端，想问一下快捷键都有哪些，最好整理成一张速查表方便以后查'],['验证门','我改完代码想确认一下收工前的验证门有没有过，现在这个检查到底是怎么跑的'],['虚拟机','VirtualBox 起不来，报 VERR_PATH_NOT_FOUND，这种虚拟机迁移路径的问题怎么修'],['称呼礼仪','你还记得我要求你怎么称呼我吗？回复的时候用什么自称，礼仪规矩是什么']];for(const [s,n] of pairs)console.log(JSON.stringify(s),m.relevanceCoverage(E,s).coverage.toFixed(4),'|',JSON.stringify(n.slice(0,16)),m.relevanceCoverage(E,n).coverage.toFixed(4));"
```

- 期望 vs 实际（真实库，四条都是「库里确实有对应条目」的问法）：

| 同一意图 | 关键词式 query | 自然消息式 query | 结果 |
|---|---|---|---|
| 抖音快捷键 | 0.2949 过门 | 0.1197 未过 | 长句低于 0.16 → `relevant=[]` |
| 验证门 | 1.1625 过门 | 0.1181 未过 | 同上 |
| 虚拟机 | 1.0945 过门 | 0.2443 过门 | 例外：靠 latin token 撑住 |
| 称呼礼仪 | 0.2645 过门 | 0.1338 未过 | 同上 |

  即：把同一句话写成用户真实会发的样子，4 条里 3 条掉到门下，相关层一条全文都不给；而 v1.1 引入相关层的目的正是覆盖「相关却没进索引」的那批。
- 根因：分母是**查询侧** idf 总和，用户多说几个字分母就涨；门槛实际在衡量「query 有多少字能在单条记忆里原样找到」，不是「记忆与问题是否同主题」。
- 建议修法：分母改为「查询内容单元中在语料里出现过的那些」的 idf 之和（未出现的词不计入分母），或先抽 query 的 top-k 内容词再加权；同时把自然长句形态加进 21 条负例基准。

---

## A4 · 覆盖率可以 > 1，且单内容单元 query 恒过门

- 严重度：中
- 状态：【已复现】
- 位置：index.js:826-828（BM25 tf 饱和系数可大于 1）、index.js:836（无钳制）、index.js:783-790（文档写「覆盖了多少查询的信息量」）
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const fs=await import('node:fs');const E=JSON.parse(fs.readFileSync('D:/AI/dsh-data/memory/memory.json','utf8')).entries.filter(e=>!e.supersededBy&&e.status!=='deprecated');for(const q of ['记忆','抖音','dsh-memory'])console.log(q,m.relevanceCoverage(E,q).coverage.toFixed(4));"
```

- 期望 vs 实际：覆盖率是「命中信息量 ÷ 查询信息量」，语义上应不超过 1（配置注释也写「0-1」）。实际真实库：`记忆 1.4211、抖音 1.3374、dsh-memory 1.4411`；合成最小例（2 条、其中一条 2 字）`抖音 = 1.4639`。单内容单元 query 一律 1.1–1.7 倍，**恒定越门**——门对短查询是空转。
- 根因：`f*(k1+1)/(f+k1*(1-b+b*len/avg))` 在 len 远小于 avg 时饱和值大于 1（k1=1.2 时极限 2.2），分子被放大 1.2–2.2 倍。
- 建议修法：分子除以 max(1, 饱和系数)，或最后 `Math.min(1, best/denominator)`，并把「单单元 query」单独走保守路径。

---

## A5 · 英文/数字 token 把句点吞进词里，`chrome.` 永不等于 `chrome`

- 严重度：中
- 状态：【已复现】
- 位置：index.js:766（contentUnitsOf 的 /[a-z0-9][a-z0-9_\-.]{1,}/g）、index.js:575（tokenize 同一字符类）
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const D=[{id:'a',text:'默认浏览器用 Chrome.'},{id:'b',text:'无关'.repeat(20)}];const st={};m.renderMemory(D,{maxInjectChars:1200,query:'Chrome',stats:st});console.log('units',JSON.stringify(m.contentUnitsOf('用 Chrome.')),'coverage',st.relevanceCoverage,'relevant',JSON.stringify(st.relevant),'score',m.scoreEntries(D,'Chrome')[0].score.toFixed(3));"
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const D=[{id:'v',text:'dsh-memory 3.8.0 已生效'},{id:'x',text:'无关'.repeat(30)}];for(const q of ['3.8','3.8.0']){const st={};m.renderMemory(D,{maxInjectChars:1200,query:q,stats:st});console.log(q,'coverage',st.relevanceCoverage,'relevant',JSON.stringify(st.relevant))}"
```

- 期望 vs 实际：期望「Chrome」能召回写着 `Chrome.` 的记忆；实际 `contentUnitsOf('用 Chrome.') = ["chrome.","用"]`（句点在字符类里），query 单元 `chrome` 与文档单元 `chrome.` 不相等 → coverage **0**、`scoreEntries = 0.000`（tokenize 同缺陷，`memory_search` 也搜不到）。同类：`3.8` 对 `3.8.0` coverage=0，而 `3.8.0` 对 `3.8.0` coverage=1.5556。
- 影响：句末英文词、带版本号的记忆（本库真实存在 `dsh-memory 3.8.0` 这类文本）在两种检索里同时不可达。
- 建议修法：字符类改为 `[a-z0-9][a-z0-9_\-]*(?:\.[a-z0-9_\-]+)*`（点只在词内），并在取 token 后去掉尾随标点。

---

## A6 · bigram 跨词边界假命中，单独就能把门顶过 0.16

- 严重度：中
- 状态：【已复现】
- 位置：index.js:772-777（无词界的 bigram）、index.js:826-828
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const now=new Date().toISOString();const P={id:'p',text:'服务器的基本地址表放在内网，忘了就问我',addedAt:now,updatedAt:now},L={id:'l',text:'无关的长记忆'.repeat(20),addedAt:now,updatedAt:now};const st={};m.renderMemory([P,L],{maxInjectChars:1200,query:'本地部署',stats:st});console.log('units',JSON.stringify(m.contentUnitsOf('本地部署')),'coverage',st.relevanceCoverage,'relevant',JSON.stringify(st.relevant));"
```

- 期望 vs 实际：期望「本地部署」与「基本地址表」无关；实际 P 的 bigram 序列是 服务/务器/…/**基本/本地/地址**/…，「本地」只是「基本｜地址」的拼接，coverage **0.2375 ≥ 0.16** → P 被全文注入。真实库里这类跨词拼接词很多（bigram 切分没有词界）。
- 建议修法：给 CJK bigram 命中加代价（要求两个单字在 query 里也各自出现），或接入轻量词典做词界约束。

---

## A7 · 分类 `tags` 被算进覆盖率分子：分类词被当成主题词

- 严重度：中
- 状态：【已复现】
- 位置：index.js:795-798（文档侧文本 = entry.text 与 tagText 拼接）、index.js:811-815
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const now=new Date().toISOString();const A={id:'t1',text:'dsh-memory 3.8.0 已生效',tags:['research'],addedAt:now,updatedAt:now},B={id:'t2',text:'抖音客户端快捷键',tags:['machine'],addedAt:now,updatedAt:now};for(const q of ['research','machine']){const st={};m.renderMemory([A,B],{maxInjectChars:1200,query:q,stats:st});console.log(q,'coverage',st.relevanceCoverage,'relevant',JSON.stringify(st.relevant))}"
```

- 期望 vs 实际：`research 覆盖率 1.1042、machine 0.9137`，两条**正文都不含该词**（交集为空），仅因 `tags` 里有分类词就被判「相关」并给全文。真实库 34 条全带 tags（research/env/ux/machine/plugin-dev…），用户消息里出现这些英文词就会触发。
- 附带：`scoreEntriesStrict` 的注释（index.js:715-716）明确写「aliases 是查询桥，不是原文内容」，同一原则没应用到 tags。
- 建议修法：覆盖率文档侧只用 `entry.text`（tags 留在排序层或按 0.5 权重计），与 strict 口径一致。

---

## A8 · 预算仍会超支：`maxInjectChars` 不超过 1000 时最多 +181 字

- 严重度：中
- 状态：【已复现】
- 位置：index.js:546-555（回削循环只在 `compact`/`indexed` 里弹，两个都空就 break）、index.js:526-530（诊断行/页脚动态、不进 `used`）
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const now=new Date().toISOString();const mk=(id,t,x={})=>({id,text:t,addedAt:now,updatedAt:now,...x});const lib=[mk('pin','硬规则'.padEnd(1)+'这是一条 600 字的硬规则记忆'.repeat(30).slice(0,599),{pinned:true})];for(let i=0;i<30;i++)lib.push(mk('n'+i,('第'+i+'条普通记忆：'+'内容'.repeat(60)).slice(0,120)));for(const mx of [1200,900,600]){const st={};const b=m.renderMemory(lib,{maxInjectChars:mx,query:'普通记忆 内容',stats:st});console.log('max='+mx,'len='+b.length,b.length>mx?'超 +'+(b.length-mx):'ok','dropped='+st.dropped.length)}"
```

- 期望 vs 实际：v3.6 注释（index.js:546-548）承诺「拿真实长度回削…削到装得下为止」。实际：`max=1200 → 1192 通过、max=900 → 925（+25）、max=600 → 781（+181）`；另测 1000 → 1064（+64）、800 → 926（+126）。原因是 pinned 600 字 + 头部 + 页脚 + 「⚠ 另有 29 条未注入：…」诊断行本身已超小预算，而 sinks 已空 → break。
- 建议修法：诊断行按剩余预算截断（只列前 N 个 id + 「等 29 条」），并把 footer/诊断也计入预算后再回削。

---

## A9 · 单字符拉丁/数字与「孤字」路径丢失：C/R 零单元，D/E/F 盘覆盖率完全相同

- 严重度：低
- 状态：【已复现】
- 位置：index.js:766（`{1,}` 要求拉丁词至少 2 字符）、index.js:767-771（单字 CJK run 只在整段 run 长度为 1 时入单元）
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const fs=await import('node:fs');const E=JSON.parse(fs.readFileSync('D:/AI/dsh-data/memory/memory.json','utf8')).entries.filter(e=>!e.supersededBy&&e.status!=='deprecated');for(const q of ['D 盘','E 盘','F 盘'])console.log(q,'units',JSON.stringify(m.contentUnitsOf(q)),'coverage',m.relevanceCoverage(E,q).coverage.toFixed(4));"
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');for(const q of ['C','R','R 语言'])console.log(JSON.stringify(q),'->',JSON.stringify(m.contentUnitsOf(q)))"
```

- 期望 vs 实际：期望「E 盘」与「D 盘」可区分；实际 `D 盘/E 盘/F 盘` 的 units 全为 `["盘"]`、coverage 全为 1.6243 → 问「E 盘」与问「D 盘」注入完全相同的记忆（盘符被 `{1,}` 吃掉）。`C/R` 直接 → `[]`（`R 语言` → `["语言"]`）。同类：单字中文 query「书」units 是 `["书"]`，但文档侧只产出 bigram，coverage = 0（`书籍 = 0.9112`）。
- 建议修法：拉丁词允许单字符但按低权重处理；query 单字 CJK 与文档 bigram 建立包含匹配（单字命中任一 bigram 首/尾字）。

---

## A10 · 停用字表整词误伤，且注释自己举的例子是错的

- 严重度：低
- 状态：【已复现】
- 位置：index.js:759-761（CJK_STOP_CHARS）、index.js:774（注释）、index.js:775（双虚词规则）
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');for(const w of ['不是','可以','已经','没有','不要','一个','三个'])console.log(w,'->',JSON.stringify(m.contentUnitsOf(w)));"
```

- 期望 vs 实际：注释 index.js:774 写「两个都是虚词才丢：保住「会议」「不是」这类含虚词字的真词」→ 期望 `不是` 被保留；实际 **`不是 → []`**（「不」「是」都在表里）。整词丢掉的还有 `可以/已经/没有/不要/不会/所以/因为/还是/就是`，以及**纯数字组合 `三个/四个`**（一二三四五六七八九十 被当虚词）。
- 影响：分子分母同时丢，单独看不会造成假命中；真正问题是 (a) 注释与实现矛盾，(b) 与 tokenize（不丢）口径分叉，正是 A2 的机制来源，(c) 数字被丢使「3 个方案/三个方案」类区分失效。
- 建议修法：停用表只用于单字判定，bigram 改用黑名单表（把 不要/不是/可以 这类真词移出），并补一条 `不是` 的断言测试。

---

## A11 · `relevanceFloor` 可配 0/负数 → 门静默失效

- 严重度：低
- 状态：【已复现】
- 位置：index.js:964（配置只做 Number.isFinite 校验）、index.js:431、index.js:440
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const now=new Date().toISOString();const lib=[{id:'a',text:'桌面快捷方式不许改名',addedAt:now,updatedAt:now},{id:'b',text:'完全不相关的一条记忆',addedAt:now,updatedAt:now}];for(const f of [undefined,0]){const st={};const o={maxInjectChars:1200,query:'推荐一部好看的电影',stats:st};if(f!==undefined)o.relevanceFloor=f;m.renderMemory(lib,o);console.log('floor='+f,'coverage',st.relevanceCoverage,'relevant',JSON.stringify(st.relevant))}"
```

- 期望 vs 实际：期望 0 代表「能配到的最低值」；实际 `coverage >= 0` 恒真 → 覆盖率 **0**（负例）也注入全文：`floor=0 → relevant=["b"]`（b 与 query 零内容单元交集，只靠 tokenize 单字「一」命中）。负数同理。
- 建议修法：配置校验 `0 < f <= 1`，越界回落 RELEVANCE_FLOOR 并写 doctor 告警。

---

## A12 · v3.6「过期条目只进索引」对 `pinned` 不生效

- 严重度：低
- 状态：【已复现】
- 位置：index.js:402-403（isExpired 定义）、index.js:406-414（pinned 全文循环没有 isExpired 判断）、index.js:457（只有相关层跳过）；注释 index.js:399-400 声称「staleAfter 已过的条目降级为只进索引、不给全文」
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');const now=new Date().toISOString();const st={};m.renderMemory([{id:'p',text:'已过期的硬规则',pinned:true,staleAfter:'2020-01-01',addedAt:now,updatedAt:now}],{maxInjectChars:1200,stats:st});console.log('full',JSON.stringify(st.full));"
```

- 期望 vs 实际：期望过期 → 只出索引行；实际 `stats.full=["p"]`，过期硬规则照样占全文预算（无 query 时也注入）。
- 建议修法：pinned 循环里也判 isExpired，过期则降到索引层并在诊断里点名。

---

## A13 · `relevanceCoverage` 对 null 条目抛 TypeError

- 严重度：低
- 状态：【已复现】
- 位置：index.js:794-803（list.map 里直接读 entry.tags，没有 entry?. 保护；对比 index.js:905/375 的 entry?. 风格）
- repro：

```powershell
node --input-type=module -e "const m=await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js');try{m.relevanceCoverage([null],'抖音')}catch(e){console.log('THROW:',e.message)}"
```

- 期望 vs 实际：期望坏数据被跳过；实际 `THROW: Cannot read properties of null (reading 'tags')`；`renderMemory([null])` 同样会炸（scoreEntries → bm25Doc）。线上可达性低：`load()` 在 index.js:1090-1093 已过滤条目（要求 entry 非空、id/text 都是字符串），只有内存 state 被别的代码写坏才会踩到。
- 建议修法：与 scoreEntriesStrict 一致地 `String(entry?.text ?? '')` / `entry?.tags`，并在 renderMemory 入口过滤非对象条目。

---

## A14 · 配置注释与 v3.8 代码不一致（且「0-1」与实际大于 1 矛盾）

- 严重度：低
- 状态：【已复现】
- 位置：`dsh-memory/cordis.patch.yml:19-21` 对比 index.js:47-49
- repro：

```powershell
Get-Content D:\AI\dsh-bundles\dsh-memory\cordis.patch.yml | Select-Object -Skip 18 -First 3
```

- 期望 vs 实际：配置注释写「相关性覆盖率下限（…0-1…）默认 0.15（用 36 题微基准校准：正例最低 0.186、负例最高 0.128）」，代码 v3.8 已改为 **0.16**，校准值为「负例最高 0.147、正例最低 0.161」。另「0-1」与 A4（实测大于 1）矛盾。
- 建议修法：把配置注释与代码注释一起对齐，并写进 README 的「口径变更必须同步清单」。

---

## 跑过但不成立（避免误伤与重复）

| 检查项 | 实测 |
|---|---|
| 空 query / 纯空白 | `coverage=0`、`relevant=[]`，无异常 |
| 纯虚词 query（`的了一`、`的` 重复 300 次） | coverage 0，安全 |
| 纯 emoji / 纯标点（👍 重复 50 次、全角句号、连字符） | coverage 0，units 0，安全 |
| 超长 query（400 个「抖」、「抖音。」重复 200 次、400 个 a） | coverage 0 / 1.3374，单次 0.4–0.5 ms，无 NaN/Infinity/负数 |
| 30 条真实无关提问（红烧肉、股票、减肥、翻译…） | **0 条** ≥0.16，21 条负例结论仍成立（最高 = Python 快排 0.1435） |
| 条目缺 text / 缺 tags | `relevanceCoverage([{id:'x'}], '抖音') = 0`，不崩；tags 传字符串也不崩 |
| 同一记忆被多算 | full(pinned)/relevant/indexed/compact/dropped 分层互斥，实测无同一 id 出现两次（inRelevant + isCrossScope 分区正确） |
| 复杂度 | 无 O(n²)。relevanceCoverage 是 O(单元数×条目数)（约 800×N），renderMemory 每次全量 tokenize 两遍；实测 34 条 3.0ms / 200 条 9.1ms / 1000 条 43.3ms / 3000 条 121.3ms。maxBytes（默认 8000、上限 64KB）把库压在几百条 → 现实不是问题，故未列为缺陷 |
| queryIdfSum / scoreEntriesStrict | 确认已不被门槛使用（仅单测/对照），注释与实现一致 |
| 覆盖率 NaN / 除零 | 未复现：docs.length 与 queryUnits 长度都大于 0 才继续，avgLength 有兜底，denominator 大于 0 才做除法 |
| renderMemory 不传 cwd 时 workspaces 条目被整条过滤 | 属实，但是 v3.0 既有设计（applicableAt 在 cwd 为空时返回 false），不在 v3.8 范围，仅备注 |

## 修法优先级（一句话版）

1. **A2 + A3 是一对**：门与选择层必须同尺，且分母不能随 query 长度膨胀——只改一处没用。
2. **A1/A6/A7** 是「门太容易过」的三个缺口：补短/中/长三形态负例 + 跨词 bigram 代价 + tags 不计入分子。
3. **A4 顺手钳到不超过 1**，让诊断与配置注释恢复可信。
4. A5/A9/A10 都是 tokenizer 边界，建议一次性重写 contentUnitsOf 并补 10 条断言。
5. A8/A11/A12/A13/A14 是低风险收尾，可与下一版一起做。
