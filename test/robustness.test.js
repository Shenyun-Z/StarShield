// 健壮性测试：覆盖本轮修复的 H1-H4 与 M1-M8（正常流程 + 边界情况）
//   H1 主循环异常保护      H2 玩家星体数量上限        H3 波次超时防软锁     H4 指针捕获/拖拽归属
//   M1 黑洞游戏时钟        M2 分数单数据源            M3 预测 AABB 剪枝     M4（CI/入口由 run-all 覆盖）
//   M5 预测性能红线常量    M6 母星受击规则            M7 存档异常反馈       M8 粒子上限
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

// ---- 带事件注册表 / 指针捕获记录的 DOM stub（H1 与 H4 需要可驱动的输入）----
// 注意：canvas 上下文替身必须让 createRadialGradient/createLinearGradient 返回带
// addColorStop 的对象——否则 render 在有星体时会抛异常（真实浏览器无此问题），
// 使得"有星体时的渲染路径"实际从未被测试覆盖。
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
  const el = {
    id: id || 'el',
    textContent: '', innerHTML: '', value: '',
    style: {}, dataset: {},
    width: 1280, height: 720,
    _handlers: {},
    _captured: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    appendChild() {}, remove() {},
    getContext: () => ctx2d(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    setPointerCapture(id) { this._captured.push(id); },
    releasePointerCapture() {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev)); },
    querySelectorAll: () => [], querySelector: () => null, focus() {},
  };
  return el;
}
function stubEl() { return makeEl('stub'); }

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
  innerWidth: 1280, innerHeight: 720,
  _handlers: {},
  addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
  dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev)); },
};
sandbox.document = {
  readyState: 'complete',
  getElementById: (id) => (elCache[id] || (elCache[id] = makeEl(id))),
  querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
  createElement: () => stubEl(),
};
sandbox.global = sandbox;
vm.createContext(sandbox);
function load(f) { vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f }); }

load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
sandbox.localStorage.setItem('starshield_campaign_unlocked', '3');
load('js/game.js');
sandbox.physics = sandbox.window.physics;
sandbox.audio = sandbox.window.audio;
sandbox.predictor = sandbox.window.predictor;
sandbox.predictorRenderer = sandbox.window.predictorRenderer;
sandbox.render = sandbox.window.render;
sandbox.game = sandbox.window.game;
load('js/input.js');   // 注册 canvas/window 事件与主循环

const game = sandbox.window.game;
const physics = sandbox.window.physics;
const predictor = sandbox.window.predictor;
// 注意：元素由 getElementById 惰性创建，必须在真正被访问时再取（不能提前捕获引用）
const el = (id) => elCache[id] || (elCache[id] = makeEl(id));
const canvasEl = el('game');
const messageEl = () => el('message');

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}
const DT = 1 / 60;
const WIN_W = 1280, WIN_H = 720;
const planetAt = () => game.state.bodies[0];
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);
// timeScale / showHint 是会话级偏好，startGame 不重置；测试统一复位以保证步进确定性
function newGame(opts) {
  const r = game.startGame(opts);
  game.state.timeScale = 1;
  return r;
}

