// P0 改进测试套件（平衡与规则漏洞）：
//   P0-1 减速额度制：满额 / 按真实帧扣减（含 120Hz 提前返回不漏扣）/ 耗尽自动回常速并提示 /
//        清波返还与封顶 / 额度不会为负
//   P0-2 撤销最近放置：成功返还与统计一致 / 时间窗失效 / 星体已不在场 / 无历史 / 历史上限 /
//        结算后不可撤销 / 黑洞整体返还
//   P0-3 撞母星预警：evaluateRisk 的 hitTime 正常与边界 / 预警列表由单次积分收集 /
//        玩家星体不计入 / 关闭开关后清空且不做积分
//   P0-4 设置持久化：默认值 / 落盘与往返 / 非法键与类型拒绝 / 损坏存档回退并提示 /
//        清除进度一并删除并复位内存
const fs = require('fs');
const { GAME_FILES, UI_FILES, loadFiles } = require('./helpers/sandbox');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

// 带渐变支持的 2d 上下文替身（render 在"有星体"时会走 createRadialGradient 链）
function ctx2d() {
  const grad = { addColorStop() {} };
  const noop = () => {};
  return new Proxy({
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    measureText: () => ({ width: 0 }),
    canvas: { width: 1280, height: 720 },
  }, { get: (t, k) => (Object.prototype.hasOwnProperty.call(t, k) ? t[k] : noop) });
}
function stubEl() {
  return {
    textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    width: 1280, height: 720,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, remove() {},
    getContext: () => ctx2d(),
    querySelectorAll: () => [], querySelector: () => null,
  };
}
const elCache = {};
const sandbox = {
  Math, Map, Set, console, JSON, Array, Object, String, Number, Boolean,
  isNaN, parseInt, parseFloat, Infinity, NaN,
  performance: { now: () => Date.now() },
  window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
  document: {
    readyState: 'complete',
    getElementById: (id) => (elCache[id] || (elCache[id] = stubEl())),
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, createElement: () => stubEl(),
  },
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
function load(f) { vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f }); }
load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
loadFiles(load, GAME_FILES);
// 浏览器里 window 即全局对象，各模块的裸引用（physics/predictor/...）可直接解析；
// 沙箱里 window 是独立对象，必须显式桥接到沙箱全局（既有测试同做法）。
sandbox.physics = sandbox.window.physics;
sandbox.predictor = sandbox.window.predictor;
sandbox.audio = sandbox.window.audio;
sandbox.render = sandbox.window.render;
sandbox.game = sandbox.window.game;
loadFiles(load, UI_FILES);   // 注册 predictorRenderer.attach 与 __showResult 等钩子

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}

const game = sandbox.game;
const physics = sandbox.physics;
const predictor = sandbox.window.predictor;
const canvas = sandbox.document.getElementById('game');
const DT = 1 / 60;
const P = { duration: physics.PREDICT_DUR, dt: physics.PREDICT_DT, sampleEvery: 2 };

function fresh() {
  game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.timeScale = 1;          // 会话级偏好：测试内显式复位，保证步进确定性
  return st;
}

