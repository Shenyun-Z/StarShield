// v1.12 结算面板按钮点击链路回归套件
//   背景：既有测试只断言结算面板各行的可见性与文本，**从不真正点击按钮**，
//   因此"挑战末关「下一关」死链"与"隐藏关弹出第四章提示"这两类缺陷一直没被发现。
//   本套件用可点击桩（_handlers + dispatch）驱动真实链路，覆盖本轮修复的全部缺陷：
//   A. 闯关/挑战「下一关」点击 → 正常进入下一关
//   B. 挑战末关：解锁进度推进到池长度但**不可进入**；「下一关」隐藏；「再来一局」仍可用
//   C. 隐藏关：不显示「下一关」（不产生与之无关的第四章提示）
//   D. 失败结算：「下一关」隐藏
//   E. 「再来一局」不改变关卡索引；「清除进度」清空存档并回到菜单态
//   F. startGame 失败路径**不留副作用**（不再污染 state.mode / state.levelIndex）
//   G. 时间流速每局复位为 1×
//   H. 星体栏价格随专精刷新（与实扣一致）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function ctx2d() {
  const grad = { addColorStop() {} };
  const noop = () => {};
  return new Proxy({
    createRadialGradient: () => grad, createLinearGradient: () => grad,
    measureText: () => ({ width: 0 }), getImageData: () => ({ data: [] }),
    canvas: { width: 1280, height: 720 },
  }, { get: (t, k) => (Object.prototype.hasOwnProperty.call(t, k) ? t[k] : noop) });
}
// 可点击桩：与 test/robustness.test.js 同款（记录 handler 并可 dispatch）
function makeEl(id) {
  const classes = new Set();
  return {
    id: id || 'el',
    textContent: '', innerHTML: '', value: '',
    style: {}, dataset: {}, width: 1280, height: 720,
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

function createSandbox(preload) {
  const elCache = {};
  const store = {};
  if (preload) for (const k in preload) store[k] = String(preload[k]);
  const sandbox = {
    Math, Map, Set, console, JSON, Array, Object, String, Number, Boolean,
    isNaN, parseInt, parseFloat, Infinity, NaN,
    performance: { now: () => Date.now() },
    window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
    localStorage: {
      _d: store,
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    document: {
      readyState: 'complete',                       // → input.js 在加载时同步 init()，绑定即生效
      getElementById: (id) => (elCache[id] || (elCache[id] = makeEl(id))),
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, createElement: () => makeEl('created'),
    },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  const load = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
  load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
  load('js/game.js');
  sandbox.physics = sandbox.window.physics;
  sandbox.predictor = sandbox.window.predictor;
  sandbox.predictorRenderer = sandbox.window.predictorRenderer;
  sandbox.audio = sandbox.window.audio;
  sandbox.render = sandbox.window.render;
  sandbox.game = sandbox.window.game;
  load('js/input.js');                              // 注册 __showResult 与结算面板按钮
  return {
    sandbox, game: sandbox.window.game, ls: sandbox.localStorage,
    el: (id) => elCache[id] || (elCache[id] = makeEl(id)),
    textOf: (id) => String((elCache[id] || (elCache[id] = makeEl(id))).textContent),
  };
}

const DT = 1 / 60;
const fullStars = () => { const t = {}; for (let i = 0; i < 40; i++) t[String(i)] = 3; return JSON.stringify(t); };

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}
// 构造一次"通关"结算（不依赖物理跑完整局）：清空威胁与波次队列并把当前波标为末波
function winLevel(g, st) {
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true;
  st.waveQueue = [];
  st.waveElapsed = 40;
  st.isLastWave = true;
  g.stepFrame(DT);
}

/* ============ A. 闯关与挑战的「下一关」 ============ */
console.log('--- A. 闯关与挑战的「下一关」---');
{
  const s = createSandbox({ starshield_campaign_unlocked: '40' });
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  g.state.timeScale = 1;
  winLevel(g, g.state);
  const btn = s.el('resultNext');
  assert('闯关第 1 关通关后「下一关」可见', btn.style.display === '');
  btn.dispatch('click', {});
  assert('点击「下一关」进入第 2 关',
    g.state.mode === 'campaign' && g.state.levelIndex === 1 && g.state.gameStarted === true,
    'idx=' + g.state.levelIndex);
}
{
  const s = createSandbox({ starshield_challenge: JSON.stringify({ unlocked: 1 }) });
  const g = s.game;
  g.startGame({ mode: 'challenge', levelIndex: 0 });
  g.state.timeScale = 1;
  winLevel(g, g.state);
  const btn = s.el('resultNext');
  assert('挑战第 1 关通关后「下一关」可见', btn.style.display === '');
  btn.dispatch('click', {});
  assert('点击「下一关」进入挑战第 2 关',
    g.state.mode === 'challenge' && g.state.levelIndex === 1 && g.state.gameStarted === true,
    'idx=' + g.state.levelIndex);
}

/* ============ B. 挑战末关（本轮修复的核心回归） ============ */
console.log('--- B. 挑战末关 ---');
{
  const s = createSandbox({ starshield_challenge: JSON.stringify({ unlocked: 39 }) });
  const g = s.game;
  assert('挑战索引 39 可进入、索引 40 不可进入',
    g.isChallengeUnlocked(39) === true && g.isChallengeUnlocked(40) === false);
  g.startGame({ mode: 'challenge', levelIndex: 39 });
  g.state.timeScale = 1;
  winLevel(g, g.state);
  assert('通关末关后解锁进度推进到池长度 40（文案口径正确）',
    g.getChallengeUnlocked() === 40 && g.bestDisplay() === '挑战已通关 40 关',
    'unlocked=' + g.getChallengeUnlocked() + ' display=' + g.bestDisplay());
  assert('索引 40 依然不可进入（越界保护生效）', g.isChallengeUnlocked(40) === false);
  assert('挑战末关通关后不显示「下一关」（消除死链）',
    s.el('resultNext').style.display === 'none', s.el('resultNext').style.display);
  assert('末关通关后关卡索引未被污染', g.state.levelIndex === 39, 'idx=' + g.state.levelIndex);
  // 再点一次（按钮已隐藏，但验证即使被触发也不会污染索引 / 不会静默进入不存在的关卡）
  s.el('resultNext').dispatch('click', {});
  assert('触发已隐藏的「下一关」也不会改变关卡索引',
    g.state.levelIndex === 39, 'idx=' + g.state.levelIndex);
  s.el('resultRetry').dispatch('click', {});
  assert('末关通关后「再来一局」仍可正常开局',
    g.state.gameStarted === true && g.state.levelIndex === 39 && g.state.gameOver === false,
    'started=' + g.state.gameStarted + ' idx=' + g.state.levelIndex);
}

/* ============ C. 隐藏关与失败结算 ============ */
console.log('--- C. 隐藏关与失败结算 ---');
{
  const s = createSandbox({ starshield_campaign_unlocked: '40', starshield_stars: fullStars() });
  const g = s.game;
  assert('隐藏关 1 已解锁（累计星数达标）', g.isLevelUnlocked(40) === true);
  g.startGame({ mode: 'campaign', levelIndex: 40 });
  g.state.timeScale = 1;
  winLevel(g, g.state);
  assert('隐藏关通关后不显示「下一关」', s.el('resultNext').style.display === 'none');
  assert('隐藏关通关给出专属结语', !!g.state.lastEnding && g.state.lastEnding.id === 'hidden-1');
}
{
  const s = createSandbox({ starshield_campaign_unlocked: '40' });
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  g.state.timeScale = 1;
  const st = g.state;
  // 失败必须由**真实碰撞**触发（母星血量只在撞击时扣减，直接置 0 不会结算）
  st.health = 1;
  const planet = st.bodies[0];
  st.bodies.push({ type: 'asteroid', mass: 40, radius: 14, x: planet.x, y: planet.y, vx: 0, vy: 0 });
  g.stepFrame(DT);
  assert('失败结算不显示「下一关」',
    st.gameOver === true && s.el('resultNext').style.display === 'none',
    'gameOver=' + st.gameOver);
}

/* ============ D. 再来一局 / 清除进度 ============ */
console.log('--- D. 再来一局 / 清除进度 ---');
{
  const s = createSandbox({ starshield_campaign_unlocked: '40' });
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 5 });
  g.state.timeScale = 1;
  winLevel(g, g.state);
  const before = g.state.levelIndex;
  s.el('resultRetry').dispatch('click', {});
  assert('「再来一局」保持同一关卡并重新开局',
    g.state.levelIndex === before && g.state.gameStarted === true && g.state.gameOver === false,
    'idx=' + g.state.levelIndex);
}
{
  const s = createSandbox({ starshield_campaign_unlocked: '40', starshield_challenge: JSON.stringify({ unlocked: 3 }) });
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  g.state.timeScale = 1;
  winLevel(g, g.state);
  assert('清除前进度键存在', s.ls.getItem('starshield_campaign_unlocked') !== null);
  s.el('resultClear').dispatch('click', {});        // 第一下：武装（二次确认）
  assert('「清除进度」首次点击只进入确认态（不误清）',
    s.ls.getItem('starshield_campaign_unlocked') !== null);
  s.el('resultClear').dispatch('click', {});        // 第二下：真正清除
  assert('「清除进度」删除进度存档',
    s.ls.getItem('starshield_campaign_unlocked') === null
    && s.ls.getItem('starshield_challenge') === null);
  assert('「清除进度」复位内存进度并回到菜单态',
    g.getCampaignUnlocked() === 0 && g.getChallengeUnlocked() === 0 && g.state.gameStarted === false,
    'campaign=' + g.getCampaignUnlocked() + ' started=' + g.state.gameStarted);
}

/* ============ E. startGame 失败路径无副作用 ============ */
console.log('--- E. startGame 失败路径无副作用 ---');
{
  const s = createSandbox({ starshield_campaign_unlocked: '40' });
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  g.state.timeScale = 1;
  const snap = { mode: g.state.mode, idx: g.state.levelIndex, started: g.state.gameStarted };
  const r1 = g.startGame({ mode: 'challenge', levelIndex: 40 });   // 挑战池无索引 40
  assert('越界挑战开局被拒绝且不留副作用',
    r1 === false && g.state.mode === snap.mode && g.state.levelIndex === snap.idx
    && g.state.gameStarted === snap.started,
    'ret=' + r1 + ' mode=' + g.state.mode + ' idx=' + g.state.levelIndex);
  const r2 = g.startGame({ mode: 'campaign', levelIndex: 999 });
  assert('越界闯关开局被拒绝且不留副作用',
    r2 === false && g.state.mode === snap.mode && g.state.levelIndex === snap.idx,
    'ret=' + r2 + ' idx=' + g.state.levelIndex);
}

/* ============ F. 时间流速每局复位 ============ */
console.log('--- F. 时间流速每局复位 ---');
{
  const s = createSandbox({ starshield_campaign_unlocked: '40' });
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  g.state.timeScale = 0.25;                        // 模拟"在减速状态下结束本局"
  winLevel(g, g.state);
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  assert('新一局时间流速复位为 1×（不再以 0.25× 开局）',
    g.state.timeScale === 1 && g.state.slowQuota > 0,
    'timeScale=' + g.state.timeScale);
}

/* ============ G. 星体栏价格随专精刷新 ============ */
console.log('--- G. 星体栏价格随专精刷新 ---');
{
  const s = createSandbox();
  const g = s.game;
  const tiers = ['small', 'mid', 'large', 'star', 'blackhole'];
  const gravityPrices = tiers.map(t => g.getStarDef(t, 'gravity').cost);
  assert('初始（引力型）价格标签为基准价',
    tiers.every((t, i) => s.textOf('starCost-' + t) === String(gravityPrices[i])),
    tiers.map(t => t + '=' + s.textOf('starCost-' + t)).join(' '));
  s.el('spec-giant').dispatch('click', {});        // 切到「巨型」
  const giantPrices = tiers.map(t => g.getStarDef(t, 'giant').cost);
  assert('切「巨型」后价格标签与实扣一致（小 60 / 中 180 / 大 360 / 恒 600 / 黑洞 1500）',
    tiers.every((t, i) => s.textOf('starCost-' + t) === String(giantPrices[i])),
    tiers.map(t => t + '=' + s.textOf('starCost-' + t)).join(' '));
  assert('黑洞不参与专精（价格不变）',
    s.textOf('starCost-blackhole') === '1500' && giantPrices[4] === 1500);
  s.el('spec-gravity').dispatch('click', {});
  assert('切回「引力型」价格恢复基准价',
    tiers.every((t, i) => s.textOf('starCost-' + t) === String(gravityPrices[i])));
}

console.log(ok ? '\n=== v1.12 结算面板点击链路与缺陷回归测试全部通过 ==='
               : '\n=== v1.12 点击链路测试存在失败 ===');
process.exit(ok ? 0 : 1);