// ============================================================
// H2：玩家星体数量上限（正常流程 + 边界）
// ============================================================
function testH2PlacedBodyCap() {
  newGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  // 生成 60 个合法点位（用 canPlaceAt 过滤掉母星禁放区内的网格点）
  const pts = [];
  for (let gy = 60; gy < WIN_H && pts.length < 60; gy += 60) {
    for (let gx = 60; gx < WIN_W && pts.length < 60; gx += 60) {
      const p = { x: gx, y: gy };
      if (game.canPlaceAt(p)) pts.push(p);
    }
  }
  assert('H2 测试点位足量', pts.length === 60, 'pts=' + pts.length);
  // 正常流程：连续放置至上限（小行星 50 星能 × 60）
  let placed = 0;
  for (let i = 0; i < 60; i++) {
    const r = game.placeStar('small', pts[i], {});
    if (r.ok) placed++;
  }
  assert('H2 上限内可正常放置 60 个星体', placed === 60, 'placed=' + placed);

  // 边界：第 61 个必须被拒绝，且不扣星能
  const budgetBefore = st.budget;
  const r61 = game.placeStar('small', pts[0], {});
  assert('H2 超出上限后被拒绝', r61.ok === false && /上限/.test(r61.reason || ''), JSON.stringify(r61));
  assert('H2 被拒绝时不扣星能', st.budget === budgetBefore, 'budget=' + st.budget);

  // 边界：星能刚好等于花费 → 成功；少 1 → 失败
  newGame({ mode: 'survival', levelIndex: 0 });
  const st2 = game.state;
  st2.bodies = st2.bodies.filter((b) => b.type === 'planet');
  st2.budget = 50;
  const okExact = game.placeStar('small', { x: 200, y: 200 }, {});
  assert('H2 星能恰好等于花费时可放置', okExact.ok === true && st2.budget === 0, 'budget=' + st2.budget);
  st2.budget = 49;
  const failPoor = game.placeStar('small', { x: 300, y: 200 }, {});
  assert('H2 星能不足 1 点时拒绝', failPoor.ok === false && failPoor.reason === '星能不足', JSON.stringify(failPoor));

  // 边界：母星禁放区判定（恰好等于半径 → 允许）
  newGame({ mode: 'survival', levelIndex: 0 });
  const st3 = game.state;
  const pl = st3.bodies[0];
  st3.budget = 9999;
  const rEdge = pl.radius + game.PLANET_FORBIDDEN_PAD;
  const inside = game.canPlaceAt({ x: pl.x + rEdge - 1, y: pl.y });
  const onEdge = game.canPlaceAt({ x: pl.x + rEdge, y: pl.y });
  assert('H2 禁放区边界：内 1px 禁止、边界上允许', inside === false && onEdge === true);
}

// ============================================================
// H3：波次超时防软锁（正常流程 + 边界）
// ============================================================
function testH3WaveTimeout() {
  const WAVE_TIMEOUT = 40;
  // 边界：未到超时阈值时，残留威胁不应被清除
  newGame({ mode: 'survival', levelIndex: 0 });
  let st = game.state;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  const pl = planetAt();
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: pl.x + 300, y: pl.y + 300, vx: 0, vy: 0 });
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = 0;
  for (let i = 0; i < 10; i++) game.stepFrame(DT);
  assert('H3 未到超时阈值不清场', st.bodies.some((b) => b.type === 'asteroid'), 'elapsed=' + st.waveElapsed);

  // 正常流程：到达阈值 → 强制收编并结算本波
  st.waveElapsed = WAVE_TIMEOUT - 0.01;
  const clearedBefore = st.asteroidsCleared;
  game.stepFrame(DT);
  assert('H3 超时后残留威胁被强制收编', !st.bodies.some((b) => b.type === 'asteroid' || b.type === 'comet'));
  assert('H3 超时收编计入拦截清除', st.asteroidsCleared === clearedBefore + 1, 'cleared=' + st.asteroidsCleared);
  assert('H3 超时后本波结算（waveActive=false）', st.waveActive === false);
  assert('H3 超时计时器已重置', st.waveElapsed === 0, 'elapsed=' + st.waveElapsed);

  // 边界：闯关模式最后一波超时 → 视为通过并解锁下一关
  game.clearAllProgress();                    // 解锁进度归零，便于验证「通关即解锁」
  const unlockedBefore = game.getCampaignUnlocked();
  assert('H3 前置：解锁进度已归零', unlockedBefore === 0, 'unlocked=' + unlockedBefore);
  newGame({ mode: 'campaign', levelIndex: 0 });
  st = game.state;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  const pl2 = planetAt();
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: pl2.x + 260, y: pl2.y + 260, vx: 0, vy: 0 });
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = WAVE_TIMEOUT; st.isLastWave = true;
  game.stepFrame(DT);
  assert('H3 最后一波超时视为通关', st.gameOver === true && st.endReason === 'win', 'reason=' + st.endReason);
  assert('H3 通关后解锁下一关', game.getCampaignUnlocked() === unlockedBefore + 1,
    'unlocked=' + game.getCampaignUnlocked());
}

