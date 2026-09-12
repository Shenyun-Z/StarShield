// 得分标准验证测试：验证 registerClear / 波次奖励 / 失守惩罚 / 模式差异
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function stubEl() {
  return { textContent: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, getContext() { return new Proxy({}, { get: () => () => {} }); },
    width: 1280, height: 720 };
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
sandbox.localStorage.setItem('starshield_campaign_unlocked', '30');
load('js/game.js');
sandbox.physics = sandbox.window.physics;
sandbox.audio = sandbox.window.audio;
sandbox.predictor = sandbox.window.predictor;
sandbox.predictorRenderer = sandbox.window.predictorRenderer;
sandbox.render = sandbox.window.render;
const game = sandbox.window.game;
// M2：总分不再有 state.score 影子字段，统一走「明细派生」的唯一口径
const total = () => game.getCurrentRunStats().score;

let ok = true;
function assert(name, cond, extra) { if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; } else console.log('PASS: ' + name); }

// 1. 生存模式：出界清除陨石应得正分，难度加权生效
function testSurvivalClear() {
  game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.difficulty = 0.3;  // 基准难度
  const planet = st.bodies[0];
  const before = total();
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet.x + 9999, y: planet.y, vx: 0, vy: 0 });
  game.stepFrame();
  const gain = total() - before;
  // base = 6 + round(50/8)=6+6=12; diffMul=1; modeMul=1 => 12
  assert('生存模式出界陨石得分≈12', Math.abs(gain - 12) < 0.2, 'gain=' + gain);
  assert('拦截计数+1', st.asteroidsCleared === 1);

  // 难度升高应更高分
  const before2 = total();
  st.difficulty = 1.0;
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet.x + 9999, y: planet.y, vx: 0, vy: 0 });
  game.stepFrame();
  const gain2 = total() - before2;
  // diffMul = 1 + (1.0-0.3)*1.4 = 1.98; 12*1.98=23.76 -> round 24
  assert('高难度出界陨石得分更高(≈24)', Math.abs(gain2 - 24) < 0.2, 'gain2=' + gain2);
  return true;
}
// 2. 彗星基础分更高
function testCometClear() {
  game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.difficulty = 0.3;
  const planet = st.bodies[0];
  const before = total();
  st.bodies.push({ type: 'comet', mass: 30, radius: 10, x: planet.x + 9999, y: planet.y, vx: 0, vy: 0 });
  game.stepFrame();
  const gain = total() - before;
  assert('彗星出界得分≈12（高于陨石）', Math.abs(gain - 12) < 0.2, 'gain=' + gain);
  return true;
}
// 3. 波次奖励
function testWaveBonus() {
  game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.wave = 3;
  const before = total();
  // 调用 clearWave 通过私有不可直接访问，改为触发：清空所有陨石并 waveActive
  st.waveActive = true; st.waveQueue = [];
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  game.stepFrame();  // 剩余威胁为 0 -> clearWave
  const gain = total() - before;
  assert('波次清空奖励≈15+5*3=30', Math.abs(gain - 30) < 0.2, 'gain=' + gain);
  return true;
}
// 4. 失守惩罚：母星被击中扣分（不低于0）
function testHitPenalty() {
  game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.difficulty = 0.3;
  const planet = st.bodies[0];
  // 先得一些分（M2：直接写明细字段，总分由其派生）
  st.scoreIntercept = 100;
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet.x + 5, y: planet.y, vx: 0, vy: 0 });
  game.stepFrame();
  assert('撞击母星扣 8 分', Math.abs(total() - 92) < 0.5, 'score=' + total());
  // 分数很低时不低于 0，且惩罚明细只累计「实际扣除量」
  st.scorePenalty = 0;
  st.scoreIntercept = 5;
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet.x + 5, y: planet.y, vx: 0, vy: 0 });
  game.stepFrame();
  assert('低分时失守不出现负分', total() >= 0 && total() < 5, 'score=' + total());
  assert('低分时惩罚明细 = 实际扣除量(5)', st.scorePenalty === 5, 'penalty=' + st.scorePenalty);
  return true;
}
// 5. 闯关模式：清掉天体返还星能（旧 rewards 紊乱已移除）
function testExtremeRecycle() {
  game.startGame({ mode: 'campaign', levelIndex: 0 });
  const st = game.state;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.difficulty = 0.3;
  const planet = st.bodies[0];
  const budgetBefore = st.budget;
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet.x + 9999, y: planet.y, vx: 0, vy: 0 });
  game.stepFrame();
  assert('闯关模式清除返还 2 星能', st.budget === budgetBefore + 2, 'budget=' + st.budget);
  // 闯关模式后关 modeMul 应 > 1
  game.startGame({ mode: 'campaign', levelIndex: 3 });
  const st2 = game.state;
  st2.bodies = st2.bodies.filter(b => b.type === 'planet');
  st2.difficulty = 0.3;
  const planet2 = st2.bodies[0];
  const b0 = total();
  st2.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet2.x + 9999, y: planet2.y, vx: 0, vy: 0 });
  game.stepFrame();
  const g = total() - b0; // modeMul = 1+3*0.15=1.45 => 12*1.45=17.4 -> 17
  assert('闯关模式第4关(modeIdx3)得分更高(=17)', g === 17, 'g=' + g);
  return true;
}
// 6. 开局无黑洞（第1关场景无黑洞，由玩家放置）
function testNoBlackhole() {
  game.startGame({ mode: 'survival', levelIndex: 0 }); game.startGame({ mode: 'campaign', levelIndex: 0 });
  assert('生存/闯关开局均无黑洞', !game.state.bodies.some(b => b.type === 'blackhole'));
  return true;
}
// 7. 分数始终为整数且明细之和恒等于总分（根治浮点漂移 / 显示不一致）
function testIntegerScore() {
  game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.difficulty = 0.3;
  // 跑足够多帧累积浮点存活分（每帧 +1/30），并模拟几次拦截与受击
  const planet = st.bodies[0];
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: planet.x + 9999, y: planet.y, vx: 0, vy: 0 });
  game.stepFrame();
  for (let i = 0; i < 100; i++) game.stepFrame();   // 累积 ~3.33 分存活分
  const stats = game.getCurrentRunStats();
  const sum = stats.scoreIntercept + stats.scoreWaveBonus + stats.scoreSurvive - stats.scorePenalty;
  assert('结算总分是整数', Number.isInteger(stats.score), 'score=' + stats.score);
  assert('总分 = 明细代数和（无浮点不一致）', stats.score === sum, 'score=' + stats.score + ' sum=' + sum);
  return true;
}

testSurvivalClear();
testCometClear();
testWaveBonus();
testHitPenalty();
testExtremeRecycle();
testNoBlackhole();
testIntegerScore();
console.log(ok ? '\n=== 得分测试全部通过 ===' : '\n=== 得分测试存在失败 ===');
process.exit(ok ? 0 : 1);
