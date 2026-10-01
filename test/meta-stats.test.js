// v1.11 模式深化与重玩性测试套件
//   A. 无尽阶段表：确定性、逐段非递减、风暴波判定（wave % 10 === 0）
//   B. 无尽节奏：第 1~10 波与上一发布版（v1.10）口径完全一致；难度进度单调不减；生存模式零漂移
//   C. 风暴波构成：风暴前锋混入分裂彗星、阶段混入特殊威胁、提示与 HUD 阶段号；生存模式不受影响
//   D. 模式统计隔离：挑战成绩只进各自模式统计，不污染生存/无尽与既有战绩口径
//   E. 累计统计：场次/胜场/时长/拦截/受击累加、单局只累加一次（幂等）、模式互不污染
//   F. 存档健壮性：损坏回退、缺字段回退、清除进度删除新键并复位内存、starshield_setup 保留
//   G. 展示层：结算面板结局文案、菜单星图总览面板渲染
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

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
  if (opts && opts.withInput) load('js/input.js');
  return {
    sandbox, game: sandbox.window.game, window: sandbox.window, ls: sandbox.localStorage,
    el: (id) => (elCache[id] || (elCache[id] = stubEl())),
  };
}

const main = createSandbox();
const game = main.game;
const DT = 1 / 60;

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}
const lerp = (a, b, t) => a + (b - a) * t;
// 强制开始下一波：waveActive=false + waveTimer 超过 0.5s 阈值 → stepFrame 内 startWave()
function startNextWave(g, st) {
  st.waveActive = false;
  st.waveTimer = 1;
  g.stepFrame(DT);
}

/* ============ A. 无尽阶段表 ============ */
console.log('--- A. 无尽阶段表 ---');
{
  const stages = game.ENDLESS_STAGES;
  assert('阶段表存在且为 6 段', Array.isArray(stages) && stages.length === 6, 'n=' + (stages && stages.length));
  assert('阶段区间为 10 波', game.ENDLESS_STAGE_SIZE === 10);
  const keys = ['bump', 'countMul', 'cometRatio', 'splitterRatio', 'disturberRatio'];
  let mono = true, detail = '';
  for (let i = 1; i < stages.length; i++) {
    for (const k of keys) {
      if (stages[i][k] < stages[i - 1][k] - 1e-12) { mono = false; detail = k + '@' + i; }
    }
  }
  assert('阶段参数逐段非递减（难度只增不减）', mono, detail);
  assert('阶段 0 为基准值（第 1~10 波与上一版完全一致的前提）',
    stages[0].bump === 0 && stages[0].countMul === 1
    && stages[0].cometRatio === 0 && stages[0].splitterRatio === 0 && stages[0].disturberRatio === 0);

  // 阶段推导：stage = floor((wave-1)/10)；风暴波 = wave % 10 === 0
  const cases = [
    [1, 0, 1, false, 9],
    [9, 0, 1, false, 1],
    [10, 0, 1, true, 0],
    [11, 1, 2, false, 9],
    [20, 1, 2, true, 0],
    [21, 2, 3, false, 9],
    [100, 9, 6, true, 0],
  ];
  let allOk = true, wrong = '';
  for (const [w, stage, stageNo, storm, since] of cases) {
    game.startGame({ mode: 'endless', levelIndex: 0 });
    game.state.timeScale = 1;
    game.state.wave = w;
    const info = game.getEndlessStageInfo();
    const hit = info.stage === stage && info.stageNo === stageNo
      && info.stormNow === storm && info.sinceStorm === since;
    if (!hit) { allOk = false; wrong = 'wave=' + w + ' → ' + JSON.stringify(info); }
  }
  assert('阶段号 / 风暴判定 / 倒计时推导正确', allOk, wrong);
  assert('超过最后一段后标记 capped（沿用末段参数）',
    (() => {
      game.startGame({ mode: 'endless', levelIndex: 0 });
      game.state.wave = 100;
      return game.getEndlessStageInfo().capped === true;
    })());
  game.startGame({ mode: 'survival', levelIndex: 0 });
  game.state.wave = 10;
  const sv = game.getEndlessStageInfo();
  assert('非无尽模式阶段信息恒为基准值（不产生效果）',
    sv.bump === 0 && sv.countMul === 1 && sv.splitterRatio === 0 && sv.stormNow === false);
}

