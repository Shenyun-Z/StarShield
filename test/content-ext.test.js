// v1.10 内容扩展测试套件（保卫萝卜式 · 纯单机）
//   A. 旧 30 关零改动：与 test/fixtures/campaign-v19.json 基线逐字段比对（新增 task 字段除外）
//   B. 第四章：40 关 / 4 章 / 参数合法与递增 / 场景白名单
//   C. 挑战模式：修饰符确定性挂载 + 5 个拦截点（禁道具/来袭加速/星能减半/禁黑洞/禁回收升级/禁减速）
//   D. 每日挑战：同日确定、跨日不同、独立存档、跨日自动重置
//   E. 额外任务：四类边界、只判不罚（不影响星级）、幂等
//   F. 下一波预告：索引口径与越界守卫、Boss 标记
//   G. 最佳记录：择优写入、新纪录标记
//   H. 存档健壮性：损坏回退、清除进度复位、单机自查（无任何网络 API）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

// ---- 沙箱工厂 ----
// opts.dailyLevel：在加载 game.js 之前替换 window.makeDailyChallenge，
//   用于构造带指定修饰符的每日关卡（挑战模式的修饰符集合由序号确定性推导，无法指定）。
function createSandbox(preload, opts) {
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
      classList: { add() {}, remove() {}, contains() { return false; } },   // 注意：无 toggle
      appendChild() {}, addEventListener() {}, remove() {},
      getContext: () => ctx2d(),
      querySelectorAll: () => [], querySelector: () => null,
    };
  }
  const elCache = {};
  const createdEls = [];
  const store = {};
  if (preload) for (const k in preload) store[k] = String(preload[k]);
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
      // appendChild 是空操作，故把 createElement 产物收集起来，供 UI 渲染断言使用
      createElement: () => { const e = stubEl(); createdEls.push(e); return e; },
    },
    localStorage: {
      _d: store,
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  const load = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
  load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
  if (opts && opts.dailyLevel) sandbox.window.makeDailyChallenge = () => opts.dailyLevel;
  load('js/game.js');
  // 浏览器里 window 即全局对象；沙箱里必须显式桥接（否则模块内裸引用会静默短路）
  sandbox.physics = sandbox.window.physics;
  sandbox.predictor = sandbox.window.predictor;
  sandbox.audio = sandbox.window.audio;
  sandbox.render = sandbox.window.render;
  sandbox.game = sandbox.window.game;
  // opts.withInput：加载交互层（用于 UI 渲染断言）
  if (opts && opts.withInput) load('js/input.js');
  return {
    sandbox, game: sandbox.window.game, physics: sandbox.window.physics, ls: sandbox.localStorage,
    createdEls, el: (id) => (elCache[id] || (elCache[id] = stubEl(id))),
  };
}

const main = createSandbox();
const game = main.game;
const physics = main.physics;
const DT = 1 / 60;

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}

function freshCampaign(levelIndex) {
  game.startGame({ mode: 'campaign', levelIndex: levelIndex || 0 });
  const st = game.state;
  st.timeScale = 1;
  return st;
}
// 直接构造一次"通关"结算（不依赖物理跑完整局）
function winCurrentLevel(st) {
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true;
  st.waveQueue = [];
  st.waveElapsed = 40;
  st.isLastWave = true;
  game.stepFrame(DT);
  return st.endReason;
}

