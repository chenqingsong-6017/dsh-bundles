#!/usr/bin/env node
/**
 * gate-hollow.test.mjs —— 验证 check.mjs 的三个「门可被掏空」洞不会静默通过。
 *
 * 洞（证据：_research/deepseek-repos/05c-harness-adr-practice.md §4.2）：
 *   1) 插件目录缺失/为空时，旧版打印「跳过」后 exit 0；
 *   2) 「有入口无测试」只打印不阻断；
 *   3) 覆盖缺口没有棘轮（新增插件可以不写测试）；
 *   4) locale/*.json 从不 parse（2026-11-02 加的 2b 门：坏掉时界面报「包元信息错误」）。
 *
 * 做法：用 os.tmpdir 下的假插件目录 + DSH_BUNDLES_DIR 跑「真 check.mjs」，断言退出码。
 * 时间预算：4 次门各 ~0.6s（假目录没有测试要跑），整体 < 5s。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "..", "gate", "check.mjs");
const START = Date.now();
let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed += 1; console.log("  PASS " + name); }
  else { failures.push(name + (detail ? " —— " + detail : "")); console.log("  FAIL " + name + (detail ? " —— " + detail : "")); }
}

function runGate(bundlesDir, extraEnv = {}) {
  const env = { ...process.env, DSH_BUNDLES_DIR: bundlesDir };
  // 外层门可能带着 --perf 的采集变量；内层假门不该写同一份 metrics。
  delete env.DSH_GATE_METRICS;
  delete env.DSH_ALLOW_EMPTY_BUNDLES;
  for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
  const r = spawnSync(process.execPath, [GATE], { env, encoding: "utf8", timeout: 60000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function makePlugin(root, name) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name,
    version: "0.0.0",
    type: "module",
    main: "index.js",
    engines: { dsh: ">=0.2.0 <0.3.0" },
    exports: { ".": "./index.js" },
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }, null, 2));
  writeFileSync(path.join(dir, "cordis.patch.yml"), "- insert:\n    - id: " + name + "\n      name: " + name + "\n");
  writeFileSync(path.join(dir, "index.js"), "export function apply() {}\n");
}

function writeBaseline(root, allow) {
  const tests = path.join(root, "_selftest", "tests");
  mkdirSync(tests, { recursive: true });
  writeFileSync(path.join(tests, "coverage-baseline.json"), JSON.stringify({ _note: "gate-hollow fixture", allow, _reasons: {} }, null, 2));
  // 2026-11-03：门现在把「测试目录为空」与「标准门脚本缺失」也当失败（堵掏空）
  // —— 假目录必须提供最小骨架，否则测的就不是本用例想测的那个洞。
  writeFileSync(path.join(tests, "fixture-smoke.test.mjs"), "console.log('fixture-smoke: 1 项通过')\nprocess.exit(0)\n");
  writeFileSync(path.join(root, "_selftest", "standard-check.mjs"), "console.log('共 1 个插件：合规 1，不合规 0（report 模式）')\n");
}

const tmpRoots = [];
function freshRoot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-gate-hollow-"));
  tmpRoots.push(dir);
  return dir;
}

try {
  // (i) 空插件目录 → exit 1，且提示里写明解析后的路径与「目录存在=true」
  {
    const root = freshRoot();
    const r = runGate(root);
    ok("空插件目录 exit 1", r.status === 1, "实际 exit " + r.status);
    ok("空插件目录提示指出 bundle 路径", r.out.includes(root.split(path.sep).join(path.sep)) || r.out.includes(root), (r.out.split("\n")[0] || "").slice(0, 120));
    ok("空插件目录提示「门被掏空」", r.out.includes("门被掏空"), (r.out.split("\n")[0] || "").slice(0, 120));
  }

  // (i-b) 目录根本不存在 → exit 1，且写出「目录存在=false」
  {
    const ghost = path.join(os.tmpdir(), "dsh-gate-hollow-does-not-exist-" + Date.now());
    const r = runGate(ghost);
    ok("插件目录不存在 exit 1", r.status === 1, "实际 exit " + r.status);
    ok("不存在时提示目录存在=false", r.out.includes("目录存在=false"), (r.out.split("\n")[2] || "").slice(0, 120));
  }

  // (ii) 有入口无测试、且不在 baseline → exit 1，并点名插件与 baseline
  {
    const root = freshRoot();
    makePlugin(root, "dsh-fake-uncovered");
    writeBaseline(root, []);
    const r = runGate(root);
    ok("无测试且不在 baseline exit 1", r.status === 1, "实际 exit " + r.status);
    ok("失败点名插件", r.out.includes("dsh-fake-uncovered"), (r.out.match(/✗[^\n]*/) || [""])[0].slice(0, 120));
    ok("失败指向 coverage-baseline.json", r.out.includes("coverage-baseline.json"), (r.out.match(/✗[^\n]*/) || [""])[0].slice(0, 120));
  }

  // (iii) 同样的插件，但已在 baseline 白名单 → 不因覆盖洞失败（exit 0）
  {
    const root = freshRoot();
    makePlugin(root, "dsh-fake-allowlisted");
    writeBaseline(root, ["dsh-fake-allowlisted"]);
    const r = runGate(root);
    ok("baseline 白名单内 exit 0", r.status === 0, "实际 exit " + r.status + "\n" + r.out.slice(0, 400));
    ok("白名单内输出通过", r.out.includes("通过"), r.out.slice(0, 200));
  }

  // (iv) 逃生口只给测试用：DSH_ALLOW_EMPTY_BUNDLES=1 时空目录放行
  {
    const root = freshRoot();
    const r = runGate(root, { DSH_ALLOW_EMPTY_BUNDLES: "1" });
    ok("空目录 + 逃生口 exit 0（仅测试）", r.status === 0, "实际 exit " + r.status);
  }

  // (v) locale JSON 坏掉 → exit 1，并点名文件与错误（2026-11-02 实测事故：
  //     dsh-obsidian/locale/zh.json 里未转义的 Windows 路径让界面报「包元信息错误」，
  //     旧门只 parse package.json，locale 从没被检查，所以这个错一路绿灯到界面）
  {
    const root = freshRoot();
    makePlugin(root, "dsh-fake-locale-broken");
    writeBaseline(root, ["dsh-fake-locale-broken"]);
    const localeDir = path.join(root, "dsh-fake-locale-broken", "locale");
    mkdirSync(localeDir, { recursive: true });
    // 注意：这里要写出一个「真·坏 JSON」，所以路径反斜杠在 JS 字符串里只写一层
    writeFileSync(path.join(localeDir, "zh.json"),
      '{\n  "meta": {\n    "title": "假插件",\n    "description": "把 D:\\AI-date\\vault 扫成索引"\n  }\n}\n');
    const r = runGate(root);
    ok("locale JSON 坏掉 exit 1", r.status === 1, "实际 exit " + r.status + "\n" + r.out.slice(0, 300));
    ok("失败点名 locale/zh.json", r.out.includes("locale/zh.json"), (r.out.match(/✗[^\n]*/) || [""])[0].slice(0, 160));
    ok("失败写出 JSON 错因", r.out.includes("不是合法 JSON"), (r.out.match(/✗[^\n]*/) || [""])[0].slice(0, 160));
  }

  // (vi) 同一个插件，把反斜杠转义对 → exit 0（证明这条检查不是「永远红」）
  {
    const root = freshRoot();
    makePlugin(root, "dsh-fake-locale-ok");
    writeBaseline(root, ["dsh-fake-locale-ok"]);
    const localeDir = path.join(root, "dsh-fake-locale-ok", "locale");
    mkdirSync(localeDir, { recursive: true });
    writeFileSync(path.join(localeDir, "zh.json"),
      '{\n  "meta": {\n    "title": "假插件",\n    "description": "把 D:\\\\AI-date\\\\vault 扫成索引"\n  }\n}\n');
    writeFileSync(path.join(localeDir, "en.json"), '{ "meta": { "title": "Fake" } }\n');
    const r = runGate(root);
    ok("locale JSON 合法 exit 0", r.status === 0, "实际 exit " + r.status + "\n" + r.out.slice(0, 400));
    ok("输出统计 locale 文件数", r.out.includes("locale 文件"), r.out.slice(0, 200));
  }
} finally {
  for (const dir of tmpRoots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录是本次测试自建，删失败不影响断言 */ }
  }
}

const elapsed = Date.now() - START;
console.log("");
console.log("gate-hollow: " + passed + " 条断言通过，" + failures.length + " 条失败，耗时 " + elapsed + "ms（目标 < 5000ms）");
if (elapsed > 8000) failures.push("测试耗时 " + elapsed + "ms 超过 8000ms");
if (failures.length > 0) {
  console.error("gate-hollow 失败：\n- " + failures.join("\n- "));
  process.exit(1);
}
if (!existsSync(GATE)) { console.error("gate-hollow: 找不到 " + GATE); process.exit(1); }
process.exit(0);