/* ============ B. 无尽节奏（与上一版前 10 波一致 + 单调） ============ */
console.log('--- B. 无尽节奏 ---');
{
  // 无尽复用 SURVIVAL_LEVELS[2].waves：start 0.45 / end 1.0 / ramp 0.018 / interval 1.2→0.4
  const s = createSandbox();
  const g = s.game;
  g.startGame({ mode: 'endless', levelIndex: 0 });
  const st = g.state;
  st.timeScale = 1;
  const cfg = st.level.waves;
  let drift = -1;
  for (let w = 1; w <= 10; w++) {
    st.wave = w;
    const p = g.getWaveParams();
    const expected = lerp(cfg.startDifficulty, cfg.endDifficulty, Math.min(1, w * cfg.difficultyRamp));
    if (Math.abs(p.difficulty - expected) > 1e-9) drift = w;
  }
  assert('第 1~10 波难度与上一发布版（v1.10）口径完全一致（阶段 0 无加成）', drift < 0, '首个漂移波=' + drift);

  // 单调性：难度进度非递减 → difficulty 不减、interval 不增（count 带 ±1 随机，不参与断言）
  let diffOk = true, intOk = true, bad = '';
  let prevDiff = -1, prevInt = Infinity;
  for (let w = 1; w <= 120; w++) {
    st.wave = w;
    const p = g.getWaveParams();
    if (p.difficulty < prevDiff - 1e-9) { diffOk = false; bad = 'w=' + w + ' diff'; }
    if (p.interval > prevInt + 1e-9) { intOk = false; bad = 'w=' + w + ' interval'; }
    prevDiff = p.difficulty;
    prevInt = p.interval;
  }
  assert('1~120 波难度单调不减', diffOk, bad);
  assert('1~120 波来袭间隔单调不增', intOk, bad);
  // 阶段加成必须真的生效（wave 60 的难度应显著高于 v1.11 的纯 ramp 值）
  st.wave = 60;
  const p60 = g.getWaveParams();
  const base60 = lerp(cfg.startDifficulty, cfg.endDifficulty, 1);
  assert('第 60 波难度高于"封顶基准"（阶段加成生效）', p60.difficulty > base60 + 0.1,
    'diff=' + p60.difficulty.toFixed(3));
  // 上限保护
  st.wave = 9999;
  assert('难度进度有上限（不会无限膨胀）', g.getWaveParams().difficulty <= 2.0,
    'diff=' + g.getWaveParams().difficulty.toFixed(3));
}
{
  // 生存模式零漂移：同样使用 SURVIVAL_LEVELS[2].waves 的生存关，难度必须等于纯 ramp 值
  const s = createSandbox();
  const g = s.game;
  g.startGame({ mode: 'survival', levelIndex: 2 });
  const st = g.state;
  st.timeScale = 1;
  const cfg = st.level.waves;
  let drift = -1;
  for (const w of [1, 10, 20, 40, 60]) {
    st.wave = w;
    const p = g.getWaveParams();
    const expected = lerp(cfg.startDifficulty, cfg.endDifficulty, Math.min(1, w * cfg.difficultyRamp));
    if (Math.abs(p.difficulty - expected) > 1e-9) drift = w;
  }
  assert('生存模式难度公式零漂移（不含无尽阶段加成）', drift < 0, '首个漂移波=' + drift);
}

