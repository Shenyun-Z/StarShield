// js/persist.js —— 本地存储基础设施：存档键 / 警告通知 / 设置 / 星级（v1.13 拆分）
// 依赖 core.js 的常量与全局状态（解构别名），同层其它文件经 window.SS 交互。
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    SETTINGS_KEY, DEFAULT_SETTINGS, STARS_KEY, STAR2_HIT_RATIO, STAR2_HIT_MIN, STAR_MAX_PER_LEVEL, ACHIEVEMENTS_KEY, CHALLENGE_KEY, DAILY_KEY, TASKS_KEY, RECORDS_KEY, STATS_KEY, CAMPAIGN_LEVELS, state, clamp,
  } = SS;

  const LS_KEYS = [
    'starshield_best_score', 'starshield_best_waves',
    'starshield_campaign_unlocked', 'starshield_audio',
    SETTINGS_KEY, STARS_KEY, ACHIEVEMENTS_KEY,
    // v1.10：挑战进度 / 每日挑战 / 额外任务 / 每关最佳记录
    CHALLENGE_KEY, DAILY_KEY, TASKS_KEY, RECORDS_KEY,
    // v1.11：累计统计
    STATS_KEY,
  ];
  // 存档异常反馈（M7）：localStorage 损坏/配额超限不再静默吞掉，
  // 记录一条待展示的提示，由 input.js 在回到菜单时用轻提示呈现给玩家。
  SS.pendingWarning = '';
  function setWarning(msg) {
    if (!SS.pendingWarning) SS.pendingWarning = msg;
    console.warn('StarShield: ' + msg);
  }
  function takeWarning() {
    const w = SS.pendingWarning;
    SS.pendingWarning = '';
    return w;
  }
  // 游戏内轻提示队列（P0-1 等）：与 setWarning 同构，但由 input.js 主循环消费后
  // 走 flashMessage 弹出，游戏模块本身不直接依赖 DOM。
  SS.pendingNotice = '';
  function pushNotice(msg) {
    if (!SS.pendingNotice) SS.pendingNotice = msg;
  }
  function takeNotice() {
    const n = SS.pendingNotice;
    SS.pendingNotice = '';
    return n;
  }

  // ===== 设置存档（P0-4）=====
  // 单一 JSON 键保存「预测线 / 撞母星预警」等偏好；音效仍由 audio.js 自管。
  // 解析失败或读写异常一律回退默认并复用 M7 的 setWarning 反馈（菜单可渲染）。
  SS.settings = Object.assign({}, DEFAULT_SETTINGS);
  function loadSettings() {
    let raw = null;
    try {
      raw = localStorage.getItem(SETTINGS_KEY);
    } catch (e) {
      setWarning('设置读取失败：本地存储不可用');
    }
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        setWarning('设置存档已损坏，已回退默认设置');
        parsed = null;
      }
    }
    SS.settings = Object.assign({}, DEFAULT_SETTINGS);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.showHint === 'boolean') SS.settings.showHint = parsed.showHint;
      if (typeof parsed.showWarnings === 'boolean') SS.settings.showWarnings = parsed.showWarnings;
      // v1.13：旧存档没有这些字段 → 保留默认值（缺字段不算损坏，与既有容错口径一致）
      if (typeof parsed.reduceMotion === 'boolean') SS.settings.reduceMotion = parsed.reduceMotion;
      if (typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)) {
        SS.settings.volume = clamp(parsed.volume, 0, 1);      // 越界存档值钳制回合法区间
      }
    }
    state.showHint = SS.settings.showHint;
    state.showWarnings = SS.settings.showWarnings;
    state.reduceMotion = SS.settings.reduceMotion;
    state.volume = SS.settings.volume;
    return getSettings();
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(SS.settings));
      return true;
    } catch (e) {
      setWarning('设置保存失败：本地存储不可用或已满');
      return false;
    }
  }
  function getSettings() {
    return Object.assign({}, SS.settings);
  }
  // 仅接受已知键与同类型值（防止脏调用把存档写成意外结构）
  function setSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return false;
    if (typeof DEFAULT_SETTINGS[key] !== typeof value) return false;
    // 音量是唯一带区间的设置项：写入前钳制，避免把越界值写进存档
    const v = (key === 'volume') ? clamp(value, 0, 1) : value;
    SS.settings[key] = v;
    if (key === 'showHint') state.showHint = v;
    if (key === 'showWarnings') state.showWarnings = v;
    if (key === 'reduceMotion') state.reduceMotion = v;   // v1.13：动效偏好同步到 state 供 UI 读取
    if (key === 'volume') state.volume = v;               // v1.13：主音量同步到 state 供 UI 读取
    saveSettings();
    return true;
  }

  // ===== 星级评价与累计星星（P1-A）=====
  // 存档 { "<levelIndex>": 1|2|3 }。总星数由该表求和派生，不额外维护计数，
  // 避免「两份真值漂移」（与 SS.integerScore() 的单一数据源思路一致）。
  SS.stars = Object.create(null);
  function parseStars(raw) {
    const out = Object.create(null);
    if (!raw) return out;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    if (!obj || typeof obj !== 'object') return out;
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const idx = parseInt(k, 10);
      const v = parseInt(obj[k], 10);
      // 存档可被手工篡改：越界键与非法值一律丢弃，避免污染总星数与 UI。
      // 上界用 regularLevelCount()：隐藏关不计星，其索引即使被写入也必须丢弃，
      // 否则总星数会超过满星上限 120，破坏 star_all 成就与第四章门槛的语义。
      if (!Number.isFinite(idx) || idx < 0 || idx >= regularLevelCount()) continue;
      if (!Number.isFinite(v) || v <= 0) continue;
      out[String(idx)] = clamp(v, 1, STAR_MAX_PER_LEVEL);
    }
    return out;
  }
  function loadStars() {
    let raw = null;
    try { raw = localStorage.getItem(STARS_KEY); } catch (e) { setWarning('星级存档读取失败：本地存储不可用'); }
    const parsed = parseStars(raw);
    if (raw && Object.keys(parsed).length === 0) setWarning('星级存档已损坏，已回退为空进度');
    SS.stars = parsed;
    migrateStars();
    return getStars();
  }
  // 旧进度迁移：老存档只有「已通关 N 关」而没有星级表 → 为这些关卡各补 1 星，不让老玩家倒退。
  // 按"逐关补缺"而非"整表为空才迁移"：既覆盖完全缺失，也能修复部分缺失（如迁移中途写盘失败），
  // 且天然幂等——无变化时不写盘。
  function migrateStars() {
    if (SS.campaignUnlocked <= 0) return 0;
    let n = 0;
    const max = Math.min(SS.campaignUnlocked, regularLevelCount());   // 隐藏关不参与补星
    for (let i = 0; i < max; i++) {
      const key = String(i);
      if (!SS.stars[key] || SS.stars[key] < 1) { SS.stars[key] = 1; n++; }
    }
    if (n > 0) saveStars();
    return n;
  }
  function saveStars() {
    try { localStorage.setItem(STARS_KEY, JSON.stringify(SS.stars)); return true; }
    catch (e) { setWarning('星级保存失败：本地存储不可用或已满'); return false; }
  }
  function getStars() { return Object.assign(Object.create(null), SS.stars); }
  // 星级分布（v1.11，星图总览面板展示用）：只统计常规关（隐藏关不计星）
  function getStarDistribution() {
    const out = { three: 0, two: 0, one: 0, none: 0 };
    for (let i = 0; i < regularLevelCount(); i++) {
      const v = starsForLevel(i);
      if (v >= 3) out.three++;
      else if (v === 2) out.two++;
      else if (v === 1) out.one++;
      else out.none++;
    }
    return out;
  }
  function starsForLevel(idx) {
    const v = parseInt(SS.stars[String(idx)] || '0', 10);
    return Number.isFinite(v) ? clamp(v, 0, STAR_MAX_PER_LEVEL) : 0;
  }
  function getTotalStars() {
    let sum = 0;
    // SS.stars 是本模块自建的 Object.create(null) 表（键只来自本模块与 JSON.parse），无原型链，无需 hasOwnProperty
    for (const k of Object.keys(SS.stars)) sum += SS.stars[k];
    return sum;
  }
  // 满星上限只统计**常规关**：隐藏关不计星，因此加入隐藏关后满星仍为 40 × 3 = 120。
  // REGULAR_LEVELS 同时用于「挑战模式关卡池」——挑战的递增修饰符只作用于常规关。
  const REGULAR_LEVELS = CAMPAIGN_LEVELS.filter(function (lv) { return !lv.hidden; });
  function regularLevelCount() { return REGULAR_LEVELS.length; }
  function totalStarsMax() { return regularLevelCount() * STAR_MAX_PER_LEVEL; }
  // 隐藏关集合（v1.11）：供「全部隐藏关通关」与「完美星图」判定使用。
  // 通关与否以每关最佳记录里的 won 标记为准（SS.recordRun 对隐藏关照常写入，且 won 只增不减）。
  const HIDDEN_LEVELS = CAMPAIGN_LEVELS.filter(function (lv) { return !!lv.hidden; });
  function countHiddenLevels() { return HIDDEN_LEVELS.length; }
  function getHiddenClearedCount() {
    let n = 0;
    for (let i = 0; i < HIDDEN_LEVELS.length; i++) {
      const idx = CAMPAIGN_LEVELS.indexOf(HIDDEN_LEVELS[i]);
      const rec = SS.recordsByKey['campaign:' + idx];
      if (rec && rec.won) n++;
    }
    return n;
  }
  // ★2 门槛：按本关波数自适应（8~22 波差异大，固定阈值会让长关卡几乎拿不到 2 星）
  function star2HitLimit(totalWaves) {
    const w = Math.max(1, parseInt(totalWaves, 10) || 1);
    return Math.max(STAR2_HIT_MIN, Math.round(w * STAR2_HIT_RATIO));
  }
  function getStarCriteria(levelIndex) {
    const lvl = CAMPAIGN_LEVELS[levelIndex];
    const totalWaves = (lvl && Array.isArray(lvl.waves)) ? lvl.waves.length : 1;
    return {
      totalWaves: totalWaves,
      star2HitLimit: star2HitLimit(totalWaves),
      max: STAR_MAX_PER_LEVEL,
      totalMax: totalStarsMax(),
    };
  }
  // 纯函数：星级只由「模式 + 结束原因 + 受击次数 + 总波数」决定，便于 UI 预览与独立测试。
  // 生存/无尽不计星（保持「比拼累计分数/最高波数」的既有口径不变）；
  // 闯关与挑战（都是固定波次模式）计星，但落在**两张独立表**里，互不影响。
  function computeStars(s) {
    if (!s || (s.mode !== 'campaign' && s.mode !== 'challenge')) return 0;
    if (s.endReason !== 'win') return 0;
    const hits = Math.max(0, parseInt(s.hitCount, 10) || 0);
    if (hits === 0) return STAR_MAX_PER_LEVEL;
    return hits <= star2HitLimit(s.totalWaves) ? 2 : 1;
  }
  // 写入本局星级（只增不减），返回本局获得的星数
  function recordRunStars() {
    // 隐藏关不计星（v1.11）：它们作为"纯挑战"关卡，只记录通关与最佳记录，
    // 不写入星级表，也不参与满星上限与第四章门槛的判定。
    if (SS.isHiddenLevel()) { state.lastStars = 0; return 0; }
    const totalWaves = (state.level && Array.isArray(state.level.waves)) ? state.level.waves.length : 0;
    const earned = computeStars({
      mode: state.mode, endReason: state.endReason, hitCount: state.hitCount, totalWaves: totalWaves,
    });
    state.lastStars = earned;
    if (earned <= 0) return 0;
    const key = String(state.levelIndex);
    // 挑战模式的星写入独立表（不并入闯关总星数：该值同时驱动成就与第四章门槛，
    // 混入挑战星会让两处语义一起漂移）
    if (state.mode === 'challenge') {
      if (earned > (SS.challenge.stars[key] || 0)) {
        SS.challenge.stars[key] = earned;
        SS.saveChallenge();
      }
      return earned;
    }
    if (earned > (SS.stars[key] || 0)) {
      SS.stars[key] = earned;
      saveStars();
    }
    return earned;
  }

  // ===== 成就（P1-C）=====
  // 声明式定义：need(SS.stats) 只读 SS.getCurrentRunStats() 的字段，判定与 UI 完全解耦、可独立测试。
  // v1.13：为每项补 group 字段（枚举 id），供 UI 按 5 组分区展示；分组顺序由 SS.ACHIEVEMENT_GROUPS 给定。
  // 该字段为**只增不改**：判定（need）与存档读写完全不读取它，故不影响任何既有逻辑与测试。

  // ===== 导出到共享命名空间 =====
  SS.LS_KEYS = LS_KEYS;
  SS.setWarning = setWarning;
  SS.takeWarning = takeWarning;
  SS.pushNotice = pushNotice;
  SS.takeNotice = takeNotice;
  SS.loadSettings = loadSettings;
  SS.saveSettings = saveSettings;
  SS.getSettings = getSettings;
  SS.setSetting = setSetting;
  SS.parseStars = parseStars;
  SS.loadStars = loadStars;
  SS.migrateStars = migrateStars;
  SS.saveStars = saveStars;
  SS.getStars = getStars;
  SS.getStarDistribution = getStarDistribution;
  SS.starsForLevel = starsForLevel;
  SS.getTotalStars = getTotalStars;
  SS.REGULAR_LEVELS = REGULAR_LEVELS;
  SS.regularLevelCount = regularLevelCount;
  SS.totalStarsMax = totalStarsMax;
  SS.HIDDEN_LEVELS = HIDDEN_LEVELS;
  SS.countHiddenLevels = countHiddenLevels;
  SS.getHiddenClearedCount = getHiddenClearedCount;
  SS.star2HitLimit = star2HitLimit;
  SS.getStarCriteria = getStarCriteria;
  SS.computeStars = computeStars;
  SS.recordRunStars = recordRunStars;
})();
