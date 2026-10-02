// v1.13 UI 重设计回归套件（暂停 / 设置 / 结构契约 / 样式体系）
//   背景：本轮重排了 index.html、重写了 style.css（改为设计 token 驱动）、新增了暂停覆盖层与设置面板。
//   既有 20 套测试对 UI 的断言是"点状"的（只看个别 id 的文本与 display 语义），
//   无法回答下面这类问题：JS 引用的 id 是否都还存在？JS 写的 class 是否有样式定义？
//   暂停是否真的冻结了游戏态？动效偏好是否落盘？
//   本套件分四块：
//     A. 暂停语义：冻结游戏态、幂等、不复用 timeScale、跨局/跨路径复位、早退位置正确
//     B. 设置扩展：reduceMotion 读写 / 持久化 / 损坏与类型错误回退 / 白名单 / 清进度复位
//     C. 交互链路：暂停按钮与 P/Esc 快捷键、Esc 优先级、覆盖层显隐与摘要、暂停中屏蔽布防与撤销、设置面板开合
//     D. 结构与样式契约：id 双向对照（无缺失、无重复）、关键文本格式与 display 语义不变、
//        被 JS 写入的 class 均已在 CSS 中定义、设计 token 与多档断点存在、动效降级通道存在、括号配平
const fs = require('fs');
const { GAME_FILES, UI_FILES, SOURCE_FILES, loadFiles } = require('./helpers/sandbox');
const path = require('path');
const vm = require('vm');
const readAllCss = require('./helpers/css');
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

// 可点击桩（与 result-actions.test.js 同款）；额外提供 window 事件注册表以测试快捷键
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
  const winHandlers = {};
  const store = {};
  if (preload) for (const k in preload) store[k] = String(preload[k]);
  const sandbox = {
    Math, Map, Set, console, JSON, Array, Object, String, Number, Boolean,
    isNaN, parseInt, parseFloat, Infinity, NaN,
    performance: { now: () => Date.now() },
    window: {
      innerWidth: 1280, innerHeight: 720,
      addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn); },
    },
    localStorage: {
      _d: store,
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    document: {
      readyState: 'complete',                       // → input.js 加载时同步 init()
      documentElement: { dataset: {} },             // v1.13：动效偏好挂在 html[data-motion]
      getElementById: (id) => (elCache[id] || (elCache[id] = makeEl(id))),
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, createElement: () => makeEl('created'),
    },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval() {},
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
  sandbox.audio = sandbox.window.audio;
  sandbox.render = sandbox.window.render;
  sandbox.game = sandbox.window.game;
  loadFiles(load, UI_FILES);
  return {
    sandbox, game: sandbox.window.game, ls: sandbox.localStorage,
    el: (id) => elCache[id] || (elCache[id] = makeEl(id)),
    win: (type, ev) => (winHandlers[type] || []).forEach((fn) => fn(ev)),
  };
}

const DT = 1 / 60;
const CAMPAIGN_UNLOCKED = { starshield_campaign_unlocked: '40' };

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}
// 构造一次通关结算（与其它套件同款手法，不依赖物理跑完整局）
function winLevel(g, st) {
  st.bodies = st.bodies.filter(b => b.type === 'planet');
  st.waveActive = true;
  st.waveQueue = [];
  st.waveElapsed = 40;
  st.isLastWave = true;
  g.stepFrame(DT);
}