/* ============ C. 风暴波构成 ============ */
console.log('--- C. 风暴波构成 ---');
{
  const s = createSandbox();
  const g = s.game;
  g.startGame({ mode: 'endless', levelIndex: 0 });
  const st = g.state;
  st.timeScale = 1;
  const kindsOf = () => st.waveQueue.map(i => i.kind);
  const count = (arr, k) => arr.filter(x => x === k).length;

  // 阶段 0 的非风暴波：只有陨石与彗星（与上一版一致）
  st.wave = 4;
  startNextWave(g, st);
  assert('第 5 波（阶段 0，非风暴）不含分裂彗星/干扰体',
    count(kindsOf(), 'splitter') === 0 && count(kindsOf(), 'disturber') === 0,
    kindsOf().join(','));

  // 风暴波（第 10 波）：额外涌入分裂彗星前锋
  st.wave = 9;
  startNextWave(g, st);
  assert('第 10 波为风暴波（stage 0 收尾）', st.wave === 10 && kindsOf().indexOf('splitter') >= 0,
    'wave=' + st.wave + ' kinds=' + kindsOf().join(','));
  assert('风暴前锋不少于 2 个分裂彗星', count(kindsOf(), 'splitter') >= 2,
    'splitter=' + count(kindsOf(), 'splitter'));
  assert('风暴提示可读（含"风暴"）', String(g.takeNotice() || '').indexOf('风暴') >= 0,
    String(g.takeNotice()));
  assert('风暴波阶段号为 1（第 1 阶段收尾）', g.getEndlessStageInfo().stageNo === 1);
  assert('无尽阶段写入 state（startWave 后 stage=0，对应阶段 1）', st.endlessStage === 0,
    'stage=' + st.endlessStage);

  // 第 20 波（阶段 1 收尾）：前锋规模更大（2 + min(2, stage) = 3）
  st.wave = 19;
  startNextWave(g, st);
  assert('第 20 波风暴前锋不少于 3 个分裂彗星', count(kindsOf(), 'splitter') >= 3,
    'splitter=' + count(kindsOf(), 'splitter'));
  // 阶段号口径：stageNo = floor((wave-1)/10) + 1 → 第 21 波 = 阶段 3
  assert('第 21 波进入阶段 3（floor((21-1)/10)+1）', (() => {
    st.wave = 20;
    startNextWave(g, st);
    return st.wave === 21 && g.getEndlessStageInfo().stageNo === 3;
  })(), 'wave=' + st.wave + ' stageNo=' + g.getEndlessStageInfo().stageNo);
  // 阶段 ≥1 后特殊威胁开始混入（占比 4% 起，按波次数量至少 1 个）
  assert('阶段 ≥1 的波次混入特殊威胁（分裂彗星或干扰体）',
    count(kindsOf(), 'splitter') + count(kindsOf(), 'disturber') > 0,
    kindsOf().join(','));
}
{
  // 生存模式构成零变化：不出现分裂彗星 / 干扰体
  const s = createSandbox();
  const g = s.game;
  g.startGame({ mode: 'survival', levelIndex: 0 });
  const st = g.state;
  st.timeScale = 1;
  st.wave = 30;
  startNextWave(g, st);
  const kinds = st.waveQueue.map(i => i.kind);
  assert('生存模式波次仍只含陨石/彗星', kinds.every(k => k === 'asteroid' || k === 'comet'),
    kinds.join(','));
  assert('生存模式不写无尽阶段（恒为 0）', st.endlessStage === 0);
}
{
  // 风暴鲁棒性：不清波地真实推进一段（含风暴前锋分裂出的子体）。
  // 风暴波会额外塞入分裂彗星，而分裂彗星被拦截时各裂成 2 个子体 —— 必须确认
  // 天体总数始终受 MAX_TOTAL_BODIES(90) 约束、不抛异常。
  const s = createSandbox();
  const g = s.game;
  g.startGame({ mode: 'endless', levelIndex: 0 });
  const st = g.state;
  st.timeScale = 1;
  st.wave = 19;
  st.health = 9999;                        // 只观察天体规模，不让母星提前被打死
  let maxBodies = 0, sawSplitter = false, threw = '';
  try {
    for (let i = 0; i < 1800; i++) {       // ≈30 游戏秒
      g.stepFrame(DT);
      if (st.bodies.length > maxBodies) maxBodies = st.bodies.length;
      if (!sawSplitter
        && st.bodies.some(b => b.type === 'splitter' || b.type === 'splitChild')) sawSplitter = true;
      if (st.gameOver) break;
    }
  } catch (e) { threw = String(e && e.message); }
  assert('无尽风暴波真实推进不抛异常', threw === '', threw);
  assert('天体总数始终受上限约束（≤ 90）', maxBodies <= 90, 'max=' + maxBodies);
  assert('风暴前锋确有分裂彗星入场（含分裂子体）', sawSplitter);
  assert('风暴期间仍在推进波次（未软锁）', st.wave > 19 || st.gameOver, 'wave=' + st.wave);
}

