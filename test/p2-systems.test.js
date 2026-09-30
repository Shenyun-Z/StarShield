// P2 系统测试（v1.9 玩法扩展第二批）
//   1) 天体类型体系：isThreat / isScene / isPickable 语义与白名单
//   2) 主题场景化：6 主题真实生成场景天体、可挡道但不可点选/回收/升级、不参与威胁结算
//   3) Boss：多段摧毁（每次碰撞掉 1 段、冷却内不掉）、段数归零计分、撞母星重罚 2 点并消失
//   4) 分裂彗星：被撞毁/被吞噬裂成 2 个子体、撞母星不分裂、子体不再分裂
//   5) 引力干扰体：脉冲冲量在 physics 层生效 —— 预测线同样包含它（预测一致性红线）
//   6) 一次性道具：配额发放、引力井限时回收、斥力波冲量、凝滞不消耗减速额度
//   7) 无尽模式与章节化：无限波次、最高波数记录、3 章覆盖 30 关
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

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
const load = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
sandbox.localStorage.setItem('starshield_campaign_unlocked', '30');   // 解锁全部关卡
load('js/game.js');
sandbox.physics = sandbox.window.physics;
sandbox.predictor = sandbox.window.predictor;
sandbox.audio = sandbox.window.audio;
sandbox.render = sandbox.window.render;
sandbox.game = sandbox.window.game;

const game = sandbox.game;
const physics = sandbox.window.physics;
const predictor = sandbox.window.predictor;
const DT = 1 / 60;

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}
function freshCampaign(idx) {
  game.startGame({ mode: 'campaign', levelIndex: idx });
  const st = game.state;
  st.timeScale = 1;
  return st;
}
// 只保留母星（清掉场景与来袭），便于构造受控场景
function clearToPlanet(st) {
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  return st.bodies[0];
}

/* ============ 1. 类型体系 ============ */
console.log('--- 1. 天体类型体系 ---');
{
  assert('威胁白名单覆盖 6 类', physics.THREAT_TYPES.length === 6
    && ['asteroid', 'comet', 'splitter', 'splitChild', 'disturber', 'boss']
      .every(t => physics.THREAT_TYPES.indexOf(t) >= 0));
  assert('场景白名单覆盖 4 类', ['companion', 'well', 'obstacle', 'pulsar']
    .every(t => physics.SCENE_TYPES.indexOf(t) >= 0));
  assert('isThreat 只认可威胁类型',
    physics.isThreat({ type: 'boss' }) && physics.isThreat({ type: 'splitChild' })
    && !physics.isThreat({ type: 'companion' }) && !physics.isThreat({ type: 'star' }));
  assert('isScene 只认场景类型',
    physics.isScene({ type: 'pulsar' }) && !physics.isScene({ type: 'asteroid' }));
  assert('isPickable 只认玩家星体与黑洞',
    physics.isPickable({ type: 'star' }) && physics.isPickable({ type: 'blackhole' })
    && !physics.isPickable({ type: 'companion' }) && !physics.isPickable({ type: 'boss' })
    && !physics.isPickable(null));
}

