// v1.11 叙事收束与成就扩展测试套件
//   A. 内容层结局文案：CHAPTERS[3].ending 与 window.STORY（隐藏关结语 / 完美星图）齐备，
//      且**关卡对象未被注入新字段**（保住 test/fixtures/campaign-v1.11.json 的逐字段精确比对）
//   B. 结局触发口径：仅闯关模式的第 40 关与两个隐藏关在通关时给文案；挑战/每日/失败/普通关均无
//   C. 成就清单：数量、唯一性、name/desc/need 齐备、star_all 文案已修正为动态满星数、
//      被既有断言点名的 id 必须保留
//   D. 新成就判定：逐项构造场景验证（专精 / 协同 / 每日 / 隐藏关 / 任务全清 / 无尽 / 挑战 / 完美）
//   E. 幂等与存档兼容：重复判定不重复解锁；未知 id 被忽略、已知（含新增）id 保留
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

// ---- 沙箱工厂（与 content-ext.test.js 同构：IIFE 挂在 window 上，需显式桥接）----
function createSandbox(preload) {
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
      classList: { add() {}, remove() {}, contains() { return false; } },   // 注意：stub 无 toggle
      appendChild() {}, addEventListener() {}, remove() {},
      getContext: () => ctx2d(),
      querySelectorAll: () => [], querySelector: () => null,
    };
  }
  const elCache = {};
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
      createElement: () => stubEl(),
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
  load('js/game.js');
  sandbox.physics = sandbox.window.physics;
  sandbox.predictor = sandbox.window.predictor;
  sandbox.audio = sandbox.window.audio;
  sandbox.render = sandbox.window.render;
  sandbox.game = sandbox.window.game;
  return { sandbox, game: sandbox.window.game, window: sandbox.window, ls: sandbox.localStorage };
}

const main = createSandbox();
const game = main.game;
const DT = 1 / 60;

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}
function unlockedIds(g) { return g.getAchievementList().filter(a => a.unlocked).map(a => a.id); }
// 直接构造一次"通关"结算（不依赖物理跑完整局；与 content-ext.test.js 的同一手法）
// 注意：必须传入当前沙箱的 game 实例——每个 createSandbox 都是独立的 vm 上下文，
// 用模块级的 game 会驱动错误的沙箱（症状：endReason 永远为空）。
function winCurrentLevel(g, st) {
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true;
  st.waveQueue = [];
  st.waveElapsed = 40;
  st.isLastWave = true;
  g.stepFrame(DT);
  return st.endReason;
}
// 满星（40 个常规关各 3 星 = 120）存档，用于解锁隐藏关 1
function fullStars() {
  const t = {};
  for (let i = 0; i < 40; i++) t[String(i)] = 3;
  return JSON.stringify(t);
}
// 40 个常规关额外任务全清存档，用于解锁隐藏关 2
function allTasks() {
  const t = {};
  for (let i = 0; i < 40; i++) t['campaign:' + i] = true;
  return JSON.stringify(t);
}

/* ============ A. 内容层结局文案 ============ */
console.log('--- A. 内容层结局文案 ---');
{
  const ch = main.window.CHAPTERS;
  assert('第四章含结局文案（title + text，长度达标）',
    !!ch[3] && !!ch[3].ending && typeof ch[3].ending.title === 'string'
    && typeof ch[3].ending.text === 'string' && ch[3].ending.text.length > 20,
    ch[3] && ch[3].ending ? ch[3].ending.title : 'missing');
  assert('前三章不含结局文案（只有章首 story）',
    ch.slice(0, 3).every(c => !c.ending));
  const story = main.window.STORY;
  assert('STORY 导出隐藏关结语与完美星图文案',
    !!story && !!story.hidden && !!story.perfect
    && typeof story.perfect.title === 'string' && story.perfect.text.length > 20);
  assert('两个隐藏关各有专属结语',
    !!story.hidden['hidden-1'] && !!story.hidden['hidden-2']
    && story.hidden['hidden-1'].text.length > 20 && story.hidden['hidden-2'].text.length > 20);
  // 关键：结局文案不得写进关卡对象（否则击穿 fixture 逐字段比对）
  const levels = game.CAMPAIGN_LEVELS;
  assert('关卡对象未被注入结局/any 新字段（fixture 精确比对的前提）',
    levels.every(l => !Object.prototype.hasOwnProperty.call(l, 'ending')
      && !Object.prototype.hasOwnProperty.call(l, 'outro')));
}