/* ============================ P0-1 减速额度制 ============================ */
console.log('--- P0-1 减速额度制 ---');
{
  const st = fresh();
  assert('开局减速额度为满额 15 秒', st.slowQuota === game.SLOW_QUOTA_MAX && game.SLOW_QUOTA_MAX === 15,
    'quota=' + st.slowQuota);
  const sm = game.slowMotionState();
  assert('slowMotionState 反映满额（非低额度、未耗尽）',
    sm.ratio === 1 && sm.low === false && sm.exhausted === false);
}
{
  const st = fresh();
  const on = game.toggleSlowMotion();
  assert('进入减速：返回 ok 且 timeScale=0.25', on.ok === true && st.timeScale === 0.25);
  const off = game.toggleSlowMotion();
  assert('退出减速：未使用额度（额度不消耗）',
    off.ok === true && st.timeScale === 1 && st.slowQuota === game.SLOW_QUOTA_MAX);
}
{
  const st = fresh();
  st.timeScale = 0.25;
  for (let i = 0; i < 60; i++) game.stepFrame(DT);
  assert('减速 60 真实帧消耗 1 秒额度', Math.abs(st.slowQuota - 14) < 1e-9, 'quota=' + st.slowQuota);
  assert('减速期间游戏时间仍按 0.25× 推进', Math.abs((60 - st.remainingTime) - 0.25) < 1e-9);
}
{
  const st = fresh();
  st.timeScale = 0.25;
  st.waveTimer = -1e9;                       // 冻结波次调度，避免生成干扰
  for (let i = 0; i < 120; i++) game.stepFrame(DT / 2);   // 120Hz：一半的帧 steps===0 提前返回
  assert('120Hz 高刷屏下额度扣减速率不变（提前返回不漏扣）',
    Math.abs(st.slowQuota - 14) < 1e-9, 'quota=' + st.slowQuota);
}
{
  const st = fresh();
  st.timeScale = 0.25;
  st.slowQuota = 0.1;
  game.stepFrame(1.0);                       // 真实帧时间被 MAX_FRAME_DT 钳到 0.25s > 剩余额度
  assert('额度耗尽 → 自动恢复常速且额度归零', st.timeScale === 1 && st.slowQuota === 0);
  const notice = game.takeNotice();
  assert('额度耗尽给出可读提示', typeof notice === 'string' && notice.indexOf('减速额度') >= 0, notice);
  const denied = game.toggleSlowMotion();
  assert('额度为 0 时拒绝进入减速并说明原因',
    denied.ok === false && denied.timeScale === 1 && denied.reason.indexOf('减速额度') >= 0);
  game.takeNotice();
  assert('额度不会扣成负数', st.slowQuota === 0);
}
{
  const st = fresh();
  st.waveTimer = 0.5;
  game.stepFrame(DT);                        // 触发 startWave
  assert('波次已开启（前置条件）', st.waveActive === true && st.wave !== 0);
  st.slowQuota = 1;
  st.waveQueue.length = 0;                   // 队列吐空
  st.bodies.length = 1;                      // 场上只剩母星 → 无残留威胁
  game.stepFrame(DT);
  assert('清空一波返还 3 秒额度', Math.abs(st.slowQuota - 4) < 1e-9, 'quota=' + st.slowQuota);
  // 封顶：满额时不再累加
  st.slowQuota = game.SLOW_QUOTA_MAX;
  st.waveActive = true;
  st.waveQueue.length = 0;
  st.bodies.length = 1;
  game.stepFrame(DT);
  assert('额度返还封顶不超出上限', st.slowQuota === game.SLOW_QUOTA_MAX, 'quota=' + st.slowQuota);
}

/* ============================ P0-2 撤销最近放置 ============================ */
console.log('--- P0-2 撤销最近放置 ---');
{
  const st = fresh();
  const planet = st.bodies[0];
  const before = st.budget;
  const r = game.placeStar('large', { x: 120, y: 120 }, {});
  assert('放置成功（前置条件）', r.ok === true && st.budget === before - 300);
  assert('放置后立即可撤销', game.canUndo().ok === true);
  const u = game.undoLastPlacement();
  assert('撤销成功并全额返还 300 星能', u.ok === true && u.refund === 300 && st.budget === before);
  assert('撤销后天体从场上移除', st.bodies.length === 1 && st.bodies[0] === planet);
  assert('撤销后花费统计与放置计数同步修正', st.totalSpent === 0 && st.starsPlaced === 0);
  assert('撤销后无更多可撤销项', game.canUndo().ok === false);
}
{
  const st = fresh();
  game.placeStar('small', { x: 120, y: 120 }, {});
  st.gameTime += game.UNDO_WINDOW + 1;       // 推进游戏时钟，越过 5 秒时间窗
  assert('超过时间窗后不可撤销',
    game.canUndo().ok === false && game.undoLastPlacement().ok === false);
}
{
  const st = fresh();
  game.placeStar('mid', { x: 120, y: 120 }, {});
  st.bodies.pop();                           // 模拟被母星吸收 / 被黑洞吞噬 / 飞出边界
  assert('星体已不在场上时不可撤销',
    game.canUndo().ok === false && game.undoLastPlacement().ok === false);
}
{
  const st = fresh();
  assert('未放置任何星体时不可撤销', game.canUndo().ok === false);
  const r = game.undoLastPlacement();
  assert('无历史时撤销返回失败而非抛异常', r.ok === false && typeof r.reason === 'string');
}
{
  const st = fresh();
  for (let i = 0; i < 25; i++) game.placeStar('small', { x: 100 + i * 18, y: 100 }, {});
  assert('撤销历史上限 20（长局不无限增长）', st.placeHistory.length === 20, 'n=' + st.placeHistory.length);
  assert('仍可撤销最近一次放置', game.canUndo().ok === true);
}
{
  const st = fresh();
  game.placeStar('small', { x: 120, y: 120 }, {});
  st.gameOver = true;
  assert('结算后不可撤销（安全短路）',
    game.canUndo().ok === false && game.undoLastPlacement().ok === false);
}
{
  const st = fresh();
  const before = st.budget;
  game.placeStar('blackhole', { x: 200, y: 200 }, {});
  assert('黑洞放置扣除 1500 星能', st.budget === before - 1500);
  const u = game.undoLastPlacement();
  assert('撤销黑洞整体返还 1500（不折算寿命）', u.ok === true && u.refund === 1500 && st.budget === before);
  assert('撤销后场上不再有黑洞', st.bodies.every(b => b.type !== 'blackhole'));
}

