// 任务3 测试：从零开始 vs 沿用上次布防 的点击逻辑
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function stubEl() {
  return { textContent: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, getContext() { return new Proxy({}, { get: () => () => {} }); }, width: 1280, height: 720 };
}
const elCache = {};
const sandbox = {
  Math, Map, console, JSON, Array, Object, String, Number, isNaN, parseInt, parseFloat,
  performance: { now: () => Date.now() },
  window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
  document: { getElementById: (id) => (elCache[id] || (elCache[id] = stubEl())), querySelectorAll: () => [], addEventListener() {}, querySelector: () => null },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; } },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
};
sandbox.global = sandbox;
vm.createContext(sandbox);
function load(f) { vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f }); }
load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
// 预置闯关进度：解锁到第 30 关，使测试可访问高关卡（解锁制单独由 unlock.test.js 验证）
sandbox.localStorage.setItem('starshield_campaign_unlocked', '30');
load('js/game.js');
sandbox.physics = sandbox.window.physics; sandbox.audio = sandbox.window.audio;
sandbox.predictor = sandbox.window.predictor; sandbox.predictorRenderer = sandbox.window.predictorRenderer;
sandbox.render = sandbox.window.render;
const game = sandbox.window.game;

let ok = true;
function assert(name, cond, extra) { if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; } else console.log('PASS: ' + name); }

// 预置一条"上次布防"存档（与 saveSetup 存盘格式一致：直接是星体数组）
sandbox.localStorage.setItem('starshield_setup', JSON.stringify([
  { type: 'star', x: 500, y: 400, mass: 150, radius: 16 },
  { type: 'star', x: 780, y: 400, mass: 150, radius: 16 },
]));

// 1. 从零开始：不应用存档，画布仅母星，星能不被扣（camp-1 budget）
game.startGame({ mode: 'campaign', levelIndex: 0, keepSetup: false });
let st = game.state;
assert('从零开始：画布仅母星（无存档星体）', st.bodies.filter(b => b.type === 'star').length === 0, 'stars=' + st.bodies.filter(b => b.type === 'star').length);
assert('从零开始：闯关星能未被扣减(预算>0)', st.budget === st.level.budget, 'budget=' + st.budget + ' lv=' + st.level.budget);

// 2. 沿用上次布防：应用存档，画布出现存档星体，星能被扣减
game.startGame({ mode: 'campaign', levelIndex: 0, keepSetup: true });
st = game.state;
const starsPlaced = st.bodies.filter(b => b.type === 'star').length;
assert('沿用：画布出现存档星体(=2)', starsPlaced === 2, 'stars=' + starsPlaced);
assert('沿用：闯关星能被扣减(预算 -300)', st.budget === st.level.budget - 300, 'budget=' + st.budget);

// 3. 默认（未传 keepSetup）应从零开始（不应用存档）
game.startGame({ mode: 'campaign', levelIndex: 0 });
st = game.state;
assert('默认(无keepSetup)：不应用存档，星体=0', st.bodies.filter(b => b.type === 'star').length === 0);

// 4. 闯关模式确定性：startGame 同关卡，波数一致且>0
game.startGame({ mode: 'campaign', levelIndex: 2, keepSetup: false });
const lvA = game.state.level;
const wcount = lvA.waves.length;
assert('闯关模式 camp-3 存在确定性波次数组', Array.isArray(lvA.waves) && wcount > 0, 'waves=' + wcount);

console.log(ok ? '\n=== 从零/沿用布防测试全部通过 ===' : '\n=== 任务3 测试存在失败 ===');
process.exit(ok ? 0 : 1);