/* ============ A. 旧 30 关零改动（基线 fixture） ============ */
console.log('--- A. 旧 30 关零改动（基线比对）---');
{
  const base = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/campaign-v19.json'), 'utf8'));
  const levels = game.CAMPAIGN_LEVELS;
  assert('关卡总数为 40（前 30 关 + 第四章 10 关）', levels.length === 40, 'n=' + levels.length);
  assert('章节为 4 章且连续覆盖 40 关',
    game.CHAPTERS.length === 4
    && game.CHAPTERS.every((c, i) => (i === 0 || c.from === game.CHAPTERS[i - 1].to + 1))
    && game.CHAPTERS[3].to === 39);

  // 逐字段比对：task 是 v1.10 新增字段，比对时排除
  function strip(lv) { const c = Object.assign({}, lv); delete c.task; return c; }
  function deepEqual(x, y) {
    if (x === y) return true;
    if (typeof x !== typeof y) return false;
    if (Array.isArray(x)) {
      return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
    }
    if (x && typeof x === 'object') {
      const kx = Object.keys(x), ky = Object.keys(y);
      return kx.length === ky.length && kx.every(k => deepEqual(x[k], y[k]));
    }
    return false;
  }
  let firstBad = -1;
  for (let i = 0; i < 30; i++) {
    if (!deepEqual(strip(levels[i]), base.levels[i])) { firstBad = i + 1; break; }
  }
  assert('前 30 关与 v1.9 基线逐字段一致（数值/波次/文案零改动）', firstBad < 0,
    firstBad > 0 ? ('首个不一致：第 ' + firstBad + ' 关') : '');
  assert('基线章节（3 章）仍为前 3 章',
    base.chapters.length === 3
    && game.CHAPTERS.slice(0, 3).every((c, i) => c.from === base.chapters[i].from && c.to === base.chapters[i].to));
}

/* ============ B. 第四章参数合法性与递增 ============ */
console.log('--- B. 第四章（31-40 关）---');
{
  const levels = game.CAMPAIGN_LEVELS;
  let diffMono = true, waveMono = true;
  for (let i = 1; i < levels.length; i++) {
    if (!(levels[i].difficulty > levels[i - 1].difficulty - 1e-9)) diffMono = false;
    if (levels[i].waves.length < levels[i - 1].waves.length) waveMono = false;
  }
  assert('全 40 关难度严格递增（无平台期）', diffMono);
  assert('全 40 关波数非递减（含 Boss 波与第四章衔接）', waveMono,
    'L30=' + levels[29].waves.length + ' L31=' + levels[30].waves.length
    + ' L40=' + levels[39].waves.length);
  assert('第四章血量 ≥ 16 且不高于首关',
    levels.slice(30).every(l => l.health >= 16) && levels[29].health >= levels[39].health);
  assert('第四章星能 ≥ 大行星成本（300）', levels.slice(30).every(l => l.budget >= 300));
  assert('第四章含两处 Boss 关（第 35 / 40 关）',
    levels[34].waves[levels[34].waves.length - 1].spawns.some(s => s.kind === 'boss')
    && levels[39].waves[levels[39].waves.length - 1].spawns.some(s => s.kind === 'boss'));
  const sceneOk = levels.slice(30).every(l => l.scene.bodies.every(b =>
    physics.SCENE_TYPES.indexOf(b.type) >= 0 && b.mass > 0 && b.radius > 0));
  assert('第四章场景天体类型合法（复用已有白名单）', sceneOk);
  assert('第四章每关都有额外任务定义',
    levels.slice(30).every(l => l.task && typeof l.task.id === 'string' && l.task.text.length > 4));
}

/* ============ C. 挑战模式与修饰符 ============ */
console.log('--- C. 挑战模式与修饰符 ---');
{
  // 确定性 + 递增：每 6 关加一条，上限 5 条
  const a = game.challengeModifiersFor(8);
  const b = game.challengeModifiersFor(8);
  assert('修饰符挂载是确定性的（同一关两次结果一致）', JSON.stringify(a) === JSON.stringify(b));
  assert('修饰符随关卡序号递增（0 关 <6 关 <12 关 <18 关 <24 关）',
    game.challengeModifiersFor(0).length === 1
    && game.challengeModifiersFor(6).length === 2
    && game.challengeModifiersFor(12).length === 3
    && game.challengeModifiersFor(18).length === 4
    && game.challengeModifiersFor(24).length === 5
    && game.challengeModifiersFor(39).length === 5);
  assert('修饰符不超过定义表长度且 id 合法',
    game.challengeModifiersFor(39).every(id => (game.MODIFIERS || []).some(m => m.id === id)));
  assert('闯关模式不挂载任何修饰符', game.challengeModifiersFor(0).length > 0
    && (game.startGame({ mode: 'campaign', levelIndex: 0 }), game.state.modifiers.length === 0));
}