// ============================================================
// H4：指针捕获与拖拽归属（正常流程 + 边界）
// ============================================================
function testH4PointerOwnership() {
  newGame({ mode: 'survival', levelIndex: 0 });
  const placingOf = () => sandbox.window.__placingStars;
  const down = (id, x, y) => canvasEl.dispatch('pointerdown',
    { type: 'pointerdown', pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y });
  const move = (id, x, y) => sandbox.window.dispatch('pointermove',
    { type: 'pointermove', pointerId: id, pointerType: 'touch', clientX: x, clientY: y });
  const up = (id) => sandbox.window.dispatch('pointerup',
    { type: 'pointerup', pointerId: id, pointerType: 'touch', clientX: 0, clientY: 0 });

  // 正常流程：按下 → 拖动 → 释放 → 完成一次放置
  canvasEl._captured.length = 0;
  down(1, 300, 200);
  assert('H4 按下后进入拖拽预览', placingOf().length === 1);
  assert('H4 按下时请求指针捕获', canvasEl._captured.length === 1 && canvasEl._captured[0] === 1,
    JSON.stringify(canvasEl._captured));
  move(1, 360, 200);
  assert('H4 活动指针的移动生效', placingOf()[0].dragDx === 60, 'dragDx=' + placingOf()[0].dragDx);
  up(1);
  assert('H4 释放后结束拖拽', placingOf().length === 0);

  // 边界：第二根手指的 move/up 必须被忽略（不能劫持或提前结束）
  down(1, 300, 200);
  const starsBefore = placingOf().length;
  move(2, 900, 600);
  assert('H4 非活动指针的移动被忽略', placingOf().length === starsBefore && placingOf()[0].dragDx === 0,
    'dragDx=' + placingOf()[0].dragDx);
  up(2);
  assert('H4 非活动指针的抬起被忽略', placingOf().length === 1);
  // 边界：拖拽进行中再次按下（第二指）不应重置起点
  const dragStartX = placingOf()[0].x;
  down(2, 1000, 650);
  assert('H4 拖拽中第二次按下被忽略', placingOf()[0].x === dragStartX);
  up(1);
  assert('H4 活动指针抬起后清理完成', placingOf().length === 0);

  // 边界：窗口失焦 → 无条件取消拖拽（不放置、不留预览）
  down(1, 300, 200);
  sandbox.window.dispatch('blur', { type: 'blur' });
  assert('H4 窗口失焦取消拖拽', placingOf().length === 0);
}

