#!/usr/bin/env node
// asar.mjs —— 读 Electron asar 归档(只读)。不需要 npx asar,零依赖。
//
// 用法:
//   node asar.mjs list  [pattern]        列出归档里的文件路径(pattern 为正则,可选)
//   node asar.mjs cat   <path>           把一个文件的内容打到 stdout
//   node asar.mjs pkg   <packageName>    列出某个包的顶层文件 + package.json
//   node asar.mjs grep  <regex> [dir]    在文本文件里搜正则(dir 限定子树,可选,限 .js/.json/.yml/.md)
//
// 默认归档路径 D:\AI\deepsek harness\resources\app.asar,可用 --asar <path> 覆盖。
//
// asar 头格式(实测): buf[0..3]=4, buf[4..7]=headerSize, buf[8..11]=strLen, buf[12..15]=jsonLen,
// JSON 目录树在 offset 16,数据区起点 = 8 + u32(4)。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ASAR = 'D:\\AI\\deepsek harness\\resources\\app.asar';

function parseArgs(argv) {
  const out = { cmd: null, args: [], asar: DEFAULT_ASAR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--asar') { out.asar = argv[++i]; continue; }
    if (!out.cmd) out.cmd = argv[i];
    else out.args.push(argv[i]);
  }
  return out;
}

function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const dataStart = 8 + head.readUInt32LE(4);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const tree = JSON.parse(jsonBuf.toString('utf8').replace(/\0+$/, ''));
  return { fd, tree, dataStart };
}

function walk(node, prefix, out) {
  if (!node || !node.files) return;
  for (const [name, child] of Object.entries(node.files)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p, out);
    else if (child.link) out.push({ path: p, link: child.link });
    else out.push({ path: p, offset: Number(child.offset), size: child.size, unpacked: !!child.unpacked });
  }
}

function readEntry(fd, dataStart, entry) {
  if (entry.unpacked) throw new Error('文件是 unpacked,直接去 app.asar.unpacked 读');
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, dataStart + entry.offset);
  return buf;
}

const { cmd, args, asar } = parseArgs(process.argv.slice(2));
if (!cmd) { console.error('用法: node asar.mjs list|cat|pkg|grep ...'); process.exit(2); }
if (!fs.existsSync(asar)) { console.error(`找不到 asar: ${asar}`); process.exit(2); }

const { fd, tree, dataStart } = openAsar(asar);
const all = [];
walk(tree, '', all);

if (cmd === 'list') {
  const re = args[0] ? new RegExp(args[0], 'i') : null;
  const hits = re ? all.filter((e) => re.test(e.path)) : all;
  for (const e of hits) console.log(e.path);
  console.error(`共 ${hits.length} / ${all.length}`);
} else if (cmd === 'cat') {
  const target = args[0].replace(/^\/+/, '');
  const e = all.find((x) => x.path === target);
  if (!e) { console.error(`找不到: ${target}`); process.exit(1); }
  process.stdout.write(readEntry(fd, dataStart, e));
} else if (cmd === 'pkg') {
  const name = args[0];
  const pre = `node_modules/${name}/`;
  const hits = all.filter((e) => e.path.startsWith(pre) && !e.path.slice(pre.length).includes('/'));
  for (const e of hits) console.log(e.path.slice(pre.length));
  const pj = all.find((e) => e.path === `${pre}package.json`);
  if (pj) {
    const j = JSON.parse(readEntry(fd, dataStart, pj).toString('utf8'));
    console.log('\n--- package.json ---');
    console.log(JSON.stringify({ name: j.name, version: j.version, main: j.main, description: j.description }, null, 2));
  }
} else if (cmd === 'grep') {
  const re = new RegExp(args[0]);
  const dir = args[1] ? args[1].replace(/^\/+|\/+$/g, '') + '/' : '';
  const files = all.filter((e) => e.path.startsWith(dir) && /\.(js|mjs|cjs|json|yml|yaml|md)$/.test(e.path) && e.size < 2_000_000);
  let n = 0;
  for (const e of files) {
    let text;
    try { text = readEntry(fd, dataStart, e).toString('utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        console.log(`${e.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (++n > 200) { console.error('结果超过 200 条,已截断'); process.exit(0); }
      }
    }
  }
  console.error(`命中 ${n} 条 / 扫了 ${files.length} 个文本文件`);
} else {
  console.error(`未知命令: ${cmd}`);
  process.exit(2);
}
fs.closeSync(fd);