// 挑战进度解锁到第 40 关的沙箱（用于逐项验证拦截点）
const ch = createSandbox({ starshield_challenge: JSON.stringify({ unlocked: 39 }) });
{
  const g = ch.game;
  // idx 0：noProps（禁道具）
  g.startGame({ mode: 'challenge', levelIndex: 0 });
  assert('挑战第 1 关挂载「禁道具」', g.state.modifiers.indexOf('noProps') >= 0
    && g.getActiveModifiers().some(m => m.id === 'noProps'));
  assert('禁道具：本局道具数量全为 0',
    g.state.props.gravityWell === 0 && g.state.props.repulseWave === 0 && g.state.props.stasis === 0);
  assert('禁道具：useProp 被拒绝（未持有）', g.useProp('stasis', { x: 100, y: 100 }).ok === false);

  // idx 12：noProps + fastThreats + halfBudget
  const lvl12 = g.CAMPAIGN_LEVELS[12];
  g.startGame({ mode: 'challenge', levelIndex: 12 });
  assert('挑战第 13 关含「星能减半」修饰符', g.state.modifiers.indexOf('halfBudget') >= 0);
  assert('星能减半：初始星能为关卡预算的一半',
    g.state.budget === Math.round(lvl12.budget * 0.5),
    'budget=' + g.state.budget + ' base=' + lvl12.budget);
  assert('任务判定的"初始预算"取生效后的值（与减半后的实际星能一致）',
    g.getCurrentRunStats().levelBudget === Math.round(lvl12.budget * 0.5),
    'levelBudget=' + g.getCurrentRunStats().levelBudget);

  // 来袭加速：首个威胁速度 = 配置速度 ×1.5
  const firstSpawn = lvl12.waves[0].spawns[0];
  const st12 = g.state;
  st12.timeScale = 1;
  for (let i = 0; i < 1200 && st12.bodies.filter(x => ch.physics.isThreat(x)).length === 0; i++) {
    g.stepFrame(DT);
  }
  const threats = st12.bodies.filter(x => ch.physics.isThreat(x));
  assert('来袭加速：首个威胁速度 = 配置速度 ×1.5',
    threats.length > 0
    && Math.abs(Math.hypot(threats[0].vx, threats[0].vy) - firstSpawn.speed * 1.5) < 0.6,
    threats.length ? ('v=' + Math.hypot(threats[0].vx, threats[0].vy).toFixed(2) + ' expect=' + (firstSpawn.speed * 1.5).toFixed(2)) : 'no threat');

  // idx 18：+ noBlackhole
  g.startGame({ mode: 'challenge', levelIndex: 18 });
  const planet = g.state.bodies[0];
  const bh = g.placeStar('blackhole', { x: planet.x + 200, y: planet.y }, {});
  assert('禁黑洞：放置黑洞被拒绝且不扣星能',
    bh.ok === false && g.state.budget === Math.round(g.CAMPAIGN_LEVELS[18].budget * 0.5),
    'ok=' + bh.ok + ' reason=' + bh.reason);
  assert('禁黑洞不影响普通星体放置',
    g.placeStar('mid', { x: planet.x + 180, y: planet.y }, {}).ok === true);

  // idx 24：+ noRecycle（禁回收/升级）
  g.startGame({ mode: 'challenge', levelIndex: 24 });
  const p24 = g.state.bodies[0];
  g.placeStar('mid', { x: p24.x + 180, y: p24.y }, {});
  const placed = g.state.bodies.filter(x => x.type === 'star')[0];
  assert('禁回收：recycleBody 被拒绝', g.recycleBody(placed).ok === false);
  assert('禁升级：upgradeBody 被拒绝', g.upgradeBody(placed).ok === false);
}

// 每日关卡构造：验证 level.modifiers 路径 + 禁减速 + 禁道具
{
  const baseLevel = main.game.CAMPAIGN_LEVELS[2];
  const customDaily = Object.assign({}, baseLevel, {
    id: 'daily', name: '每日挑战 · 测试', daily: true, duration: 0,
    modifiers: ['noSlow', 'noProps'],
    task: { id: 'noSlow', text: '不使用时间减速通关' },
  });
  const d = createSandbox(null, { dailyLevel: customDaily });
  const g = d.game;
  g.startGame({ mode: 'daily', levelIndex: 0 });
  assert('每日挑战：关卡自带修饰符被正确挂载',
    g.state.modifiers.indexOf('noSlow') >= 0 && g.state.modifiers.indexOf('noProps') >= 0);
  assert('禁减速：减速额度为 0 且状态标记禁用',
    g.state.slowQuota === 0 && g.slowMotionState().disabled === true);
  const r = g.toggleSlowMotion();
  assert('禁减速：无法进入慢动作并给出原因',
    r.ok === false && String(r.reason).indexOf('减速') >= 0 && g.state.timeScale === 1);
}

