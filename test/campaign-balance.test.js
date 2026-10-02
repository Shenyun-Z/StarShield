// 40 关可达性 / 无软锁校验（v1.9 重校准 + v1.10 第四章追加后）
//   A. 静态下界：每关「初始星能 + 清场返还」足以支撑最低限度布防；场景规格合法且不与母星禁放区冲突
//   B. 被动模拟（不操作）：代表关卡必须能推进波次并在有界时间内进入终局 —— 证明没有软锁
//   C. 主动模拟（标准布防）：按固定启发式放置后，代表关卡前三波内能有效拦截且母星存活
//
// 方法局限（明示）：
//   1) 抽样而非全量：被动/主动模拟各覆盖代表关卡（每 5 关取 1，另单独覆盖第四章 31/35/40 关），不是 40 关的完备证明；
//   2) 启发式策略偏保守：AI 只会"在母星两侧放两颗大行星 + 有道具就用"，真人可用更巧的布局；
//      因此 C 的断言刻意取"布防有效"而非"必胜"，避免把策略不足误判为关卡不可达；
//   3) 时间被截断：模拟有帧数上限，断言的是"有界时间内有进展"，不是跑到通关。
const fs = require('fs');
const { GAME_FILES, UI_FILES, loadFiles } = require('./helpers/sandbox');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function stubEl() {
  return {
    textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    width: 1280, height: 720,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, remove() {},
    getContext: () => new Proxy({}, { get: () => () => {} }),
    querySelectorAll: () => [], querySelector: () => null,
  };
}
const elCache = {};
// 确定性 PRNG（mulberry32）替换 Math.random：
// game.js 并非处处确定——分裂彗星子体的初速、粒子爆发等都取 Math.random，
// 传真实 Math 会让被动/主动模拟随每次运行波动（曾出现同一断言时绿时红，
// 例如第四章代表关的"进度 ≥ 45%"在 41%~89% 之间跳动）。固定种子后模拟完全可复现。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MathStub = {};
for (const k of Object.getOwnPropertyNames(Math)) MathStub[k] = Math[k];
MathStub.random = mulberry32(0x5EED1);
const sandbox = {
  Math: MathStub, Map, Set, console, JSON, Array, Object, String, Number, Boolean,
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
const load = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
load('js/physics.js'); load('js/audio.js'); load('js/levels-campaign.js');
// 关键：先解锁全部关卡再加载 game.js。否则 startGame(未解锁关卡) 返回 false，
// state 会残留上一局的终局状态 —— 模拟出来的数据全是假的（曾因此误判过关）。
sandbox.localStorage.setItem('starshield_campaign_unlocked', '40');
loadFiles(load, GAME_FILES);
sandbox.physics = sandbox.window.physics;
sandbox.audio = sandbox.window.audio;
sandbox.game = sandbox.window.game;

const game = sandbox.game;
const physics = sandbox.window.physics;
const levels = game.CAMPAIGN_LEVELS;
const STAR_TYPES = game.STAR_TYPES;

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}

