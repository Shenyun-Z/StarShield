// 关卡基线 fixture 生成脚本（v1.11 新增）
//
// 背景：test/fixtures/campaign-v1.10.json 与 campaign-v1.11.json 此前没有可复现的生成脚本，
// 导致「重校准关卡数值 → 需要更新基线」时无法一步复现。本脚本把当前 js/levels-campaign.js
// 的产出序列化为基线 JSON，结构为 { levels: [ <每关完整对象>, ... ] }（与既有 fixture 一致）。
//
// 用法：
//   node test/fixtures/generate.js                   # 默认写出 campaign-v1.14.json（下一发布版的快照）
//   node test/fixtures/generate.js <name>.json       # 亦可指定文件名（当前发布版 v1.13 的基线仍是 v1.11 的冻结文件）
//
// 安全约束：
//   1) 拒绝覆盖历史基线 campaign-v1.10.json / campaign-v1.11.json —— 它们是不可变的历史证据：
//      v1.10 是上一发布版的基线，v1.11 是当前关卡数值的锁定依据（42 关逐字段比对）；
//      v1.12（纯修复）与 v1.13（UI 重设计）均未改动任何关卡数值，故**不新增 v1.12/v1.13 基线文件**（避免重复近 2MB 资产）；
//   2) 不写入任何其他路径（只写 test/fixtures/ 下）；
//   3) 文件名非 .test.js 后缀，因此不会被 test/run-all.js 当作测试套件执行（但会被 node --check 语法检查）。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FROZEN_BASELINES = ['campaign-v1.10.json', 'campaign-v1.11.json'];
const root = path.join(__dirname, '..', '..');
const target = process.argv[2] || 'campaign-v1.14.json';

// 只允许同级目录下的 .json 文件名（禁止路径分隔符与 ..，避免写到 fixtures 之外）
if (!/^[\w.-]+\.json$/.test(target) || target.indexOf('..') >= 0) {
  console.error('输出文件名不合法（应为同级目录下的 .json，如 campaign-v1.14.json）: ' + target);
  process.exit(1);
}
if (FROZEN_BASELINES.indexOf(target) >= 0) {
  console.error('拒绝覆盖历史基线（不可变）: ' + target);
  process.exit(1);
}

// 与测试沙箱保持同构：IIFE 挂在沙箱 window 上，因此加载后从 window.CAMPAIGN_LEVELS 取结果。
// 注意：levels-campaign.js 不依赖 Date（日期键由调用方传入），此处也不注入，保持口径一致。
const sandbox = {
  Math: Math, Number: Number, Object: Object, Array: Array, JSON: JSON,
  String: String, Boolean: Boolean, isNaN: isNaN, isFinite: isFinite,
  parseInt: parseInt, parseFloat: parseFloat, Infinity: Infinity, NaN: NaN,
  console: console,
};
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const src = fs.readFileSync(path.join(root, 'js', 'levels-campaign.js'), 'utf8');
vm.runInContext(src, sandbox, { filename: 'js/levels-campaign.js' });

const win = sandbox.window || sandbox;
const levels = win.CAMPAIGN_LEVELS;
if (!Array.isArray(levels) || levels.length === 0) {
  console.error('加载失败：未能取得 CAMPAIGN_LEVELS');
  process.exit(1);
}

const outPath = path.join(__dirname, target);
const payload = { levels: levels };
fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');

const regular = levels.filter(l => !l.hidden).length;
const hidden = levels.filter(l => l.hidden).length;
const chapters = (win.CHAPTERS || []).length;
console.log('已写出 ' + path.relative(root, outPath).replace(/\\/g, '/'));
console.log('  关卡 ' + levels.length + '（常规 ' + regular + ' / 隐藏 ' + hidden + '）'
  + ' | 章节 ' + chapters + ' | 字节 ' + fs.statSync(outPath).size);