/* ============ D. 模式统计隔离 ============ */
console.log('--- D. 模式统计隔离 ---');
{
  // 挑战成绩只进挑战统计，不污染生存/无尽场次与既有 bestScore / bestWaves 口径
  const s = createSandbox({ starshield_challenge: JSON.stringify({ unlocked: 40 }) });
  const g = s.game;
  const survivalBefore = g.bestForMode('survival');
  const wavesBefore = g.getBestWaves();
  g.startGame({ mode: 'challenge', levelIndex: 0 });
  const st = g.state;
  st.timeScale = 1;
  st.scoreIntercept = 100;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = 40; st.isLastWave = true;
  g.stepFrame(DT);
  const t = g.getStatsTotals();
  assert('挑战模式场次记入挑战统计', t.plays.challenge === 1 && t.wins.challenge === 1);
  assert('挑战模式不污染生存/无尽场次', t.plays.survival === 0 && t.plays.endless === 0);
  assert('挑战模式不污染既有 bestScore / bestWaves',
    g.bestForMode('survival') === survivalBefore && g.getBestWaves() === wavesBefore);
}
{
  // 无尽模式：阵亡结算正常推进 bestWaves（与榜单无关的既有口径）
  const s = createSandbox();
  const g = s.game;
  const die = (wave) => {
    g.startGame({ mode: 'endless', levelIndex: 0 });
    const st = g.state;
    st.timeScale = 1;
    st.wave = wave;
    st.health = 1;
    const planet = st.bodies[0];
    st.bodies.push({ type: 'asteroid', mass: 40, radius: 14, x: planet.x, y: planet.y, vx: 0, vy: 0 });
    g.stepFrame(DT);
    return st.gameOver;
  };
  assert('无尽第 5 波阵亡可正常结算', die(5) === true);
  assert('无尽第 9 波阵亡可正常结算', die(9) === true);
  assert('无尽阵亡推进 bestWaves（取最高波数）', g.getBestWaves() === 9, 'best=' + g.getBestWaves());
}

/* ============ E. 累计统计 ============ */
console.log('--- E. 累计统计 ---');
{
  const s = createSandbox({ starshield_campaign_unlocked: '40' });
  const g = s.game;
  const t0 = g.getStatsTotals();
  assert('初始统计全零',
    t0.intercepted === 0 && t0.hits === 0 && t0.timeSec === 0 && t0.bestScore === 0
    && t0.plays.campaign === 0 && t0.plays.survival === 0);
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  const st = g.state;
  st.timeScale = 1;
  st.asteroidsCleared = 12;
  st.hitCount = 3;
  st.gameTime = 42;
  st.scoreIntercept = 100;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = 40; st.isLastWave = true;
  g.stepFrame(DT);
  const t1 = g.getStatsTotals();
  assert('累计拦截威胁 +12', t1.intercepted === 12, 'n=' + t1.intercepted);
  assert('累计母星受击 +3', t1.hits === 3, 'n=' + t1.hits);
  assert('累计游戏时长 ≥ 42s', t1.timeSec >= 42, 'sec=' + t1.timeSec);
  assert('历史最高分被记录', t1.bestScore > 0, 'best=' + t1.bestScore);
  assert('第二局累计：只增不清零', (() => {
    g.startGame({ mode: 'campaign', levelIndex: 0 });
    const st2 = g.state;
    st2.timeScale = 1;
    st2.asteroidsCleared = 5;
    st2.hitCount = 1;
    st2.scoreIntercept = 50;
    st2.bodies = st2.bodies.filter(b => b.type === 'planet');
    st2.waveActive = true; st2.waveQueue = []; st2.waveElapsed = 40; st2.isLastWave = true;
    g.stepFrame(DT);
    const t2 = g.getStatsTotals();
    return t2.intercepted === 17 && t2.hits === 4 && t2.plays.campaign === 2;
  })(), JSON.stringify(g.getStatsTotals()));
}