// 挑战进度与挑战星（独立于闯关）
{
  const g = game;
  g.clearAllProgress();
  assert('挑战初始进度为 0（仅第 1 关可玩）',
    g.getChallengeUnlocked() === 0 && g.isChallengeUnlocked(0) && !g.isChallengeUnlocked(1));
  const st = (g.startGame({ mode: 'challenge', levelIndex: 0 }), g.state);
  st.timeScale = 1;
  st.hitCount = 0;
  winCurrentLevel(st);
  assert('挑战通关推进挑战进度', g.getChallengeUnlocked() === 1 && g.isChallengeUnlocked(1));
  assert('挑战通关不影响闯关解锁进度', g.getCampaignUnlocked() === 0);
  assert('挑战通关获得挑战星（零受击 = 3 星）', g.challengeStarsForLevel(0) === 3,
    'stars=' + g.challengeStarsForLevel(0));
  assert('挑战星不并入闯关总星数（两套口径独立）', g.getTotalStars() === 0,
    'totalStars=' + g.getTotalStars());
  assert('挑战星记录落盘', !!main.ls.getItem('starshield_challenge'));
}

/* ============ D. 每日挑战 ============ */
console.log('--- D. 每日挑战 ---');
{
  const maker = main.sandbox.window.makeDailyChallenge;
  assert('每日挑战生成器已导出且可用', typeof maker === 'function');
  const k1 = '20260101', k2 = '20260102';
  assert('同一日期生成完全一致的关卡',
    JSON.stringify(maker(k1)) === JSON.stringify(maker(k1)));
  assert('不同日期生成不同的关卡',
    JSON.stringify(maker(k1)) !== JSON.stringify(maker(k2)));
  const dl = game.getDailyLevel();
  assert('当日关卡结构完整（波次/任务/修饰符/场景）',
    dl && Array.isArray(dl.waves) && dl.waves.length > 0
    && dl.task && dl.task.id && Array.isArray(dl.modifiers) && dl.scene);
  assert('每日关卡自带 Boss 收尾波',
    dl.waves[dl.waves.length - 1].spawns.some(s => s.kind === 'boss'));
  const dstate = game.getDailyState();
  assert('每日状态含日期键 / 通关标记 / 当日最高分',
    typeof dstate.key === 'string' && typeof dstate.cleared === 'boolean'
    && Number.isFinite(dstate.bestScore));

  // 每日成绩独立：不污染生存/无尽的 bestScore / bestWaves
  const beforeScore = game.bestForMode('survival');
  const beforeWaves = game.getBestWaves();
  game.startGame({ mode: 'daily', levelIndex: 0 });
  game.state.timeScale = 1;
  game.state.wave = Math.min(5, game.state.level.waves.length - 1);   // 模拟已推进到第 5 波
  winCurrentLevel(game.state);
  const after = game.getDailyState();
  assert('每日挑战通关后标记当日已通关', after.cleared === true);
  assert('每日成绩记录最高波数', after.bestWave === 5, 'wave=' + after.bestWave);
  assert('每日成绩不污染生存/无尽记录',
    game.bestForMode('survival') === beforeScore && game.getBestWaves() === beforeWaves);
  assert('每日挑战存档落盘', !!main.ls.getItem('starshield_daily'));
}
{
  // 跨日自动重置：预置一份"昨天"的存档
  const stale = createSandbox({ starshield_daily: JSON.stringify({ date: '20000101', cleared: true, bestScore: 999, bestWave: 9 }) });
  const d = stale.game.getDailyState();
  assert('每日挑战跨日自动重置（不显示昨天的成绩）',
    d.cleared === false && d.bestScore === 0 && d.bestWave === 0);
}

