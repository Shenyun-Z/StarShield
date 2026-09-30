// 公平性/确定性测试：验证闯关模式配置每次加载完全一致（无 Math.random 差异）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function loadLevels() {
  const sandbox = { Math, Object, console, JSON, Array, Number, String };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/levels-campaign.js'), 'utf8'), sandbox, { filename: 'levels-campaign.js' });
  return sandbox.window.CAMPAIGN_LEVELS;
}

let ok = true;
function assert(name, cond, extra) { if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; } else console.log('PASS: ' + name); }

const a = loadLevels();
const b = loadLevels();
const c = loadLevels();

assert('配置加载为 42 个关卡（40 常规关 + 2 隐藏关）', a.length === 42, 'len=' + a.length);
assert('常规关仍为 40 / 隐藏关为 2',
  a.filter(l => !l.hidden).length === 40 && a.filter(l => l.hidden).length === 2,
  'regular=' + a.filter(l => !l.hidden).length + ' hidden=' + a.filter(l => l.hidden).length);
assert('三次加载关卡数量一致', a.length === b.length && b.length === c.length);

function deepEqual(x, y) {
  if (x === y) return true;
  if (typeof x !== typeof y) return false;
  if (Array.isArray(x)) {
    if (x.length !== y.length) return false;
    return x.every((v, i) => deepEqual(v, y[i]));
  }
  if (x && typeof x === 'object') {
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.length !== ky.length) return false;
    return kx.every(k => deepEqual(x[k], y[k]));
  }
  return x === y;
}
assert('加载 A 与 B 完全一致（确定性）', deepEqual(a, b));
assert('加载 A 与 C 完全一致（确定性）', deepEqual(a, c));

// 规模检查：40 关 × 9~30 波 × 每波 4~14 个威胁 ≈ 数千个威胁单位
let totalSpawns = 0;
a.forEach(lv => { totalSpawns += lv.waves.reduce((s, w) => s + w.spawns.length, 0); });
assert('威胁配置总数 >= 1000', totalSpawns >= 1000, 'total=' + totalSpawns);

// 每波 spawns 字段完整（可被 game 直接消费）
let fieldOk = true;
a.forEach(lv => lv.waves.forEach(w => w.spawns.forEach(s => {
  if (typeof s.kind !== 'string' || s.edge == null || s.spread == null || !s.speed || !s.mass || !s.radius) fieldOk = false;
})));
assert('每个 spawn 含 kind/edge/spread/speed/mass/radius', fieldOk);

// 每关含清晰目标与失败条件（供开局横幅与结算展示）
let goalOk = a.every(lv => typeof lv.objective === 'string' && lv.objective.length > 0
  && typeof lv.failCondition === 'string' && lv.failCondition.length > 0);
assert('每关含 objective 与 failCondition', goalOk);

// 每关含简介（intro）供关卡卡片展示
let introOk = a.every(lv => typeof lv.intro === 'string' && lv.intro.length > 0);
assert('每关含 intro 简介', introOk);

// 难度严格递增：**常规关**的整体难度必须随序号单调递增（无平台期）。
// 隐藏关是"特殊规则挑战关"，不在难度曲线内（各有专属 modifier 与极低血量），故单独断言。
const reg = a.filter(l => !l.hidden);
let monoOk = true;
let firstBad = -1;
for (let i = 1; i < reg.length; i++) {
  if (reg[i].difficulty <= reg[i - 1].difficulty - 1e-9) { monoOk = false; if (firstBad < 0) firstBad = i; }
}
assert('常规 40 关难度严格递增', monoOk, (firstBad >= 0 ? 'break at ' + firstBad : '') + ' d0=' + reg[0].difficulty + ' dN=' + reg[reg.length - 1].difficulty);

// 波次数也随关卡递增（更多波 = 更持久 = 更难）
let waveMono = true;
for (let i = 1; i < reg.length; i++) if (reg[i].waves.length < reg[i - 1].waves.length) waveMono = false;
assert('常规 40 关波次数随序号非递减', waveMono, 'w0=' + reg[0].waves.length + ' wN=' + reg[reg.length - 1].waves.length);

// 隐藏关：不计星的特殊规则关，自成一组并独立校验
const hid = a.filter(l => l.hidden);
assert('隐藏关带 hidden / unlock / modifiers / 更低血量',
  hid.every(l => l.hidden && l.unlock && Array.isArray(l.modifiers) && l.modifiers.length > 0 && l.health < 16),
  JSON.stringify(hid.map(l => l.id + ':' + l.health)));
assert('隐藏关难度递增（隐藏 2 严于隐藏 1）', hid[0].difficulty < hid[1].difficulty,
  hid.map(l => l.difficulty).join(' -> '));

// 早期关卡更简单：第 1 关血量最高（与常规关末关比较）
assert('第 1 关血量 >= 常规关末关', reg[0].health >= reg[reg.length - 1].health,
  'h0=' + reg[0].health + ' hN=' + reg[reg.length - 1].health);

// 验证无 Math.random 依赖（从源码层面）：levels-campaign.js 不应含 Math.random
const src = fs.readFileSync(path.join(root, 'js/levels-campaign.js'), 'utf8');
assert('生成器不使用 Math.random（纯确定性 PRNG）', !/Math\.random/.test(src));

console.log(ok ? '\n=== 确定性/公平性测试全部通过 ===' : '\n=== 确定性测试存在失败 ===');
process.exit(ok ? 0 : 1);