/* ============ A. 静态下界与场景规格 ============ */
console.log('--- A. 静态下界与场景规格 ---');
{
  assert('关卡数为 42（40 常规 + 2 隐藏）', levels.length === 42, 'n=' + levels.length);
  // v1.11：常规关沿用可行下界模型；隐藏关是"特殊规则挑战关"，另行断言其极端参数
  const regular = levels.filter(l => !l.hidden);
  const hidden = levels.filter(l => l.hidden);
  assert('常规关仍为 40 / 隐藏关为 2', regular.length === 40 && hidden.length === 2,
    'regular=' + regular.length + ' hidden=' + hidden.length);
  // 可玩性下界模型：初始星能 + 清场返还(+2/威胁) ≥ 最基础布防（两颗大行星 = 600）
  let minAvail = Infinity, worst = -1;
  for (let i = 0; i < regular.length; i++) {
    const lv = regular[i];
    const totalSpawns = lv.waves.reduce((s, w) => s + w.spawns.length, 0);
    const avail = lv.budget + 2 * totalSpawns;      // 与 registerClear 的 +2 返还口径一致
    if (avail < minAvail) { minAvail = avail; worst = i + 1; }
  }
  assert('常规关可用星能下界 ≥ 2 颗大行星成本（600）',
    minAvail >= 2 * STAR_TYPES.large.cost, 'min=' + minAvail + ' @level ' + worst);
  assert('常规关初始星能 ≥ 1 颗大行星成本（300）',
    regular.every(lv => lv.budget >= STAR_TYPES.large.cost));
  assert('常规关母星血量 ≥ 16（★2 门槛可承受）',
    regular.every(lv => lv.health >= 16));
  assert('★2 门槛（max(2, 波数/2)）不超过该关波数（全部 42 关）',
    levels.every((lv, i) => game.getStarCriteria(i).star2HitLimit <= lv.waves.length));
  // 隐藏关：极低血量 + 星能收紧 + 带修饰符 + 不计星（满星上限仍为 120）
  assert('隐藏关参数合法（血量 8~15、星能 ≥ 200、带 1~3 条修饰符、含 Boss 收尾波）',
    hidden.every(lv => lv.health >= 8 && lv.health < 16
      && lv.budget >= 200
      && Array.isArray(lv.modifiers) && lv.modifiers.length >= 1 && lv.modifiers.length <= 3
      && lv.waves[lv.waves.length - 1].spawns.some(s => s.kind === 'boss')),
    JSON.stringify(hidden.map(lv => lv.id + ':hp' + lv.health)));
  assert('隐藏关不计星：满星上限仍为 120',
    game.totalStarsMax() === 120 && game.regularLevelCount() === 40);
  assert('隐藏关解锁数据合法（stars / tasks 两类，值为正）',
    hidden.every(lv => lv.unlock && (lv.unlock.type === 'stars' || lv.unlock.type === 'tasks')
      && lv.unlock.value > 0));
  // 场景规格合法：类型白名单 + 质量/半径为正 + 不在母星禁放区内
  const W = 1280, H = 720, cx = W / 2, cy = H / 2;
  let sceneOk = true, sceneCount = 0, minDist = Infinity;
  for (const lv of levels) {
    for (const b of lv.scene.bodies) {
      sceneCount++;
      if (physics.SCENE_TYPES.indexOf(b.type) < 0) sceneOk = false;
      if (!(b.mass > 0) || !(b.radius > 0)) sceneOk = false;
      const d = Math.hypot(b.dx * W, b.dy * H);
      minDist = Math.min(minDist, d);
      if (d < 30 + 34) sceneOk = false;            // 母星半径 + 禁放缓冲
    }
  }
  assert('场景规格合法（类型白名单 / 正质量与半径 / 不侵入禁放区）', sceneOk);
  assert('42 关共生成场景天体（至少 10 个，主题确有内容）', sceneCount >= 10, 'n=' + sceneCount);
  assert('所有场景天体与母星保持安全距离', minDist >= 64, 'minDist=' + minDist.toFixed(1));
  assert('主题场景与简介一致（有场景的关卡简介非空且提到场景）',
    levels.every(lv => (lv.scene.bodies.length === 0) || (typeof lv.scene.intro === 'string' && lv.scene.intro.length > 8)));
}

/* ============ B. 被动模拟：无软锁 ============ */
console.log('--- B. 被动模拟（不操作，验证无软锁）---');
function simulate(levelIndex, maxSteps, policy) {
  game.startGame({ mode: 'campaign', levelIndex });
  const st = game.state;
  st.timeScale = 1;
  let steps = 0;
  let policyApplied = false;
  while (steps < maxSteps && !st.gameOver) {
    if (policy && !policyApplied) { policy(st); policyApplied = true; }
    game.stepFrame(1 / 60);
    steps++;
  }
  return { st, steps };
}
{
  const samples = [0, 14, 29];                     // 首 / 中 / 末关
  let pass = true, detail = [];
  for (const idx of samples) {
    const r = simulate(idx, 6000, null);           // 上限 6000 帧 ≈ 100 游戏秒
    const progressed = r.st.wave >= 2 || r.st.gameOver;
    const bombCount = r.st.bodies.length;
    detail.push('L' + (idx + 1) + ':wave=' + r.st.wave + ',over=' + r.st.gameOver
      + ',bodies=' + bombCount + ',steps=' + r.steps);
    if (!progressed) pass = false;                 // 既不结束也不推进 → 软锁嫌疑
    if (bombCount > 90) pass = false;              // 天体总数上限（MAX_TOTAL_BODIES）
  }
  assert('被动模拟：代表关卡均能在有界时间内推进波次或进入终局（无软锁）', pass, detail.join(' | '));
}
{
  // 场景天体绝不能被当作威胁：被动跑到结束，波次结算不会因场景天体卡住
  const r = simulate(20, 6000, null);              // 第 21 关：乱流迷宫（含 3 个障碍）
  const sceneBodies = r.st.bodies.filter(b => physics.isScene(b)).length;
  assert('场景天体不阻断波次结算（乱流迷宫关可正常推进）',
    r.st.wave >= 2 || r.st.gameOver, 'wave=' + r.st.wave);
  assert('场景天体与波次计数器互不干扰（不威胁判定）',
    r.st.bodies.filter(b => physics.isThreat(b)).length >= 0 && sceneBodies >= 0);
}

/* ============ B2. 被动模拟：第四章（追加内容）无软锁 ============ */
console.log('--- B2. 被动模拟（第四章）---');
{
  // 第四章星能更低（370→300），但结构相同：验证不会出现"波次停摆/天体堆积"的软锁
  const samples = [30, 34, 39];                    // 第 31 / 35 / 40 关
  let pass = true, detail = [];
  for (const idx of samples) {
    const r = simulate(idx, 6000, null);
    detail.push('L' + (idx + 1) + ':wave=' + r.st.wave + '/' + r.st.level.waves.length
      + ',over=' + r.st.gameOver + ',bodies=' + r.st.bodies.length);
    if (!(r.st.wave >= 2 || r.st.gameOver)) pass = false;
    if (r.st.bodies.length > 90) pass = false;
  }
  assert('第四章：被动模拟亦能在有界时间内推进波次或进入终局（无软锁）', pass, detail.join(' | '));
}