/* ============ E. 每关额外任务（只判不罚） ============ */
console.log('--- E. 每关额外任务 ---');
{
  game.clearAllProgress();
  assert('任务初始全部未完成', game.getTasksDoneCount() === 0);
  assert('第 1 关任务为「不使用任何道具」',
    game.CAMPAIGN_LEVELS[0].task.id === 'noProp'
    && game.isTaskDone('campaign', 0) === false);

  // 达成：零受击 + 未用道具 + 未用减速 (+2 星能返还口径不变)
  const st = freshCampaign(0);
  st.hitCount = 0;
  winCurrentLevel(st);
  assert('通关且未使用道具 → 任务达成并落盘',
    game.isTaskDone('campaign', 0) === true && game.getTasksDoneCount() === 1
    && !!main.ls.getItem('starshield_tasks'));
  assert('任务结果写入 state.lastTask 供结算展示',
    game.state.lastTask && game.state.lastTask.done === true && game.state.lastTask.id === 'noProp');

  // 幂等：再通关一次不重复计数
  const st2 = freshCampaign(0);
  winCurrentLevel(st2);
  assert('任务达成幂等（重复通关不重复计数）', game.getTasksDoneCount() === 1);

  // 未达成：使用了道具
  const st3 = freshCampaign(0);
  st3.propsUsed = 1;
  winCurrentLevel(st3);
  assert('使用了道具 → 任务未达成（但通关照常结算）',
    game.state.lastTask.done === false && game.state.endReason === 'win');

  // 失败局不判定、不记录：让威胁撞毁母星（与 robustness/score 同一路径）
  const st4 = freshCampaign(1);
  st4.health = 1;
  const p4 = st4.bodies[0];
  st4.bodies.push({ type: 'asteroid', mass: 50, radius: 13, x: p4.x + 5, y: p4.y, vx: 0, vy: 0 });
  game.stepFrame(DT);
  assert('母星被摧毁 → 结算为失败', st4.endReason === 'defeat', 'endReason=' + st4.endReason);
  assert('未通关不判定任务', game.isTaskDone('campaign', 1) === false
    && game.state.lastTask && game.state.lastTask.done === false);

  // 只判不罚：完成任务不改变星级（依旧按受击数判定）
  assert('任务不影响星级判定（第 1 关仍为 3 星）', game.starsForLevel(0) === 3);

  // 各任务判定边界（直接调用判定表，与成就同构的纯函数）
  const T = game.TASK_CHECKS;
  assert('noProp 判定：未用道具为真 / 用道具为假',
    T.noProp({ propsUsed: 0 }) === true && T.noProp({ propsUsed: 1 }) === false);
  assert('noSlow 判定：未减速为真 / 减速为假',
    T.noSlow({ slowUsedSeconds: 0 }) === true && T.noSlow({ slowUsedSeconds: 0.5 }) === false);
  assert('noBlackhole 判定：未放黑洞为真 / 放过为假',
    T.noBlackhole({ blackholesPlaced: 0 }) === true && T.noBlackhole({ blackholesPlaced: 1 }) === false);
  assert('noRecycle 判定：升级或回收任一发生即失败',
    T.noRecycle({ recycles: 0, upgrades: 0 }) === true
    && T.noRecycle({ recycles: 1, upgrades: 0 }) === false
    && T.noRecycle({ recycles: 0, upgrades: 2 }) === false);
  assert('thrifty 判定：结余 ≥ 初始预算一半为真（含边界）',
    T.thrifty({ budgetLeft: 100, levelBudget: 200 }) === true
    && T.thrifty({ budgetLeft: 99, levelBudget: 200 }) === false);
  assert('noHit 判定：零受击为真 / 受击为假',
    T.noHit({ hits: 0 }) === true && T.noHit({ hits: 1 }) === false);
}

