// 主循环与来袭生成机制测试：
//   1) 帧率无关累加步进（60/120/240Hz 推进相同游戏时间，高刷屏不再 2 倍速）
//   2) 超长 dt 钳制（最多补 MAX_SUBSTEPS=3 步，防追帧雪崩）
//   3) 慢动作 timeScale=0.25 等比减速
//   4) 闯关确定性波次的 edge 字符串映射（left/right 正确落到左右边界）
//   5) 生存模式来袭瞄准母星（偏角随难度收窄，不再全向乱飞白送拦截分）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function stubEl() {
  return { textContent: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, getContext() { return new Proxy({}, { get: () => () => {} }); },
    querySelectorAll: () => [], querySelector: () => null, dataset: {}, width: 1280, height: 720 };
}
const elCache = {};
const sandbox = {
  Math, Map, console, JSON, Array, Object, String, Number, isNaN, parseInt, parseFloat,
  performance: { now: () => Date.now() },
  window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
  document: { getElementById: (id) => (elCache[id] || (elCache[id] = stubEl())), querySelectorAll: () => [], addEventListener() {}, querySelector: () => null, createElement: () => stubEl() },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
function load(f) { vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f }); }
load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
load('js/game.js');
sandbox.physics = sandbox.window.physics;
sandbox.audio = sandbox.window.audio;
sandbox.render = sandbox.window.render;
sandbox.game = sandbox.window.game;
load('js/input.js');   // 注册 __showResult / __refreshMenuBest 钩子

let ok = true;
function assert(name, cond, extra) { if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; } else console.log('PASS: ' + name); }

// 冻结物理积分：本测试只关心调度/生成，不关心轨迹演化
const physics = sandbox.physics;
physics.stepSystem = function () {};

const game = sandbox.window.game;
const DT = 1 / 60;
function freshSurvival() {
  game.startGame({ mode: 'survival', levelIndex: 0 });
  return game.state;
}

// ---- 1. 帧率无关 ----
function advance(frames, dt) {
  const st = freshSurvival();
  for (let i = 0; i < frames; i++) game.stepFrame(dt);
  return 60 - st.remainingTime;   // 已推进的游戏秒数（生存 60s 限时倒计时）
}
const t60 = advance(60, DT);
const t120 = advance(120, DT / 2);
const t240 = advance(240, DT / 4);
assert('60Hz × 1s 推进 1.0s 游戏时间', Math.abs(t60 - 1) < 1e-9, 't=' + t60);
assert('120Hz × 1s 推进 1.0s 游戏时间（不再 2 倍速）', Math.abs(t120 - 1) < 1e-9, 't=' + t120);
assert('240Hz × 1s 推进 1.0s 游戏时间', Math.abs(t240 - 1) < 1e-9, 't=' + t240);
assert('三种帧率推进完全一致', Math.abs(t60 - t120) < 1e-12 && Math.abs(t120 - t240) < 1e-12);

// ---- 2. 超长 dt 钳制（切后台/卡顿）----
{
  const st = freshSurvival();
  game.stepFrame(10);                       // 单帧 10 秒的离谱 dt
  const advanced = 60 - st.remainingTime;
  assert('超长 dt 被钳制为 ≤ 3 步(0.05s)', advanced <= 3 * DT + 1e-9 && advanced > 0, 'advanced=' + advanced);
  game.stepFrame(10);                       // 积压不累积，仍是 3 步
  assert('积压被丢弃，不会追帧雪崩', 60 - st.remainingTime <= 6 * DT + 1e-9, 'total=' + (60 - st.remainingTime));
}

// ---- 3. 慢动作 timeScale = 0.25 ----
{
  const st = freshSurvival();
  st.timeScale = 0.25;
  for (let i = 0; i < 60; i++) game.stepFrame(DT);
  const advanced = 60 - st.remainingTime;
  assert('慢动作 60 帧推进 0.25s', Math.abs(advanced - 0.25) < 1e-9, 't=' + advanced);
}

// ---- 4. 闯关威胁从配置的边界生成（'left'/'right' 映射）----
{
  game.startGame({ mode: 'campaign', levelIndex: 0 });
  const st = game.state;
  st.timeScale = 1;          // state 为单例，前一用例的慢动作会残留，这里显式复位
  st.waveTimer = 0.5;
  const spawned = [];
  for (let f = 0; f < 1200; f++) {
    const before = st.bodies.length;
    game.stepFrame(DT);
    for (let i = before; i < st.bodies.length; i++) {
      const b = st.bodies[i];
      if (b.type === 'asteroid' || b.type === 'comet') spawned.push(b);
    }
    // 波次已开启且队列吐空 = 本波生成完毕（波次未开始时队列本就是空的，不能据此 break）
    if (st.waveActive && st.waveQueue.length === 0) break;
  }
  assert('第一波威胁全部生成（>0 个）', spawned.length > 0, 'n=' + spawned.length);
  const edgeOk = spawned.every(b => b.x === -60 || b.x === 1280 + 60);
  assert('威胁从 left/right 边界生成（edge 字符串映射生效）', edgeOk,
    'xs=' + [...new Set(spawned.map(b => b.x))].slice(0, 5).join(','));
}

// ---- 5. 生存模式来袭瞄准母星 ----
{
  const st = freshSurvival();
  st.timeScale = 1;
  st.waveTimer = 0.5;
  const planet = st.bodies[0];
  const spawned = [];
  for (let f = 0; f < 1200; f++) {
    const before = st.bodies.length;
    game.stepFrame(DT);
    for (let i = before; i < st.bodies.length; i++) {
      const b = st.bodies[i];
      if (b.type === 'asteroid' || b.type === 'comet') spawned.push(b);
    }
    if (st.waveActive && st.waveQueue.length === 0) break;
  }
  assert('生存模式第一波威胁全部生成（>0 个）', spawned.length > 0, 'n=' + spawned.length);
  // 第 1 关难度 ≈0.30 → spreadArc = lerp(0.60, 0.15, 0.30) ≈ 0.465 rad
  let maxDev = 0;
  for (const b of spawned) {
    const baseAng = Math.atan2(planet.y - b.y, planet.x - b.x);
    const ang = Math.atan2(b.vy, b.vx);
    let dev = Math.abs(ang - baseAng);
    while (dev > Math.PI) dev = Math.abs(dev - 2 * Math.PI);
    maxDev = Math.max(maxDev, dev);
  }
  assert('威胁方向瞄准母星（偏角 ≤ 0.6 rad）', maxDev <= 0.6, 'maxDev=' + maxDev.toFixed(3));
  // 出界计分只对威胁生效：玩家星体飞出边界不得分（回归测试）
  const fakeStar = { type: 'star', mass: 150, radius: 13, x: -200, y: 360, vx: 0, vy: 0 };
  const clearedBefore = st.asteroidsCleared;
  st.bodies.push(fakeStar);
  game.stepFrame(DT);
  assert('玩家星体出界不计入拦截分', st.asteroidsCleared === clearedBefore);
}

console.log(ok ? '\n=== 主循环/来袭生成机制测试全部通过 ===' : '\n=== 主循环/来袭生成机制测试存在失败 ===');
process.exit(ok ? 0 : 1);
