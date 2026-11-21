// 生命周期与画布尺寸测试（v1.15）
//   M9  高 DPI 画布尺寸幂等：devicePixelRatio 为小数时不得每帧重建画布
//   M10 切后台自动暂停：对局中隐藏页面即暂停，恢复可见不自动续玩，菜单态不受影响
const fs = require('fs');
const { GAME_FILES, UI_FILES, loadFiles } = require('./helpers/sandbox');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function ctx2d() {
  const grad = { addColorStop() {} };
  const noop = () => {};
  return new Proxy({
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    createPattern: () => null,
    measureText: () => ({ width: 0 }),
    getImageData: () => ({ data: [] }),
    canvas: { width: 1280, height: 720 },
  }, { get: (t, k) => (Object.prototype.hasOwnProperty.call(t, k) ? t[k] : noop) });
}
function makeEl(id) {
  const classes = new Set();
  return {
    id: id || 'el',
    textContent: '', innerHTML: '', value: '',
    style: {}, dataset: {},
    width: 0, height: 0,
    _handlers: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    appendChild() {}, remove() {},
    getContext: () => ctx2d(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    setPointerCapture() {}, releasePointerCapture() {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev)); },
    querySelectorAll: () => [], querySelector: () => null, focus() {},
  };
}

const elCache = {};
const rafQueue = [];
const sandbox = {
  Math, Map, Set, console, JSON, Array, Object, String, Number, Boolean,
  isNaN, parseInt, parseFloat, Infinity, NaN,
  performance: { now: () => Date.now() },
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  },
};
sandbox.window = {
  innerWidth: 1001, innerHeight: 733,
  devicePixelRatio: 1.25,          // Windows 125% 缩放：innerWidth * 1.25 = 1251.25（小数）
  _handlers: {},
  addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
  dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev)); },
};
// document 需要真实的事件注册表：visibilitychange 是 M10 的驱动入口
sandbox.document = {
  readyState: 'complete',
  hidden: false,
  _handlers: {},
  getElementById: (id) => (elCache[id] || (elCache[id] = makeEl(id))),
  querySelectorAll: () => [], querySelector: () => null,
  createElement: () => makeEl('stub'),
  addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
  dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev)); },
};
sandbox.global = sandbox;

// 预置 canvas：把 width/height 换成可计数的访问器，用来断言「每帧是否重建画布」
const canvasEl = makeEl('game');
elCache.game = canvasEl;
let widthSets = 0, heightSets = 0;
let _w = 0, _h = 0;
Object.defineProperty(canvasEl, 'width', {
  configurable: true, get: () => _w, set: (v) => { _w = Number(v) | 0; widthSets++; },
});
Object.defineProperty(canvasEl, 'height', {
  configurable: true, get: () => _h, set: (v) => { _h = Number(v) | 0; heightSets++; },
});

vm.createContext(sandbox);
function load(f) { vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f }); }

load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
loadFiles(load, GAME_FILES);
sandbox.physics = sandbox.window.physics;
sandbox.audio = sandbox.window.audio;
sandbox.predictor = sandbox.window.predictor;
sandbox.predictorRenderer = sandbox.window.predictorRenderer;
sandbox.render = sandbox.window.render;
sandbox.game = sandbox.window.game;
loadFiles(load, UI_FILES);

const game = sandbox.window.game;
const render = sandbox.window.render;
const el = (id) => elCache[id] || (elCache[id] = makeEl(id));

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}

// ============================================================
// M9：高 DPI 画布尺寸幂等
// ============================================================
function testM9CanvasSizeIdempotent() {
  const expectW = Math.floor(1001 * 1.25);   // 1251（canvas.width 本身只能存整数）
  const expectH = Math.floor(733 * 1.25);    // 916

  // 预热一帧：把画布尺寸带到当前视口/DPR 的正确值（此前的赋值不计入幂等统计）
  render(canvasEl, game.state);
  assert('M9 首帧按 DPR 重建画布尺寸', _w === expectW && _h === expectH, _w + 'x' + _h);

  const wBase = widthSets, hBase = heightSets;
  for (let i = 0; i < 5; i++) render(canvasEl, game.state);
  console.log('DBG sets', widthSets, wBase, heightSets, hBase, '_w=', _w);
  assert('M9 尺寸未变时后续帧不再重建画布（小数 DPR 不再每帧重置）',
    widthSets === wBase && heightSets === hBase,
    'delta_w=' + (widthSets - wBase) + ' delta_h=' + (heightSets - hBase));

  // 边界：视口变化 → 重新尺寸化且只做一次
  sandbox.window.innerWidth = 1000;          // 1000 * 1.25 = 1250（整数）
  render(canvasEl, game.state);
  assert('M9 视口变化后重建一次', _w === 1250 && widthSets === wBase + 1, _w + '/' + (widthSets - wBase));
  render(canvasEl, game.state);
  assert('M9 新尺寸下继续幂等', widthSets === wBase + 1, 'delta_w=' + (widthSets - wBase));

  // 边界：DPR 变化（拖到另一块屏）→ 必须重建
  sandbox.window.devicePixelRatio = 2;
  render(canvasEl, game.state);
  assert('M9 DPR 变化后重建', _w === 2000 && _h === 1466, _w + 'x' + _h);

  sandbox.window.innerWidth = 1001; sandbox.window.innerHeight = 733; sandbox.window.devicePixelRatio = 1.25;
}

// ============================================================
// M10：切后台自动暂停
// ============================================================
function testM10AutoPauseOnHidden() {
  const st = game.state;
  // 菜单态：未开局 → 隐藏页面不得置暂停
  st.gameStarted = false;
  st.paused = false;
  sandbox.document.hidden = true;
  sandbox.document.dispatch('visibilitychange', { type: 'visibilitychange' });
  assert('M10 未开局时切后台不暂停', game.isPaused() === false);

  // 对局中：隐藏 → 自动暂停
  game.startGame({ mode: 'survival', levelIndex: 0 });
  st.gameStarted = true;
  st.paused = false;
  sandbox.document.hidden = true;
  sandbox.document.dispatch('visibilitychange', { type: 'visibilitychange' });
  assert('M10 对局中切后台自动暂停', game.isPaused() === true);

  // 幂等：重复隐藏事件不报错、状态不变
  sandbox.document.dispatch('visibilitychange', { type: 'visibilitychange' });
  assert('M10 重复隐藏事件保持暂停', game.isPaused() === true);

  // 恢复可见：不自动续玩
  sandbox.document.hidden = false;
  sandbox.document.dispatch('visibilitychange', { type: 'visibilitychange' });
  assert('M10 恢复可见不自动续玩', game.isPaused() === true);

  // 玩家手动继续后，暂停态清除
  game.setPaused(false);
  assert('M10 手动继续后解除暂停', game.isPaused() === false);

  // 边界：已结束对局不得被自动暂停（结算面板与暂停覆盖层不互抢）
  st.gameOver = true;
  sandbox.document.hidden = true;
  sandbox.document.dispatch('visibilitychange', { type: 'visibilitychange' });
  assert('M10 结算态切后台不暂停', game.isPaused() === false);
  sandbox.document.hidden = false;
}


testM9CanvasSizeIdempotent();
testM10AutoPauseOnHidden();

console.log(ok ? '\n=== 生命周期/画布测试全部通过 ===' : '\n=== 生命周期/画布测试存在失败 ===');
process.exit(ok ? 0 : 1);