/* ============ F. 存档健壮性与清除 ============ */
console.log('--- F. 存档健壮性与清除 ---');
{
  const bad = createSandbox({ starshield_stats: '{oops' });
  assert('损坏的统计存档回退为空进度',
    bad.game.getStatsTotals().intercepted === 0);
  assert('损坏存档产生可读提示（含"损坏"）',
    String(bad.game.takeWarning() || '').indexOf('损坏') >= 0, String(bad.game.takeWarning()));
  const partial = createSandbox({ starshield_stats: JSON.stringify({ v: 1 }) });
  const pt = partial.game.getStatsTotals();
  assert('缺字段的统计存档回退默认且不抛错',
    pt.plays.campaign === 0 && pt.timeSec === 0);
  const junk = createSandbox({
    starshield_stats: JSON.stringify({
      totals: { plays: { campaign: 'x' }, wins: null, timeSec: -5, intercepted: NaN },
    }),
  });
  const jt = junk.game.getStatsTotals();
  assert('脏数据被归一化（负数/NaN/字符串全部收敛）',
    jt.plays.campaign === 0 && jt.timeSec === 0 && jt.intercepted === 0,
    JSON.stringify(jt));
}
{
  // 清除进度：删除 stats 键 + 复位内存；starshield_setup 仍不受管理
  const s = createSandbox({ starshield_campaign_unlocked: '40', starshield_setup: JSON.stringify([{ x: 1 }]) });
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  const st = g.state;
  st.timeScale = 1;
  st.asteroidsCleared = 9;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = 40; st.isLastWave = true;
  g.stepFrame(DT);
  assert('清除前统计键存在', !!s.ls.getItem('starshield_stats'));
  g.clearAllProgress();
  assert('清除进度删除统计键', s.ls.getItem('starshield_stats') === null);
  const t = g.getStatsTotals();
  assert('清除进度复位统计内存态',
    t.intercepted === 0 && t.plays.campaign === 0,
    JSON.stringify(t));
  assert('布防存档键仍不属于游戏管理范围', s.ls.getItem('starshield_setup') !== null);
}
{
  // 单机自查：统计实现中不得出现任何网络 API
  const src = fs.readFileSync(path.join(root, 'js/game.js'), 'utf8');
  assert('无任何网络请求 API（fetch/XHR/WebSocket/ServiceWorker）',
    !/\bfetch\s*\(/.test(src) && !/XMLHttpRequest/.test(src)
    && !/WebSocket/.test(src) && !/serviceWorker/i.test(src));
}

/* ============ G. 展示层：结算面板 + 星图总览 ============ */
console.log('--- G. 展示层 ---');
{
  const s = createSandbox(
    { starshield_campaign_unlocked: '40', starshield_stars: (() => { const t = {}; for (let i = 0; i < 40; i++) t[String(i)] = 3; return JSON.stringify(t); })() },
    { withInput: true }
  );
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 39 });
  const st = g.state;
  st.timeScale = 1;
  st.scoreIntercept = 120;
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true; st.waveQueue = []; st.waveElapsed = 40; st.isLastWave = true;
  g.stepFrame(DT);                                  // 触发 endGame → 内部调用 window.__showResult
  const endBox = s.el('resultEnding');
  assert('结算面板渲染结局文案（含标题与正文）',
    endBox.style.display === '' && endBox.innerHTML.indexOf('结局') >= 0
    && endBox.innerHTML.indexOf('re-text') >= 0, endBox.innerHTML.slice(0, 60));
  // 菜单星图总览
  s.window.__refreshMenuBest();
  const collect = s.el('collectList');
  const html = collect.innerHTML;
  assert('星图总览面板含两块内容（收集进度 / 统计摘要）且不再出现榜单',
    html.indexOf('收集进度') >= 0 && html.indexOf('统计摘要') >= 0 && html.indexOf('榜') < 0);
  assert('星图总览展示闯关星数与隐藏关进度',
    html.indexOf('闯关星数') >= 0 && html.indexOf('隐藏关') >= 0);
  assert('星图总览展示累计统计口径（时长 / 拦截 / 场次）',
    html.indexOf('累计游戏时长') >= 0 && html.indexOf('累计拦截威胁') >= 0 && html.indexOf('累计场次') >= 0);
  assert('非 100% 收集时不显示「完美星图」收束文案', html.indexOf('perfect') < 0 && html.indexOf('完美星图') < 0);
}

console.log(ok ? '\n=== v1.11 无尽阶段 / 统计测试全部通过 ==='
               : '\n=== v1.11 统计测试存在失败 ===');
process.exit(ok ? 0 : 1);