// ============================================================
// M1：黑洞生命周期使用游戏时钟
// ============================================================
function testM1BlackholeGameClock() {
  newGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  st.budget = 99999;
  const r = game.placeStar('blackhole', { x: 300, y: 300 }, {});
  assert('M1 黑洞放置成功', r.ok === true, JSON.stringify(r));
  let bh = st.bodies.find((b) => b.type === 'blackhole');
  assert('M1 黑洞初始寿命为 10 游戏秒', near(bh.lifeRemaining, 10), 'life=' + bh.lifeRemaining);
  assert('M1 不再使用墙钟 expiresAt 字段', bh.expiresAt === undefined);

  // 正常流程：1× 速度推进 2 游戏秒 → 寿命 8
  for (let i = 0; i < 120; i++) game.stepFrame(DT);
  bh = st.bodies.find((b) => b.type === 'blackhole');
  assert('M1 1× 推进 2 秒后寿命 = 8', near(bh.lifeRemaining, 8, 0.05), 'life=' + bh.lifeRemaining);

  // 边界：0.25× 慢动作推进同样多的「真实帧」只消耗 0.5 游戏秒（证明用游戏时钟而非墙钟）
  newGame({ mode: 'survival', levelIndex: 0 });
  const st2 = game.state;
  st2.bodies = st2.bodies.filter((b) => b.type === 'planet');
  st2.budget = 99999;
  st2.timeScale = 0.25;
  game.placeStar('blackhole', { x: 300, y: 300 }, {});
  for (let i = 0; i < 120; i++) game.stepFrame(DT);
  const bh2 = st2.bodies.find((b) => b.type === 'blackhole');
  assert('M1 慢动作下寿命按游戏时间消耗（≈9.5，而非 8）', near(bh2.lifeRemaining, 9.5, 0.05),
    'life=' + bh2.lifeRemaining);

  // 边界：寿命耗尽 → 移除（复位为 1× 以推进一个完整物理步）
  bh2.lifeRemaining = 0.01;
  st2.timeScale = 1;
  game.stepFrame(DT);
  assert('M1 寿命耗尽后黑洞被移除', !st2.bodies.some((b) => b.type === 'blackhole'));
}

// ============================================================
// M2：分数单数据源（无影子字段 / 明细派生 / 惩罚只记实际扣除）
// ============================================================
function testM2SingleScoreSource() {
  newGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  assert('M2 不存在浮点影子字段 state.score', st.score === undefined);
  assert('M2 明细字段齐备', ['scoreIntercept', 'scoreWaveBonus', 'scoreSurvive', 'scorePenalty']
    .every((k) => Number.isFinite(st[k])));

  // 正常流程：总分恒等于明细代数和（整数）
  st.scoreIntercept = 100; st.scoreWaveBonus = 30; st.scoreSurvive = 5.7; st.scorePenalty = 3;
  const s = game.getCurrentRunStats();
  assert('M2 总分 = 明细代数和（各自取整）', s.score === 100 + 30 + 6 - 3, 'score=' + s.score);
  assert('M2 HUD/结算总分是整数', Number.isInteger(s.score));

  // 边界：总分为 0 时受击 → 惩罚明细不再虚增
  st.scoreIntercept = 0; st.scoreWaveBonus = 0; st.scoreSurvive = 0; st.scorePenalty = 0;
  game.stepFrame(DT);                        // 生存模式每帧 +存活分
  st.scoreSurvive = 0; st.scorePenalty = 0; st.scoreIntercept = 0; st.scoreWaveBonus = 0;
  st.health = 20;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  const pl = planetAt();
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: pl.x + 5, y: pl.y, vx: 0, vy: 0 });
  game.stepFrame(DT);
  assert('M2 总分为 0 时惩罚明细保持 0', st.scorePenalty === 0, 'penalty=' + st.scorePenalty);
  assert('M2 受击后总分仍为 0（不为负）', game.getCurrentRunStats().score === 0);
}

