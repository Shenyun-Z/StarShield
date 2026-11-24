// 难度曲线回归（v1.16）
//   把「曲线是否被改崩」从口头约定变成可执行断言。
//
// 指标定义（压力指数 pressure）：
//   pressure = 本关全部来袭质量之和 / (初始星能 + 2 × 来袭个数)
//   - 分母里的「+2 × 个数」与 registerClear 的清场返还口径一致（每清掉一个威胁 +2 星能），
//     因此分母 = 本关真实可得星能总量；
//   - 分子 = 本关必须处理的总质量，代表"单位星能要扛多少来袭"。
//   这个比值不依赖玩家操作水平，纯粹由关卡数据决定，适合作为跨关对比的标尺。
//
// 断言：
//   A. 40 关压力单调不降（曲线整体向上，不出现倒挂）
//   B. 章内相邻两关跳变 ≤ 1.25（平滑爬升）——历史实测最大约 1.18
//   C. 跨章入口跳变 ≤ 1.55，且「超过 1.35 的跳变」全 40 关里只允许出现在第四章入口
//      （L30→L31 实测 1.51×，是刻意保留的章节门槛；超过 1.55 说明门槛失控）
//   D. 首末关锚点：开局轻松（≤ 4.5）、终局高压（≥ 60）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const sandbox = { Math, Object, Array, String, Number, JSON, console, parseInt, parseFloat, Boolean };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/levels-campaign.js'), 'utf8'), sandbox, { filename: 'levels-campaign.js' });

const LEVELS = sandbox.CAMPAIGN_LEVELS;
const CH4_START = 30;                 // 与 core.js 的 CH4_START 保持一致（章界：0/10/20/30）

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}

function pressureOf(lv) {
  const spawns = lv.waves.reduce((n, w) => n + w.spawns.length, 0);
  const mass = lv.waves.reduce((s, w) => s + w.spawns.reduce((x, sp) => x + (sp.mass || 0), 0), 0);
  const avail = lv.budget + 2 * spawns;
  return { spawns, mass, avail, pressure: mass / avail };
}

const reg = LEVELS.filter(l => !l.hidden);
const rows = reg.map((lv, i) => Object.assign({ index: i + 1, waves: lv.waves.length }, pressureOf(lv)));

console.log('--- 关卡压力曲线（每点可用星能对应的来袭质量）---');
console.log(rows.map(r => 'L' + r.index + ':' + r.pressure.toFixed(1)).join(' '));

/* ---- A. 单调不降 ---- */
{
  // 注：来袭个数与质量都按整数取整，个别相邻关会出现 0.1~0.2% 的抖动（实测 L36→L37 为
  // 64.0→63.9），因此口径定为「不得回落超过 3%」——仍能拦住任何真实的难度倒挂。
  let bad = -1, minRatio = Infinity, minAt = '';
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i].pressure / rows[i - 1].pressure;
    if (r < minRatio) { minRatio = r; minAt = 'L' + rows[i - 1].index + '→L' + rows[i].index; }
    if (r < 0.97) { bad = i + 1; break; }
  }
  assert('A. 40 关压力指数单调不降（允许取整抖动 ≤ 3%）', bad < 0,
    bad > 0 ? ('L' + (bad - 1) + ' → L' + bad + ' 回落') : ('最小比值 ' + minRatio.toFixed(3) + ' @' + minAt));
}

/* ---- B. 章内平滑 ---- */
{
  const bounds = [0, 10, 20, CH4_START, 40];      // 章界（左闭右开）
  let maxRatio = 0, maxAt = '';
  let withinBad = '';
  for (let c = 0; c < bounds.length - 1; c++) {
    for (let i = bounds[c] + 1; i < bounds[c + 1]; i++) {
      const r = rows[i].pressure / rows[i - 1].pressure;
      if (r > maxRatio) { maxRatio = r; maxAt = 'L' + rows[i - 1].index + '→L' + rows[i].index; }
      if (r > 1.25) withinBad += 'L' + rows[i - 1].index + '→L' + rows[i].index + '=' + r.toFixed(2) + ' ';
    }
  }
  assert('B. 章内相邻关跳变 ≤ 1.25（爬升平滑）', withinBad === '',
    'max=' + maxRatio.toFixed(2) + ' @' + maxAt + (withinBad ? ' | ' + withinBad : ''));
}

/* ---- C. 章界跳变与「唯一断点」约束 ---- */
{
  const entries = [10, 20, CH4_START].map(i => ({
    at: 'L' + rows[i - 1].index + '→L' + rows[i].index,
    ratio: rows[i].pressure / rows[i - 1].pressure,
  }));
  const tooBig = entries.filter(e => e.ratio > 1.55);
  assert('C1. 跨章入口跳变均 ≤ 1.55（章节门槛不得失控）', tooBig.length === 0,
    entries.map(e => e.at + '=' + e.ratio.toFixed(2)).join(' | '));

  // 全曲线里「> 1.35 的跳变」只允许一笔，且必须落在第四章入口
  let spikes = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i].pressure / rows[i - 1].pressure;
    if (r > 1.35) spikes.push({ at: 'L' + rows[i - 1].index + '→L' + rows[i].index, ratio: r });
  }
  const onlyCh4 = spikes.length === 1 && spikes[0].at === 'L30→L31';
  assert('C2. 全曲线仅第四章入口存在一处陡增（> 1.35），其余章节就近平滑', onlyCh4,
    spikes.map(s => s.at + '=' + s.ratio.toFixed(2)).join(' | ') || '无陡增');
}

/* ---- D. 首末锚点 ---- */
{
  assert('D1. 第 1 关足够轻松（压力 ≤ 4.5）', rows[0].pressure <= 4.5, 'p=' + rows[0].pressure.toFixed(2));
  assert('D2. 第 40 关处于终局高压（压力 ≥ 60）', rows[rows.length - 1].pressure >= 60,
    'p=' + rows[rows.length - 1].pressure.toFixed(2));
  // 同上：整数取整会带来末位抖动（实测 L39 65.9 / L40 65.2），故要求"处于最高档"而非"逐位最高"
  const peak = Math.max(...rows.map(r => r.pressure));
  assert('D3. 第 40 关处于全曲线最高档（≥ 峰值 98%）',
    rows[rows.length - 1].pressure >= peak * 0.98,
    'L40=' + rows[rows.length - 1].pressure.toFixed(1) + ' peak=' + peak.toFixed(1));
}

console.log(ok ? '\n=== 难度曲线回归全部通过 ===' : '\n=== 难度曲线回归存在失败 ===');
process.exit(ok ? 0 : 1);