/* ============ 2. 主题场景化 ============ */
console.log('--- 2. 主题场景化 ---');
{
  const st1 = freshCampaign(0);      // 第 1 关：宁静星域（无场景）
  assert('宁静星域开局只有母星',
    st1.bodies.length === 1 && st1.bodies[0].type === 'planet',
    'n=' + st1.bodies.length);
  const st6 = freshCampaign(5);      // 第 6 关：双星轨道（1 颗伴星）
  const companions = st6.bodies.filter(b => b.type === 'companion');
  assert('双星轨道生成伴星', companions.length === 1);
  assert('场景天体为锚定实心体',
    companions[0].immovable === true && companions[0].anchored === true && companions[0].solid === true);
  assert('场景天体不参与威胁判定（不计波次剩余）',
    st6.bodies.filter(b => physics.isThreat(b)).length === 0);
  // 第 21 关：乱流迷宫（3 个障碍）
  const st21 = freshCampaign(20);
  assert('乱流迷宫生成 3 个障碍',
    st21.bodies.filter(b => b.type === 'obstacle').length === 3);
  // 第 26 关：风暴核心（脉冲源）
  const st26 = freshCampaign(25);
  const pulsars = st26.bodies.filter(b => b.type === 'pulsar');
  assert('风暴核心生成脉冲源（带脉冲参数）',
    pulsars.length === 1 && pulsars[0].pulsePeriod > 0 && pulsars[0].pulseStrength > 0);
}
{
  const st = freshCampaign(5);
  const companion = st.bodies.filter(b => b.type === 'companion')[0];
  assert('场景天体不可点选', game.selectBodyAt({ x: companion.x, y: companion.y }).ok === false);
  assert('场景天体不可回收', game.recycleBody(companion).ok === false);
  assert('场景天体不可升级', game.upgradeBody(companion).ok === false);
  assert('场景天体不计入玩家星体上限', game.state.bodies.length - 1 >= 1
    && game.canPlaceAt({ x: companion.x + 200, y: companion.y }) === true);
}
{
  // 场景天体撞毁来袭威胁（挡道），且自身不受影响
  const st = freshCampaign(5);
  const planet = clearToPlanet(st);
  const obstacle = {
    type: 'obstacle', mass: 320, radius: 22, x: planet.x + 200, y: planet.y,
    vx: 0, vy: 0, immovable: true, anchored: true, solid: true, scene: true,
    vertices: [1, 1, 1, 1, 1],
  };
  const rock = { type: 'asteroid', mass: 40, radius: 14, x: planet.x + 200, y: planet.y, vx: 0, vy: 0 };
  st.bodies.push(obstacle, rock);
  game.stepFrame(DT);
  assert('来袭威胁撞上场景天体被撞毁', st.bodies.indexOf(rock) < 0);
  assert('场景天体自身不受影响（仍在场上）', st.bodies.indexOf(obstacle) >= 0);
  assert('撞毁不计入黑洞吞噬统计', st.blackholeSwallowed === 0);
}

/* ============ 3. Boss ============ */
console.log('--- 3. Boss 多段摧毁 ---');
{
  const lv = game.CAMPAIGN_LEVELS[4];        // 第 5 关（Boss 关）
  assert('Boss 关的末波含 boss 生成项',
    lv.waves[lv.waves.length - 1].spawns.some(s => s.kind === 'boss'));
  assert('Boss 波计入总波数与目标文案',
    lv.objective.indexOf('全部 ' + lv.waves.length + ' 波') >= 0);
}
{
  const st = freshCampaign(4);
  const planet = clearToPlanet(st);
  const boss = { type: 'boss', mass: 320, radius: 34, x: planet.x + 220, y: planet.y,
    vx: 0, vy: 0, hp: 3, hpMax: 3, hpCd: 0 };
  st.bodies.push(boss);
  let rounds = 0;
  for (let i = 0; i < 3; i++) {
    // 每次放一颗星撞上去（并把冷却清零，模拟间隔足够的多次撞击）
    st.bodies.push({ type: 'star', mass: 300, radius: 17, placedType: 'large',
      x: boss.x, y: boss.y, vx: 0, vy: 0 });
    boss.hpCd = 0;
    game.stepFrame(DT);
    rounds++;
    if (st.bodies.indexOf(boss) < 0) break;
  }
  assert('Boss 每次碰撞只掉 1 段（3 段需 3 次）', rounds === 3, 'rounds=' + rounds);
  assert('Boss 段数归零后被清除', st.bodies.indexOf(boss) < 0);
  assert('摧毁 Boss 计入拦截计分（Boss 本身算 1 个清除）',
    st.scoreIntercept > 0 && st.asteroidsCleared >= 1,
    'score=' + st.scoreIntercept + ', cleared=' + st.asteroidsCleared);
}
{
  // 撞母星：Boss 消失且母星扣 2 点（hitCount 仍按 1 次计）
  const st = freshCampaign(4);
  const planet = clearToPlanet(st);
  const hp0 = st.health;
  const boss = { type: 'boss', mass: 320, radius: 34, x: planet.x, y: planet.y,
    vx: 0, vy: 0, hp: 4, hpMax: 4, hpCd: 0 };
  st.bodies.push(boss);
  game.stepFrame(DT);
  assert('Boss 撞母星扣 2 点血', st.health === hp0 - 2, 'health=' + st.health);
  assert('Boss 撞母星只计 1 次受击', st.hitCount === 1, 'hits=' + st.hitCount);
  assert('Boss 撞母星后自身消失', st.bodies.indexOf(boss) < 0);
}