// ============================================================
// M3：预测 AABB 剪枝（等价性 + 正确性）
// ============================================================
function testM3PredictionPruning() {
  const planet = { type: 'planet', mass: 8000, radius: 30, x: 640, y: 360, vx: 0, vy: 0, immovable: true, anchored: true, isStar: true };
  const hit = { type: 'asteroid', mass: 60, radius: 12, x: 640, y: 60, vx: 0, vy: 180 };   // 直奔母星
  const far = { type: 'asteroid', mass: 60, radius: 12, x: 60, y: 60, vx: -80, vy: 0 };     // 飞离
  const bodies = [planet, hit, far];

  const simA = predictor.simulateFuture(bodies, { duration: 3, dt: physics.PREDICT_DT, sampleEvery: 2 });
  assert('M3 模拟结果携带每条路径的包围盒', Array.isArray(simA.aabbs) && simA.aabbs.length === bodies.length);
  assert('M3 包围盒覆盖路径全部采样点',
    simA.paths.every((p, i) => p.every((q) => q.x >= simA.aabbs[i].minX - 1e-9 && q.x <= simA.aabbs[i].maxX + 1e-9 &&
      q.y >= simA.aabbs[i].minY - 1e-9 && q.y <= simA.aabbs[i].maxY + 1e-9)));

  // 正确性：直奔母星的判红，飞离的判蓝
  const riskHit = predictor.evaluateRisk(simA, 1, planet);
  const riskFar = predictor.evaluateRisk(simA, 2, planet);
  assert('M3 直奔母星的威胁判红', riskHit.level === 'red' && riskHit.hitMother === true, riskHit.level);
  assert('M3 远离母星的威胁判蓝', riskFar.level === 'blue', riskFar.level);

  // 等价性：删除 aabbs 强制走无剪枝路径，三种判色/截断结果必须完全一致
  const simB = predictor.simulateFuture(bodies, { duration: 3, dt: physics.PREDICT_DT, sampleEvery: 2 });
  delete simB.aabbs;
  let same = true;
  for (let i = 0; i < bodies.length; i++) {
    const ra = predictor.evaluateRisk(simA, i, planet);
    const rb = predictor.evaluateRisk(simB, i, planet);
    if (ra.level !== rb.level || ra.hitMother !== rb.hitMother || ra.captured !== rb.captured ||
        !near(ra.endX, rb.endX, 1e-9) || !near(ra.endY, rb.endY, 1e-9) ||
        ra.path.length !== rb.path.length) same = false;
  }
  assert('M3 剪枝前后判色/截断结果完全一致（无漏判）', same);

  // 边界：单天体（无候选）不应崩溃
  const solo = predictor.simulateFuture([planet], { duration: 1 });
  const rs = predictor.evaluateRisk(solo, 0, planet);
  assert('M3 单天体系统安全返回', rs.level === 'blue' && rs.path.length >= 1);
}

// ============================================================
// M5：预测性能红线常量统一（基于 PREDICT_DUR）
// ============================================================
function testM5PredictDuration() {
  const ring = (n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 / n) * i;
      arr.push({ type: 'asteroid', mass: 40, radius: 4, x: 640 + Math.cos(a) * 300, y: 360 + Math.sin(a) * 300,
        vx: -Math.sin(a) * 20, vy: Math.cos(a) * 20 });
    }
    return arr;
  };
  const span = (n) => {
    const sim = predictor.simulateFuture(ring(n), { duration: physics.PREDICT_DUR, dt: physics.PREDICT_DT, sampleEvery: 2 });
    return sim.sampleDt * (sim.paths[0].length - 1);
  };
  assert('M5 N=50 使用完整预测时长 6s', near(span(50), 6, 0.11), 'span=' + span(50).toFixed(2));
  assert('M5 N=60 按 PREDICT_DUR 递减为 5s（而非旧的硬编码 5）',
    near(span(60), 5, 0.11), 'span=' + span(60).toFixed(2));
}