/* ============ A. 暂停语义 ============ */
console.log('--- A. 暂停语义（冻结 / 幂等 / 不复用 timeScale / 复位）---');
{
  const s = createSandbox(CAMPAIGN_UNLOCKED);
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  const st = g.state;
  assert('暂停字段默认关闭', st.paused === false && g.isPaused() === false);

  g.stepFrame(DT);
  const t0 = st.gameTime;
  assert('未暂停时游戏时钟正常推进', t0 > 0, 't=' + t0);

  // 模拟"减速中"再暂停：额度与统计都必须冻结
  st.timeScale = 0.25;
  st.slowQuota = 15;
  const q0 = st.slowQuota, u0 = st.slowUsedSeconds;
  const wave0 = st.wave, wt0 = st.waveTimer;
  assert('setPaused(true) 生效并返回新状态', g.setPaused(true) === true && g.isPaused() === true);
  assert('暂停不复用 timeScale（避免污染"开局即常速"语义）', st.timeScale === 0.25, 'timeScale=' + st.timeScale);
  assert('重复 setPaused(true) 幂等', g.setPaused(true) === true && st.paused === true);

  for (let i = 0; i < 40; i++) g.stepFrame(DT);
  assert('暂停期间游戏时钟冻结', st.gameTime === t0, 't=' + st.gameTime);
  assert('暂停期间减速额度不消耗', st.slowQuota === q0, 'q=' + st.slowQuota);
  assert('暂停期间减速统计不增长（早退在额度扣减之前）', st.slowUsedSeconds === u0, 'u=' + st.slowUsedSeconds);
  assert('暂停期间波次与波次计时都不推进',
    st.wave === wave0 && st.waveTimer === wt0, 'wave=' + st.wave + ' timer=' + st.waveTimer);

  g.setPaused(false);
  assert('setPaused(false) 恢复', g.isPaused() === false);
  st.timeScale = 1;                       // 复原，便于观察推进
  for (let i = 0; i < 4; i++) g.stepFrame(DT);
  assert('继续后游戏时钟恢复推进', st.gameTime > t0, 't=' + st.gameTime);

  // 路径复位：回菜单 / 结算 / 新一局
  g.setPaused(true);
  g.backToMenu();
  assert('回菜单解除暂停', g.isPaused() === false);
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  g.setPaused(true);
  winLevel(g, g.state);
  assert('暂停中即使满足通关条件也不结算（冻结链完整）', g.state.gameOver === false);
  g.setPaused(false);
  winLevel(g, g.state);
  assert('恢复后正常结算，且结算路径保持非暂停（面板可交互）',
    g.state.gameOver === true && g.isPaused() === false);
  g.state.paused = true;                  // 人为置脏：验证新一局一定清掉
  g.startGame({ mode: 'campaign', levelIndex: 1 });
  assert('新一局必从"运行中"开始（暂停态跨局不残留）', g.isPaused() === false);

  // 未开局 / 已结束不可暂停
  const s2 = createSandbox();
  assert('未开局不可暂停', s2.game.setPaused(true) === false && s2.game.state.paused === false);
  s2.game.backToMenu();
  assert('菜单态 setPaused 不产生脏状态', s2.game.isPaused() === false);
}

/* ============ B. 设置扩展（reduceMotion） ============ */
console.log('--- B. 设置扩展：reduceMotion 读写 / 持久化 / 回退 / 白名单 ---');
{
  const s = createSandbox();
  const g = s.game;
  assert('默认关闭且与 state 同步', g.getSettings().reduceMotion === false && g.state.reduceMotion === false);
  assert('旧存档缺该字段 → 按默认回退（不算损坏）', g.loadSettings().reduceMotion === false);
  assert('setSetting 接受 reduceMotion', g.setSetting('reduceMotion', true) === true);
  assert('写入后同步到 state（供 UI 读取）', g.state.reduceMotion === true);
  assert('落盘到 starshield_settings（不新增存档键）',
    JSON.parse(s.ls.getItem('starshield_settings')).reduceMotion === true);
  assert('未知键被拒绝', g.setSetting('reduceMotionX', true) === false);
  assert('类型不符被拒绝且不污染已有值',
    g.setSetting('reduceMotion', 'yes') === false && g.state.reduceMotion === true);
  assert('不影响既有设置键', g.setSetting('showWarnings', false) === true
    && JSON.parse(s.ls.getItem('starshield_settings')).showWarnings === false);

  // 主音量（v1.13：设置面板里唯一的滑条控件）
  assert('音量默认 0.8 且同步 state', g.getSettings().volume === 0.8 && g.state.volume === 0.8);
  assert('音量接受数字并按 0~1 钳制',
    g.setSetting('volume', 0.5) === true && g.state.volume === 0.5
    && g.setSetting('volume', 3) === true && g.state.volume === 1
    && g.setSetting('volume', -2) === true && g.state.volume === 0);
  assert('音量拒绝非数字类型', g.setSetting('volume', '0.5') === false);
  assert('音量落盘（仍为单一设置键）', JSON.parse(s.ls.getItem('starshield_settings')).volume === 0);
  assert('越界存档值在读取时被钳制回区间',
    createSandbox({ starshield_settings: JSON.stringify({ volume: 9 }) }).game.state.volume === 1);
  assert('旧存档缺音量字段 → 回退默认 0.8',
    createSandbox({ starshield_settings: JSON.stringify({ showHint: true }) }).game.state.volume === 0.8);

  const s2 = createSandbox({
    starshield_settings: JSON.stringify({ showHint: false, showWarnings: false, reduceMotion: true }),
  });
  assert('新会话恢复已保存的动效偏好',
    s2.game.state.reduceMotion === true && s2.game.state.showHint === false);
  const s3 = createSandbox({
    starshield_settings: JSON.stringify({ showHint: true, showWarnings: true, reduceMotion: 'yes' }),
  });
  assert('字段类型错误 → 该字段回退默认（不整体判损坏）',
    s3.game.getSettings().reduceMotion === false && s3.game.state.reduceMotion === false);
  const s4 = createSandbox({ starshield_settings: '{oops' });
  assert('存档整体损坏 → 全部回退默认', s4.game.getSettings().reduceMotion === false);

  s.game.clearAllProgress();
  assert('清除进度复位动效偏好（内存 + 存档）',
    s.game.getSettings().reduceMotion === false && s.game.state.reduceMotion === false
    && s.ls.getItem('starshield_settings') === null);
}

