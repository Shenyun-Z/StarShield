// 结算界面（任务1）数据链路测试：
// 验证 getCurrentRunStats 返回的计分项/权重倍率/明细/总分字段完整，
// 且 input.showResult 能正确填充 DOM（计分项/权重/倍率/明细/总分）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

function stubEl() {
  return {
    textContent: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, getContext() { return ctx2d(); },
    querySelectorAll: () => [], querySelector: () => null,
    width: 1280, height: 720, dataset: {},
  };
}
function ctx2d() { return new Proxy({}, { get: () => () => {} }); }
const elCache = {};
const sandbox = {
  Math, Map, console, JSON, Array, Object, String, Number, isNaN, parseInt, parseFloat,
  performance: { now: () => Date.now() },
  window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
  document: { getElementById: (id) => (elCache[id] || (elCache[id] = stubEl())), querySelectorAll: () => [], addEventListener() {}, querySelector: () => null, createElement: () => stubEl() },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; } },
};
sandbox.global = sandbox;
sandbox.window.game = undefined;
vm.createContext(sandbox);

function load(f) { vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f }); }
load('js/physics.js');
load('js/predictor.js');
load('js/predictorRenderer.js');
load('js/audio.js');
load('js/levels-campaign.js');
sandbox.localStorage.setItem('starshield_campaign_unlocked', '30');
load('js/render.js');
load('js/game.js');
const game = sandbox.window.game;
// input.js 直接引用裸全局 game，需先暴露
sandbox.game = game;
sandbox.physics = sandbox.window.physics;
sandbox.render = sandbox.window.render;
sandbox.pred = sandbox.window.render; // input.js 用 render
load('js/input.js');   // 提供 window.__showResult
const showResult = sandbox.window.__showResult;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); failed++; }
  else console.log('PASS: ' + msg);
}

// ---- 1) 统计字段完整性 ----
game.startGame({ mode: 'survival', levelIndex: 0 });
// 模拟一次拦截清除 + 一次母星受击，构造明细
const st = game.state;
// 直接调用内部计分入口：通过 registerClear 不存在于 window，改用 stepFrame 自然路径较繁，
// 这里直接驱动 state 上的累计字段以验证展示链路（计分逻辑本身由 score.test.js 覆盖）。
st.scoreIntercept = 256;
st.scoreWaveBonus = 80;
st.scoreSurvive = 140;
st.scorePenalty = 16;
st.asteroidsCleared = 18;
st.score = st.scoreIntercept + st.scoreWaveBonus + st.scoreSurvive - st.scorePenalty;
st.difficulty = 0.9;

const stats = game.getCurrentRunStats();
assert(typeof stats.scoreIntercept === 'number', 'getCurrentRunStats 含 scoreIntercept');
assert(typeof stats.scoreWaveBonus === 'number', 'getCurrentRunStats 含 scoreWaveBonus');
assert(typeof stats.scoreSurvive === 'number', 'getCurrentRunStats 含 scoreSurvive');
assert(typeof stats.scorePenalty === 'number', 'getCurrentRunStats 含 scorePenalty');
assert(typeof stats.interceptCount === 'number' && stats.interceptCount === 18, 'getCurrentRunStats 含 interceptCount=18');
assert(typeof stats.diffMul === 'number' && stats.diffMul > 1, 'diffMul 随难度加权 >1 (=' + stats.diffMul + ')');
assert(typeof stats.modeMul === 'number', 'modeMul 字段存在');

// 生存模式 modeMul 应为 1
assert(stats.modeMul === 1, '生存模式 modeMul = 1');

// ---- 2) showResult 填充 DOM（计分项/权重/倍率/明细/总分） ----
showResult('timeup'); // 不应抛错
assert(elCache['rsIntercept'].textContent === 256, 'rsIntercept 被填充 = 256');
assert(elCache['rsWaveBonus'].textContent === 80, 'rsWaveBonus 被填充 = 80');
assert(elCache['rsSurvive'].textContent === 140, 'rsSurvive 被填充 = 140');
assert(elCache['rsPenalty'].textContent === 16, 'rsPenalty 被填充 = 16');
assert(elCache['rsScore'].textContent === (256 + 80 + 140 - 16), 'rsScore 总分 = 各分项代数和');
assert(/×/.test(String(elCache['sdDiffMul'].textContent)), 'sdDiffMul 显示倍率形式 ' + elCache['sdDiffMul'].textContent);
assert(/清除 18 个/.test(String(elCache['rsInterceptNote'].textContent)), '拦截明细展示清除数量: ' + elCache['rsInterceptNote'].textContent);

// 生存模式应显示生存奖励行（display 不影响 stub，但 showResult 不应隐藏）
assert(elCache['sdSurviveRow'].style.display === '', '生存模式显示生存奖励行');

// ---- 3) 闯关模式隐藏生存行 + modeMul>1 ----
game.startGame({ mode: 'campaign', levelIndex: 2 });
game.state.scoreIntercept = 300; game.state.scoreWaveBonus = 50; game.state.scorePenalty = 8;
game.state.asteroidsCleared = 10;
game.state.score = 300 + 50 - 8;
showResult('defeat');
assert(elCache['sdSurviveRow'].style.display === 'none', '闯关模式隐藏生存奖励行');
assert(elCache['sdModeMul'].textContent === '×' + (1 + 2 * 0.15).toFixed(2), '闯关模式 modeMul 随关卡序号 = ' + elCache['sdModeMul'].textContent);

if (failed > 0) { console.error('\n' + failed + ' 项失败'); process.exit(1); }
console.log('\n全部结算界面数据链路测试通过');