// ============================================================
// M6：母星受击规则（只有来袭威胁扣血）
// ============================================================
function testM6PlanetDamageRule() {
  // 正常流程：陨石撞母星 → 扣血
  newGame({ mode: 'survival', levelIndex: 0 });
  let st = game.state;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  const pl = planetAt();
  const h0 = st.health, hit0 = st.hitCount;
  st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: pl.x + 5, y: pl.y, vx: 0, vy: 0 });
  game.stepFrame(DT);
  assert('M6 陨石撞母星扣 1 点血', st.health === h0 - 1 && st.hitCount === hit0 + 1,
    'health=' + st.health + ' hits=' + st.hitCount);

  // 边界：玩家星体撞母星 → 不扣血，仅被吸收
  newGame({ mode: 'survival', levelIndex: 0 });
  st = game.state;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  st.budget = 9999;
  const pl2 = planetAt();
  const h1 = st.health, hit1 = st.hitCount, pen0 = st.scorePenalty;
  st.bodies.push({ type: 'star', mass: 300, radius: 17, x: pl2.x + 4, y: pl2.y, vx: 0, vy: 0 });
  game.stepFrame(DT);
  assert('M6 玩家星体撞母星不扣血', st.health === h1 && st.hitCount === hit1,
    'health=' + st.health + ' hits=' + st.hitCount);
  assert('M6 玩家星体撞母星不计失守惩罚', st.scorePenalty === pen0, 'penalty=' + st.scorePenalty);
  assert('M6 玩家星体被吸收（从场上移除）', !st.bodies.some((b) => b.type === 'star'));

  // 边界：玩家恒星（高质量）同样不伤害母星
  newGame({ mode: 'survival', levelIndex: 0 });
  st = game.state;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  const pl3 = planetAt();
  const h2 = st.health;
  st.bodies.push({ type: 'star', mass: 500, radius: 20, x: pl3.x + 2, y: pl3.y + 2, vx: 0, vy: 0 });
  game.stepFrame(DT);
  assert('M6 高质量玩家恒星撞母星同样不扣血', st.health === h2, 'health=' + st.health);
}

// ============================================================
// M7：存储异常反馈（布防存档已随「沿用上次布防」删除，此处覆盖战绩写入失败路径）
// ============================================================
function testM7StorageWarnings() {
  // 正常流程：写入成功且无提示
  newGame({ mode: 'survival', levelIndex: 0 });
  game.saveBest();
  assert('M7 正常写入无提示', game.takeWarning() === '', 'warn=' + game.takeWarning());

  // 边界：写入失败（配额/隐私模式）→ 不崩溃、给出提示
  const realSet = sandbox.localStorage.setItem;
  sandbox.localStorage.setItem = function () { throw new Error('QuotaExceededError'); };
  game.saveBest();
  const w = game.takeWarning();
  sandbox.localStorage.setItem = realSet;
  assert('M7 写入失败产生提示', typeof w === 'string' && w.indexOf('失败') >= 0, 'warn=' + w);
  assert('M7 提示读取后即清空（不重复弹出）', game.takeWarning() === '');

  // 边界：存储整体不可用（读取抛异常）时开局仍应正常
  const realGet = sandbox.localStorage.getItem;
  sandbox.localStorage.getItem = function () { throw new Error('SecurityError'); };
  const began = newGame({ mode: 'survival', levelIndex: 0 });
  sandbox.localStorage.getItem = realGet;
  assert('M7 存储不可用不影响开局', began !== false && game.state.gameStarted === true);

  // 正常流程：恢复后无残留提示
  game.saveBest();
  assert('M7 恢复正常写入后无残留提示', game.takeWarning() === '');
}

// ============================================================
// M8：粒子总量上限
// ============================================================
function testM8ParticleCap() {
  newGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.bodies = st.bodies.filter((b) => b.type === 'planet');
  st.health = 999;                       // 避免中途失败结算
  const pl = planetAt();
  // 40 个威胁同帧撞母星 → 每次 24 个粒子 = 960，超过上限 800
  for (let i = 0; i < 40; i++) {
    st.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: pl.x + 3 + i * 0.01, y: pl.y, vx: 0, vy: 0 });
  }
  game.stepFrame(DT);
  assert('M8 大量同帧爆炸后粒子数不超过上限 800', st.particles.length <= 800, 'n=' + st.particles.length);
  assert('M8 粒子仍在正常产生', st.particles.length > 0, 'n=' + st.particles.length);
}