/* ============ 4. 分裂彗星 ============ */
console.log('--- 4. 分裂彗星 ---');
{
  const st = freshCampaign(10);
  const planet = clearToPlanet(st);
  st.budget = 5000;
  game.placeStar('blackhole', { x: planet.x + 300, y: planet.y }, {});
  const bh = st.bodies[st.bodies.length - 1];
  const splitter = { type: 'splitter', mass: 30, radius: 9,
    x: bh.x, y: bh.y, vx: 0, vy: 0, splitDepth: 0 };
  st.bodies.push(splitter);
  game.stepFrame(DT);
  const children = st.bodies.filter(b => b.type === 'splitChild');
  assert('分裂彗星被黑洞吞噬后裂成 2 个子体', children.length === 2, 'n=' + children.length);
  assert('母体被移除', st.bodies.indexOf(splitter) < 0);
  assert('子体标记为不可再分裂（splitDepth=1）',
    children.every(c => c.splitDepth === 1 && c.type === 'splitChild'));
  assert('子体计入威胁（参与波次结算与预警）',
    children.every(c => physics.isThreat(c)));
  // 子体再被吞噬也不会分裂
  const before = st.bodies.filter(b => b.type === 'splitChild').length;
  children[0].x = bh.x; children[0].y = bh.y;
  game.stepFrame(DT);
  assert('子体不会二次分裂',
    st.bodies.filter(b => b.type === 'splitChild').length <= before, 'n=' +
    st.bodies.filter(b => b.type === 'splitChild').length);
}
{
  // 撞母星不分裂
  const st = freshCampaign(10);
  const planet = clearToPlanet(st);
  const hp0 = st.health;
  const splitter = { type: 'splitter', mass: 30, radius: 9,
    x: planet.x, y: planet.y, vx: 0, vy: 0, splitDepth: 0 };
  st.bodies.push(splitter);
  game.stepFrame(DT);
  assert('分裂彗星撞母星扣血但不分裂',
    st.health === hp0 - 1 && st.bodies.filter(b => b.type === 'splitChild').length === 0,
    'health=' + st.health);
}

/* ============ 5. 引力干扰体（预测一致性） ============ */
console.log('--- 5. 引力干扰体 ---');
{
  const st = freshCampaign(15);
  const planet = clearToPlanet(st);
  const dist = { type: 'disturber', mass: 70, radius: 15,
    x: planet.x + 260, y: planet.y, vx: 0, vy: 0,
    pulseStrength: 200, pulsePeriod: 0.5 };
  const rock = { type: 'asteroid', mass: 40, radius: 14,
    x: planet.x + 300, y: planet.y + 40, vx: 0, vy: 0 };
  st.bodies.push(dist, rock);
  const vx0 = rock.vx;
  for (let i = 0; i < 45; i++) game.stepFrame(DT);      // 0.75s → 至少一发脉冲
  assert('干扰体脉冲对附近天体产生冲量', Math.abs(rock.vx - vx0) > 1,
    'dvx=' + (rock.vx - vx0).toFixed(2));
  // 预测一致性（红线）：预测器复用同一积分器，因此预测轨迹里同样包含脉冲效果
  const d2 = Object.assign({}, dist, { x: 900, y: 200 });
  const r2 = { type: 'asteroid', mass: 40, radius: 14, x: 940, y: 240, vx: 0, vy: 0 };
  const sim = predictor.simulateFuture([d2, r2], { duration: 1.5, dt: 0.05, sampleEvery: 2 });
  const path = sim.paths[1];
  const drift = Math.hypot(path[path.length - 1].x - path[0].x, path[path.length - 1].y - path[0].y);
  assert('预测轨迹包含脉冲造成的位移（预测与实际同源）', drift > 5, 'drift=' + drift.toFixed(1));
}

