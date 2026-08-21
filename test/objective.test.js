// 关卡目标 / 结束条件 / 常驻进度 / 结算「下一关」 集成测试（需求：目标清晰显示）
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
sandbox.localStorage.setItem('starshield_campaign_unlocked', '30');
load('js/game.js');
const game = sandbox.window.game;
sandbox.game = game;
sandbox.physics = sandbox.window.physics;
sandbox.render = sandbox.window.render;
load('js/input.js');   // 提供 __showResult / __refreshMenuBest
const showResult = sandbox.window.__showResult;

let ok = true;
function assert(name, cond, extra) { if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; } else console.log('PASS: ' + name); }

// 1. 开局后关卡含目标与失败条件（横幅渲染数据源）
game.startGame({ mode: 'campaign', levelIndex: 0 });
const lv = game.state.level;
assert('关卡含 objective（目标）', typeof lv.objective === 'string' && lv.objective.length > 0, lv.objective);
assert('关卡含 failCondition（失败条件）', typeof lv.failCondition === 'string' && lv.failCondition.length > 0, lv.failCondition);
assert('objective 文案提及总波数', /全部 \d+ 波/.test(lv.objective), lv.objective);

// 2. 开局横幅被填充目标与失败条件
const banner = elCache['levelBanner'];
assert('开局横幅写入关卡名', (banner.innerHTML || '').indexOf(lv.name) >= 0);
assert('开局横幅写入目标', (banner.innerHTML || '').indexOf(lv.objective) >= 0);
assert('开局横幅写入失败条件', (banner.innerHTML || '').indexOf(lv.failCondition) >= 0);

// 3. 常驻进度：HUD 波次显示「当前/总」
game.updateHud();
const waveVal = elCache['waveVal'];
assert('HUD 波次显示 当前/总波', /^\d+\/\d+$/.test(String(waveVal.textContent)), waveVal.textContent);

// 4. 结算面板：胜利（win）显示「下一关」，失败（defeat）隐藏
game.state.wave = lv.waves.length;       // 模拟打到最后一波
game.state.isLastWave = true;
game.state.mode = 'campaign';
showResult('win');
const nextBtn = elCache['resultNext'];
assert('胜利结算显示「下一关」按钮', nextBtn.style.display !== 'none');
assert('胜利标题为「通关！」', elCache['resultTitle'].textContent === '通关！');
assert('胜利副标题说明目标达成', (elCache['resultSubtitle'].textContent || '').indexOf('目标达成') >= 0);

// 失败：重置为未通关状态再结算
game.startGame({ mode: 'campaign', levelIndex: 0 });
game.state.mode = 'campaign';
game.state.wave = 2;
showResult('defeat');
assert('失败结算隐藏「下一关」按钮', elCache['resultNext'].style.display === 'none');
assert('失败标题为「防线失守」', elCache['resultTitle'].textContent === '防线失守');
assert('失败副标题说明止步波次', (elCache['resultSubtitle'].textContent || '').indexOf('止步于') >= 0);

console.log(ok ? '\n=== 关卡目标/结束条件/进度/下一关测试全部通过 ===' : '\n=== 目标展示测试存在失败 ===');
process.exit(ok ? 0 : 1);