// ============================================================
// 回归：「沿用上次布防」已删除 —— 每局固定从零开始，无任何预设布防
// ============================================================
function testNoPresetSetup() {
  // 即使 localStorage 残留旧版布防数据，也不会被恢复
  sandbox.localStorage.setItem('starshield_setup', JSON.stringify([
    { x: 200, y: 200, type: 'star', mass: 150, radius: 13 },
  ]));
  newGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  assert('无预设布防：开局仅有母星', st.bodies.length === 1 && st.bodies[0].type === 'planet',
    'others=' + st.bodies.filter((b) => b.type !== 'planet').length);
  // 兼容性：历史调用传入 keepSetup 也不再有任何效果（不会报错、不会恢复）
  const again = game.startGame({ mode: 'survival', levelIndex: 0, keepSetup: true });
  assert('传入 keepSetup 无副作用（仍从零开始）',
    again !== false && game.state.bodies.length === 1, 'bodies=' + game.state.bodies.length);
  // 新契约：该键不再由游戏管理（clearAllProgress 不会触碰它）
  game.clearAllProgress();
  assert('布防存档键已不属于游戏管理范围',
    sandbox.localStorage.getItem('starshield_setup') !== null);
  sandbox.localStorage.removeItem('starshield_setup');
}

// ============================================================
// H1：主循环异常保护（放在最后：会把主循环置为停止态）
// ============================================================
function testH1LoopErrorGuard() {
  const drive = (ts) => { const cb = rafQueue.shift(); if (cb) cb(ts); return !!cb; };
  // 用一局干净的游戏保证"正常帧"真的成功（成功帧会把连续异常计数清零）
  newGame({ mode: 'survival', levelIndex: 0 });
  assert('H1 初始化后已排队一帧', rafQueue.length === 1, 'queue=' + rafQueue.length);
  drive(100);
  assert('H1 正常帧后继续调度', rafQueue.length === 1, 'queue=' + rafQueue.length);

  // 边界：单次异常不得终止主循环（可自愈）
  const realStep = game.stepFrame;
  let thrown = 0;
  game.stepFrame = () => { thrown++; throw new Error('injected'); };
  drive(200);
  assert('H1 单次异常后仍继续调度（可自愈）', rafQueue.length === 1 && thrown === 1,
    'queue=' + rafQueue.length + ' thrown=' + thrown);

  // 边界：连续异常达到阈值(60) → 停止空转并给出可读提示
  let frames = 1;                                 // 上面已产生 1 次连续异常
  while (rafQueue.length > 0 && frames < 500) { drive(300 + frames); frames++; }
  assert('H1 连续异常 60 次后停止调度', thrown === 60 && rafQueue.length === 0,
    'thrown=' + thrown + ' queue=' + rafQueue.length);
  assert('H1 停止后给出可读提示', /异常/.test(messageEl().textContent) && messageEl().classList.contains('show'),
    'msg=' + messageEl().textContent);

  // 边界：停止后重新开局应恢复主循环（否则点「重新开始」画面会一直不动）
  game.stepFrame = realStep;
  newGame({ mode: 'survival', levelIndex: 0 });
  assert('H1 重新开局后主循环恢复', rafQueue.length === 1, 'queue=' + rafQueue.length);
  assert('H1 恢复后清除异常提示', messageEl().textContent === '' && !messageEl().classList.contains('show'),
    'msg=' + messageEl().textContent);
  drive(1000);
  assert('H1 恢复后的帧可正常执行', rafQueue.length === 1, 'queue=' + rafQueue.length);
}

// ============================================================
// 顺序执行（H1 会使主循环停止，故放最后）
// ============================================================
testH2PlacedBodyCap();
testH3WaveTimeout();
testH4PointerOwnership();
testM1BlackholeGameClock();
testM2SingleScoreSource();
testM3PredictionPruning();
testM5PredictDuration();
testM6PlanetDamageRule();
testM7StorageWarnings();
testM8ParticleCap();
testNoPresetSetup();
testH1LoopErrorGuard();

console.log(ok ? '\n=== 健壮性测试全部通过 ===' : '\n=== 健壮性测试存在失败 ===');
process.exit(ok ? 0 : 1);