/* ============ 6. 一次性道具 ============ */
console.log('--- 6. 一次性道具 ---');
{
  const st = freshCampaign(0);
  const props = game.getProps();
  assert('闯关模式开局配额 2/1/1',
    props.length === 3
    && props.filter(p => p.id === 'gravityWell')[0].count === 2
    && props.filter(p => p.id === 'repulseWave')[0].count === 1
    && props.filter(p => p.id === 'stasis')[0].count === 1);
  const planet = st.bodies[0];
  // 引力井：限时回收（lifespan 3 游戏秒）
  const r1 = game.useProp('gravityWell', { x: planet.x + 220, y: planet.y });
  assert('引力井释放成功', r1.ok === true && game.getProps().filter(p => p.id === 'gravityWell')[0].count === 1);
  const well = st.bodies.filter(b => b.type === 'gravityWell')[0];
  assert('引力井已生成且带存活时限', !!well && well.lifespan > 0);
  for (let i = 0; i < 240; i++) game.stepFrame(DT);     // 4 游戏秒
  assert('引力井到期后被回收', st.bodies.filter(b => b.type === 'gravityWell').length === 0);
}
{
  const st = freshCampaign(0);
  const planet = clearToPlanet(st);
  const rock = { type: 'asteroid', mass: 40, radius: 14,
    x: planet.x + 180, y: planet.y, vx: 0, vy: 0 };
  st.bodies.push(rock);
  // 释放点与威胁保持一段距离（正中心 0 距离会因除零保护被跳过，属预期行为）
  const r = game.useProp('repulseWave', { x: planet.x + 140, y: planet.y });
  assert('斥力波释放成功且计数减少',
    r.ok === true && game.getProps().filter(p => p.id === 'repulseWave')[0].count === 0);
  assert('斥力波把威胁推离母星（获得向外速度）', rock.vx > 1, 'vx=' + rock.vx.toFixed(1));
}
{
  // 用生存模式（有限时倒计时）来测量"游戏时间推进速度"
  game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.timeScale = 1;
  const planet = st.bodies[0];
  const quota0 = st.slowQuota;
  const used0 = st.slowUsedSeconds;
  const t0 = st.remainingTime;
  const r = game.useProp('stasis', { x: planet.x, y: planet.y });
  assert('凝滞释放成功', r.ok === true && st.stasisTime > 0);
  for (let i = 0; i < 60; i++) game.stepFrame(DT);      // 真实 1 秒
  const advanced = t0 - st.remainingTime;
  assert('凝滞期间游戏时间显著变慢（≈0.35×）', advanced > 0.2 && advanced < 0.6,
    'advanced=' + advanced.toFixed(2));
  assert('凝滞不消耗减速额度', st.slowQuota === quota0, 'quota=' + st.slowQuota);
  assert('凝滞不计入"使用慢动作"统计（成就口径不受污染）', st.slowUsedSeconds === used0);
  const r0 = game.useProp('nope', { x: 1, y: 1 });
  assert('未知道具被拒绝', r0.ok === false);
}

/* ============ 7. 无尽模式与章节化 ============ */
console.log('--- 7. 无尽模式与章节化 ---');
{
  const list = game.getLevelsForMode('endless');
  assert('无尽模式返回单个合成关卡', list.length === 1 && list[0].duration === 0);
  game.startGame({ mode: 'endless', levelIndex: 0 });
  const st = game.state;
  st.timeScale = 1;
  assert('无尽模式可开局且无波次上限', st.gameStarted === true && st.mode === 'endless');
  // 直接推进若干波次，验证没有"通关即结束"的上限逻辑
  st.wave = 7;
  st.health = 1;
  const planet = st.bodies[0];
  st.bodies.push({ type: 'asteroid', mass: 40, radius: 14, x: planet.x, y: planet.y, vx: 0, vy: 0 });
  game.stepFrame(DT);
  assert('无尽模式生命归零即结束（无通关上限）', st.gameOver === true);
  assert('最高波数被记录并落盘',
    game.getBestWaves() === 7 && sandbox.localStorage.getItem('starshield_best_waves') === '7',
    'best=' + game.getBestWaves());
}
{
  const chapters = game.CHAPTERS;
  const regularLevels = game.CAMPAIGN_LEVELS.filter(l => !l.hidden);
  assert('章节数为 4 且覆盖全部 40 个常规关',
    chapters.length === 4 && chapters[0].from === 0
    && chapters[chapters.length - 1].to === regularLevels.length - 1);
  assert('每章含剧情文案（极简叙事，供章首关横幅展示）',
    chapters.every(c => typeof c.story === 'string' && c.story.length > 8));
  let contiguous = true;
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].from !== chapters[i - 1].to + 1) contiguous = false;
  }
  assert('章节区间连续无空洞', contiguous);
  assert('每个常规关都属于且仅属于一个章节（隐藏关不属任何章节）',
    game.CAMPAIGN_LEVELS.every((lv, idx) => lv.hidden
      ? chapters.filter(c => idx >= c.from && idx <= c.to).length === 0
      : chapters.filter(c => idx >= c.from && idx <= c.to).length === 1));
}

console.log(ok ? '\n=== P2 系统（类型/场景/Boss/分裂/干扰/道具/无尽/章节）测试全部通过 ==='
               : '\n=== P2 系统测试存在失败 ===');
process.exit(ok ? 0 : 1);