/* ============ C. 交互链路（暂停按钮 / 快捷键 / 设置面板） ============ */
console.log('--- C. 交互链路：暂停覆盖层、快捷键优先级、设置面板 ---');
{
  const s = createSandbox(CAMPAIGN_UNLOCKED);
  const g = s.game;
  g.startGame({ mode: 'campaign', levelIndex: 0 });
  g.state.budget = 99999;
  g.placeStar('small', { x: 320, y: 300 }, { spec: 'gravity' });

  const pauseEl = s.el('pause');
  assert('暂停覆盖层初始隐藏（.hidden）', pauseEl.classList.contains('hidden') === true);

  s.el('pauseBtn').dispatch('click', {});
  assert('点击「暂停」→ state.paused = true', g.isPaused() === true);
  assert('暂停后覆盖层显示', pauseEl.classList.contains('hidden') === false);
  assert('暂停摘要：模式 · 关卡', /·/.test(s.el('pauseSub').textContent) && s.el('pauseSub').textContent.length > 2,
    s.el('pauseSub').textContent);
  assert('暂停摘要：波次为「当前/总」格式', /^\d+\/\d+$/.test(s.el('pauseWave').textContent),
    s.el('pauseWave').textContent);
  assert('暂停摘要：分数为纯整数', /^\d+$/.test(s.el('pauseScore').textContent), s.el('pauseScore').textContent);
  assert('暂停摘要：减速余额带单位', /s$|禁用/.test(s.el('pauseSlow').textContent), s.el('pauseSlow').textContent);

  // 暂停中屏蔽布防与撤销
  const histLen = g.state.placeHistory.length;
  const before = (s.sandbox.window.__placingStars || []).length;
  s.el('game').dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 420, clientY: 400 });
  assert('暂停中不响应画布布防',
    (s.sandbox.window.__placingStars || []).length === before,
    'before=' + before + ' after=' + (s.sandbox.window.__placingStars || []).length);
  s.win('keydown', { key: 'z' });
  assert('暂停中屏蔽 Z 撤销', g.state.placeHistory.length === histLen);

  // P 键（不区分大小写）
  s.win('keydown', { key: 'P' });
  assert('P 键（大写）继续游戏', g.isPaused() === false);
  assert('继续后覆盖层隐藏', pauseEl.classList.contains('hidden') === true);
  s.win('keydown', { key: 'p' });
  assert('P 键暂停', g.isPaused() === true);

  // Esc 优先级：设置面板 > 选中/道具 > 暂停
  s.el('pauseSettingsBtn').dispatch('click', {});
  const settingsEl = s.el('settings');
  assert('暂停层可打开设置面板', settingsEl.classList.contains('hidden') === false);
  s.win('keydown', { key: 'Escape' });
  assert('Esc 优先关闭设置面板且保持暂停',
    settingsEl.classList.contains('hidden') === true && g.isPaused() === true);

  g.setPaused(false);
  const body = g.state.bodies.filter(b => b.type !== 'planet')[0];
  g.state.selectedBody = body || null;
  s.win('keydown', { key: 'Escape' });
  assert('有选中星体时 Esc 只取消选中、不进入暂停',
    g.state.selectedBody === null && g.isPaused() === false);
  s.win('keydown', { key: 'Escape' });
  assert('无选中 / 无道具时 Esc 进入暂停', g.isPaused() === true);
  s.el('pauseResume').dispatch('click', {});
  assert('「继续游戏」按钮恢复', g.isPaused() === false);

  // 设置面板：菜单入口 + 动效开关
  s.el('menuSettingsBtn').dispatch('click', {});
  assert('菜单设置入口打开同一实例', settingsEl.classList.contains('hidden') === false
    && settingsEl.dataset.from === 'menu');
  assert('设置行初始态：开关类与状态文案一致',
    s.el('hintBtn').classList.contains('on') === true && s.el('hintState').textContent === '开');
  s.el('motionBtn').dispatch('click', {});
  assert('「减少动效」写入 state', g.state.reduceMotion === true);
  assert('「减少动效」映射到 html[data-motion]',
    s.sandbox.document.documentElement.dataset.motion === 'reduced',
    String(s.sandbox.document.documentElement.dataset.motion));
  assert('设置行获得 .on 类（胶囊开关视觉）且状态文案为「开」',
    s.el('motionBtn').classList.contains('on') === true && s.el('motionState').textContent === '开');
  // 主音量滑条：拖动 → 设置 + 音频模块同步
  const range = s.el('volumeRange');
  assert('滑条初值与设置一致', range.value === '80', String(range.value));
  range.value = '35';
  range.dispatch('input', {});
  assert('拖动滑条写入设置', g.state.volume === 0.35, 'v=' + g.state.volume);
  assert('滑条状态文案同步', s.el('volumeState').textContent === '35%', s.el('volumeState').textContent);
  assert('音量已应用到 audio 模块（主音量节点）',
    Math.abs(s.sandbox.audio.getVolume() - 0.35) < 1e-9, String(s.sandbox.audio.getVolume()));
  range.value = '0';
  range.dispatch('input', {});
  assert('静音（0%）可正常写入', g.state.volume === 0 && s.sandbox.audio.getVolume() === 0);
  range.value = '80';
  range.dispatch('input', {});

  s.el('motionBtn').dispatch('click', {});
  assert('再次点击关闭并回写 data-motion=full',
    g.state.reduceMotion === false && s.sandbox.document.documentElement.dataset.motion === 'full');
  s.el('settingsClose').dispatch('click', {});
  assert('关闭设置面板', settingsEl.classList.contains('hidden') === true);

  // 暂停中按 P：既恢复游戏也收起面板
  s.el('pauseBtn').dispatch('click', {});
  s.el('pauseSettingsBtn').dispatch('click', {});
  s.win('keydown', { key: 'p' });
  assert('暂停中按 P：继续游戏并自动收起设置',
    g.isPaused() === false && settingsEl.classList.contains('hidden') === true);

  // 菜单态（未开局）：设置面板同样可开可关（关闭动作必须在 gameStarted 守卫之前处理）
  const sm = createSandbox();
  sm.el('menuSettingsBtn').dispatch('click', {});
  assert('菜单（未开局）可打开设置面板', sm.el('settings').classList.contains('hidden') === false);
  sm.win('keydown', { key: 'Escape' });
  assert('菜单态 Esc 关闭设置面板',
    sm.el('settings').classList.contains('hidden') === true);
  assert('未开局时 P 键不会产生暂停态', sm.game.setPaused(true) === false && sm.game.state.paused === false);

  // HUD 重排后：波次文本格式与模式标签写入点
  g.updateHud();
  assert('HUD 波次仍为「当前/总」格式', /^\d+\/\d+$/.test(s.el('waveVal').textContent),
    s.el('waveVal').textContent);
  assert('模式标签写入独立文本节点（容器不再被写 textContent）',
    s.el('modeTagText').textContent.length > 0 && s.el('modeTag').textContent === '',
    s.el('modeTagText').textContent + ' | ' + s.el('modeTag').textContent);
}