/* ============ F. 下一波来袭预告 ============ */
console.log('--- F. 下一波来袭预告 ---');
{
  // 生存模式没有预定义波次 → 不可用
  game.startGame({ mode: 'survival', levelIndex: 0 });
  assert('生存模式无下一波预告（available=false）',
    game.getWavePreview().available === false);

  const st = freshCampaign(0);
  const lvl = game.CAMPAIGN_LEVELS[0];
  const pv = game.getWavePreview();
  assert('闯关模式预告可用且指向下一波（索引口径 = state.wave）',
    pv.available === true && pv.waveNo === st.wave + 1 && pv.total === lvl.waves.length,
    'waveNo=' + pv.waveNo + ' wave=' + st.wave + ' total=' + pv.total);
  const expectCount = lvl.waves[st.wave].spawns.length;
  const gotCount = pv.counts.reduce((s, c) => s + c.count, 0);
  assert('预告构成数量与该波实际来袭数一致', gotCount === expectCount,
    'got=' + gotCount + ' expect=' + expectCount);
  assert('预告含来袭方向', pv.sides.length > 0 && pv.label.length > 0);

  // Boss 波预告标记（需要解锁到第 5 关，用独立沙箱避免受前面 clearAllProgress 影响）
  const unlocked = createSandbox({ starshield_campaign_unlocked: '5' });
  const boss = (unlocked.game.startGame({ mode: 'campaign', levelIndex: 4 }), unlocked.game.state);
  boss.wave = boss.level.waves.length - 1;      // 停在 Boss 波
  const pvBoss = unlocked.game.getWavePreview();
  assert('Boss 波预告带 boss 标记', pvBoss.available === true && pvBoss.boss === true,
    JSON.stringify(pvBoss));

  // 越界守卫：全部波次已开始时不再预告
  boss.wave = boss.level.waves.length;
  assert('越界守卫：无更多波次时不给出预告', unlocked.game.getWavePreview().available === false);

  assert('预告是纯只读接口（调用后不改变场上天体数）', (function () {
    const n = unlocked.game.state.bodies.length;
    unlocked.game.getWavePreview(); unlocked.game.getWavePreview();
    return unlocked.game.state.bodies.length === n;
  })());
}

/* ============ G. 每关最佳记录 ============ */
console.log('--- G. 每关最佳记录 ---');
{
  game.clearAllProgress();
  const st = freshCampaign(0);
  st.hitCount = 0;
  winCurrentLevel(st);
  const rec = game.getRecord('campaign', 0);
  assert('通关后写入最佳记录（分数 / 受击 / 用时 / 通关标记）',
    !!rec && rec.bestScore >= 0 && rec.leastHits === 0 && rec.won === true && rec.plays === 1,
    JSON.stringify(rec));
  assert('首次记录标记 first=true',
    game.state.lastRecord && game.state.lastRecord.newBest.first === true);
  assert('最佳记录落盘', !!main.ls.getItem('starshield_records'));

  // 第二次更差：不覆盖最佳分、不产生新纪录
  const st2 = freshCampaign(0);
  st2.hitCount = 3;
  st2.scoreIntercept = 0;
  winCurrentLevel(st2);
  const rec2 = game.getRecord('campaign', 0);
  assert('较差的一局不覆盖最佳分数', rec2.bestScore === rec.bestScore);
  assert('较差的一局不产生"新纪录"标记',
    game.state.lastRecord.newBest.score === false);
  assert('记录累计游玩次数', rec2.plays === 2);
  assert('最少受击记录保持更优值', rec2.leastHits === 0, 'least=' + rec2.leastHits);
}

