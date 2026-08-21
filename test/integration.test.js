// 系统集成测试：端到端验证“陨石撞母星 → 扣血 + 动画”
// 用 stub DOM 加载真实 game.js，模拟真实 stepFrame 调用路径。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

// ---- DOM / 环境 stub ----
function stubEl() {
  return {
    textContent: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, getContext() { return ctx2d(); },
    width: 1280, height: 720,
  };
}
function ctx2d() {
  return new Proxy({}, { get: () => () => {} });
}
const elCache = {};
const sandbox = {
  Math, Map, console, JSON, Array, Object, String, Number, isNaN, parseInt, parseFloat,
  performance: { now: () => Date.now() },
  window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  document: { getElementById: (id) => (elCache[id] || (elCache[id] = stubEl())), querySelectorAll: () => [], addEventListener() {}, querySelector: () => null },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; } },
};
sandbox.global = sandbox;
sandbox.window.game = undefined;
vm.createContext(sandbox);

function load(f) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
// 先加载依赖（挂到 sandbox 全局，模拟浏览器 window.* 全局变量）
load('js/physics.js');
load('js/predictor.js');
load('js/predictorRenderer.js');
load('js/audio.js');
load('js/render.js');
// 暴露为全局（浏览器中这些即 window.x）
sandbox.physics = sandbox.window.physics;
sandbox.predictor = sandbox.window.predictor;
sandbox.predictorRenderer = sandbox.window.predictorRenderer;
sandbox.audio = sandbox.window.audio;
sandbox.render = sandbox.window.render;

// ---- 加载 game.js ----
load('js/game.js');
const game = sandbox.window.game;
if (!game || !game.startGame || !game.stepFrame) {
  console.error('FAIL: game.startGame/stepFrame 未导出');
  process.exit(1);
}

// ---- 系统测试：生存模式，强制陨石撞母星 ----
function testFullHitStar() {
  game.startGame('survival', 0);
  const st = game.state;
  if (!st || !st.gameStarted) { console.error('FAIL: startGame 未启动'); return false; }
  if (st.bodies.some(b => b.type === 'blackhole')) { console.error('FAIL: 开局不应有黑洞'); return false; }

  // 清空自动生成的陨石，手动放一个径直撞向母星的陨石
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  const planet = st.bodies[0];
  const before = st.health;
  st.bodies.push({
    type: 'asteroid', mass: 50, radius: 13,
    x: planet.x + 5, y: planet.y, vx: 0, vy: 0,
  });

  // 跑若干帧（stepFrame 内部会调用 damagePlanet + 动画）
  let damaged = false, animated = false;
  for (let i = 0; i < 5; i++) {
    game.stepFrame();
    if (st.health < before) damaged = true;
    if (st.healthFlash > 0 || st.planetPunch > 0 || st.shake > 0) animated = true;
  }
  if (!damaged) { console.error('FAIL: 撞击母星后 health 未减少 (before=' + before + ', after=' + st.health + ')'); return false; }
  if (!animated) { console.error('FAIL: 撞击母星后未触发动画状态'); return false; }
  console.log('PASS: 端到端 撞击母星 → 扣血 ' + before + '→' + st.health + ' + 动画触发');
  return true;
}

// ---- 系统测试：母星被多次撞击，血量耗尽应触发 gameOver ----
function testGameOverOnDepletion() {
  game.startGame('survival', 0);
  const st = game.state;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  const planet = st.bodies[0];
  let guard = 0;
  while (!st.gameOver && guard++ < 50) {
    st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet.x + 5, y: planet.y, vx: 0, vy: 0 });
    game.stepFrame();
    // 移除已 dead 的（避免堆积，但 stepFrame 内会自动清理）
  }
  if (!st.gameOver) { console.error('FAIL: 血量耗尽后未触发 gameOver'); return false; }
  console.log('PASS: 血量耗尽触发 gameOver');
  return true;
}

let ok = true;
ok = testFullHitStar() && ok;
ok = testGameOverOnDepletion() && ok;
console.log(ok ? '\n=== 系统测试全部通过 ===' : '\n=== 系统测试存在失败 ===');
process.exit(ok ? 0 : 1);
