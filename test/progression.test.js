// P1 玩法扩展测试套件（保卫萝卜式 · 纯单机）
//   P1-A 星级评价：computeStars 四类边界、★2 门槛自适应且自洽、通关落盘与"只增不减"、
//        旧进度迁移幂等、损坏/越界存档回退、清除进度一并复位
//   P1-B 回收与升级：返还 70% 记账、黑洞规则、升级差价与位置/速度保持、档位/星能/黑名单边界、
//        升级后原撤销历史失效、选中命中与短路
//   P1-C 成就：声明式定义完整性、幂等解锁、队列一次性消费、存档往返与损坏回退、清除复位
//   其它：getCurrentRunStats 扩展字段（只增不改）与减速时长统计
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

// ---- 沙箱工厂：预置 localStorage 后加载全部模块（迁移/损坏场景需要不同的预置存档）----
// withInput=false：不加载 input.js（其 init 会渲染菜单并消费 takeWarning / 成就队列，
// 使存档异常提示无法在测试中被断言）
function createSandbox(preload, withInput) {
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
      addEventListener() {}, createElement: () => stubEl(),
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
  // 浏览器里 window 即全局对象；沙箱里必须显式桥接（否则模块内裸引用会静默短路）
  sandbox.physics = sandbox.window.physics;
  sandbox.predictor = sandbox.window.predictor;
  sandbox.audio = sandbox.window.audio;
  sandbox.render = sandbox.window.render;
  sandbox.game = sandbox.window.game;
  if (withInput !== false) load('js/input.js');
  return {
    sandbox,
    game: sandbox.window.game,
    physics: sandbox.window.physics,
    render: sandbox.window.render,
    showResult: sandbox.window.__showResult,
    ls: sandbox.localStorage,
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

function freshCampaign(levelIndex) {
  game.startGame({ mode: 'campaign', levelIndex: levelIndex || 0 });
  const st = game.state;
  st.timeScale = 1;
  return st;
}
function freshSurvival() {
  game.startGame({ mode: 'survival', levelIndex: 0 });
  const st = game.state;
  st.timeScale = 1;
  return st;
}
// 直接构造一次"通关"结算（与 robustness H3 同一路径，不依赖物理跑完整局）
function winCurrentLevel(st) {
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true;
  st.waveQueue = [];
  st.waveElapsed = 40;
  st.isLastWave = true;
  game.stepFrame(DT);
  return st.endReason;
}

/* ============================ P1-A 星级评价 ============================ */
console.log('--- P1-A 星级评价 ---');
{
  const crit = game.getStarCriteria(0);
  assert('星级上限与总分上限正确（40 关 × 3 星 = 120）',
    crit.max === 3 && crit.totalMax === 120,
    'max=' + crit.max + ' totalMax=' + crit.totalMax);
  assert('★2 门槛按波数自适应且自洽（≥2 且 ≤ 波数）',
    crit.star2HitLimit >= 2 && crit.star2HitLimit <= crit.totalWaves,
    'limit=' + crit.star2HitLimit + ' waves=' + crit.totalWaves);
  let monoOk = true;
  for (let i = 0; i < game.CAMPAIGN_LEVELS.length; i++) {
    const c = game.getStarCriteria(i);
    if (!(c.star2HitLimit >= 2 && c.star2HitLimit <= c.totalWaves)) monoOk = false;
  }
  assert('40 关门槛全部自洽（不会出现不可达的 2 星）', monoOk);
}
{
  const limit = game.getStarCriteria(0).star2HitLimit;
  const waveCount = game.getStarCriteria(0).totalWaves;
  assert('零受击通关 = 3 星',
    game.computeStars({ mode: 'campaign', endReason: 'win', hitCount: 0, totalWaves: waveCount }) === 3);
  assert('受击 = 门槛 = 2 星',
    game.computeStars({ mode: 'campaign', endReason: 'win', hitCount: limit, totalWaves: waveCount }) === 2);
  assert('受击 > 门槛 = 1 星',
    game.computeStars({ mode: 'campaign', endReason: 'win', hitCount: limit + 1, totalWaves: waveCount }) === 1);
  assert('未通关 = 0 星',
    game.computeStars({ mode: 'campaign', endReason: 'defeat', hitCount: 0, totalWaves: waveCount }) === 0);
  assert('生存模式不计星（保持比拼分数口径）',
    game.computeStars({ mode: 'survival', endReason: 'win', hitCount: 0, totalWaves: 0 }) === 0);
  assert('空参数安全返回 0 星', game.computeStars(null) === 0);
}
{
  // 端到端：通关 → 落盘 + 总星数增加
  game.clearAllProgress();
  const st = freshCampaign(0);
  const before = game.getTotalStars();
  st.hitCount = 0;
  const reason = winCurrentLevel(st);
  assert('闯关最后一波清空 → 通关', reason === 'win', 'reason=' + reason);
  assert('零受击通关落盘 3 星', game.starsForLevel(0) === 3);
  assert('总星数随之增加', game.getTotalStars() === before + 3, 'total=' + game.getTotalStars());
  const raw = main.ls.getItem('starshield_stars');
  assert('星级写入 JSON 存档', !!raw && JSON.parse(raw)['0'] === 3, raw);
}
{
  // 只增不减：再次以低星通关不覆盖高星
  const st = freshCampaign(0);
  st.hitCount = 99;
  winCurrentLevel(st);
  assert('低星通关不覆盖历史高星（只增不减）', game.starsForLevel(0) === 3);
  // 同一关更高星可以覆盖
  const st2 = freshCampaign(1);
  st2.hitCount = 99;
  winCurrentLevel(st2);
  assert('第 2 关先得 1 星', game.starsForLevel(1) === 1);
  const st3 = freshCampaign(1);
  st3.hitCount = 0;
  winCurrentLevel(st3);
  assert('同关更高星可覆盖为 3 星', game.starsForLevel(1) === 3);
}
{
  // 失败不给星（也不清空历史）
  freshCampaign(2);
  assert('未通关的关卡保持 0 星', game.starsForLevel(2) === 0);
  assert('既有星数不受影响', game.starsForLevel(0) === 3 && game.starsForLevel(1) === 3);
}
{
  // 旧进度迁移：只有「已通关 N 关」，没有星级表 → 每关补 1 星
  const mig = createSandbox({ starshield_campaign_unlocked: '3' }, false);
  assert('旧存档迁移：已通关 3 关 → 3 颗星', mig.game.getTotalStars() === 3,
    'total=' + mig.game.getTotalStars());
  assert('迁移后每关各 1 星（不虚报高星）',
    mig.game.starsForLevel(0) === 1 && mig.game.starsForLevel(1) === 1 && mig.game.starsForLevel(2) === 1);
  assert('迁移后第 4 关仍为 0 星', mig.game.starsForLevel(3) === 0);
  // 幂等：再次加载不重复叠加
  mig.game.loadStars();
  assert('迁移幂等（重复加载不再叠加）', mig.game.getTotalStars() === 3);
}
{
  // 已有更高星时，迁移不覆盖
  const mig2 = createSandbox({
    starshield_campaign_unlocked: '2',
    starshield_stars: JSON.stringify({ '0': 3 }),
  }, false);
  assert('迁移不覆盖已有更高星', mig2.game.starsForLevel(0) === 3 && mig2.game.getTotalStars() === 4,
    'total=' + mig2.game.getTotalStars());
}
{
  // 损坏 / 越界存档
  const bad = createSandbox({ starshield_stars: '{"0": tru' }, false);
  assert('损坏的星级存档回退为空进度', bad.game.getTotalStars() === 0);
  assert('损坏存档产生可读提示', String(bad.game.takeWarning() || '').indexOf('损坏') >= 0);
  const junk = createSandbox(
    { starshield_stars: JSON.stringify({ '0': 9, '1': -2, '999': 3, x: 2 }) }, false);
  assert('越界键与非法值被丢弃、超上限被收敛',
    junk.game.starsForLevel(0) === 3 && junk.game.getTotalStars() === 3,
    'total=' + junk.game.getTotalStars());
}
{
  // 清除进度：星级一并删除并复位内存
  const st = freshCampaign(0);
  st.hitCount = 0;
  winCurrentLevel(st);
  assert('清除前存在星级', game.getTotalStars() > 0);
  game.clearAllProgress();
  assert('清除进度删除星级存档', main.ls.getItem('starshield_stars') === null);
  assert('清除进度后内存星数归零', game.getTotalStars() === 0);
}

/* ============================ P1-B 回收与升级 ============================ */
console.log('--- P1-B 回收与升级 ---');
{
  const st = freshSurvival();
  st.budget = 2000;
  const before = st.budget;
  game.placeStar('star', { x: 120, y: 120 }, {});          // 恒星 cost 500
  assert('放置恒星扣除 500 星能', st.budget === before - 500);
  const body = st.bodies[st.bodies.length - 1];
  const r = game.recycleBody(body);
  assert('回收返还 70%（500 → 350）', r.ok === true && r.refund === 350 && st.budget === before - 150,
    'refund=' + r.refund + ' budget=' + st.budget);
  assert('回收后星体离场且计数 +1',
    st.bodies.indexOf(body) < 0 && st.recycles === 1);
  assert('回收后净花费 = 500 - 350 = 150', st.totalSpent === 150, 'spent=' + st.totalSpent);
}
{
  const st = freshSurvival();
  st.budget = 5000;
  const before = st.budget;
  game.placeStar('blackhole', { x: 200, y: 200 }, {});
  const bh = st.bodies[st.bodies.length - 1];
  const r = game.recycleBody(bh);
  assert('黑洞可回收（返还 1050，不做寿命折算）',
    r.ok === true && r.refund === 1050 && st.budget === before - 450, 'refund=' + r.refund);
  assert('黑洞回收后场上无黑洞', st.bodies.every(b => b.type !== 'blackhole'));
}
{
  const st = freshSurvival();
  st.budget = 2000;
  const before = st.budget;
  game.placeStar('small', { x: 200, y: 200 }, { vx: 12, vy: -8 });   // cost 50
  const body = st.bodies[st.bodies.length - 1];
  const x0 = body.x, y0 = body.y, vx0 = body.vx, vy0 = body.vy;
  const r = game.upgradeBody(body);
  assert('升级一小档补差价 100（150 - 50）', r.ok === true && r.delta === 100 && st.budget === before - 50 - 100,
    'delta=' + r.delta + ' budget=' + st.budget);
  assert('升级后档位/质量/半径更新',
    body.placedType === 'mid' && body.mass === game.STAR_TYPES.mid.mass && body.radius === game.STAR_TYPES.mid.radius);
  assert('升级保留位置与初速',
    body.x === x0 && body.y === y0 && body.vx === vx0 && body.vy === vy0);
  assert('升级计数 +1', st.upgrades === 1);
  assert('升级后原放置历史不再可撤销（避免按旧价返还）', game.canUndo().ok === false);
}
{
  const st = freshSurvival();
  st.budget = 5000;
  game.placeStar('star', { x: 220, y: 220 }, {});
  const body = st.bodies[st.bodies.length - 1];
  const r = game.upgradeBody(body);
  assert('恒星已是最高档 → 拒绝升级', r.ok === false && r.reason.indexOf('最高档位') >= 0, r.reason);
  st.budget = 5000;
  game.placeStar('blackhole', { x: 400, y: 300 }, {});
  const bh = st.bodies[st.bodies.length - 1];
  const r2 = game.upgradeBody(bh);
  assert('黑洞不可升级', r2.ok === false && r2.reason.indexOf('黑洞') >= 0, r2.reason);
}
{
  const st = freshSurvival();
  st.budget = 60;
  game.placeStar('small', { x: 200, y: 200 }, {});
  const body = st.bodies[st.bodies.length - 1];
  const r = game.upgradeBody(body);
  assert('星能不足时拒绝升级并说明差额',
    r.ok === false && r.reason.indexOf('星能不足') >= 0 && body.placedType === 'small', r.reason);
  st.budget = 1000;
  const info = game.getBodyActionInfo(body);
  assert('操作面板信息含差价与返还', info.upgradeDelta === 100 && info.refund === 35 && info.canUpgrade === true,
    JSON.stringify(info));
}
{
  // 非法时机 / 离场目标
  const st = freshSurvival();
  st.budget = 2000;
  game.placeStar('small', { x: 200, y: 200 }, {});
  const body = st.bodies[st.bodies.length - 1];
  st.gameOver = true;
  assert('结算后拒绝回收/升级',
    game.recycleBody(body).ok === false && game.upgradeBody(body).ok === false);
  st.gameOver = false;
  st.bodies.splice(st.bodies.indexOf(body), 1);
  assert('已离场目标拒绝回收/升级',
    game.recycleBody(body).ok === false && game.upgradeBody(body).ok === false);
  assert('非法目标给可读原因',
    game.recycleBody(body).reason.length > 0);
}
{
  // 选中：命中放宽、母星与威胁不可选、短路
  const st = freshSurvival();
  st.budget = 2000;
  game.placeStar('large', { x: 300, y: 300 }, {});
  const body = st.bodies[st.bodies.length - 1];
  const planet = st.bodies[0];
  assert('点选命中已放置星体', game.selectBodyAt({ x: 300, y: 300 }).ok === true
    && game.state.selectedBody === body);
  assert('点空白处取消选中', game.selectBodyAt({ x: 30, y: 30 }).ok === false
    && game.state.selectedBody === null);
  assert('母星不可选中', game.selectBodyAt({ x: planet.x, y: planet.y }).ok === false);
  assert('非法坐标安全短路', game.selectBodyAt(null).ok === false && game.selectBodyAt({ x: NaN, y: 0 }).ok === false);
  game.selectBodyAt({ x: 300, y: 300 });
  game.clearSelection();
  assert('clearSelection 清空选中态', game.state.selectedBody === null);
  st.gameOver = true;
  assert('结算后拒绝选中', game.selectBodyAt({ x: 300, y: 300 }).ok === false);
}
{
  // 回收不应污染撤销历史数组（上限仍为 20）
  const st = freshSurvival();
  st.budget = 99999;
  for (let i = 0; i < 25; i++) game.placeStar('small', { x: 100 + i * 16, y: 100 }, {});
  assert('撤销历史上限仍为 20', st.placeHistory.length === 20);
  const body = st.bodies[st.bodies.length - 1];
  game.recycleBody(body);
  assert('回收不会向撤销历史追加条目', st.placeHistory.length === 20);
}

/* ============================ P1-C 成就系统 ============================ */
console.log('--- P1-C 成就系统 ---');
{
  const list = game.getAchievementList();
  // v1.12：成就由 14 项扩到 26 项（新增专精/协同/每日/隐藏关/任务全清/无尽风暴/挑战/完美收集）
  assert('成就数量在 24-30 之间', list.length >= 24 && list.length <= 30, 'n=' + list.length);
  assert('成就列表与定义数量一致', list.length === game.ACHIEVEMENTS.length);
  const ids = list.map(a => a.id);
  assert('成就 id 唯一', new Set(ids).size === ids.length);
  assert('每项成就含名称与描述', list.every(a => a.name && a.desc));
  assert('每项均带判定函数', game.ACHIEVEMENTS.every(a => typeof a.need === 'function'));
}
{
  game.clearAllProgress();
  const st = freshSurvival();
  st.asteroidsCleared = 50;          // 结算统计口径：cleared 派生自 asteroidsCleared
  const stats = game.getCurrentRunStats();
  const first = game.evaluateAchievements(stats);
  assert('达到条件即解锁拦截专家', first.unlocked.some(a => a.id === 'clear_50'),
    JSON.stringify(first.unlocked.map(a => a.id)));
  const second = game.evaluateAchievements(stats);
  assert('幂等：重复判定不再重复解锁', second.unlocked.length === 0);
  assert('解锁数量保持一致', second.count === first.count);
  const pending = game.takeNewAchievements();
  assert('新解锁队列可一次性取走且随后清空',
    pending.some(a => a.id === 'clear_50') && game.takeNewAchievements().length === 0,
    'pending=' + pending.length);
  st.asteroidsCleared = 80;
  game.evaluateAchievements(game.getCurrentRunStats());
  assert('已解锁成就不再进入新解锁队列', game.takeNewAchievements().length === 0);
}
{
  // 结算流程端到端：通关 + 零受击 → 触发成就并落盘
  game.clearAllProgress();
  const st = freshCampaign(0);
  st.hitCount = 0;
  winCurrentLevel(st);
  const list = game.getAchievementList();
  assert('通关结算触发成就（初次告捷 / 铜墙铁壁）',
    list.find(a => a.id === 'first_win').unlocked === true
    && list.find(a => a.id === 'no_hit_win').unlocked === true,
    JSON.stringify(list.filter(a => a.unlocked).map(a => a.id)));
  assert('新解锁队列已由结算面板消费（不重复提示）', game.takeNewAchievements().length === 0);
  assert('成就写入存档', !!main.ls.getItem('starshield_achievements'));
  const raw = JSON.parse(main.ls.getItem('starshield_achievements'));
  assert('存档记录解锁时间戳', Number.isFinite(raw.first_win) && raw.first_win > 0);
}
{
  const rl = createSandbox({
    starshield_achievements: JSON.stringify({ first_win: 123, unknown_key: 1 }),
  }, false);
  const list = rl.game.getAchievementList();
  assert('成就存档往返读取', list.find(a => a.id === 'first_win').unlocked === true);
  assert('旧版本残留键被忽略', list.every(a => a.id !== 'unknown_key'));
  const bad = createSandbox({ starshield_achievements: '{oops' }, false);
  assert('损坏成就存档回退为空进度',
    bad.game.getAchievementList().every(a => !a.unlocked));
  assert('损坏成就存档产生可读提示', String(bad.game.takeWarning() || '').indexOf('损坏') >= 0);
}
{
  const st = freshCampaign(0);
  st.hitCount = 0;
  winCurrentLevel(st);
  game.clearAllProgress();
  assert('清除进度删除成就存档', main.ls.getItem('starshield_achievements') === null);
  assert('清除进度后内存成就归零',
    game.getAchievementList().every(a => !a.unlocked));
}

/* ============================ 结算数据契约扩展 ============================ */
console.log('--- getCurrentRunStats 扩展字段 ---');
{
  const st = freshSurvival();
  st.timeScale = 0.25;
  for (let i = 0; i < 30; i++) game.stepFrame(DT);
  const s = game.getCurrentRunStats();
  assert('新增统计字段齐全且类型正确',
    Number.isFinite(s.slowUsedSeconds) && Number.isFinite(s.upgrades) && Number.isFinite(s.recycles)
    && Number.isFinite(s.blackholeSwallowed) && Number.isFinite(s.budgetLeft)
    && Number.isFinite(s.totalStars) && Number.isFinite(s.levelIndex));
  assert('减速使用时长被累计（30 帧 ≈ 0.5s）', s.slowUsedSeconds > 0.4 && s.slowUsedSeconds <= 0.5,
    'slowUsed=' + s.slowUsedSeconds);
  assert('既有字段口径未被破坏（score = 明细代数和）',
    s.score === s.scoreIntercept + s.scoreWaveBonus + s.scoreSurvive - s.scorePenalty);
  assert('M2 红线：不存在浮点影子字段 state.score', game.state.score === undefined);
  assert('生存模式 modeMul 仍为 1', s.modeMul === 1);
}

console.log(ok ? '\n=== P1 玩法扩展（星级/回收升级/成就）测试全部通过 ==='
               : '\n=== P1 玩法扩展测试存在失败 ===');
process.exit(ok ? 0 : 1);