/* ============ D. 结构与样式契约 ============ */
console.log('--- D. 结构与样式契约（id 对照 / class 定义 / token / 断点 / 降级）---');
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = readAllCss();
  const inputSrc = fs.readFileSync(path.join(root, 'js', 'input.js'), 'utf8');

  // D0. 样式已拆分为 css/ 多文件：index.html 必须按层叠顺序逐一引用，且不再引用旧 style.css
  const cssLinks = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(m => m[1]);
  const expectLinks = readAllCss.FILES.map(f => 'css/' + f);
  assert('index.html 按层叠顺序引用全部 css 文件',
    cssLinks.length === expectLinks.length && expectLinks.every((p, i) => cssLinks[i] === p),
    cssLinks.join(','));
  assert('index.html 不再引用旧 style.css', cssLinks.indexOf('style.css') < 0);

  // D0b. 脚本完整性：index.html 必须引用全部本地模块，且无 ESM / 外链脚本
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  const missingScripts = SOURCE_FILES.filter(f => scriptSrcs.indexOf(f) < 0);
  assert('index.html 引用全部本地脚本模块', missingScripts.length === 0, 'missing=' + missingScripts.join(','));
  assert('index.html 无 ESM / 外链脚本',
    !/type=["']module["']/.test(html) && scriptSrcs.every(s => !/^https?:|^\/\//.test(s)),
    scriptSrcs.join(','));

  const idList = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
  const htmlIds = new Set(idList);
  const dupes = idList.filter((id, i) => idList.indexOf(id) !== i);
  assert('index.html 无重复 id', dupes.length === 0, dupes.join(','));

  // D1. JS 字面量引用的 id 必须都存在（DOM 重排最容易踩的坑：元素被移走/改名而代码仍在写它）
  const used = new Set();
  for (const f of SOURCE_FILES) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) used.add(m[1]);
  }
  // 动态拼接的 id：按已知后缀显式展开（与代码中的拼接逻辑一一对应）
  ['starCost-small', 'starCost-mid', 'starCost-large', 'starCost-star', 'starCost-blackhole',
    'prop-gravityWell', 'prop-repulseWave', 'prop-stasis',
    'propCount-gravityWell', 'propCount-repulseWave', 'propCount-stasis',
    'spec-gravity', 'spec-giant'].forEach(id => used.add(id));
  const missing = [...used].filter(id => !htmlIds.has(id));
  assert('JS 引用的全部 id 都存在于 index.html', missing.length === 0, 'missing=' + missing.join(','));
  assert('JS 引用的 id 数量合理（≥60，防止正则失配导致的假通过）', used.size >= 60, 'n=' + used.size);

  // D2. 新增 UI 的 id 齐备（含"按钮内含图标，故文案写在 label 节点"的 8 个节点）
  const required = ['pause', 'pauseSub', 'pauseWave', 'pauseScore', 'pauseCleared', 'pauseSlow',
    'pauseResume', 'pauseSettingsBtn', 'pauseBtn', 'settings', 'settingsClose', 'settingsClearProg',
    'motionBtn', 'motionState', 'warnState', 'hintState', 'audioState', 'menuSettingsBtn', 'modeTagText',
    'volumeRange', 'volumeState',
    'restartLabel', 'menuLabel', 'clearLabel', 'settingsClearLabel', 'menuClearLabel', 'resultClearLabel',
    'achieveToggleLabel', 'collectToggleLabel'];
  const absent = required.filter(id => !htmlIds.has(id));
  assert('新增暂停/设置相关 id 齐备', absent.length === 0, 'missing=' + absent.join(','));
  const labelIds = required.filter(id => /Label$|State$|Text$/.test(id));
  labelIds.forEach(id => {
    const el = new RegExp('<[a-z]+[^>]*id="' + id + '"').exec(html);
    assert('文案/状态节点 ' + id + ' 存在且非容器', !!el);
  });

  // D3. 被 JS 写入的 class 必须已在 CSS 中定义（防止"JS 加了个不存在的类"的静默失效）
  const jsClasses = ['mode-tag', 'hud-group', 'preview-group', 'boss', 'stage-group', 'storm',
    'prop-opt', 'active', 'star-opt', 'selected', 'spec-opt', 'ctrl', 'low', 'exhausted', 'on',
    'ghost', 'danger', 'armed', 'restart', 'opt-btn', 'primary', 'fold', 'open', 'star-bar',
    'body-panel', 'bp-name', 'hidden', 'show', 'rs-star', 'pop', 'rs-star-note', 'result-hidden-rule',
    'result-task', 'done', 'result-record', 'new', 'result-ending', 'result-achieve',
    'ra-item', 'achieve-item', 'unlocked', 'ai-name', 'ai-desc', 'collect-block', 'cb-title',
    'collect-row', 'cr-label', 'cr-value', 'collect-perfect', 'cp-title', 'cp-text', 'chapter-head',
    'hidden-head', 'ch-title', 'ch-sub', 'ch-stars', 'level-card', 'locked', 'hidden-level',
    'lc-name', 'lc-desc', 'lc-meta', 'lc-stars', 'st', 'lc-mods', 'mod-chip', 'lc-task', 'lc-record',
    'lc-unlock', 'badge', 'wp-body', 'wp-item', 'wp-dot', 'wp-side', 'wp-total', 'bb-seg',
    'menu-warn', 'setting-row', 'sr-name', 'sr-sub', 'sr-state', 'switch', 'message',
    'bottom-stack', 'slider', 'slider-row', 'ic-xs', 'ic-sm', 'ic-lg', 'po-name', 'so-name',
    'prop-bar-label', 'fold-arrow', 'menu-brand', 'menu-logo', 'pause-card', 'settings-card',
    'pause-actions', 'pause-stats', 'ps-item', 'ps-label', 'ps-val', 'ph-title', 'ph-sub',
    'settings-body', 'settings-actions', 'hud-inner', 'hud-left', 'hud-right', 'hud-sub'];
  const undef = jsClasses.filter(c => css.indexOf('.' + c) < 0);
  assert('JS 写入的 class 均已在 style.css 定义', undef.length === 0, 'undefined=' + undef.join(','));

  // D4. 设计 token 与动效降级通道
  assert('建立 :root 设计 token（色板/字号/圆角/时长）',
    /:root\s*\{/.test(css) && /--primary\s*:/.test(css) && /--bg-0\s*:/.test(css)
    && /--dur-2\s*:/.test(css) && /--r-md\s*:/.test(css));
  assert('减少动效双通道（设置项 + 系统偏好）',
    /html\[data-motion="reduced"\]/.test(css) && /prefers-reduced-motion:\s*reduce/.test(css));
  assert('键盘可达：统一 focus-visible 焦点环', /:focus-visible/.test(css));
  assert('交互四态齐备（hover/active/focus-visible/disabled）',
    /:hover/.test(css) && /:active/.test(css) && /:disabled/.test(css) && /:focus-visible/.test(css));
  const mediaCount = (css.match(/@media/g) || []).length;
  assert('多分辨率断点齐备（≥6 档）', mediaCount >= 6, 'media=' + mediaCount);
  ['min-width: 1920px', 'max-width: 1279px', 'max-width: 1023px', 'max-height: 560px',
    'max-width: 767px', 'max-width: 520px', 'max-width: 400px'].forEach(bp => {
    assert('断点存在：' + bp, css.indexOf(bp) >= 0);
  });
  const open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
  assert('CSS 花括号配平', open === close, open + ' vs ' + close);
  assert('保留 intro 测试锁定的菜单布局锚点',
    /\.menu\s*\{[^}]*justify-content:\s*flex-start/.test(css)
    && /\.menu h1\s*\{\s*margin-top:\s*auto/.test(css)
    && /\.menu-footer\s*\{\s*margin-bottom:\s*auto/.test(css));
  assert('不再依赖 classList.toggle（测试桩无该方法）', !/\.classList\.toggle\(/.test(inputSrc));
  assert('内联 SVG sprite 已定义且无外链资源',
    /<svg class="svg-sprite"/.test(html) && /<symbol id="ic-/.test(html)
    && !/https?:\/\/(?!www\.w3\.org)/.test(html) && !/@import/.test(css));
}

console.log(ok ? '\n=== v1.13 UI（暂停 / 设置 / 结构契约）测试全部通过 ==='
  : '\n=== v1.13 UI 测试存在失败 ===');
process.exit(ok ? 0 : 1);
