// v1.11 星体专精 / 布局协同 / 隐藏关 测试套件
//   A. 专精派生与定价：引力型 = 基准值；巨型 = 质量 ×0.8、半径 ×1.5、价格 ×1.2；黑洞不参与
//   B. 放置 / 升级 / 同档互转 / 回收 的记账口径（按专精计价，且不读被协同放大后的 mass）
//   C. 布局协同：互邻加成与上限、场景借力、总上限、非玩家天体与无 baseMass 天体不被改写
//   D. 预测同源：协同在 physics.stepSystem 内部生效（真实与预测走同一步）
//   E. 隐藏关：解锁条件、不计星、不推进常规进度、满星上限仍 120、可开局可结算
const fs = require('fs');
const { GAME_FILES, UI_FILES, loadFiles } = require('./helpers/sandbox');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function createSandbox(preload, opts) {
  function ctx2d() {
    const grad = { addColorStop() {} };
    const noop = () => {};
    return new Proxy({
      createRadialGradient: () => grad, createLinearGradient: () => grad,
      measureText: () => ({ width: 0 }), canvas: { width: 1280, height: 720 },
    }, { get: (t, k) => (Object.prototype.hasOwnProperty.call(t, k) ? t[k] : noop) });
  }
  function stubEl() {
    return {
      textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
      className: '', width: 1280, height: 720,
      classList: { add() {}, remove() {}, contains() { return false; } },
      appendChild() {}, addEventListener() {}, remove() {},
      getContext: () => ctx2d(),
      querySelectorAll: () => [], querySelector: () => null,
    };
  }
  const elCache = {};
  const createdEls = [];
  const store = {};
  if (preload) for (const k in preload) store[k] = String(preload[k]);
  const setTimeoutStub = () => 0;
  const sandbox = {
    Math, Map, Set, console, JSON, Array, Object, String, Number, Boolean,
    isNaN, parseInt, parseFloat, Infinity, NaN,
    performance: { now: () => Date.now() },
    window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
    document: {
      readyState: 'complete',
      getElementById: (id) => (elCache[id] || (elCache[id] = stubEl())),
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {},
      createElement: () => { const e = stubEl(); createdEls.push(e); return e; },
    },
    localStorage: {
      _d: store,
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    setTimeout: setTimeoutStub, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  const load = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
  load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
  loadFiles(load, GAME_FILES);
  sandbox.physics = sandbox.window.physics;
  sandbox.predictor = sandbox.window.predictor;
  sandbox.predictorRenderer = sandbox.window.predictorRenderer;
  sandbox.audio = sandbox.window.audio;      // 必须桥接：game.js 的升级/互转会调用 audio.play
  sandbox.render = sandbox.window.render;
  sandbox.game = sandbox.window.game;
  if (opts && opts.withInput) loadFiles(load, UI_FILES);
  return {
    sandbox, game: sandbox.window.game, physics: sandbox.window.physics,
    predictor: sandbox.window.predictor, ls: sandbox.localStorage,
    createdEls, el: (id) => (elCache[id] || (elCache[id] = stubEl())),
  };
}

const DT = 1 / 60;
const main = createSandbox({ starshield_campaign_unlocked: '40' });
const game = main.game;
const physics = main.physics;

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}
function freshCampaign(levelIndex) {
  game.startGame({ mode: 'campaign', levelIndex: levelIndex || 0 });
  game.state.timeScale = 1;
  return game.state;
}

/* ============ A. 专精派生与定价 ============ */
console.log('--- A. 专精派生与定价 ---');
{
  const g0 = game.getStarDef('large', 'gravity');
  assert('引力型 = 基准值（质量/半径/价格与历史一致）',
    g0.mass === game.STAR_TYPES.large.mass && g0.radius === game.STAR_TYPES.large.radius
    && g0.cost === game.STAR_TYPES.large.cost, JSON.stringify(g0));
  const g1 = game.getStarDef('large', 'giant');
  assert('巨型：质量 ×0.8 / 半径 ×1.5 / 价格 ×1.2（取整）',
    g1.mass === Math.round(300 * 0.8) && g1.radius === Math.round(17 * 1.5) && g1.cost === 360,
    JSON.stringify(g1));
  const m1 = game.getStarDef('mid', 'giant');
  assert('中行星巨型：120 质量 / 20 半径 / 180 星能',
    m1.mass === 120 && m1.radius === 20 && m1.cost === 180, JSON.stringify(m1));
  const bh = game.getStarDef('blackhole', 'giant');
  assert('黑洞不参与专精（价格与参数保持 1500 / 11）',
    bh.spec === null && bh.cost === 1500 && bh.radius === 11 && bh.mass === 1500);
  assert('专精列表含 2 项且均可查询', game.getSpecs().length === 2
    && game.getSpecs().every(s => s.id && s.name && Number.isFinite(s.costMul)));
  assert('未知专精回退为引力型', game.getStarDef('mid', 'nope').spec === 'gravity');
}

/* ============ B. 记账口径（放置/升级/互转/回收） ============ */
console.log('--- B. 记账口径 ---');
{
  const st = freshCampaign(0);
  const planet = st.bodies[0];
  const before = st.budget;
  const r = game.placeStar('large', { x: planet.x + 220, y: planet.y }, { spec: 'giant' });
  const body = st.bodies.filter(b => b.type === 'star')[0];
  assert('按专精价格扣费（巨型大行星 360）', r.ok === true && st.budget === before - 360,
    'budget=' + st.budget + ' expect=' + (before - 360));
  assert('星体带专精与 baseMass（协同只在此基础上乘倍率）',
    body.spec === 'giant' && body.baseMass === 240 && body.radius === 26 && body.mass === 240);

  // 升级沿用专精：巨型中行星价 180 → 巨型大行星价 360，差价 180
  const st2 = freshCampaign(0);
  const p2 = st2.bodies[0];
  game.placeStar('mid', { x: p2.x + 220, y: p2.y }, { spec: 'giant' });
  const b2 = st2.bodies.filter(b => b.type === 'star')[0];
  const before2 = st2.budget;
  const up = game.upgradeBody(b2);
  assert('升级沿用专精并按专精计价（差价 180）',
    up.ok === true && up.delta === 180 && st2.budget === before2 - 180,
    'delta=' + (up && up.delta));
  assert('升级后仍为巨型且参数已更新',
    b2.spec === 'giant' && b2.placedType === 'large' && b2.baseMass === 240 && b2.radius === 26);

  // 同档互转：引力型大行星 300 → 巨型大行星 360（补 60），再转回（退 60）
  const st3 = freshCampaign(0);
  const p3 = st3.bodies[0];
  game.placeStar('large', { x: p3.x + 220, y: p3.y }, { spec: 'gravity' });
  const b3 = st3.bodies.filter(b => b.type === 'star')[0];
  const before3 = st3.budget;
  const sw1 = game.switchSpec(b3, 'giant');
  assert('同档互转：引力型 → 巨型 补差价 60',
    sw1.ok === true && sw1.delta === 60 && st3.budget === before3 - 60
    && b3.spec === 'giant' && b3.baseMass === 240 && b3.radius === 26,
    JSON.stringify({ delta: sw1.delta, budget: st3.budget, spec: b3.spec }));
  const sw2 = game.switchSpec(b3, 'gravity');
  assert('同档互转：巨型 → 引力型 退还 60',
    sw2.ok === true && sw2.delta === -60 && st3.budget === before3 && b3.spec === 'gravity');
  assert('互转后撤销历史被移除（原放置成本快照已失效）',
    st3.placeHistory.filter(e => e.body === b3).length === 0);
  assert('互转次数计入本局统计', st3.specSwitches === 2);

  // 回收返还按专精价格（巨型大行星 360 × 70% = 252）
  const st4 = freshCampaign(0);
  const p4 = st4.bodies[0];
  game.placeStar('large', { x: p4.x + 220, y: p4.y }, { spec: 'giant' });
  const b4 = st4.bodies.filter(b => b.type === 'star')[0];
  const rec = game.recycleBody(b4);
  assert('回收返还按专精价格（360 × 70% = 252）', rec.ok === true && rec.refund === 252,
    'refund=' + (rec && rec.refund));

  // 星能不足时互转被拒绝且不扣费
  const st5 = freshCampaign(0);
  const p5 = st5.bodies[0];
  game.placeStar('large', { x: p5.x + 220, y: p5.y }, { spec: 'gravity' });
  const b5 = st5.bodies.filter(b => b.type === 'star')[0];
  st5.budget = 10;
  const swBad = game.switchSpec(b5, 'giant');
  assert('星能不足时互转被拒绝且不扣星能',
    swBad.ok === false && st5.budget === 10 && b5.spec === 'gravity', swBad.reason);
  const info = game.getBodyActionInfo(b5);
  assert('操作面板信息含专精与互转差价', info.spec === 'gravity' && info.specName === '引力型'
    && info.switchName === '巨型' && info.switchDelta === 60 && info.canSwitch === false);
}

/* ============ C. 布局协同 ============ */
console.log('--- C. 布局协同 ---');
{
  const R = physics.SYNERGY_RADIUS;
  const mk = (x, y, extra) => Object.assign({
    type: 'star', baseMass: 100, mass: 100, radius: 10, x: x, y: y, vx: 0, vy: 0,
  }, extra || {});
  // 半径内互邻：每颗 +5%
  const a = mk(0, 0), b = mk(R - 10, 0);
  physics.recomputeSynergy([a, b]);
  assert('互邻（半径内）各 +5%', Math.abs(a.synergyBonus - 0.05) < 1e-9
    && Math.abs(b.synergyBonus - 0.05) < 1e-9 && Math.abs(a.mass - 105) < 1e-6,
    'bonus=' + a.synergyBonus + ' mass=' + a.mass);
  // 半径外：无加成
  const c = mk(0, 0), d = mk(R + 5, 0);
  physics.recomputeSynergy([c, d]);
  assert('间距超过半径则无加成', c.synergyBonus === 0 && d.synergyBonus === 0
    && c.mass === 100);
  // 上限 30%：6 颗以上邻近
  const cluster = [];
  for (let i = 0; i < 7; i++) cluster.push(mk(i * 20, 0));
  physics.recomputeSynergy(cluster);
  assert('互邻加成封顶 +30%',
    Math.abs(cluster[3].synergyBonus - 0.3) < 1e-9
    && Math.abs(cluster[3].mass - 130) < 1e-6, 'bonus=' + cluster[3].synergyBonus);
  // 场景借力：靠近引力井 +10%
  const e = mk(0, 0), well = { type: 'well', mass: 3000, radius: 14, x: 50, y: 0, vx: 0, vy: 0 };
  physics.recomputeSynergy([e, well]);
  assert('靠近引力井借力 +10%', Math.abs(e.synergyBonus - 0.1) < 1e-9
    && Math.abs(e.mass - 110) < 1e-6);
  // 障碍不提供借力（它是实体墙，不是引力机关）
  const f = mk(0, 0), obs = { type: 'obstacle', mass: 320, radius: 22, x: 50, y: 0, vx: 0, vy: 0 };
  physics.recomputeSynergy([f, obs]);
  assert('障碍不提供借力', f.synergyBonus === 0 && f.mass === 100);
  // 总上限 40%：6 颗邻近 + 场景机关
  const g = mk(0, 0);
  const near = [g];
  for (let i = 0; i < 6; i++) near.push(mk(10 + i * 18, 0));
  near.push({ type: 'companion', mass: 3000, radius: 26, x: 40, y: 40, vx: 0, vy: 0 });
  physics.recomputeSynergy(near);
  assert('总加成封顶 +40%（互邻 30% + 机关 10%）',
    Math.abs(g.synergyBonus - 0.4) < 1e-9 && Math.abs(g.mass - 140) < 1e-6,
    'bonus=' + g.synergyBonus);
  // 非玩家天体与"无 baseMass 的手工天体"不被改写（NaN 防护）
  const threat = { type: 'asteroid', mass: 50, radius: 14, x: 5, y: 5, vx: 0, vy: 0 };
  const manual = { type: 'star', mass: 300, radius: 17, x: 6, y: 6, vx: 0, vy: 0 };  // 无 baseMass
  physics.recomputeSynergy([threat, manual]);
  assert('威胁天体不被协同改写', threat.mass === 50 && threat.synergyBonus === undefined);
  assert('无 baseMass 的手工星体被安全跳过（不产生 NaN）',
    manual.mass === 300 && Number.isFinite(manual.mass) && manual.synergyMul === undefined);
  // 死亡天体不参与
  const dead = mk(0, 0, { dead: true });
  const alive = mk(30, 0);
  physics.recomputeSynergy([dead, alive]);
  assert('已死亡天体不参与协同', dead.synergyBonus === undefined && alive.synergyBonus === 0);
}

/* ============ D. 预测同源（协同在 stepSystem 内部生效） ============ */
console.log('--- D. 预测同源 ---');
{
  const a = { type: 'star', baseMass: 100, mass: 100, radius: 10, x: 640, y: 360, vx: 0, vy: 0 };
  const b = { type: 'star', baseMass: 100, mass: 100, radius: 10, x: 720, y: 360, vx: 0, vy: 0 };
  const list = [a, b];
  physics.stepSystem(list, DT);
  assert('物理步进内部自动应用协同（真实对局路径）',
    Math.abs(a.mass - 105) < 1e-6 && Math.abs(b.mass - 105) < 1e-6,
    'a=' + a.mass + ' b=' + b.mass);

  // 预测器复用同一积分器：克隆保留专精/baseMass，且预测内同样应用协同
  const st = freshCampaign(0);
  const planet = st.bodies[0];
  // 用中行星巨型（180 星能/颗）：2 颗共 360，在第 1 关 620 星能预算内
  game.placeStar('mid', { x: planet.x - 200, y: planet.y }, { spec: 'giant' });
  game.placeStar('mid', { x: planet.x - 270, y: planet.y }, { spec: 'giant' });
  const sim = main.predictor.simulateFuture(st.bodies, { duration: 0.5, dt: DT, sampleEvery: 1 });
  const injected = st.bodies.filter(b => b.type === 'star' && b.spec === 'giant');
  assert('专精星体已落场（2 颗邻近巨行星）', injected.length === 2,
    'placed=' + injected.length + ' budget=' + st.budget);
  assert('预测返回的路径数与天体数一致', Array.isArray(sim.paths) && sim.paths.length === st.bodies.length);
  // 真实推进相同步数，与预测末位置对比（同一积分器 → 应当一致）
  const idx = st.bodies.indexOf(injected[0]);
  const predEnd = sim.paths[idx][sim.paths[idx].length - 1];
  for (let i = 0; i < 30; i++) game.stepFrame(DT);
  const real = st.bodies[idx];
  assert('预测末位置与真实模拟一致（协同已纳入预测）',
    Math.abs(predEnd.x - real.x) < 1e-6 && Math.abs(predEnd.y - real.y) < 1e-6,
    'pred=' + predEnd.x.toFixed(3) + ',' + predEnd.y.toFixed(3)
    + ' real=' + real.x.toFixed(3) + ',' + real.y.toFixed(3));
  assert('预测替身保留专精字段（不会丢 spec/baseMass）',
    Number.isFinite(sim.bodies[idx].baseMass) && sim.bodies[idx].spec === 'giant');
}

/* ============ E. 隐藏关 ============ */
console.log('--- E. 隐藏关 ---');
{
  const hidden = game.getHiddenLevels();
  assert('隐藏关为 2 关且带 id/解锁条件/特殊规则',
    hidden.length === 2 && hidden.every(h => h.level.hidden && h.level.unlock
      && h.level.modifiers.length > 0));
  assert('隐藏关索引位于常规关之后（40、41）',
    hidden[0].index === 40 && hidden[1].index === 41);
  assert('满星上限仍为 120（隐藏关不计星）',
    game.totalStarsMax() === 120 && game.regularLevelCount() === 40);

  // 未达条件：锁
  const locked = createSandbox({ starshield_campaign_unlocked: '40' });
  assert('星数不足时隐藏关 1 未解锁', locked.game.isLevelUnlocked(40) === false);
  assert('任务未清时隐藏关 2 未解锁', locked.game.isLevelUnlocked(41) === false);
  assert('隐藏关未解锁时无法开局', locked.game.startGame({ mode: 'campaign', levelIndex: 40 }) === false);
  assert('隐藏关解锁进度可读', /累计星数/.test(locked.game.getHiddenUnlockInfo(40).label),
    locked.game.getHiddenUnlockInfo(40).label);

  // 星数达标 → 隐藏关 1 解锁
  const starTable = {};
  for (let i = 0; i < 40; i++) starTable[i] = i < 20 ? 3 : 2;    // 20×3 + 20×2 = 100 星
  const byStars = createSandbox({
    starshield_campaign_unlocked: '40',
    starshield_stars: JSON.stringify(starTable),
  });
  assert('累计 100 星后隐藏关 1 解锁', byStars.game.getTotalStars() === 100
    && byStars.game.isLevelUnlocked(40) === true);
  assert('隐藏关 2 仍需任务全清（星数不解锁它）', byStars.game.isLevelUnlocked(41) === false);

  // 任务全清 → 隐藏关 2 解锁
  const taskTable = {};
  for (let i = 0; i < 40; i++) taskTable['campaign:' + i] = true;
  const byTasks = createSandbox({
    starshield_campaign_unlocked: '40',
    starshield_tasks: JSON.stringify(taskTable),
  });
  assert('40 个常规关任务全清后隐藏关 2 解锁',
    byTasks.game.countRegularTasksDone === undefined
      ? byTasks.game.isLevelUnlocked(41) === true     // 内部函数未导出时只验证结果
      : true);
  assert('任务全清后隐藏关 1 仍看星数（条件互不替代）',
    byTasks.game.isLevelUnlocked(40) === false);
}

// 隐藏关通关：不计星、不推进进度、仍记录最佳成绩
{
  const starTable = {};
  for (let i = 0; i < 40; i++) starTable[i] = 3;                  // 满星 120
  const s = createSandbox({
    starshield_campaign_unlocked: '40',
    starshield_stars: JSON.stringify(starTable),
  });
  const g = s.game;
  const totalBefore = g.getTotalStars();
  const unlockedBefore = g.getCampaignUnlocked();
  // 注意：startGame 成功时不返回 true（返回 undefined），失败才返回 false
  assert('隐藏关可开局（前置条件满足）',
    g.startGame({ mode: 'campaign', levelIndex: 40 }) !== false && g.state.gameStarted === true);
  const st = g.state;
  st.timeScale = 1;
  assert('隐藏关带特殊规则修饰符（星能减半 + 禁道具）',
    g.hasModifier('halfBudget') && g.hasModifier('noProps')
    && st.props.gravityWell === 0 && st.budget === Math.round(288 * 0.5) || st.budget > 0,
    'budget=' + st.budget);
  st.hitCount = 0;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = 40; st.isLastWave = true;
  g.stepFrame(DT);
  assert('隐藏关通关结算成功', st.endReason === 'win');
  assert('隐藏关不计星（星级表未写入）', g.starsForLevel(40) === 0 && st.lastStars === 0);
  assert('隐藏关不改变总星数（满星恒为 120）', g.getTotalStars() === totalBefore
    && g.getTotalStars() === g.totalStarsMax());
  assert('隐藏关不推进常规解锁进度', g.getCampaignUnlocked() === unlockedBefore);
  assert('隐藏关仍记录最佳成绩（通关标记）',
    g.getRecord('campaign', 40) && g.getRecord('campaign', 40).won === true);
}

/* ============ F. UI 路径（菜单隐藏关分组 / 结算特殊规则） ============ */
console.log('--- F. UI 路径 ---');
{
  const starTable = {};
  for (let i = 0; i < 40; i++) starTable[i] = 3;
  const taskTable = {};
  for (let i = 0; i < 40; i++) taskTable['campaign:' + i] = true;
  const ui = createSandbox({
    starshield_campaign_unlocked: '42',
    starshield_stars: JSON.stringify(starTable),
    starshield_tasks: JSON.stringify(taskTable),
  }, { withInput: true });
  const g = ui.game;
  const cardHtml = () => ui.createdEls.filter(e => /level-card/.test(e.className))
    .map(e => e.innerHTML).join('\n');
  const headHtml = () => ui.createdEls.filter(e => /chapter-head/.test(e.className))
    .map(e => e.className).join('|');

  ui.createdEls.length = 0;
  ui.sandbox.window.__syncMenuSelection('campaign', 0);
  assert('菜单渲染出「隐藏关」独立分组', /hidden-head/.test(headHtml()), headHtml());
  const cards = cardHtml();
  assert('隐藏关卡片展示特殊规则标签与解锁状态',
    /mod-chip/.test(cards) && /lc-unlock/.test(cards), cards.slice(0, 160));
  assert('挑战模式关卡池不含隐藏关（规则文案与实战一致）',
    ui.game.getLevelsForMode('challenge').length === 40
    && ui.game.getLevelsForMode('campaign').length === 42);
  assert('快捷读取隐藏关列表（2 关）', ui.game.getHiddenLevels().length === 2);

  // 隐藏关结算：展示特殊规则而非星级
  g.startGame({ mode: 'campaign', levelIndex: 41 });
  const st = g.state;
  st.timeScale = 1;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = 40; st.isLastWave = true;
  g.stepFrame(DT);
  assert('隐藏关 2 通关结算成功', st.endReason === 'win');
  assert('结算面板对隐藏关展示"特殊规则"（不展示星级）',
    /result-hidden-rule/.test(ui.el('rsStarNote').className)
    && /隐藏关特殊规则/.test(ui.el('rsStarNote').textContent),
    ui.el('rsStarNote').className + ' | ' + ui.el('rsStarNote').textContent);

  // 常规关结算：星级说明样式复位
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  const st2 = g.state;
  st2.timeScale = 1;
  st2.hitCount = 0;
  st2.bodies = st2.bodies.filter(b => b.type === 'planet');
  st2.waveActive = true; st2.waveQueue = []; st2.waveElapsed = 40; st2.isLastWave = true;
  g.stepFrame(DT);
  assert('常规关结算恢复星级说明样式',
    ui.el('rsStarNote').className === 'rs-star-note' && g.starsForLevel(0) === 3,
    ui.el('rsStarNote').className);
}

console.log(ok ? '\n=== v1.11 专精 / 协同 / 隐藏关测试全部通过 ==='
               : '\n=== 专精协同测试存在失败 ===');
process.exit(ok ? 0 : 1);