/* ============ B. 结局触发口径 ============ */
console.log('--- B. 结局触发口径 ---');
{
  // 1) 普通关（第 1 关）通关：无结局文案
  const a = createSandbox({ starshield_campaign_unlocked: '40' });
  a.game.startGame({ mode: 'campaign', levelIndex: 0 });
  a.game.state.timeScale = 1;
  winCurrentLevel(a.game, a.game.state);
  assert('普通关通关不给结局文案', a.game.state.lastEnding === null,
    JSON.stringify(a.game.state.lastEnding));
  assert('普通关结算统计 ending 为空串', a.game.getCurrentRunStats().ending === '');
  // 新一局开局必须复位（否则上一局结局会残留到新一局结算）
  a.game.startGame({ mode: 'campaign', levelIndex: 1 });
  assert('开局复位 lastEnding', a.game.state.lastEnding === null);
}
{
  // 2) 第 40 关（第四章终关）通关：给第四章结局
  const b = createSandbox({ starshield_campaign_unlocked: '40', starshield_stars: fullStars() });
  b.game.startGame({ mode: 'campaign', levelIndex: 39 });
  b.game.state.timeScale = 1;
  winCurrentLevel(b.game, b.game.state);
  const e = b.game.state.lastEnding;
  assert('第 40 关通关给第四章结局（id=ch4）', !!e && e.id === 'ch4' && e.title && e.text,
    JSON.stringify(e && e.id));
}
{
  // 3) 挑战模式通关同一关：不播剧情（避免同一段剧情讲两遍）
  const c = createSandbox({ starshield_challenge: JSON.stringify({ unlocked: 40 }) });
  c.game.startGame({ mode: 'challenge', levelIndex: 39 });
  c.game.state.timeScale = 1;
  winCurrentLevel(c.game, c.game.state);
  assert('挑战模式不播结局剧情', c.game.state.lastEnding === null);
}
{
  // 4) 每日挑战通关：不播剧情
  const d = createSandbox();
  d.game.startGame({ mode: 'daily', levelIndex: 0 });
  d.game.state.timeScale = 1;
  winCurrentLevel(d.game, d.game.state);
  assert('每日挑战不播结局剧情', d.game.state.lastEnding === null);
}
{
  // 5) 隐藏关 1 通关：专属结语
  const e = createSandbox({ starshield_campaign_unlocked: '40', starshield_stars: fullStars() });
  e.game.startGame({ mode: 'campaign', levelIndex: 40 });
  e.game.state.timeScale = 1;
  assert('隐藏关 1 可开局（累计星数 120 ≥ 门槛）', e.game.state.gameStarted === true);
  winCurrentLevel(e.game, e.game.state);
  const nd = e.game.state.lastEnding;
  assert('隐藏关 1 通关给专属结语（id=hidden-1）',
    !!nd && nd.id === 'hidden-1' && nd.text === e.window.STORY.hidden['hidden-1'].text);
  assert('隐藏关不计星（lastStars=0）', e.game.state.lastStars === 0);
}
{
  // 6) 失败结算：无结局文案
  const f = createSandbox({ starshield_campaign_unlocked: '40' });
  f.game.startGame({ mode: 'campaign', levelIndex: 0 });
  f.game.state.timeScale = 1;
  f.game.state.health = 0;
  f.game.state.endReason = 'defeat';
  assert('失败时 getRunEnding 为空', f.game.getRunEnding() === null);
}

/* ============ C. 成就清单与文案 ============ */
console.log('--- C. 成就清单与文案 ---');
{
  const list = game.getAchievementList();
  const ids = list.map(a => a.id);
  assert('成就数量已扩展到 26 项', list.length === 26, 'n=' + list.length);
  assert('成就 id 唯一', new Set(ids).size === ids.length);
  assert('每项成就含名称与描述', list.every(a => a.name && a.desc));
  assert('每项均带判定函数', game.ACHIEVEMENTS.every(a => typeof a.need === 'function'));
  // 被既有断言点名的 id 必须保留（改名会丢玩家进度，也会击穿 progression.test.js）
  const must = ['clear_50', 'first_win', 'no_hit_win', 'thrifty'];
  assert('既有被点名的成就 id 全部保留', must.every(id => ids.indexOf(id) >= 0),
    must.filter(id => ids.indexOf(id) < 0).join(','));
  // 文案与实战一致：star_all 判定用 totalStarsMax()（120），文案不得再写 90
  const starAll = list.filter(a => a.id === 'star_all')[0];
  assert('star_all 文案与实战一致（含 120 且不含 90）',
    starAll && starAll.desc.indexOf('120') >= 0 && starAll.desc.indexOf('90') < 0,
    starAll && starAll.desc);
  const newIds = ['spec_giant_5', 'spec_switch_3', 'synergy_30', 'synergy_40', 'daily_first',
    'daily_streak_3', 'hidden_clear', 'hidden_all', 'task_all', 'endless_30', 'challenge_10', 'perfect'];
  assert('v1.11 新增 12 项成就全部就位', newIds.every(id => ids.indexOf(id) >= 0),
    newIds.filter(id => ids.indexOf(id) < 0).join(','));
}

