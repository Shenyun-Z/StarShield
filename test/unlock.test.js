// 解锁制测试（需求2）：
//   - 默认只解锁第 1 关（idx 0）
//   - 通关当前关后解锁下一关
//   - 未解锁的关卡 startGame 返回 false（无法开玩）
//   - 一键清除进度：清空 localStorage，回到第 1 关
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
load('js/game.js');   // 注意：此时 localStorage 无解锁进度，loadBest 读到 0
sandbox.physics = sandbox.window.physics;
sandbox.audio = sandbox.window.audio;
sandbox.predictor = sandbox.window.predictor;
sandbox.predictorRenderer = sandbox.window.predictorRenderer;
sandbox.render = sandbox.window.render;
const game = sandbox.window.game;

let ok = true;
function assert(name, cond, extra) { if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; } else console.log('PASS: ' + name); }

// 1. 新玩家默认只解锁第 1 关
assert('默认解锁进度 = 0（仅第 1 关可玩）', game.getCampaignUnlocked() === 0, 'unlocked=' + game.getCampaignUnlocked());
assert('第 1 关已解锁', game.isLevelUnlocked(0));
assert('第 2 关未解锁', !game.isLevelUnlocked(1));

// 2. 未解锁关卡无法 startGame
const r1 = game.startGame({ mode: 'campaign', levelIndex: 5 });
assert('未解锁关卡 startGame 返回 false', r1 === false);

// 3. 第 1 关可正常开局
const r0 = game.startGame({ mode: 'campaign', levelIndex: 0 });
assert('第 1 关可开局', r0 !== false);

// 4. 通关第 1 关 → 解锁第 2 关（通过最后一波清空触发 endGame('win')）
game.state.mode = 'campaign';
game.state.levelIndex = 0;
game.state.isLastWave = true;
game.state.waveActive = true;
game.state.waveQueue = [];
// 清空场上全部威胁（仅保留母星），stepFrame 会检测剩余=0 → clearWave → win
game.state.bodies = game.state.bodies.filter(b => b.type === 'planet');
game.stepFrame();
assert('通关后解锁进度推进到 1', game.getCampaignUnlocked() === 1, 'unlocked=' + game.getCampaignUnlocked());
assert('第 2 关现在已解锁', game.isLevelUnlocked(1));
assert('第 3 关仍未解锁', !game.isLevelUnlocked(2));

// 5. 通关进度已写入 localStorage
assert('解锁进度写入 localStorage', sandbox.localStorage.getItem('starshield_campaign_unlocked') === '1');

// 6. 继续通关第 2 关 → 解锁第 3 关
game.startGame({ mode: 'campaign', levelIndex: 1 });
game.state.isLastWave = true;
game.state.waveActive = true;
game.state.waveQueue = [];
game.state.bodies = game.state.bodies.filter(b => b.type === 'planet');
game.stepFrame();
assert('连续通关到第 2 关', game.getCampaignUnlocked() === 2, 'unlocked=' + game.getCampaignUnlocked());

// 7. 一键清除进度：清空全部 localStorage 键 + 回第 1 关
sandbox.localStorage.setItem('starshield_setup', JSON.stringify([{ x: 1, y: 2, type: 'star', mass: 150, radius: 16 }]));
sandbox.localStorage.setItem('starshield_best_score', '999');
sandbox.localStorage.setItem('starshield_audio', 'off');
game.clearAllProgress();
assert('清除后解锁进度归零', game.getCampaignUnlocked() === 0);
assert('清除后布防存档被删除', sandbox.localStorage.getItem('starshield_setup') === null);
assert('清除后最佳战绩被删除', sandbox.localStorage.getItem('starshield_best_score') === null);
assert('清除后音频设置被删除', sandbox.localStorage.getItem('starshield_audio') === null);
assert('清除后第 2 关重新锁定', !game.isLevelUnlocked(1));

console.log(ok ? '\n=== 解锁制/清除进度测试全部通过 ===' : '\n=== 解锁制测试存在失败 ===');
process.exit(ok ? 0 : 1);