/* ============================ P0-3 撞母星预警 ============================ */
console.log('--- P0-3 撞母星预警 ---');
{
  const planet = {
    type: 'planet', mass: 8000, radius: 30, x: 640, y: 360, vx: 0, vy: 0,
    immovable: true, anchored: true, isStar: true,
  };
  // 直冲母星的陨石：命中 → hitMother + hitTime
  const rock = { type: 'asteroid', mass: 40, radius: 14, x: planet.x + 160, y: planet.y, vx: -120, vy: 0 };
  const simHit = predictor.simulateFuture([planet, rock], P);
  const riskHit = predictor.evaluateRisk(simHit, 1, planet);
  assert('直冲母星的威胁判定为 hitMother 且判红',
    riskHit.hitMother === true && riskHit.level === 'red');
  assert('预警附带撞击倒计时 hitTime（秒，且在预测窗口内）',
    riskHit.hitTime > 0 && riskHit.hitTime <= physics.PREDICT_DUR, 'hitTime=' + riskHit.hitTime);
  // 远离母星的威胁：不产生预警，hitTime 恒为 0
  const away = { type: 'asteroid', mass: 40, radius: 14,
    x: planet.x - 800, y: planet.y - 600, vx: -200, vy: -150 };
  const simAway = predictor.simulateFuture([planet, away], P);
  const riskAway = predictor.evaluateRisk(simAway, 1, planet);
  assert('远离母星的威胁不产生预警（hitTime=0）',
    riskAway.hitMother === false && riskAway.hitTime === 0);
}
{
  const st = fresh();
  st.showHint = false;                       // 只开预警：验证与提示线相互独立
  st.showWarnings = true;
  const planet = st.bodies[0];
  st.bodies.push({ type: 'asteroid', mass: 40, radius: 14,
    x: planet.x + 160, y: planet.y, vx: -120, vy: 0 });
  // 玩家自己的星体即便撞向母星也不扣血（M6）→ 不应进入预警列表
  st.bodies.push({ type: 'star', mass: 300, radius: 17,
    x: planet.x, y: planet.y - 200, vx: 0, vy: 120 });
  sandbox.render(canvas, st);
  assert('预警列表收集到 1 个来袭威胁（只开预警也能产出）',
    Array.isArray(st.threatWarnings) && st.threatWarnings.length === 1,
    'n=' + (st.threatWarnings || []).length);
  assert('预警项携带坐标 / 半径 / 倒计时',
    st.threatWarnings.length === 1 && st.threatWarnings[0].radius === 14
    && st.threatWarnings[0].hitTime > 0);
  assert('玩家星体不计入预警（只有威胁才预警）',
    st.threatWarnings.every(w => w.radius === 14));
  st.showWarnings = false;
  sandbox.render(canvas, st);
  assert('关闭预警后列表被清空（无残影）', st.threatWarnings.length === 0);
}

/* ============================ P0-4 设置持久化 ============================ */
console.log('--- P0-4 设置持久化 ---');
{
  const st = fresh();
  game.takeWarning();                        // 清空历史提示，保证断言针对本次
  assert('默认设置为开启（预测线 / 预警）',
    game.getSettings().showHint === true && game.getSettings().showWarnings === true);
  assert('写入设置成功并同步内存状态',
    game.setSetting('showWarnings', false) === true && st.showWarnings === false);
  const raw = sandbox.localStorage.getItem('starshield_settings');
  assert('设置以 JSON 落盘（单一存档键）',
    !!raw && JSON.parse(raw).showWarnings === false, raw);
  game.setSetting('showHint', false);
  const back = game.loadSettings();
  assert('往返读取一致（刷新后保持）',
    back.showHint === false && back.showWarnings === false && st.showHint === false);
  assert('拒绝未知设置键', game.setSetting('nope', true) === false);
  assert('拒绝类型不匹配的值', game.setSetting('showHint', 'yes') === false);
  assert('拒绝后设置保持不变', game.getSettings().showHint === false);
  // 损坏存档（JSON 解析失败）→ 回退默认 + 可读提示
  sandbox.localStorage.setItem('starshield_settings', '{"showHint": tru');
  const fallback = game.loadSettings();
  assert('损坏存档回退默认设置',
    fallback.showHint === true && fallback.showWarnings === true && st.showHint === true);
  assert('损坏存档产生可读提示', String(game.takeWarning() || '').indexOf('损坏') >= 0);
  // 清除进度：设置一并删除并复位内存
  game.setSetting('showWarnings', false);
  game.clearAllProgress();
  assert('清除进度同时删除设置存档',
    sandbox.localStorage.getItem('starshield_settings') === null);
  assert('清除进度后内存设置复位默认',
    game.getSettings().showWarnings === true && st.showWarnings === true);
}

console.log(ok ? '\n=== P0 改进（额度/撤销/预警/设置）测试全部通过 ==='
               : '\n=== P0 改进测试存在失败 ===');
process.exit(ok ? 0 : 1);