/* ============ D. 新成就判定 ============ */
console.log('--- D. 新成就判定 ---');
{
  // 专精：单局放置 5 颗「巨型」
  const s = createSandbox();
  s.game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = s.game.state;
  st.budget = 99999;
  const p = st.bodies[0];
  let placed = 0;
  for (let i = 0; i < 5; i++) {
    const r = s.game.placeStar('small', { x: p.x + (i - 2) * 40, y: p.y - 160 }, { spec: 'giant' });
    if (r.ok) placed++;
  }
  assert('巨型专精可放置 5 颗', placed === 5, 'placed=' + placed);
  assert('统计暴露 specGiantPlaced=5', s.game.getCurrentRunStats().specGiantPlaced === 5,
    'n=' + s.game.getCurrentRunStats().specGiantPlaced);
  s.game.evaluateAchievements();
  assert('达成「巨石匠」（spec_giant_5）', unlockedIds(s.game).indexOf('spec_giant_5') >= 0);
}
{
  // 专精互转：3 次 → 变形者
  const s = createSandbox();
  s.game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = s.game.state;
  st.budget = 99999;
  const p = st.bodies[0];
  s.game.placeStar('large', { x: p.x, y: p.y - 170 }, { spec: 'gravity' });
  const body = st.bodies[st.bodies.length - 1];
  s.game.switchSpec(body, 'giant');
  s.game.switchSpec(body, 'gravity');
  s.game.switchSpec(body, 'giant');
  assert('专精互转次数被累计（3 次）', s.game.getCurrentRunStats().specSwitches === 3,
    'n=' + s.game.getCurrentRunStats().specSwitches);
  s.game.evaluateAchievements();
  assert('达成「变形者」（spec_switch_3）', unlockedIds(s.game).indexOf('spec_switch_3') >= 0);
}
{
  // 协同（互邻上限）：7 颗互为邻居 → 每颗 +5% × 6 = 30%（互邻部分上限）。
  // 间距取舍：小行星半径 9（直径 18）→ 间距必须 > 18 才不会在物理步进里互撞双毁；
  // 同时任意两颗距离必须 ≤ SYNERGY_RADIUS(150) 才计入互邻 → 取间距 24、总跨度 144 同时满足。
  const s = createSandbox();
  s.game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = s.game.state;
  st.budget = 99999;
  const p = st.bodies[0];
  const cx = p.x, cy = p.y - 220;
  let placed = 0;
  for (let i = 0; i < 7; i++) {
    if (s.game.placeStar('small', { x: cx + (i - 3) * 24, y: cy }, { spec: 'gravity' }).ok) placed++;
  }
  assert('7 颗小行星全部放置成功', placed === 7, 'placed=' + placed);
  s.game.stepFrame(DT);                       // 协同在物理步进内写回 body.synergyBonus
  const b30 = s.game.getCurrentRunStats().synergyMaxBonus;
  assert('7 颗相邻星体的协同加成达 30%（互邻部分上限）', b30 >= 0.30 - 1e-9, 'bonus=' + b30);
  assert('未借力场景机关时不超过 30%', b30 <= 0.30 + 1e-9, 'bonus=' + b30);
  s.game.evaluateAchievements();
  assert('达成「引力共振」（synergy_30）', unlockedIds(s.game).indexOf('synergy_30') >= 0);

  // 借力场景机关（伴星）+10% → 打满总上限 40%
  const s2 = createSandbox();
  s2.game.startGame({ mode: 'survival', levelIndex: 0 });
  const st2 = s2.game.state;
  st2.budget = 99999;
  const p2 = st2.bodies[0];
  const cx2 = p2.x, cy2 = p2.y - 220;
  st2.bodies.push({ type: 'companion', mass: 600, radius: 12, x: cx2, y: cy2 - 30, vx: 0, vy: 0 });
  for (let i = 0; i < 7; i++) {
    s2.game.placeStar('small', { x: cx2 + (i - 3) * 24, y: cy2 }, { spec: 'gravity' });
  }
  s2.game.stepFrame(DT);
  const b40 = s2.game.getCurrentRunStats().synergyMaxBonus;
  assert('邻接 + 借力 → 协同打满 40% 总上限', b40 >= 0.40 - 1e-9 && b40 <= 0.40 + 1e-9, 'bonus=' + b40);
  s2.game.evaluateAchievements();
  assert('达成「满格共振」（synergy_40）', unlockedIds(s2.game).indexOf('synergy_40') >= 0);
}
{
  // 每日挑战：首次通关 + 连胜推进到 3 天
  // 场景：昨天已通关（连胜 2 天）→ 今天再通关 → 连胜 3 天 → 达成「三日不辍」。
  const ymd = (d) => {
    const m = d.getMonth() + 1, day = d.getDate();
    return String(d.getFullYear()) + (m < 10 ? '0' + m : m) + (day < 10 ? '0' + day : day);
  };
  const now = new Date();
  const todayKey = ymd(now);
  const yest = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const s = createSandbox({
    starshield_daily: JSON.stringify({ date: todayKey, cleared: false, bestScore: 0, bestWave: 0,
      streak: 2, lastCleared: yest, clearedTotal: 5 }),
  });
  assert('跨日把连胜元数据读入内存（连胜 2 天）', s.game.getDailyStreak() === 2,
    'streak=' + s.game.getDailyStreak());
  s.game.startGame({ mode: 'daily', levelIndex: 0 });
  s.game.state.timeScale = 1;
  winCurrentLevel(s.game, s.game.state);
  const ids = unlockedIds(s.game);
  assert('达成「今日之星」（daily_first）', ids.indexOf('daily_first') >= 0);
  const dstate = s.game.getDailyState();
  assert('昨日已通关 → 今日通关使连胜推进到 3 天', dstate.streak === 3, 'streak=' + dstate.streak);
  assert('累计通关天数 +1', dstate.clearedTotal === 6, 'total=' + dstate.clearedTotal);
  assert('达成「三日不辍」（daily_streak_3）', ids.indexOf('daily_streak_3') >= 0);
}
{
  // 连胜中断：上次通关是 5 天前（有断档）→ 今日通关应把连胜重置为 1
  const ymd = (d) => {
    const m = d.getMonth() + 1, day = d.getDate();
    return String(d.getFullYear()) + (m < 10 ? '0' + m : m) + (day < 10 ? '0' + day : day);
  };
  const now = new Date();
  const gap = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5));
  const s = createSandbox({
    starshield_daily: JSON.stringify({ streak: 5, lastCleared: gap, clearedTotal: 9 }),
  });
  s.game.startGame({ mode: 'daily', levelIndex: 0 });
  s.game.state.timeScale = 1;
  winCurrentLevel(s.game, s.game.state);
  assert('断档后通关：连胜重置为 1（不累积）', s.game.getDailyState().streak === 1,
    'streak=' + s.game.getDailyState().streak);
  assert('累计通关天数仍 +1', s.game.getDailyState().clearedTotal === 10,
    'total=' + s.game.getDailyState().clearedTotal);
}
{
  // 每日连胜：同一天重复通关不重复计数（幂等）
  const s = createSandbox();
  s.game.startGame({ mode: 'daily', levelIndex: 0 });
  s.game.state.timeScale = 1;
  winCurrentLevel(s.game, s.game.state);
  const st1 = s.game.getDailyState();
  s.game.startGame({ mode: 'daily', levelIndex: 0 });
  s.game.state.timeScale = 1;
  winCurrentLevel(s.game, s.game.state);
  const st2 = s.game.getDailyState();
  assert('同一天重复通关：连胜仍为 1（不刷连胜）', st1.streak === 1 && st2.streak === 1,
    's1=' + st1.streak + ' s2=' + st2.streak);
  assert('累计通关天数只记一次', st1.clearedTotal === 1 && st2.clearedTotal === 1,
    'c1=' + st1.clearedTotal + ' c2=' + st2.clearedTotal);
}
{
  // 隐藏关：通关 1 个 → 密道探索者；两个都通关 → 星图尽头
  const s = createSandbox({
    starshield_campaign_unlocked: '40',
    starshield_stars: fullStars(),
    starshield_tasks: allTasks(),
  });
  s.game.startGame({ mode: 'campaign', levelIndex: 40 });
  s.game.state.timeScale = 1;
  winCurrentLevel(s.game, s.game.state);
  assert('通关隐藏关 1 后计数为 1', s.game.getHiddenClearedCount() === 1,
    'n=' + s.game.getHiddenClearedCount());
  assert('达成「密道探索者」（hidden_clear）', unlockedIds(s.game).indexOf('hidden_clear') >= 0);
  assert('尚未达成「星图尽头」（还差隐藏关 2）', unlockedIds(s.game).indexOf('hidden_all') < 0);
  s.game.startGame({ mode: 'campaign', levelIndex: 41 });
  s.game.state.timeScale = 1;
  winCurrentLevel(s.game, s.game.state);
  assert('两个隐藏关通关后计数为 2', s.game.getHiddenClearedCount() === 2);
  assert('达成「星图尽头」（hidden_all）', unlockedIds(s.game).indexOf('hidden_all') >= 0);
}
{
  // 任务全清（40 项）
  const s = createSandbox({ starshield_tasks: allTasks() });
  assert('任务存档读到 40 项', s.game.getTasksDoneCount() === 40, 'n=' + s.game.getTasksDoneCount());
  s.game.evaluateAchievements({ mode: 'survival', endReason: 'defeat' });
  assert('达成「使命必达」（task_all）', unlockedIds(s.game).indexOf('task_all') >= 0);
}
{
  // 无尽风暴：坚守 30 波
  const s = createSandbox();
  s.game.startGame({ mode: 'endless', levelIndex: 0 });
  s.game.state.timeScale = 1;
  s.game.state.wave = 29;
  s.game.evaluateAchievements();
  assert('第 29 波未达成（endless_30 需 30 波）', unlockedIds(s.game).indexOf('endless_30') < 0);
  s.game.state.wave = 30;
  s.game.evaluateAchievements();
  assert('达成「风暴幸存者」（endless_30）', unlockedIds(s.game).indexOf('endless_30') >= 0);
}
{
  // 挑战进度：通关 10 关
  const s = createSandbox({ starshield_challenge: JSON.stringify({ unlocked: 10 }) });
  s.game.evaluateAchievements({ mode: 'challenge', endReason: 'defeat' });
  assert('达成「挑战者」（challenge_10）', unlockedIds(s.game).indexOf('challenge_10') >= 0);
}
{
  // 完美星图：120 星 + 40 任务 + 2 隐藏关全清
  const s = createSandbox({
    starshield_stars: fullStars(),
    starshield_tasks: allTasks(),
    starshield_records: JSON.stringify({
      'campaign:40': { bestScore: 10, leastHits: 0, fastestWin: 60, won: true, plays: 1 },
      'campaign:41': { bestScore: 10, leastHits: 0, fastestWin: 60, won: true, plays: 1 },
    }),
  });
  const partial = createSandbox({
    starshield_stars: fullStars(),
    starshield_tasks: allTasks(),
  });
  assert('未通关隐藏关时不算完美收集', partial.game.isPerfectCollected() === false);
  assert('完美收集判定为真', s.game.isPerfectCollected() === true);
  s.game.evaluateAchievements({ mode: 'campaign', endReason: 'win' });
  assert('达成「完美星图」（perfect）', unlockedIds(s.game).indexOf('perfect') >= 0);
  assert('完美星图文案可读且非空', !!s.game.getPerfectStory() && s.game.getPerfectStory().text.length > 20);
}

