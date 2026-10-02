// js/persist.js —— 本地战绩 / 进度：localStorage 读写与查询（v1.13 从 game.js 拆出）
// 依赖 core.js 的常量与全局状态（解构别名）与同层其它文件经 window.SS 暴露的函数。
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    SETTINGS_KEY, DEFAULT_SETTINGS, STARS_KEY, STAR2_HIT_RATIO, STAR2_HIT_MIN,
    STAR_MAX_PER_LEVEL, ACHIEVEMENTS_KEY, CHALLENGE_KEY, DAILY_KEY, TASKS_KEY,
    RECORDS_KEY, STATS_KEY, CAMPAIGN_LEVELS, state, clamp,
    clampInt, bestScore, bestWaves,
  } = SS;

  // ===== 本地战绩 / 进度 =====
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
  // 通关与否以每关最佳记录里的 won 标记为准（recordRun 对隐藏关照常写入，且 won 只增不减）。
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
        saveChallenge();
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
  // v1.13：为每项补 group 字段（枚举 id），供 UI 按 5 组分区展示；分组顺序由 ACHIEVEMENT_GROUPS 给定。
  // 该字段为**只增不改**：判定（need）与存档读写完全不读取它，故不影响任何既有逻辑与测试。
  const ACHIEVEMENTS = [
    { id: 'first_win',    group: 'combat',  name: '初次告捷', desc: '首次通关任意闯关关卡',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' },
    { id: 'no_hit_win',   group: 'combat',  name: '铜墙铁壁', desc: '零受击通关（三星）',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.hits === 0 },
    { id: 'hit_survive',  group: 'combat',  name: '浴火重生', desc: '母星受击 5 次以上仍通关',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.hits >= 5 },
    { id: 'wave_15',      group: 'combat',  name: '波次机器', desc: '单局击退 15 波以上并通关',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.wave >= 15 },
    { id: 'star_30',      group: 'combat',  name: '群星闪耀', desc: '累计获得 30 颗星',
      need: () => getTotalStars() >= 30 },
    { id: 'star_60',      group: 'combat',  name: '星河为证', desc: '累计获得 60 颗星',
      need: () => getTotalStars() >= 60 },
    // 文案修正（v1.11）：判定一直用 totalStarsMax()（现为 40 常规关 × 3 = 120），
    // 旧文案写的 90 是加入第四章前的数字，属"文案与实战不符"，此处改为动态口径。
    { id: 'star_all',     group: 'combat',  name: '完美星域', desc: '集齐全部 ' + (regularLevelCount() * STAR_MAX_PER_LEVEL) + ' 颗星',
      need: () => getTotalStars() >= totalStarsMax() },
    { id: 'clear_50',     group: 'economy', name: '拦截专家', desc: '单局拦截 50 个来袭威胁',
      need: (s) => s.cleared >= 50 },
    { id: 'bh_10',        group: 'economy', name: '黑洞胃王', desc: '单局用黑洞吞噬 10 个威胁',
      need: (s) => s.blackholeSwallowed >= 10 },
    { id: 'no_slow_win',  group: 'economy', name: '从容不迫', desc: '不使用慢动作通关',
      need: (s) => s.endReason === 'win' && s.slowUsedSeconds <= 0 },
    { id: 'thrifty',      group: 'economy', name: '一次成型', desc: '通关过程中不回收、不升级',
      need: (s) => s.endReason === 'win' && s.mode === 'campaign' && s.recycles === 0 && s.upgrades === 0 },
    { id: 'tinkerer',     group: 'economy', name: '机械师', desc: '单局完成 5 次星体升级',
      need: (s) => s.upgrades >= 5 },
    { id: 'eco_win',      group: 'economy', name: '零浪费', desc: '闯关通关且星能结余 ≥ 200',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.budgetLeft >= 200 },
    { id: 'survive_500',  group: 'economy', name: '长明者', desc: '生存模式单局得分 ≥ 500',
      need: (s) => s.mode === 'survival' && s.score >= 500 },
    // ===== v1.11 扩展（+12 项）：覆盖专精 / 协同 / 每日挑战 / 隐藏关 / 任务全清 / 无尽风暴 / 挑战进度 / 完美收集 =====
    // 口径说明：
    //   · 判定只读 SS.getCurrentRunStats() 的字段或本文件内的 getter，与既有成就同构（可独立测试）；
    //   · 无尽成就用 s.wave 而非 SS.bestWaves —— SS.updateBest() 在 evaluateAchievements() **之后**执行，
    //     结算时 SS.bestWaves 还是上一局的值，用它会漏判；
    //   · 协同是小数比率（physics.SYNERGY_TOTAL_MAX = 0.40），故阈值写作 0.30 / 0.40。
    { id: 'spec_giant_5',  group: 'spec',    name: '巨石匠',   desc: '单局放置 5 颗「巨型」专精星体',
      need: (s) => s.specGiantPlaced >= 5 },
    { id: 'spec_switch_3', group: 'spec',    name: '变形者',   desc: '单局完成 3 次专精互转',
      need: (s) => s.specSwitches >= 3 },
    { id: 'synergy_30',    group: 'spec',    name: '引力共振', desc: '单局某颗星体的协同加成达 30%',
      need: (s) => s.synergyMaxBonus >= 0.30 },
    { id: 'synergy_40',    group: 'spec',    name: '满格共振', desc: '单局协同加成打满 40% 上限',
      need: (s) => s.synergyMaxBonus >= 0.40 },
    { id: 'daily_first',   group: 'daily',   name: '今日之星', desc: '首次通关每日挑战',
      need: (s) => s.mode === 'daily' && s.endReason === 'win' },
    { id: 'daily_streak_3', group: 'daily',  name: '三日不辍', desc: '每日挑战连续通关 3 天',
      need: () => getDailyStreak() >= 3 },
    { id: 'hidden_clear',  group: 'daily',   name: '密道探索者', desc: '通关任意隐藏关',
      need: (s) => !!s.hidden && s.endReason === 'win' },
    { id: 'hidden_all',    group: 'daily',   name: '星图尽头', desc: '通关全部隐藏关',
      need: () => countHiddenLevels() > 0 && getHiddenClearedCount() >= countHiddenLevels() },
    { id: 'task_all',      group: 'meta',    name: '使命必达', desc: '完成全部 ' + regularLevelCount() + ' 个常规关的额外任务',
      need: () => regularLevelCount() > 0 && SS.countRegularTasksDone() >= regularLevelCount() },
    { id: 'endless_30',    group: 'meta',    name: '风暴幸存者', desc: '无尽模式坚守 30 波（历经三次风暴）',
      need: (s) => s.mode === 'endless' && s.wave >= 30 },
    { id: 'challenge_10',  group: 'meta',    name: '挑战者',   desc: '挑战模式通关 10 关',
      need: () => getChallengeUnlocked() >= 10 },
    { id: 'perfect',       group: 'meta',    name: '完美星图', desc: '集齐 ' + (regularLevelCount() * STAR_MAX_PER_LEVEL)
        + ' 星、清空全部额外任务与隐藏关',
      need: () => getTotalStars() >= totalStarsMax()
        && regularLevelCount() > 0 && SS.countRegularTasksDone() >= regularLevelCount()
        && countHiddenLevels() > 0 && getHiddenClearedCount() >= countHiddenLevels() },
  ];
  // 成就分组表（v1.13）：数组顺序即 UI 展示顺序；icon 为内联 SVG sprite 的 symbol id。
  const ACHIEVEMENT_GROUPS = [
    { id: 'combat',  label: '通关与星级', icon: 'ic-star' },
    { id: 'economy', label: '操作与经营', icon: 'ic-budget' },
    { id: 'spec',    label: '专精与协同', icon: 'ic-orbit' },
    { id: 'daily',   label: '每日与隐藏关', icon: 'ic-clock' },
    { id: 'meta',    label: '模式与收集', icon: 'ic-trophy' },
  ];
  SS.achievements = Object.create(null);
  SS.pendingAchievements = [];
  function loadAchievements() {
    let raw = null;
    try { raw = localStorage.getItem(ACHIEVEMENTS_KEY); } catch (e) { setWarning('成就存档读取失败：本地存储不可用'); }
    SS.achievements = Object.create(null);
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('成就存档已损坏，已回退为空进度');
      } else {
        for (const k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          // 只接受当前版本仍存在的成就 id（旧版本残留键直接忽略）
          if (ACHIEVEMENTS.some(a => a.id === k)) SS.achievements[k] = obj[k] || Date.now();
        }
      }
    }
    SS.pendingAchievements = [];
    return getAchievementList();
  }
  function saveAchievements() {
    try { localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(SS.achievements)); return true; }
    catch (e) { setWarning('成就保存失败：本地存储不可用或已满'); return false; }
  }
  function getAchievementList() {
    return ACHIEVEMENTS.map(a => ({
      id: a.id, group: a.group, name: a.name, desc: a.desc,
      unlocked: !!SS.achievements[a.id],
      time: SS.achievements[a.id] || 0,
    }));
  }
  // 幂等解锁：已解锁项直接跳过；判定抛异常按"未达成"处理，绝不打断结算流程。
  function evaluateAchievements(stats) {
    const s = stats || SS.getCurrentRunStats();
    const unlocked = [];
    for (const a of ACHIEVEMENTS) {
      if (SS.achievements[a.id]) continue;
      let hit = false;
      try { hit = !!a.need(s); } catch (e) { hit = false; }
      if (hit) {
        SS.achievements[a.id] = Date.now();
        unlocked.push({ id: a.id, name: a.name, desc: a.desc });
      }
    }
    if (unlocked.length) {
      SS.pendingAchievements = SS.pendingAchievements.concat(unlocked);
      saveAchievements();
    }
    return { unlocked: unlocked, total: ACHIEVEMENTS.length, count: Object.keys(SS.achievements).length };
  }
  // 供 UI 一次性取走"本次新解锁"（与 takeWarning / takeNotice 同构）
  function takeNewAchievements() {
    const list = SS.pendingAchievements;
    SS.pendingAchievements = [];
    return list;
  }

  // ===== 模式单一真源（v1.10）=====
  // 固定波次模式：关卡自带 waves 数组、有明确终局（击退全部波次即通关）。
  // 胜利判定 / HUD 波次显示 / 道具配额 / 波次道具补给 / 统计口径都读它，
  // 避免"新增模式后某处仍按 campaign 判断"造成隐形缺陷（本批次最大的风险来源）。
  function isFixedWaveMode(mode) {
    const m = mode || state.mode;
    return m === 'campaign' || m === 'challenge' || m === 'daily';
  }

  // ===== 挑战修饰符（v1.10）=====
  // 声明式定义；各个拦截点只读 hasModifier()，不在别处自行推导规则。
  const MODIFIERS = [
    { id: 'noProps',     name: '禁道具',     desc: '本局不发放任何道具' },
    { id: 'fastThreats', name: '来袭加速',   desc: '所有来袭威胁速度 ×1.5' },
    { id: 'halfBudget',  name: '星能减半',   desc: '初始星能只有一半' },
    { id: 'noBlackhole', name: '禁黑洞',     desc: '不能放置黑洞' },
    { id: 'noRecycle',   name: '禁回收升级', desc: '不能回收或升级星体' },
    { id: 'noSlow',      name: '禁减速',     desc: '本局没有减速额度' },
  ];
  const MODIFIER_ORDER = MODIFIERS.map(m => m.id);
  // 挑战模式：按关卡序号确定性挂载递增修饰符（每 6 关加一条，上限 5 条）。
  // 确定性是硬要求——"挑战模式第 N 关"对所有玩家必须是同一套规则。
  function challengeModifiersFor(levelIndex) {
    const idx = Math.max(0, parseInt(levelIndex, 10) || 0);
    const n = Math.min(5, 1 + Math.floor(idx / 6));
    return MODIFIER_ORDER.slice(0, n);
  }
  function modifierDefs(ids) {
    const list = Array.isArray(ids) ? ids : [];
    return list.map(id => {
      const d = MODIFIERS.filter(m => m.id === id)[0];
      return d ? { id: d.id, name: d.name, desc: d.desc } : { id: String(id), name: String(id), desc: '' };
    });
  }
  function hasModifier(id) {
    return Array.isArray(state.modifiers) && state.modifiers.indexOf(id) >= 0;
  }
  function getActiveModifiers() { return modifierDefs(state.modifiers); }

  // ===== 每关额外任务（v1.10）=====
  // 与成就同构：声明式判定、只读结算统计、幂等存档（只增不减）。
  // 语义：**只判不罚**——达成不给星、不返还星能，因此不改变任何一关的既有平衡与可达性。
  const TASK_CHECKS = {
    noProp:      (s) => s.propsUsed === 0,
    noSlow:      (s) => s.slowUsedSeconds <= 0,
    noBlackhole: (s) => s.blackholesPlaced === 0,
    noRecycle:   (s) => s.recycles === 0 && s.upgrades === 0,
    thrifty:     (s) => s.budgetLeft >= Math.round((s.levelBudget || 0) * 0.5),
    noHit:       (s) => s.hits === 0,
  };
  SS.tasksDone = Object.create(null);        // { "<mode>:<idx>": true }
  function taskKey(mode, levelIndex) {
    const m = mode || state.mode;
    const idx = parseInt(levelIndex, 10);
    return String(m) + ':' + (Number.isFinite(idx) ? idx : state.levelIndex);
  }
  function loadTasks() {
    let raw = null;
    try { raw = localStorage.getItem(TASKS_KEY); } catch (e) { setWarning('任务存档读取失败：本地存储不可用'); }
    SS.tasksDone = Object.create(null);
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('任务存档已损坏，已回退为空进度');
      } else {
        for (const k in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k]) SS.tasksDone[k] = true;
        }
      }
    }
    return getTasksDoneCount();
  }
  function saveTasks() {
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(SS.tasksDone)); return true; }
    catch (e) { setWarning('任务保存失败：本地存储不可用或已满'); return false; }
  }
  function isTaskDone(mode, levelIndex) { return !!SS.tasksDone[taskKey(mode, levelIndex)]; }
  function getTasksDoneCount() { return Object.keys(SS.tasksDone).length; }
  // 本局任务判定（仅固定波次模式；未通关不判定、不记录）
  function recordRunTask() {
    const lvl = state.level;
    if (!isFixedWaveMode() || !lvl || !lvl.task) {
      return { done: false, already: false, id: '', text: '' };
    }
    const key = taskKey();
    const already = !!SS.tasksDone[key];
    if (state.endReason !== 'win') return { done: false, already: already, id: lvl.task.id, text: lvl.task.text };
    const check = TASK_CHECKS[lvl.task.id];
    let hit = false;
    try { hit = !!check(SS.getCurrentRunStats()); } catch (e) { hit = false; }
    if (!hit) return { done: false, already: already, id: lvl.task.id, text: lvl.task.text };
    if (!already) { SS.tasksDone[key] = true; saveTasks(); }
    return { done: true, already: already, id: lvl.task.id, text: lvl.task.text };
  }

  // ===== 每关最佳记录（v1.10）=====
  // 键为 "<mode>:<idx>"：闯关 / 挑战 / 每日 / 生存 / 无尽 各自独立，互不干扰。
  SS.recordsByKey = Object.create(null);
  function loadRecords() {
    let raw = null;
    try { raw = localStorage.getItem(RECORDS_KEY); } catch (e) { setWarning('最佳记录读取失败：本地存储不可用'); }
    SS.recordsByKey = Object.create(null);
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('最佳记录已损坏，已回退为空进度');
      } else {
        for (const k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          const v = obj[k];
          if (!v || typeof v !== 'object') continue;
          SS.recordsByKey[k] = {
            bestScore: Math.max(0, Math.round(Number(v.bestScore) || 0)),
            leastHits: Math.max(0, Math.round(Number(v.leastHits) || 0)),
            fastestWin: Math.max(0, Math.round(Number(v.fastestWin) || 0)),
            won: !!v.won,
            plays: Math.max(0, Math.round(Number(v.plays) || 0)),
          };
        }
      }
    }
    return Object.keys(SS.recordsByKey).length;
  }
  function saveRecords() {
    try { localStorage.setItem(RECORDS_KEY, JSON.stringify(SS.recordsByKey)); return true; }
    catch (e) { setWarning('最佳记录保存失败：本地存储不可用或已满'); return false; }
  }
  function getRecord(mode, levelIndex) {
    return SS.recordsByKey[taskKey(mode, levelIndex)] || null;
  }
  // 结算时择优写入；返回 { record, newBest } 供结算面板展示"新纪录"
  function recordRun() {
    if (!state.level) return null;
    const key = taskKey();
    const cur = SS.recordsByKey[key] || null;
    const score = SS.integerScore();
    const hits = Math.max(0, state.hitCount);
    const won = state.endReason === 'win';
    const duration = Math.max(0, Math.round(state.gameTime));
    const next = cur ? Object.assign({}, cur) : { bestScore: 0, leastHits: 0, fastestWin: 0, won: false, plays: 0 };
    const newBest = { score: false, leastHits: false, fastestWin: false, first: !cur };
    if (!cur || score > next.bestScore) { if (cur) newBest.score = true; next.bestScore = score; }
    if (!cur || hits < next.leastHits) { if (cur) newBest.leastHits = true; next.leastHits = hits; }
    if (won && (!next.won || !next.fastestWin || duration < next.fastestWin)) {
      if (next.won && next.fastestWin > 0) newBest.fastestWin = true;
      next.fastestWin = duration;
    }
    next.won = next.won || won;
    next.plays += 1;
    SS.recordsByKey[key] = next;
    saveRecords();
    return { record: Object.assign({}, next), newBest: newBest };
  }

  // ===== 累计统计（v1.11；v1.13 移除本机榜单，仅保留累计统计）=====
  // 单一存档键 STATS_KEY，结构：
  //   { v: 1,
  //     totals: { plays:{mode:n}, wins:{mode:n}, timeSec, intercepted, hits, SS.bestScore, bestWaves: SS.bestWaves } }
  // 设计取舍：累计统计是"只增"的展示型数据。旧存档中的 boards 字段会被自然忽略（向后兼容）。
  // 写入时机：仅结算期（SS.endGame），主循环零开销。
  const STATS_MODES = ['survival', 'campaign', 'challenge', 'endless', 'daily'];
  const MODE_NAMES = { survival: '生存', campaign: '闯关', challenge: '挑战', endless: '无尽', daily: '每日' };
  function emptyStats() {
    const plays = Object.create(null), wins = Object.create(null);
    for (let i = 0; i < STATS_MODES.length; i++) {
      plays[STATS_MODES[i]] = 0;
      wins[STATS_MODES[i]] = 0;
    }
    return {
      v: 1,
      totals: {
        plays: plays, wins: wins, timeSec: 0, intercepted: 0, hits: 0,
        bestScore: 0, bestWaves: 0,
      },
    };
  }
  SS.stats = emptyStats();
  function statsInt(v) { return Math.max(0, Math.round(Number(v) || 0)); }
  function loadStats() {
    let raw = null;
    try { raw = localStorage.getItem(STATS_KEY); } catch (e) { setWarning('统计读取失败：本地存储不可用'); }
    SS.stats = emptyStats();
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('统计存档已损坏，已回退为空进度');
      } else {
        const t = (obj.totals && typeof obj.totals === 'object') ? obj.totals : {};
        const tp = (t.plays && typeof t.plays === 'object') ? t.plays : {};
        const tw = (t.wins && typeof t.wins === 'object') ? t.wins : {};
        for (let i = 0; i < STATS_MODES.length; i++) {
          const m = STATS_MODES[i];
          SS.stats.totals.plays[m] = statsInt(tp[m]);
          SS.stats.totals.wins[m] = statsInt(tw[m]);
        }
        SS.stats.totals.timeSec = statsInt(t.timeSec);
        SS.stats.totals.intercepted = statsInt(t.intercepted);
        SS.stats.totals.hits = statsInt(t.hits);
        SS.stats.totals.bestScore = statsInt(t.bestScore);
        SS.stats.totals.bestWaves = statsInt(t.bestWaves);
      }
    }
    return getStatsTotals();
  }
  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(SS.stats)); return true; }
    catch (e) { setWarning('统计保存失败：本地存储不可用或已满'); return false; }
  }
  function getStatsTotals() {
    const t = SS.stats.totals;
    const plays = {}, wins = {};
    for (let i = 0; i < STATS_MODES.length; i++) {
      const m = STATS_MODES[i];
      plays[m] = t.plays[m] || 0;
      wins[m] = t.wins[m] || 0;
    }
    return {
      plays: plays, wins: wins,
      timeSec: t.timeSec || 0, intercepted: t.intercepted || 0, hits: t.hits || 0,
      bestScore: t.bestScore || 0, bestWaves: t.bestWaves || 0,
    };
  }
  // 累计统计累加（每局一次）。调用点：SS.endGame() 末尾 —— 该函数顶部有 gameOver 幂等护栏，
  // 因此这里无需再判重；整段 try/catch 包裹，失败只提示、绝不影响结算面板。
  function accumulateStats() {
    const mode = state.mode;
    if (STATS_MODES.indexOf(mode) < 0) return null;
    try {
      SS.stats.totals.plays[mode] = (SS.stats.totals.plays[mode] || 0) + 1;
      if (state.endReason === 'win') SS.stats.totals.wins[mode] = (SS.stats.totals.wins[mode] || 0) + 1;
      SS.stats.totals.timeSec = statsInt(SS.stats.totals.timeSec + Math.max(0, state.gameTime));
      SS.stats.totals.intercepted = statsInt(SS.stats.totals.intercepted + Math.max(0, state.asteroidsCleared));
      SS.stats.totals.hits = statsInt(SS.stats.totals.hits + Math.max(0, state.hitCount));
      const sc = SS.integerScore();
      if (sc > SS.stats.totals.bestScore) SS.stats.totals.bestScore = sc;
      if (mode === 'endless' && state.wave > SS.stats.totals.bestWaves) SS.stats.totals.bestWaves = statsInt(state.wave);
      saveStats();
      return getStatsTotals();
    } catch (e) {
      setWarning('统计累加失败：本地存储不可用');
      return null;
    }
  }
  function getModeNames() { return Object.assign({}, MODE_NAMES); }

  // ===== 挑战模式进度存档（v1.10）=====
  // { unlocked, stars: {"<idx>":1|2|3}, best: {"<idx>":{SS.bestScore,leastHits,fastestWin,won,plays}} }
  // 挑战星**不并入** getTotalStars()：闯关星级同时驱动成就与第四章门槛，混入会污染两处语义。
  SS.challenge = { unlocked: 0, stars: Object.create(null), best: Object.create(null) };
  function parseChallenge(raw) {
    const out = { unlocked: 0, stars: Object.create(null), best: Object.create(null) };
    if (!raw) return out;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    if (!obj || typeof obj !== 'object') {
      setWarning('挑战存档已损坏，已回退为空进度');   // 损坏不静默（M7 口径）
      return out;
    }
    // 挑战模式的关卡池是 40 个常规关（REGULAR_LEVELS，**不含隐藏关**）：
    // unlocked 允许等于池长度（表示"40 关已全部通关"），但索引必须 < 池长度才可进入。
    // 旧实现误用 CAMPAIGN_LEVELS.length（42），会让篡改后的存档解锁不存在的索引 40/41。
    out.unlocked = clampInt(obj.unlocked, 0, REGULAR_LEVELS.length);
    if (obj.stars && typeof obj.stars === 'object') {
      for (const k in obj.stars) {
        if (!Object.prototype.hasOwnProperty.call(obj.stars, k)) continue;
        const idx = parseInt(k, 10);
        const v = parseInt(obj.stars[k], 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= REGULAR_LEVELS.length) continue;
        if (!Number.isFinite(v) || v <= 0) continue;
        out.stars[String(idx)] = clamp(v, 1, STAR_MAX_PER_LEVEL);
      }
    }
    if (obj.best && typeof obj.best === 'object') {
      for (const k in obj.best) {
        if (!Object.prototype.hasOwnProperty.call(obj.best, k)) continue;
        const idx = parseInt(k, 10);
        const v = obj.best[k];
        if (!Number.isFinite(idx) || idx < 0 || idx >= REGULAR_LEVELS.length) continue;
        if (!v || typeof v !== 'object') continue;
        out.best[String(idx)] = {
          bestScore: Math.max(0, Math.round(Number(v.bestScore) || 0)),
          leastHits: Math.max(0, Math.round(Number(v.leastHits) || 0)),
          fastestWin: Math.max(0, Math.round(Number(v.fastestWin) || 0)),
          won: !!v.won,
          plays: Math.max(0, Math.round(Number(v.plays) || 0)),
        };
      }
    }
    return out;
  }
  function loadChallenge() {
    let raw = null;
    try { raw = localStorage.getItem(CHALLENGE_KEY); } catch (e) { setWarning('挑战存档读取失败：本地存储不可用'); }
    SS.challenge = parseChallenge(raw);
    return getChallengeUnlocked();
  }
  function saveChallenge() {
    try { localStorage.setItem(CHALLENGE_KEY, JSON.stringify(SS.challenge)); return true; }
    catch (e) { setWarning('挑战存档保存失败：本地存储不可用或已满'); return false; }
  }
  function getChallengeUnlocked() { return SS.challenge.unlocked; }
  // 挑战可进入的索引必须**同时**满足：在已解锁进度内，且落在挑战关卡池内（0..39）。
  // 实测缺陷（v1.12 修复）：旧实现只判 `i <= challenge.unlocked`，而 unlockNextChallenge 用
  // CAMPAIGN_LEVELS.length(42) 作上界 → 通关第 40 关后 unlocked=40，isChallengeUnlocked(40) 为 true，
  // 结算面板「下一关」据此调用 SS.startGame(40) → 关卡池只有 0..39 → 静默失败（点了没反应）。
  function isChallengeUnlocked(idx) {
    const i = parseInt(idx, 10);
    return Number.isFinite(i) && i >= 0 && i < REGULAR_LEVELS.length && i <= SS.challenge.unlocked;
  }
  function unlockNextChallenge() {
    if (state.mode !== 'challenge') return;
    const next = state.levelIndex + 1;
    // 允许 unlocked 推进到池长度（= 40，表示"挑战 40 关已全部通关"，SS.bestDisplay 文案据此显示），
    // 但不得超过池长度（索引 40/41 在挑战池里并不存在，属越界进度）。
    if (next > SS.challenge.unlocked && next <= REGULAR_LEVELS.length) {
      SS.challenge.unlocked = next;
      saveChallenge();
    }
  }
  function challengeStarsForLevel(idx) {
    const v = parseInt(SS.challenge.stars[String(idx)] || '0', 10);
    return Number.isFinite(v) ? clamp(v, 0, STAR_MAX_PER_LEVEL) : 0;
  }
  function getChallengeStarsTotal() {
    let sum = 0;
    for (const k of Object.keys(SS.challenge.stars)) sum += SS.challenge.stars[k];
    return sum;
  }
  // 挑战成绩与闯关共用同一套择优逻辑，但落在独立的 best 表里
  function recordChallengeRun() {
    if (state.mode !== 'challenge') return null;
    const key = String(state.levelIndex);
    const cur = SS.challenge.best[key] || null;
    const score = SS.integerScore();
    const hits = Math.max(0, state.hitCount);
    const won = state.endReason === 'win';
    const duration = Math.max(0, Math.round(state.gameTime));
    const next = cur ? Object.assign({}, cur) : { bestScore: 0, leastHits: 0, fastestWin: 0, won: false, plays: 0 };
    if (!cur || score > next.bestScore) next.bestScore = score;
    if (!cur || hits < next.leastHits) next.leastHits = hits;
    if (won && (!next.won || !next.fastestWin || duration < next.fastestWin)) next.fastestWin = duration;
    next.won = next.won || won;
    next.plays += 1;
    SS.challenge.best[key] = next;
    saveChallenge();
    return Object.assign({}, next);
  }
  function getChallengeBest(idx) { return SS.challenge.best[String(idx)] || null; }

  // ===== 每日挑战存档（v1.10；v1.11 增加连胜）=====
  // 只保存"当天"的成绩；读取时若日期已变（跨日）会自动重置，无需定时器。
  // v1.11 扩展三个**跨日保留**的元数据（不随当日成绩重置）：
  //   streak       连续通关天数（同一日期重复通关只记一次，保证幂等）
  //   lastCleared  最近一次通关的日期键
  //   clearedTotal 累计通关天数
  const DAILY_EMPTY = {
    date: '', cleared: false, bestScore: 0, bestWave: 0,
    streak: 0, lastCleared: '', clearedTotal: 0,
  };
  function emptyDaily() { return Object.assign({}, DAILY_EMPTY); }
  SS.daily = emptyDaily();
  SS.dailyCache = null;                     // { key, level }：同一日期内复用同一关卡对象
  function dailyKeyOf(now) {
    const d = (now instanceof Date) ? now : new Date();
    const m = d.getMonth() + 1, day = d.getDate();
    return String(d.getFullYear()) + (m < 10 ? '0' + m : m) + (day < 10 ? '0' + day : day);
  }
  function getDailyKey() {
    try { return dailyKeyOf(new Date()); } catch (e) { return '00000000'; }
  }
  // 日期键算术：返回 dateKey 的前一天键（连胜判定用）。非法输入返回 ''。
  // 用 Date 完成进位（自动处理月末/闰年），避免手写日历规则出错。
  function prevDailyKey(dateKey) {
    const s = String(dateKey == null ? '' : dateKey).replace(/[^0-9]/g, '');
    if (s.length !== 8) return '';
    const y = parseInt(s.slice(0, 4), 10), m = parseInt(s.slice(4, 6), 10), d = parseInt(s.slice(6, 8), 10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
    try {
      const dt = new Date(y, m - 1, d);
      dt.setDate(dt.getDate() - 1);
      const mm = dt.getMonth() + 1, dd = dt.getDate();
      return String(dt.getFullYear()) + (mm < 10 ? '0' + mm : mm) + (dd < 10 ? '0' + dd : dd);
    } catch (e) { return ''; }
  }
  function getDailyStreak() { return Math.max(0, Math.round(Number(SS.daily.streak) || 0)); }
  function loadDaily() {
    let raw = null;
    try { raw = localStorage.getItem(DAILY_KEY); } catch (e) { setWarning('每日挑战存档读取失败：本地存储不可用'); }
    SS.daily = emptyDaily();
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('每日挑战存档已损坏，已回退为空进度');
      } else {
        // 连胜元数据跨日保留（旧版存档缺这三个字段时按默认值回退，不视为损坏）
        SS.daily.streak = Math.max(0, Math.round(Number(obj.streak) || 0));
        SS.daily.lastCleared = String(obj.lastCleared || '');
        SS.daily.clearedTotal = Math.max(0, Math.round(Number(obj.clearedTotal) || 0));
        // 当日成绩只在日期键匹配时恢复（跨日即视为新的一天）
        if (String(obj.date || '') === getDailyKey()) {
          SS.daily.date = String(obj.date);
          SS.daily.cleared = !!obj.cleared;
          SS.daily.bestScore = Math.max(0, Math.round(Number(obj.bestScore) || 0));
          SS.daily.bestWave = Math.max(0, Math.round(Number(obj.bestWave) || 0));
        }
      }
    }
    return getDailyState();
  }
  function saveDaily() {
    try { localStorage.setItem(DAILY_KEY, JSON.stringify(SS.daily)); return true; }
    catch (e) { setWarning('每日挑战保存失败：本地存储不可用或已满'); return false; }
  }
  function getDailyState() {
    const key = getDailyKey();
    const fresh = (SS.daily.date !== key);
    return {
      key: key,
      date: fresh ? key : SS.daily.date,
      cleared: fresh ? false : SS.daily.cleared,
      bestScore: fresh ? 0 : SS.daily.bestScore,
      bestWave: fresh ? 0 : SS.daily.bestWave,
      // v1.11：连胜元数据不受"跨日重置当日成绩"的影响
      streak: getDailyStreak(),
      lastCleared: SS.daily.lastCleared || '',
      clearedTotal: Math.max(0, Math.round(Number(SS.daily.clearedTotal) || 0)),
      level: getDailyLevel(),
    };
  }
  // 当天的确定性关卡（由 levels-campaign.js 的 makeDailyChallenge 生成；同一天复用同一对象）
  function getDailyLevel() {
    const key = getDailyKey();
    if (SS.dailyCache && SS.dailyCache.key === key) return SS.dailyCache.level;
    let level = null;
    // levels-campaign.js 恒定导出 makeDailyChallenge；try/catch 保留（生成器异常时回退空关卡并提示）
    try { level = window.makeDailyChallenge(key); } catch (e) { level = null; }
    if (!level) setWarning('每日挑战关卡生成失败');
    SS.dailyCache = { key: key, level: level };
    return level;
  }
  function recordDaily() {
    const key = getDailyKey();
    // 跨日：只重置"当日成绩"，连胜元数据必须保留（否则连胜永远只能是 1）
    if (SS.daily.date !== key) {
      const keep = { streak: getDailyStreak(), lastCleared: SS.daily.lastCleared, clearedTotal: SS.daily.clearedTotal };
      SS.daily = Object.assign(emptyDaily(), keep);
      SS.daily.date = key;
    }
    const score = SS.integerScore();
    const won = state.endReason === 'win';
    const newBest = { score: score > SS.daily.bestScore, wave: state.wave > SS.daily.bestWave };
    SS.daily.bestScore = Math.max(SS.daily.bestScore, score);
    SS.daily.bestWave = Math.max(SS.daily.bestWave, state.wave);
    SS.daily.cleared = SS.daily.cleared || won;
    // 连胜推进（幂等）：同一天重复通关只记一次，避免"刷连胜"
    let streakUp = false;
    if (won && SS.daily.lastCleared !== key) {
      SS.daily.streak = (SS.daily.lastCleared === prevDailyKey(key)) ? getDailyStreak() + 1 : 1;
      SS.daily.lastCleared = key;
      SS.daily.clearedTotal = Math.max(0, Math.round(Number(SS.daily.clearedTotal) || 0)) + 1;
      streakUp = true;
    }
    saveDaily();
    return { state: getDailyState(), newBest: newBest, streakUp: streakUp };
  }

  // ===== 星体回收与就地升级（P1-B）=====
  // 与「撤销」的语义边界：撤销＝放置后 5 游戏秒内、全额返还、自动失效（纠错）；
  // 回收＝任意时刻、返还 70%、有代价（战术腾挪）。两者互不改写对方的数组与存档。

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
  SS.ACHIEVEMENTS = ACHIEVEMENTS;
  SS.ACHIEVEMENT_GROUPS = ACHIEVEMENT_GROUPS;
  SS.loadAchievements = loadAchievements;
  SS.saveAchievements = saveAchievements;
  SS.getAchievementList = getAchievementList;
  SS.evaluateAchievements = evaluateAchievements;
  SS.takeNewAchievements = takeNewAchievements;
  SS.isFixedWaveMode = isFixedWaveMode;
  SS.MODIFIERS = MODIFIERS;
  SS.MODIFIER_ORDER = MODIFIER_ORDER;
  SS.challengeModifiersFor = challengeModifiersFor;
  SS.modifierDefs = modifierDefs;
  SS.hasModifier = hasModifier;
  SS.getActiveModifiers = getActiveModifiers;
  SS.TASK_CHECKS = TASK_CHECKS;
  SS.taskKey = taskKey;
  SS.loadTasks = loadTasks;
  SS.saveTasks = saveTasks;
  SS.isTaskDone = isTaskDone;
  SS.getTasksDoneCount = getTasksDoneCount;
  SS.recordRunTask = recordRunTask;
  SS.loadRecords = loadRecords;
  SS.saveRecords = saveRecords;
  SS.getRecord = getRecord;
  SS.recordRun = recordRun;
  SS.STATS_MODES = STATS_MODES;
  SS.MODE_NAMES = MODE_NAMES;
  SS.emptyStats = emptyStats;
  SS.statsInt = statsInt;
  SS.loadStats = loadStats;
  SS.saveStats = saveStats;
  SS.getStatsTotals = getStatsTotals;
  SS.accumulateStats = accumulateStats;
  SS.getModeNames = getModeNames;
  SS.parseChallenge = parseChallenge;
  SS.loadChallenge = loadChallenge;
  SS.saveChallenge = saveChallenge;
  SS.getChallengeUnlocked = getChallengeUnlocked;
  SS.isChallengeUnlocked = isChallengeUnlocked;
  SS.unlockNextChallenge = unlockNextChallenge;
  SS.challengeStarsForLevel = challengeStarsForLevel;
  SS.getChallengeStarsTotal = getChallengeStarsTotal;
  SS.recordChallengeRun = recordChallengeRun;
  SS.getChallengeBest = getChallengeBest;
  SS.DAILY_EMPTY = DAILY_EMPTY;
  SS.emptyDaily = emptyDaily;
  SS.dailyKeyOf = dailyKeyOf;
  SS.getDailyKey = getDailyKey;
  SS.prevDailyKey = prevDailyKey;
  SS.getDailyStreak = getDailyStreak;
  SS.loadDaily = loadDaily;
  SS.saveDaily = saveDaily;
  SS.getDailyState = getDailyState;
  SS.getDailyLevel = getDailyLevel;
  SS.recordDaily = recordDaily;
})();
