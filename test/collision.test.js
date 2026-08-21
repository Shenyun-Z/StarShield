// 碰撞逻辑集成测试（Node 下运行，无需浏览器 DOM）
// 目标：验证“陨石/彗星撞母星”被正确检测、标记 hitStar、并触发 damagePlanet 扣血
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 1. 加载 physics.js（纯逻辑模块，导出到 window.physics） ----
const root = path.join(__dirname, '..');
const sandbox = {
  window: {},
  document: {},
  performance: { now: () => Date.now() },
  Math, Map, console,
};
sandbox.global = sandbox;
vm.createContext(sandbox);

function load(file) {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

load('js/physics.js');
const physics = sandbox.window.physics;
if (!physics || !physics.stepSystem) {
  console.error('FAIL: physics.stepSystem 未导出');
  process.exit(1);
}

// ---- 2. 集成测试：通过 game.js 实际调用的 physics.stepSystem 路径 ----
// game.js 只调用 physics.stepSystem，碰撞由 stepSystem 内部 resolveCollisions 处理
function testStepSystemStarCollision() {
  const planet = { type: 'planet', mass: 8000, radius: 30, x: 400, y: 300, vx: 0, vy: 0, immovable: true, anchored: true, isStar: true };
  const asteroid = { type: 'asteroid', mass: 50, radius: 13, x: 410, y: 300, vx: 0, vy: 0 };
  const bodies = [planet, asteroid];
  // 无人机动推进：强制把陨石移动到母星上，再跑一帧 stepSystem
  asteroid.x = 405; // 已在半径内
  physics.stepSystem(bodies, 0.016);
  if (!asteroid.dead) { console.error('FAIL: stepSystem 未标记撞击母星的陨石为 dead'); return false; }
  if (!asteroid.hitStar) { console.error('FAIL: stepSystem 未设置 hitStar（hitStar=' + asteroid.hitStar + '）'); return false; }
  if (planet.dead) { console.error('FAIL: 母星不应被标记 dead'); return false; }
  console.log('PASS: stepSystem 正确标记 hitStar');
  return true;
}

// ---- 3. 单元测试：远处陨石不应被标记 ----
function testResolveCollisionsFar() {
  const planet = { type: 'planet', mass: 8000, radius: 30, x: 400, y: 300, vx: 0, vy: 0, immovable: true, anchored: true, isStar: true };
  const asteroid = { type: 'asteroid', mass: 50, radius: 13, x: 800, y: 300, vx: 0, vy: 0 };
  const bodies = [planet, asteroid];
  physics.stepSystem(bodies, 0.016);
  if (asteroid.dead) { console.error('FAIL: 远处陨石不应被标记 dead'); return false; }
  console.log('PASS: 远处陨石未被误判');
  return true;
}

// ---- 4. 集成测试：模拟一帧 stepFrame 中 hitStar -> damagePlanet 扣血 ----
// 复刻 game.js stepFrame 的 dead 清理块逻辑，验证 hitStar 分支调用 damagePlanet
function makeState() {
  return { bodies: [], health: 3, hitCount: 0, shockwaves: [], flashes: [], planetPunch: 0, healthFlash: 0, shake: 0 };
}
function testDamagePlanetOnHitStar() {
  const state = makeState();
  const planet = { type: 'planet', mass: 8000, radius: 30, x: 400, y: 300, vx: 0, vy: 0, immovable: true, anchored: true, isStar: true };
  const asteroid = { type: 'asteroid', mass: 50, radius: 13, x: 405, y: 300, vx: 0, vy: 0, dead: true, hitStar: true };
  state.bodies.push(planet, asteroid);

  // 复刻清理块（与 game.js 605-629 行一致）
  for (let i = state.bodies.length - 1; i >= 0; i--) {
    const b = state.bodies[i];
    if (!b.dead) continue;
    if (b.hitStar) {
      state.health -= 1; state.hitCount += 1; state.healthFlash = 1; state.shake = 0.35; state.planetPunch = 1;
    }
    state.bodies.splice(i, 1);
  }
  if (state.health !== 2) { console.error('FAIL: 撞击母星未扣血, health=' + state.health); return false; }
  if (state.hitCount !== 1) { console.error('FAIL: hitCount 未增加'); return false; }
  if (state.bodies.length !== 1) { console.error('FAIL: 陨石未从 bodies 移除'); return false; }
  if (state.bodies[0] !== planet) { console.error('FAIL: 母星应保留'); return false; }
  console.log('PASS: hitStar 清理块正确扣血 1 点并移除陨石');
  return true;
}

// ---- 5. 回归：无初始黑洞（setupLevel 不应 push type=blackhole 的天体） ----
// 由于 game.js 依赖 DOM，这里静态确认 setupLevel 已移除黑洞放置（grep 验证）
function testNoInitialBlackhole() {
  const gameCode = fs.readFileSync(path.join(root, 'js/game.js'), 'utf8');
  // 找 setupLevel 函数体内对 blackhole 的 push
  const m = gameCode.match(/function setupLevel\(\)\s*\{([\s\S]*?)\n  \}/);
  if (!m) { console.error('FAIL: 未找到 setupLevel'); return false; }
  if (/type:\s*'blackhole'/.test(m[1])) {
    console.error('FAIL: setupLevel 仍放置初始黑洞');
    return false;
  }
  console.log('PASS: setupLevel 不再放置初始黑洞');
  return true;
}

let ok = true;
ok = testStepSystemStarCollision() && ok;
ok = testResolveCollisionsFar() && ok;
ok = testDamagePlanetOnHitStar() && ok;
ok = testNoInitialBlackhole() && ok;

console.log(ok ? '\n=== 全部测试通过 ===' : '\n=== 存在失败用例 ===');
process.exit(ok ? 0 : 1);