/* ============ E. 幂等与存档兼容 ============ */
console.log('--- E. 幂等与存档兼容 ---');
{
  const s = createSandbox({ starshield_tasks: allTasks() });
  const stats = { mode: 'survival', endReason: 'defeat' };
  const first = s.game.evaluateAchievements(stats);
  const second = s.game.evaluateAchievements(stats);
  assert('首次判定有新解锁', first.unlocked.length > 0, 'n=' + first.unlocked.length);
  assert('重复判定不再重复解锁（幂等）', second.unlocked.length === 0);
  assert('已解锁数量保持一致', second.count === first.count);
  const pending = s.game.takeNewAchievements();
  assert('新解锁队列可一次性取走并随后清空',
    pending.length > 0 && s.game.takeNewAchievements().length === 0);
}
{
  // 存档兼容：未知 id 丢弃、既有 id（含 v1.11 新增）保留
  const s = createSandbox({
    starshield_achievements: JSON.stringify({ first_win: 123, spec_giant_5: 456, unknown_key: 1 }),
  });
  const list = s.game.getAchievementList();
  const find = (id) => list.filter(a => a.id === id)[0];
  assert('已知既有 id 往返读取', find('first_win').unlocked === true);
  assert('v1.11 新增 id 往返读取（不丢新成就进度）', find('spec_giant_5').unlocked === true);
  assert('未知 id 被忽略', list.every(a => a.id !== 'unknown_key'));
}

console.log(ok ? '\n=== v1.11 结局文案与成就扩展测试全部通过 ==='
               : '\n=== v1.11 结局/成就测试存在失败 ===');
process.exit(ok ? 0 : 1);