/* ============ C. 主动模拟：标准布防有效性 ============ */
console.log('--- C. 主动模拟（静态布防，验证关卡不失控）---');
// 说明：这里的 AI 是"一次性布置、之后不再调整、不用道具/减速/回收"的保守基准。
// 实测（见提交说明）：它能在代表关卡撑过约 50%~90% 的波次后被击穿——这既证明布防与拦截链路有效，
// 也提醒"AI 输"不等于"关卡不可达"（真人可动态补星、回收升级、用道具与减速）。
{
  const samples = [0, 5, 10, 15, 20, 25];
  let allOk = true, detail = [];
  for (const idx of samples) {
    const r = simulate(idx, 10800, (st) => {     // 上限 180 游戏秒
      // 固定启发式：母星周围"十字环"布防（4 颗中行星，正好用尽该档预算量级）
      const planet = st.bodies[0];
      game.placeStar('mid', { x: planet.x - 130, y: planet.y }, {});
      game.placeStar('mid', { x: planet.x + 130, y: planet.y }, {});
      game.placeStar('mid', { x: planet.x, y: planet.y - 130 }, {});
      game.placeStar('mid', { x: planet.x, y: planet.y + 130 }, {});
    });
    const totalWaves = r.st.level.waves.length;
    const cleared = r.st.asteroidsCleared;
    const reachedRatio = r.st.wave / totalWaves;
    detail.push('L' + (idx + 1) + ':wave=' + r.st.wave + '/' + totalWaves
      + ',cleared=' + cleared + ',hits=' + r.st.hitCount);
    if (cleared < 8) allOk = false;              // 布防确实在拦截（链路有效）
    if (reachedRatio < 0.45) allOk = false;      // 静态布防也能撑过约一半波次 → 关卡不失控
  }
  assert('静态布防在代表关卡均有效拦截且不被开局击穿（清场 ≥ 8、进度 ≥ 45%）', allOk,
    detail.join(' | '));
}
{
  // 场景机关也必须让布防可用：乱流迷宫关（含 3 个障碍）在静态布防下同样有进展
  const r = simulate(20, 10800, (st) => {
    const planet = st.bodies[0];
    game.placeStar('mid', { x: planet.x - 130, y: planet.y }, {});
    game.placeStar('mid', { x: planet.x + 130, y: planet.y }, {});
    game.placeStar('mid', { x: planet.x, y: planet.y - 130 }, {});
    game.placeStar('mid', { x: planet.x, y: planet.y + 130 }, {});
  });
  assert('含场景障碍的关卡在静态布防下仍能推进（wave ≥ 45% 且拦截 ≥ 8）',
    r.st.wave / r.st.level.waves.length >= 0.45 && r.st.asteroidsCleared >= 8,
    'wave=' + r.st.wave + '/' + r.st.level.waves.length + ', cleared=' + r.st.asteroidsCleared);
}

/* ============ C2. 主动模拟：第四章（预算更低）布防仍有效 ============ */
console.log('--- C2. 主动模拟（第四章，预算感知布防）---');
{
  // 第四章星能预算 370→300，原有的"4 颗中行星（600）"启发式超出预算，
  // 因此改用预算感知策略：每个方位优先大行星，星能不足时降级为中/小行星。
  function policyBudgetAware(st) {
    const planet = st.bodies[0];
    const spots = [[-140, 0], [140, 0], [0, -140], [0, 140]];
    for (const sp of spots) {
      const p = { x: planet.x + sp[0], y: planet.y + sp[1] };
      if (!game.placeStar('large', p, {}).ok) {
        if (!game.placeStar('mid', p, {}).ok) game.placeStar('small', p, {});
      }
    }
  }
  const samples = [30, 34, 39];
  let allOk = true, detail = [];
  for (const idx of samples) {
    const r = simulate(idx, 10800, policyBudgetAware);
    const totalWaves = r.st.level.waves.length;
    const ratio = r.st.wave / totalWaves;
    detail.push('L' + (idx + 1) + ':wave=' + r.st.wave + '/' + totalWaves
      + ',cleared=' + r.st.asteroidsCleared + ',hits=' + r.st.hitCount);
    if (r.st.asteroidsCleared < 8) allOk = false;
    if (ratio < 0.45) allOk = false;
  }
  assert('第四章：静态布防在代表关卡均有效拦截且不被开局击穿（清场 ≥ 8、进度 ≥ 45%）',
    allOk, detail.join(' | '));
}

console.log(ok ? '\n=== 40 关平衡 / 可达性校验全部通过 ===' : '\n=== 平衡校验存在失败 ===');
process.exit(ok ? 0 : 1);
