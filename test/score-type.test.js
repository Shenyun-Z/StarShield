// 分数整数类型一致性测试（用户 bug：生存最佳分数显示为 274.03333333 分）
// 验证：旧存档浮点被 parseInt 归一、bestForMode 恒为整数、结算总分与明细一致。
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

let ok = true;
function assert(name, cond, extra) { if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; } else console.log('PASS: ' + name); }

// 预置一段"浮点旧存档"（模拟用户看到的 bug 场景），再加载模块
sandbox.localStorage.setItem('starshield_best_score', '274.03333333333334');
load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
sandbox.localStorage.setItem('starshield_campaign_unlocked', '30');
load('js/game.js');
const game = sandbox.window.game;
sandbox.game = game;
sandbox.physics = sandbox.window.physics;
sandbox.render = sandbox.window.render;
load('js/input.js');   // 提供 __refreshMenuBest（renderMenuBest）
const refresh = sandbox.window.__refreshMenuBest;

// 1. loadBest 用 parseInt 归一化浮点旧存档 → 整数
game.loadBest();
const best = game.bestForMode('survival');
assert('浮点旧存档被归一为整数', Number.isInteger(best) && best === 274, 'best=' + best);

// 2. 显示层拼接为整数（菜单「X 分」）
const menuText = `本机成就：生存最佳 ${best > 0 ? best + ' 分' : '—'}`;
assert('菜单分数拼接为整数', /274 分/.test(menuText), menuText);

// 3. 生存模式累积浮点存活分后，结算总分恒为整数且 = 明细代数和
game.startGame({ mode: 'survival', levelIndex: 0 });
const st = game.state;
st.bodies = st.bodies.filter(b => b.type === 'planet');
st.difficulty = 0.3;
for (let i = 0; i < 200; i++) game.stepFrame();   // 累积 ~6.67 分浮点存活分
// 再触发一次拦截，制造拦截分
const planet = st.bodies[0];
st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet.x + 9999, y: planet.y, vx: 0, vy: 0 });
game.stepFrame();
const stats = game.getCurrentRunStats();
const sum = stats.scoreIntercept + stats.scoreWaveBonus + stats.scoreSurvive - stats.scorePenalty;
assert('存活分累积后结算总分为整数', Number.isInteger(stats.score), 'score=' + stats.score);
assert('总分与明细代数和一致', stats.score === sum, 'score=' + stats.score + ' sum=' + sum);

console.log(ok ? '\n=== 分数整数类型测试全部通过 ===' : '\n=== 分数整数类型测试存在失败 ===');
process.exit(ok ? 0 : 1);