/* ============ H. 存档健壮性 / 清除 / 单机自查 ============ */
console.log('--- H. 存档健壮性 / 清除 / 单机自查 ---');
{
  const bad = createSandbox({
    starshield_challenge: '{oops',
    starshield_tasks: '{oops',
    starshield_records: '{oops',
    starshield_daily: '{oops',
  });
  assert('损坏的挑战存档回退为空进度', bad.game.getChallengeUnlocked() === 0);
  assert('损坏的任务存档回退为空进度', bad.game.getTasksDoneCount() === 0);
  assert('损坏的记录存档回退为空进度', bad.game.getRecord('campaign', 0) === null);
  assert('损坏的每日存档不抛错且状态归零',
    bad.game.getDailyState().cleared === false);
  assert('损坏存档产生可读提示', String(bad.game.takeWarning() || '').indexOf('损坏') >= 0);
}
{
  // 清除进度：删除新增键并复位内存态；starshield_setup（历史键）不受管理
  const s = createSandbox({ starshield_setup: JSON.stringify([{ x: 1 }]) });
  const g = s.game;
  g.startGame({ mode: 'challenge', levelIndex: 0 });
  g.state.timeScale = 1;
  winCurrentLevel(g.state);
  g.clearAllProgress();
  assert('清除进度删除挑战 / 任务 / 记录 / 每日 4 个新键',
    s.ls.getItem('starshield_challenge') === null
    && s.ls.getItem('starshield_tasks') === null
    && s.ls.getItem('starshield_records') === null
    && s.ls.getItem('starshield_daily') === null);
  assert('清除进度复位内存态（挑战进度 / 任务 / 记录）',
    g.getChallengeUnlocked() === 0 && g.getTasksDoneCount() === 0
    && g.getRecord('challenge', 0) === null);
  assert('布防存档键仍不属于游戏管理范围', s.ls.getItem('starshield_setup') !== null);
}
{
  // 第四章解锁门槛：前 30 关不看星数，第 31 关起需要累计星星达标。
  // 注意：旧进度迁移会给每个已通关卡补 1 星，因此"通关 30 关"的存档自然有 30 星，
  // 仍低于门槛（40）→ 需要回玩拿到 2-3 星才能开启第四章（这正是"目标感"的设计意图）。
  const justCleared = createSandbox({ starshield_campaign_unlocked: '30' });
  assert('前 30 关解锁语义不变（不因星数被锁）',
    justCleared.game.isLevelUnlocked(29) === true);
  assert('旧进度迁移按每关 1 星补齐', justCleared.game.getTotalStars() === 30,
    'stars=' + justCleared.game.getTotalStars());
  assert('第四章需累计星星达标（通关 30 关但仅 30 星 → 未解锁）',
    justCleared.game.isLevelUnlocked(30) === false);
  assert('第四章门槛可被查询且为正数', justCleared.game.getCh4StarGate() > 0);

  // 同一份进度 + 回玩拿到足够星数 → 第四章开启（门槛只对新增关卡生效）
  const starTable30 = {};
  for (let i = 0; i < 30; i++) starTable30[i] = i < 10 ? 3 : 1;   // 10 关满星 + 20 关 1 星 = 50 星
  const gated = createSandbox({
    starshield_campaign_unlocked: '30',
    starshield_stars: JSON.stringify(starTable30),
  });
  assert('累计星星达标后第四章开启', gated.game.getTotalStars() >= gated.game.getCh4StarGate()
    && gated.game.isLevelUnlocked(30) === true,
    'stars=' + gated.game.getTotalStars());

  // 构造一份"已通关 40 关 + 星数达标"的存档
  const starTable = {};
  for (let i = 0; i < 40; i++) starTable[i] = 3;
  const enough = createSandbox({
    starshield_campaign_unlocked: '40',
    starshield_stars: JSON.stringify(starTable),
  });
  assert('累计星星达标后第四章解锁', enough.game.isLevelUnlocked(30) === true);
  assert('星数达标后总星数与满星上限一致',
    enough.game.getTotalStars() === enough.game.totalStarsMax()
    && enough.game.totalStarsMax() === 120);
}
{
  // 单机自查：源码不得含任何网络请求 API
  const files = ['js/physics.js', 'js/predictor.js', 'js/predictorRenderer.js', 'js/audio.js',
    'js/render.js', 'js/levels-campaign.js', 'js/game.js', 'js/input.js'];
  const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/;
  const offenders = files.filter(f => netRe.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert('纯单机自查：全部模块无网络请求 API', offenders.length === 0, offenders.join(','));
}

/* ============ I. UI 渲染（菜单卡片 / 预告胶囊 / 结算行） ============ */
console.log('--- I. UI 渲染路径 ---');
{
  const ui = createSandbox({ starshield_campaign_unlocked: '40' }, { withInput: true });
  const g = ui.game;
  const cardHtml = () => ui.createdEls.filter(e => /level-card/.test(e.className))
    .map(e => e.innerHTML).join('\n');

  // 挑战模式关卡列表：修饰符标签 + 额外任务 + 星级行
  ui.createdEls.length = 0;
  ui.sandbox.window.__syncMenuSelection('challenge', 0);
  const chCards = cardHtml();
  assert('挑战关卡卡片渲染修饰符标签', /mod-chip/.test(chCards));
  assert('挑战关卡卡片渲染额外任务徽章', /lc-task/.test(chCards));
  assert('挑战关卡卡片保留纯文本简介（lc-desc 不含标签）',
    /<div class="lc-desc">[^<]*<\/div>/.test(chCards));
  assert('挑战关卡标题展示挑战进度与挑战星数',
    /挑战关卡/.test(ui.el('levelTitle').textContent)
    && /挑战星数/.test(ui.el('levelTitle').textContent),
    ui.el('levelTitle').textContent);
  assert('挑战模式开始按钮与提示正确',
    /挑战模式/.test(ui.el('startBtn').textContent) && /项修饰符/.test(ui.el('ctaHint').textContent),
    ui.el('startBtn').textContent + ' | ' + ui.el('ctaHint').textContent);

  // 每日挑战：单张卡片
  ui.createdEls.length = 0;
  ui.sandbox.window.__syncMenuSelection('daily', 0);
  assert('每日挑战只渲染一张卡片',
    ui.createdEls.filter(e => /level-card/.test(e.className)).length === 1);
  assert('每日挑战标题展示日期键与当日最高分',
    /每日挑战（\d{8}/.test(ui.el('levelTitle').textContent), ui.el('levelTitle').textContent);

  // 菜单记录行 + 每日卡状态
  ui.sandbox.window.__refreshMenuBest();
  assert('菜单记录行含挑战进度与额外任务数',
    /挑战已通关/.test(ui.el('menuBest').innerHTML) && /额外任务/.test(ui.el('menuBest').innerHTML));
  assert('每日模式卡显示当日状态', ui.el('dailyBest').textContent.length > 0,
    ui.el('dailyBest').textContent);

  // 结算面板：任务行 / 纪录行 / 星级行 / 下一关按钮
  g.startGame({ mode: 'challenge', levelIndex: 0 });
  const st = g.state;
  st.timeScale = 1;
  st.hitCount = 0;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = 40; st.isLastWave = true;
  g.stepFrame(DT);
  assert('挑战模式通关走通完整结算链路（无异常）', st.endReason === 'win');
  assert('结算面板填充额外任务行', /额外任务/.test(ui.el('resultTask').textContent),
    ui.el('resultTask').textContent);
  assert('结算面板填充本关纪录行', /纪录：最佳/.test(ui.el('resultRecord').textContent),
    ui.el('resultRecord').textContent);
  assert('结算面板在挑战模式也展示星级',
    ui.el('resultStars').style.display === '' && g.challengeStarsForLevel(0) === 3);
  assert('结算面板「下一关」按钮对挑战模式可见', ui.el('resultNext').style.display === '');

  // 每日挑战结算：纪录行额外展示"当日"口径（与关卡最佳记录区分）
  ui.sandbox.window.__syncMenuSelection('daily', 0);
  g.startGame({ mode: 'daily', levelIndex: 0 });
  const dst = g.state;
  dst.timeScale = 1;
  dst.wave = Math.min(4, dst.level.waves.length - 1);
  dst.bodies = dst.bodies.filter(b => b.type === 'planet');
  dst.waveActive = true; dst.waveQueue = []; dst.waveElapsed = 40; dst.isLastWave = true;
  g.stepFrame(DT);
  assert('每日挑战结算纪录行含"今日最佳"口径',
    /今日最佳/.test(ui.el('resultRecord').textContent), ui.el('resultRecord').textContent);
  assert('每日模式开始提示含当日最高波数',
    (function () {
      ui.sandbox.window.__syncMenuSelection('survival', 0);      // 先切走
      ui.sandbox.window.__syncMenuSelection('daily', 0);          // 再切回，强制重渲染
      return /波/.test(ui.el('ctaHint').textContent) && /当日最高/.test(ui.el('ctaHint').textContent);
    })(), ui.el('ctaHint').textContent);

  // 生存模式不受影响：预告不可用、无修饰符
  ui.sandbox.window.__syncMenuSelection('survival', 0);
  g.startGame({ mode: 'survival', levelIndex: 0 });
  assert('生存模式：无预告且无修饰符',
    g.getWavePreview().available === false && g.state.modifiers.length === 0);
}

console.log(ok ? '\n=== v1.10 内容扩展（第四章/挑战/每日/任务/预告/记录/UI）测试全部通过 ==='
               : '\n=== 内容扩展测试存在失败 ===');
process.exit(ok ? 0 : 1);
