(function () {
  'use strict';

  // ===== 常量 =====
  const DT = 1 / 60;              // 固定物理步长(s)：主循环按真实时间累加，攒够一步才推进
  const MAX_SUBSTEPS = 3;         // 单帧最多补 3 个物理步（防止卡顿后追帧雪崩）
  const MAX_FRAME_DT = 0.25;      // 单帧真实时间上限(s)（切后台回来时防止一次补太多）
  let stepAccumulator = 0;        // 未消耗的真实时间（秒）
  const BASE_HEALTH = 20;
  // 场上玩家星体上限：物理 stepSystem 与预测模拟都是 O(N²)，星能无限时无上限会直接卡死页面
  const MAX_PLACED_BODIES = 60;
  // 场上天体总数上限（玩家星体 + 威胁 + 场景机关 + Boss/分裂子体 + 道具场）。
  // 物理与预测都是 O(N²)，必须有总闸：超限时"不出生"而不是让页面卡死。
  const MAX_TOTAL_BODIES = 90;
  // ===== 一次性道具（P2）=====
  // 保持「不能用武器」的核心设定：道具全部是引力/空间机制（不引入"击碎弹"这类武器）。
  // 引力脉冲在 physics 层以「临时强引力井天体」实现（预测自动一致）；
  // 斥力波是瞬时冲量（一次性事件，不进预测，README 已说明）；凝滞是全局短时减速。
  const PROP_DEFS = [
    { id: 'gravityWell', name: '引力脉冲', desc: '临时强引力井，吸附并偏转来袭威胁' },
    { id: 'repulseWave', name: '斥力波', desc: '把附近来袭威胁推离母星（瞬时冲量）' },
    { id: 'stasis', name: '凝滞', desc: '短时全局减速，不消耗减速额度' },
  ];
  const PROP_WELL_LIFE = 3.0;         // 引力井存活时长（游戏秒）
  const PROP_WELL_MASS = 6000;        // 引力井质量（强引力）
  const PROP_REPULSE_RADIUS = 320;    // 斥力波作用半径(px)
  const PROP_REPULSE_POWER = 240;     // 斥力波冲量基数(px/s)
  const STASIS_FACTOR = 0.35;         // 凝滞时的时间倍率
  const STASIS_DURATION = 3.0;        // 凝滞持续（真实秒）
  const PROP_MAX_EACH = 3;            // 单个道具持有上限
  // 单波超时（游戏秒）：队列吐空后仍无法清场（威胁被引力拘禁在稳定轨道）时强制收编，避免软锁
  const WAVE_TIMEOUT = 40;
  // 玩家黑洞：存活时长与消失前收缩动画时长（均为游戏时钟秒，见 M1）
  const BLACKHOLE_LIFE = 10;
  const BLACKHOLE_FADE = 1.5;
  // 粒子总量上限（超出时淘汰最旧粒子，避免同帧大量爆炸造成内存/绘制尖峰）
  const MAX_PARTICLES = 800;
  // 减速额度（P0-1）：慢动作由「无限开关」改为有限资源，避免常开 0.25× 把 30 关的
  // 递增难度（血量 28→16 / 星能 650→380 / 波数 8→22 / 难度 0.50→1.45）整体抹平。
  // 扣减口径为真实帧时间：1 秒额度 = 1 秒真实减速，玩家成本可预期；
  // 每清空一波返还一部分，鼓励「打得干净 → 换取从容布防的时间」。
  const SLOW_QUOTA_MAX = 15;          // 额度上限（秒）
  const SLOW_REFUND_PER_WAVE = 3;     // 每清空一波返还（秒）
  const SLOW_LOW_RATIO = 0.25;        // 低于该比例视为「低额度」（UI 转琥珀色）
  // 撤销最近放置（P0-2）：时间窗按游戏时钟计（慢动作下窗口按比例延长），
  // 且只允许撤销「最近一颗仍在场上」的星体——保留布防决策的重量，不当零成本试错工具。
  const UNDO_WINDOW = 5;              // 撤销时间窗（游戏秒）
  const UNDO_HISTORY_MAX = 20;        // 历史条目上限（防长局无限增长）
  // 设置存档（P0-4）：单一 JSON 键。音效开关仍由 audio.js 自管 starshield_audio，
  // 不迁入此处，避免双写与音效状态被设置存档覆盖。
  const SETTINGS_KEY = 'starshield_settings';
  const DEFAULT_SETTINGS = { showHint: true, showWarnings: true };
  // ===== 星级评价（P1-A，对标塔防 3 星制）=====
  // 仅闯关模式计星：★1 通关 / ★2 通关且受击 ≤ 自适应阈值 / ★3 零受击。
  // 阈值必须"保证可达"，故按本关波数自适应并设下限（不同关卡波数 8~22 差异很大，
  // 固定阈值会让长关卡几乎不可能拿到 2 星）。
  const STARS_KEY = 'starshield_stars';
  const STAR2_HIT_RATIO = 0.5;      // ★2 门槛 = round(波数 × 0.5)
  const STAR2_HIT_MIN = 2;          // 但至少允许受击 2 次
  const STAR_MAX_PER_LEVEL = 3;
  // ===== 回收 / 升级（P1-B）=====
  // 与既有「撤销」语义严格区分：撤销＝放置后 5 游戏秒内、全额、纠错；
  // 回收＝任意时刻、返还 70%、战术腾挪（有代价）。
  const RECYCLE_REFUND_RATIO = 0.7;
  const UPGRADE_CHAIN = ['small', 'mid', 'large', 'star'];   // 升级链（黑洞不参与）
  const BODY_PICK_PAD = 8;          // 点选星体的命中放宽（px，便于触屏）
  // ===== 成就（P1-C）=====
  const ACHIEVEMENTS_KEY = 'starshield_achievements';
  // ===== v1.10 新增存档键（挑战 / 每日挑战 / 额外任务 / 每关最佳记录）=====
  const CHALLENGE_KEY = 'starshield_challenge';
  const DAILY_KEY = 'starshield_daily';
  const TASKS_KEY = 'starshield_tasks';
  const RECORDS_KEY = 'starshield_records';
  // ===== v1.12 新增存档键（历史榜单 + 累计统计，共用一个键）=====
  const STATS_KEY = 'starshield_stats';
  // 第四章（新增内容）的解锁门槛：通关第 30 关之后，还需累计星星达到门槛。
  // 只作用于 idx >= 30 的新关卡——前 30 关的解锁语义与可达性逐位不变（不做进度倒退）。
  // 老存档经 migrateStars 迁移后通常已有 30 星，回玩若干关拿到 2-3 星即可达标。
  const CH4_START = 30;
  const CH4_STAR_GATE = 40;
  // ===== v1.11：星体专精与隐藏关 =====
  const DEFAULT_SPEC = 'gravity';      // 默认专精（= 基准值，与历史行为一致）
  const HIDDEN_STAR_GATE = 100;        // 隐藏关 1 的解锁门槛（满星 120 的 5/6）
  const HIDDEN_TASK_NEED = 40;         // 隐藏关 2 的解锁门槛（40 个常规关的额外任务全清）
  // 母星与玩家星体之间最小距离（半径 + 缓冲）。
  // 必须与 input.js 的 isInsidePlanet 使用同一个值，避免判定不一致。
  const PLANET_FORBIDDEN_PAD = 34;     // px
  const PLANET_FORBIDDEN_RADIUS = () =>
    state.bodies[0] ? state.bodies[0].radius + PLANET_FORBIDDEN_PAD : 64;

  // ===== 关卡定义 =====
  // 生存模式用 SURVIVAL_LEVELS 中的某一个作为起始，循环复用（共享同一关卡池）
  // 闯关模式按 idx 逐关解锁：需通关前一关才能开启下一关（保存在 localStorage）
  const SURVIVAL_LEVELS = [
    {
      id: 'sv-1', name: '和平年代', desc: '空白试炼，60秒攒分',
      intro: '宁静星海，母星孤悬。在 60 秒限时内熟悉引力布防，尽可能多地拦截来袭陨石。',
      objective: '存活 60 秒，尽可能多地拦截来袭威胁',
      failCondition: '母星生命值（20 点）归零',
      health: 20, budget: 99999, duration: 60,
      waves: { startInterval: 2.0, endInterval: 0.7, intervalDrop: 0.04,
               startDifficulty: 0.30, endDifficulty: 1.0, difficultyRamp: 0.025,
               startCount: 3, endCount: 12, countRamp: 0.25 },
      rewards: { clearStar: 0, clearBlackhole: 1 },
    },
    {
      id: 'sv-2', name: '引力试炼', desc: '更难，更多陨石',
      intro: '来袭更密更快。90 秒限时内需更高效地布防，在引力试炼中证明你的防守功底。',
      objective: '存活 90 秒，坚持越久得分越高',
      failCondition: '母星生命值（18 点）归零',
      health: 18, budget: 99999, duration: 90,
      waves: { startInterval: 1.6, endInterval: 0.5, intervalDrop: 0.05,
               startDifficulty: 0.40, endDifficulty: 1.0, difficultyRamp: 0.022,
               startCount: 4, endCount: 14, countRamp: 0.28 },
      rewards: { clearStar: 0, clearBlackhole: 1 },
    },
    {
      id: 'sv-3', name: '星界危机', desc: '极限节奏，120秒',
      intro: '高压极限节奏，120 秒内高频来袭。多目标同屏，需冷静布局方能守住母星。',
      objective: '存活 120 秒，应对高频高难来袭',
      failCondition: '母星生命值（15 点）归零',
      health: 15, budget: 99999, duration: 120,
      waves: { startInterval: 1.2, endInterval: 0.4, intervalDrop: 0.05,
               startDifficulty: 0.45, endDifficulty: 1.0, difficultyRamp: 0.018,
               startCount: 5, endCount: 16, countRamp: 0.30 },
      rewards: { clearStar: 0, clearBlackhole: 1 },
    },
  ];
  // 闯关模式关卡：使用 levels-campaign.js 提供的确定性配置（保证公平、可复现、
  // 层层递进）。所有用户加载同一份数据将得到完全一致的波次序列。
  const CAMPAIGN_LEVELS = (typeof window !== 'undefined' && window.CAMPAIGN_LEVELS)
    ? window.CAMPAIGN_LEVELS
    : (typeof window !== 'undefined' && window.EXTREME_LEVELS ? window.EXTREME_LEVELS : []);
  // 章节划分（3 章 × 10 关）：菜单按章分组并显示该章星数完成度（数据来自 levels-campaign.js）
  const CHAPTERS = (typeof window !== 'undefined' && window.CHAPTERS) ? window.CHAPTERS : [];
  // 无尽模式：复用生存模式最高强度档的波次参数（随机生成），去掉限时 → 波次无上限。
  // 本机记录：最高波数走 starshield_best_waves（bestWaves），分数沿用 bestScore。
  const ENDLESS_LEVEL = {
    id: 'endless', name: '无尽深空', desc: '无限波次 · 比拼最高波数',
    intro: '波次无穷无尽，难度在封顶后仍会缓慢上升。守住母星，比拼你撑过的最高波数与累计分数。',
    objective: '守住母星，尽可能撑过更多波次',
    failCondition: '母星生命值（20 点）归零',
    health: 20, budget: 99999, duration: 0,
    waves: SURVIVAL_LEVELS[2].waves,
    rewards: { clearStar: 0, clearBlackhole: 1 },
  };

  // ===== 全局状态 =====
  const state = {
    bodies: [],
    particles: [],
    shake: 0,
    health: BASE_HEALTH,
    budget: 0,
    initialBudget: 0,       // 本局生效后的初始星能（修饰符生效后写入，见 setupLevel）
    // 注意：不再保存总分字段。总分一律由 integerScore() 从四类明细派生，
    // 避免「浮点累加值」与「明细代数和」两套真值漂移（见 M2）。
    wave: 0,
    mode: 'survival',
    level: null,
    levelIndex: 0,
    timeScale: 1,
    gameOver: false,
    showHint: true,
    showWarnings: true,      // 撞母星预警开关（P0-3，独立于提示线）
    slowQuota: SLOW_QUOTA_MAX,  // 减速剩余额度（秒，P0-1）
    gameTime: 0,             // 本局游戏时钟累计（秒，P0-2 撤销窗口口径）
    placeHistory: [],        // 撤销历史：[{ body, cost, typeKey, time }]（P0-2）
    threatWarnings: [],      // 撞母星预警：[{ x, y, radius, hitTime, id }]（P0-3，渲染端每帧写入）
    // P1 新增：选中态（不写入 bodies，仅 UI/渲染读取）与本局统计（供成就判定）
    selectedBody: null,
    slowUsedSeconds: 0,      // 本局减速累计使用（真实秒）
    upgrades: 0,             // 本局升级次数
    recycles: 0,             // 本局回收次数
    blackholeSwallowed: 0,   // 本局黑洞吞噬威胁数
    lastStars: 0,            // 最近一局获得的星数（结算展示用）
    // P2：一次性道具
    props: { gravityWell: 0, repulseWave: 0, stasis: 0 },   // 持有数
    propsUsed: 0,            // 本局使用次数
    stasisTime: 0,           // 凝滞剩余时长（真实秒）
    // v1.10：模式扩展
    modifiers: [],           // 本局生效的挑战修饰符 id（[] = 无修饰）
    blackholesPlaced: 0,     // 本局放置的黑洞数（任务 noBlackhole 判定用）
    specSwitches: 0,         // 本局专精互转次数（v1.11，结算统计）
    specGiantPlaced: 0,      // 本局放置的「巨型」专精星体数（v1.12，成就判定用）
    isLastWave: false,       // 当前波是否为该关最后一波（跨局必须复位，见 setupLevel）
    endlessStage: 0,         // 无尽模式当前阶段（v1.12：每 10 波一段，跨局必须复位）
    lastTask: null,          // 最近一局的任务结果（结算面板用）
    lastRecord: null,        // 最近一局的纪录对比（结算面板用）
    lastDaily: null,         // 最近一局的每日挑战成绩（结算面板用）
    lastEnding: null,        // 最近一局的结局文案（v1.12，结算面板用；仅闯关终关/隐藏关）
    lastBoardRank: null,     // 最近一局的历史榜单名次（v1.12，结算面板用）
    comets: 0,
    asteroids: 0,
    starsPlaced: 0,
    asteroidsCleared: 0,
    hitCount: 0,        // 母星累计受击
    totalSpent: 0,      // 本局星能花费
    difficulty: 0.3,    // 当前波次难度系数（用于计分加权）
    gameStarted: false,
    spawnAccumulator: 0,
    waveActive: false,
    waveQueue: [],
    waveTimer: 0,
    waveElapsed: 0,     // 当前波已进行的游戏时长(s)，用于超时保护
    healthFlash: 0,
    // 碰撞动画
    shockwaves: [],         // { x, y, radius, maxRadius, life, maxLife, color }
    flashes: [],            // { color, life, maxLife, intensity } —— 全屏屏闪（render 消费）
    planetPunch: 0,         // 母星受击震缩 0~1，>0 时缩放抖动
    // 生存模式限时
    duration: 0,            // 0 表示无限；>0 表示秒数
    remainingTime: 0,       // 剩余秒数（生存模式）
  };
  let bestScore = 0, bestWaves = 0;
  let campaignUnlocked = 0;   // 已解锁的最大关卡索引（成就：通关到「第 N 关」）

  // ===== 工具 =====
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clampInt(v, a, b) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? clamp(n, a, b) : a;
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ===== 本地战绩 / 进度 =====
  const LS_KEYS = [
    'starshield_best_score', 'starshield_best_waves',
    'starshield_campaign_unlocked', 'starshield_audio',
    SETTINGS_KEY, STARS_KEY, ACHIEVEMENTS_KEY,
    // v1.10：挑战进度 / 每日挑战 / 额外任务 / 每关最佳记录
    CHALLENGE_KEY, DAILY_KEY, TASKS_KEY, RECORDS_KEY,
    // v1.12：历史榜单与累计统计
    STATS_KEY,
  ];
  // 存档异常反馈（M7）：localStorage 损坏/配额超限不再静默吞掉，
  // 记录一条待展示的提示，由 input.js 在回到菜单时用轻提示呈现给玩家。
  let pendingWarning = '';
  function setWarning(msg) {
    if (!pendingWarning) pendingWarning = msg;
    console.warn('StarShield: ' + msg);
  }
  function takeWarning() {
    const w = pendingWarning;
    pendingWarning = '';
    return w;
  }
  // 游戏内轻提示队列（P0-1 等）：与 setWarning 同构，但由 input.js 主循环消费后
  // 走 flashMessage 弹出，游戏模块本身不直接依赖 DOM。
  let pendingNotice = '';
  function pushNotice(msg) {
    if (!pendingNotice) pendingNotice = msg;
  }
  function takeNotice() {
    const n = pendingNotice;
    pendingNotice = '';
    return n;
  }

  // ===== 设置存档（P0-4）=====
  // 单一 JSON 键保存「预测线 / 撞母星预警」等偏好；音效仍由 audio.js 自管。
  // 解析失败或读写异常一律回退默认并复用 M7 的 setWarning 反馈（菜单可渲染）。
  let settings = Object.assign({}, DEFAULT_SETTINGS);
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
    settings = Object.assign({}, DEFAULT_SETTINGS);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.showHint === 'boolean') settings.showHint = parsed.showHint;
      if (typeof parsed.showWarnings === 'boolean') settings.showWarnings = parsed.showWarnings;
    }
    state.showHint = settings.showHint;
    state.showWarnings = settings.showWarnings;
    return getSettings();
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      return true;
    } catch (e) {
      setWarning('设置保存失败：本地存储不可用或已满');
      return false;
    }
  }
  function getSettings() {
    return Object.assign({}, settings);
  }
  // 仅接受已知键与同类型值（防止脏调用把存档写成意外结构）
  function setSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return false;
    if (typeof DEFAULT_SETTINGS[key] !== typeof value) return false;
    settings[key] = value;
    if (key === 'showHint') state.showHint = value;
    if (key === 'showWarnings') state.showWarnings = value;
    saveSettings();
    return true;
  }

  // ===== 星级评价与累计星星（P1-A）=====
  // 存档 { "<levelIndex>": 1|2|3 }。总星数由该表求和派生，不额外维护计数，
  // 避免「两份真值漂移」（与 integerScore() 的单一数据源思路一致）。
  let stars = Object.create(null);
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
    stars = parsed;
    migrateStars();
    return getStars();
  }
  // 旧进度迁移：老存档只有「已通关 N 关」而没有星级表 → 为这些关卡各补 1 星，不让老玩家倒退。
  // 按"逐关补缺"而非"整表为空才迁移"：既覆盖完全缺失，也能修复部分缺失（如迁移中途写盘失败），
  // 且天然幂等——无变化时不写盘。
  function migrateStars() {
    if (campaignUnlocked <= 0) return 0;
    let n = 0;
    const max = Math.min(campaignUnlocked, regularLevelCount());   // 隐藏关不参与补星
    for (let i = 0; i < max; i++) {
      const key = String(i);
      if (!stars[key] || stars[key] < 1) { stars[key] = 1; n++; }
    }
    if (n > 0) saveStars();
    return n;
  }
  function saveStars() {
    try { localStorage.setItem(STARS_KEY, JSON.stringify(stars)); return true; }
    catch (e) { setWarning('星级保存失败：本地存储不可用或已满'); return false; }
  }
  function getStars() { return Object.assign(Object.create(null), stars); }
  // 星级分布（v1.12，星图总览面板展示用）：只统计常规关（隐藏关不计星）
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
    const v = parseInt(stars[String(idx)] || '0', 10);
    return Number.isFinite(v) ? clamp(v, 0, STAR_MAX_PER_LEVEL) : 0;
  }
  function getTotalStars() {
    let sum = 0;
    for (const k in stars) {
      if (Object.prototype.hasOwnProperty.call(stars, k)) sum += stars[k];
    }
    return sum;
  }
  // 满星上限只统计**常规关**：隐藏关不计星，因此加入隐藏关后满星仍为 40 × 3 = 120。
  // REGULAR_LEVELS 同时用于「挑战模式关卡池」——挑战的递增修饰符只作用于常规关。
  const REGULAR_LEVELS = CAMPAIGN_LEVELS.filter(function (lv) { return !lv.hidden; });
  function regularLevelCount() { return REGULAR_LEVELS.length; }
  function totalStarsMax() { return regularLevelCount() * STAR_MAX_PER_LEVEL; }
  // 隐藏关集合（v1.12）：供「全部隐藏关通关」与「完美星图」判定使用。
  // 通关与否以每关最佳记录里的 won 标记为准（recordRun 对隐藏关照常写入，且 won 只增不减）。
  const HIDDEN_LEVELS = CAMPAIGN_LEVELS.filter(function (lv) { return !!lv.hidden; });
  function countHiddenLevels() { return HIDDEN_LEVELS.length; }
  function getHiddenClearedCount() {
    let n = 0;
    for (let i = 0; i < HIDDEN_LEVELS.length; i++) {
      const idx = CAMPAIGN_LEVELS.indexOf(HIDDEN_LEVELS[i]);
      const rec = recordsByKey['campaign:' + idx];
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
    if (isHiddenLevel()) { state.lastStars = 0; return 0; }
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
      if (earned > (challenge.stars[key] || 0)) {
        challenge.stars[key] = earned;
        saveChallenge();
      }
      return earned;
    }
    if (earned > (stars[key] || 0)) {
      stars[key] = earned;
      saveStars();
    }
    return earned;
  }

  // ===== 成就（P1-C）=====
  // 声明式定义：need(stats) 只读 getCurrentRunStats() 的字段，判定与 UI 完全解耦、可独立测试。
  const ACHIEVEMENTS = [
    { id: 'first_win',    name: '初次告捷', desc: '首次通关任意闯关关卡',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' },
    { id: 'no_hit_win',   name: '铜墙铁壁', desc: '零受击通关（三星）',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.hits === 0 },
    { id: 'hit_survive',  name: '浴火重生', desc: '母星受击 5 次以上仍通关',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.hits >= 5 },
    { id: 'wave_15',      name: '波次机器', desc: '单局击退 15 波以上并通关',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.wave >= 15 },
    { id: 'star_30',      name: '群星闪耀', desc: '累计获得 30 颗星',
      need: () => getTotalStars() >= 30 },
    { id: 'star_60',      name: '星河为证', desc: '累计获得 60 颗星',
      need: () => getTotalStars() >= 60 },
    // 文案修正（v1.12）：判定一直用 totalStarsMax()（现为 40 常规关 × 3 = 120），
    // 旧文案写的 90 是加入第四章前的数字，属"文案与实战不符"，此处改为动态口径。
    { id: 'star_all',     name: '完美星域', desc: '集齐全部 ' + (regularLevelCount() * STAR_MAX_PER_LEVEL) + ' 颗星',
      need: () => getTotalStars() >= totalStarsMax() },
    { id: 'clear_50',     name: '拦截专家', desc: '单局拦截 50 个来袭威胁',
      need: (s) => s.cleared >= 50 },
    { id: 'bh_10',        name: '黑洞胃王', desc: '单局用黑洞吞噬 10 个威胁',
      need: (s) => s.blackholeSwallowed >= 10 },
    { id: 'no_slow_win',  name: '从容不迫', desc: '不使用慢动作通关',
      need: (s) => s.endReason === 'win' && s.slowUsedSeconds <= 0 },
    { id: 'thrifty',      name: '一次成型', desc: '通关过程中不回收、不升级',
      need: (s) => s.endReason === 'win' && s.mode === 'campaign' && s.recycles === 0 && s.upgrades === 0 },
    { id: 'tinkerer',     name: '机械师', desc: '单局完成 5 次星体升级',
      need: (s) => s.upgrades >= 5 },
    { id: 'eco_win',      name: '零浪费', desc: '闯关通关且星能结余 ≥ 200',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.budgetLeft >= 200 },
    { id: 'survive_500',  name: '长明者', desc: '生存模式单局得分 ≥ 500',
      need: (s) => s.mode === 'survival' && s.score >= 500 },
    // ===== v1.12 扩展（+12 项）：覆盖专精 / 协同 / 每日挑战 / 隐藏关 / 任务全清 / 无尽风暴 / 挑战进度 / 完美收集 =====
    // 口径说明：
    //   · 判定只读 getCurrentRunStats() 的字段或本文件内的 getter，与既有成就同构（可独立测试）；
    //   · 无尽成就用 s.wave 而非 bestWaves —— updateBest() 在 evaluateAchievements() **之后**执行，
    //     结算时 bestWaves 还是上一局的值，用它会漏判；
    //   · 协同是小数比率（physics.SYNERGY_TOTAL_MAX = 0.40），故阈值写作 0.30 / 0.40。
    { id: 'spec_giant_5',  name: '巨石匠',   desc: '单局放置 5 颗「巨型」专精星体',
      need: (s) => s.specGiantPlaced >= 5 },
    { id: 'spec_switch_3', name: '变形者',   desc: '单局完成 3 次专精互转',
      need: (s) => s.specSwitches >= 3 },
    { id: 'synergy_30',    name: '引力共振', desc: '单局某颗星体的协同加成达 30%',
      need: (s) => s.synergyMaxBonus >= 0.30 },
    { id: 'synergy_40',    name: '满格共振', desc: '单局协同加成打满 40% 上限',
      need: (s) => s.synergyMaxBonus >= 0.40 },
    { id: 'daily_first',   name: '今日之星', desc: '首次通关每日挑战',
      need: (s) => s.mode === 'daily' && s.endReason === 'win' },
    { id: 'daily_streak_3', name: '三日不辍', desc: '每日挑战连续通关 3 天',
      need: () => getDailyStreak() >= 3 },
    { id: 'hidden_clear',  name: '密道探索者', desc: '通关任意隐藏关',
      need: (s) => !!s.hidden && s.endReason === 'win' },
    { id: 'hidden_all',    name: '星图尽头', desc: '通关全部隐藏关',
      need: () => countHiddenLevels() > 0 && getHiddenClearedCount() >= countHiddenLevels() },
    { id: 'task_all',      name: '使命必达', desc: '完成全部 ' + regularLevelCount() + ' 个常规关的额外任务',
      need: () => regularLevelCount() > 0 && countRegularTasksDone() >= regularLevelCount() },
    { id: 'endless_30',    name: '风暴幸存者', desc: '无尽模式坚守 30 波（历经三次风暴）',
      need: (s) => s.mode === 'endless' && s.wave >= 30 },
    { id: 'challenge_10',  name: '挑战者',   desc: '挑战模式通关 10 关',
      need: () => getChallengeUnlocked() >= 10 },
    { id: 'perfect',       name: '完美星图', desc: '集齐 ' + (regularLevelCount() * STAR_MAX_PER_LEVEL)
        + ' 星、清空全部额外任务与隐藏关',
      need: () => getTotalStars() >= totalStarsMax()
        && regularLevelCount() > 0 && countRegularTasksDone() >= regularLevelCount()
        && countHiddenLevels() > 0 && getHiddenClearedCount() >= countHiddenLevels() },
  ];
  let achievements = Object.create(null);
  let pendingAchievements = [];
  function loadAchievements() {
    let raw = null;
    try { raw = localStorage.getItem(ACHIEVEMENTS_KEY); } catch (e) { setWarning('成就存档读取失败：本地存储不可用'); }
    achievements = Object.create(null);
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('成就存档已损坏，已回退为空进度');
      } else {
        for (const k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          // 只接受当前版本仍存在的成就 id（旧版本残留键直接忽略）
          if (ACHIEVEMENTS.some(a => a.id === k)) achievements[k] = obj[k] || Date.now();
        }
      }
    }
    pendingAchievements = [];
    return getAchievementList();
  }
  function saveAchievements() {
    try { localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(achievements)); return true; }
    catch (e) { setWarning('成就保存失败：本地存储不可用或已满'); return false; }
  }
  function getAchievementList() {
    return ACHIEVEMENTS.map(a => ({
      id: a.id, name: a.name, desc: a.desc,
      unlocked: !!achievements[a.id],
      time: achievements[a.id] || 0,
    }));
  }
  // 幂等解锁：已解锁项直接跳过；判定抛异常按"未达成"处理，绝不打断结算流程。
  function evaluateAchievements(stats) {
    const s = stats || getCurrentRunStats();
    const unlocked = [];
    for (const a of ACHIEVEMENTS) {
      if (achievements[a.id]) continue;
      let hit = false;
      try { hit = !!a.need(s); } catch (e) { hit = false; }
      if (hit) {
        achievements[a.id] = Date.now();
        unlocked.push({ id: a.id, name: a.name, desc: a.desc });
      }
    }
    if (unlocked.length) {
      pendingAchievements = pendingAchievements.concat(unlocked);
      saveAchievements();
    }
    return { unlocked: unlocked, total: ACHIEVEMENTS.length, count: Object.keys(achievements).length };
  }
  // 供 UI 一次性取走"本次新解锁"（与 takeWarning / takeNotice 同构）
  function takeNewAchievements() {
    const list = pendingAchievements;
    pendingAchievements = [];
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
  let tasksDone = Object.create(null);        // { "<mode>:<idx>": true }
  function taskKey(mode, levelIndex) {
    const m = mode || state.mode;
    const idx = parseInt(levelIndex, 10);
    return String(m) + ':' + (Number.isFinite(idx) ? idx : state.levelIndex);
  }
  function loadTasks() {
    let raw = null;
    try { raw = localStorage.getItem(TASKS_KEY); } catch (e) { setWarning('任务存档读取失败：本地存储不可用'); }
    tasksDone = Object.create(null);
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('任务存档已损坏，已回退为空进度');
      } else {
        for (const k in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k]) tasksDone[k] = true;
        }
      }
    }
    return getTasksDoneCount();
  }
  function saveTasks() {
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasksDone)); return true; }
    catch (e) { setWarning('任务保存失败：本地存储不可用或已满'); return false; }
  }
  function isTaskDone(mode, levelIndex) { return !!tasksDone[taskKey(mode, levelIndex)]; }
  function getTasksDoneCount() { return Object.keys(tasksDone).length; }
  // 本局任务判定（仅固定波次模式；未通关不判定、不记录）
  function recordRunTask() {
    const lvl = state.level;
    if (!isFixedWaveMode() || !lvl || !lvl.task) {
      return { done: false, already: false, id: '', text: '' };
    }
    const key = taskKey();
    const already = !!tasksDone[key];
    if (state.endReason !== 'win') return { done: false, already: already, id: lvl.task.id, text: lvl.task.text };
    const check = TASK_CHECKS[lvl.task.id];
    let hit = false;
    try { hit = !!check(getCurrentRunStats()); } catch (e) { hit = false; }
    if (!hit) return { done: false, already: already, id: lvl.task.id, text: lvl.task.text };
    if (!already) { tasksDone[key] = true; saveTasks(); }
    return { done: true, already: already, id: lvl.task.id, text: lvl.task.text };
  }

  // ===== 每关最佳记录（v1.10）=====
  // 键为 "<mode>:<idx>"：闯关 / 挑战 / 每日 / 生存 / 无尽 各自独立，互不干扰。
  let recordsByKey = Object.create(null);
  function loadRecords() {
    let raw = null;
    try { raw = localStorage.getItem(RECORDS_KEY); } catch (e) { setWarning('最佳记录读取失败：本地存储不可用'); }
    recordsByKey = Object.create(null);
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
          recordsByKey[k] = {
            bestScore: Math.max(0, Math.round(Number(v.bestScore) || 0)),
            leastHits: Math.max(0, Math.round(Number(v.leastHits) || 0)),
            fastestWin: Math.max(0, Math.round(Number(v.fastestWin) || 0)),
            won: !!v.won,
            plays: Math.max(0, Math.round(Number(v.plays) || 0)),
          };
        }
      }
    }
    return Object.keys(recordsByKey).length;
  }
  function saveRecords() {
    try { localStorage.setItem(RECORDS_KEY, JSON.stringify(recordsByKey)); return true; }
    catch (e) { setWarning('最佳记录保存失败：本地存储不可用或已满'); return false; }
  }
  function getRecord(mode, levelIndex) {
    return recordsByKey[taskKey(mode, levelIndex)] || null;
  }
  // 结算时择优写入；返回 { record, newBest } 供结算面板展示"新纪录"
  function recordRun() {
    if (!state.level) return null;
    const key = taskKey();
    const cur = recordsByKey[key] || null;
    const score = integerScore();
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
    recordsByKey[key] = next;
    saveRecords();
    return { record: Object.assign({}, next), newBest: newBest };
  }

  // ===== 历史榜单与累计统计（v1.12）=====
  // 单一存档键 STATS_KEY，结构：
  //   { v: 1,
  //     totals: { plays:{mode:n}, wins:{mode:n}, timeSec, intercepted, hits, bestScore, bestWaves },
  //     boards: { survival:[], campaign:[], challenge:[], endless:[], daily:[] } }   // 各模式前 5 名
  // 设计取舍：榜单与累计统计都是"只增"的展示型数据，合用一个键可减少键数量与清进度时的复位面。
  // 排序指标（与 README 保持一致）：无尽 → 波数优先、同波数比分数；其余模式 → 分数优先、同分比波数。
  // 写入时机：仅结算期（endGame），主循环零开销。
  const BOARD_SIZE = 5;
  const BOARD_MODES = ['survival', 'campaign', 'challenge', 'endless', 'daily'];
  const BOARD_MODE_NAMES = { survival: '生存', campaign: '闯关', challenge: '挑战', endless: '无尽', daily: '每日' };
  function emptyStats() {
    const plays = Object.create(null), wins = Object.create(null);
    for (let i = 0; i < BOARD_MODES.length; i++) {
      plays[BOARD_MODES[i]] = 0;
      wins[BOARD_MODES[i]] = 0;
    }
    const boards = Object.create(null);
    for (let i = 0; i < BOARD_MODES.length; i++) boards[BOARD_MODES[i]] = [];
    return {
      v: 1,
      totals: {
        plays: plays, wins: wins, timeSec: 0, intercepted: 0, hits: 0,
        bestScore: 0, bestWaves: 0,
      },
      boards: boards,
    };
  }
  let stats = emptyStats();
  function statsInt(v) { return Math.max(0, Math.round(Number(v) || 0)); }
  // 本机日期键（'YYYY-MM-DD'，仅用于榜单展示）。纯展示用途，不参与任何判定。
  function todayKey() {
    try {
      const d = new Date();
      const m = d.getMonth() + 1, day = d.getDate();
      return String(d.getFullYear()) + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
    } catch (e) { return ''; }
  }
  function loadStats() {
    let raw = null;
    try { raw = localStorage.getItem(STATS_KEY); } catch (e) { setWarning('统计与榜单读取失败：本地存储不可用'); }
    stats = emptyStats();
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('统计与榜单存档已损坏，已回退为空进度');
      } else {
        const t = (obj.totals && typeof obj.totals === 'object') ? obj.totals : {};
        const tp = (t.plays && typeof t.plays === 'object') ? t.plays : {};
        const tw = (t.wins && typeof t.wins === 'object') ? t.wins : {};
        for (let i = 0; i < BOARD_MODES.length; i++) {
          const m = BOARD_MODES[i];
          stats.totals.plays[m] = statsInt(tp[m]);
          stats.totals.wins[m] = statsInt(tw[m]);
        }
        stats.totals.timeSec = statsInt(t.timeSec);
        stats.totals.intercepted = statsInt(t.intercepted);
        stats.totals.hits = statsInt(t.hits);
        stats.totals.bestScore = statsInt(t.bestScore);
        stats.totals.bestWaves = statsInt(t.bestWaves);
        const bs = (obj.boards && typeof obj.boards === 'object') ? obj.boards : {};
        for (let i = 0; i < BOARD_MODES.length; i++) {
          const m = BOARD_MODES[i];
          const arr = Array.isArray(bs[m]) ? bs[m] : [];
          const clean = [];
          for (let j = 0; j < arr.length; j++) {
            const e = arr[j];
            if (!e || typeof e !== 'object') continue;
            clean.push({
              mode: m,
              score: statsInt(e.score),
              wave: statsInt(e.wave),
              level: statsInt(e.level),
              levelName: String(e.levelName == null ? '' : e.levelName),
              stars: statsInt(e.stars),
              duration: statsInt(e.duration),
              date: String(e.date == null ? '' : e.date),
              hidden: !!e.hidden,
              won: !!e.won,
            });
          }
          clean.sort(function (a, b) { return compareBoardEntries(m, a, b); });
          stats.boards[m] = clean.slice(0, BOARD_SIZE);
        }
      }
    }
    return getStatsTotals();
  }
  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); return true; }
    catch (e) { setWarning('统计与榜单保存失败：本地存储不可用或已满'); return false; }
  }
  // 榜单排序（返回负数表示 a 排在 b 前面）
  function compareBoardEntries(mode, a, b) {
    if (mode === 'endless') {
      if ((b.wave || 0) !== (a.wave || 0)) return (b.wave || 0) - (a.wave || 0);
      return (b.score || 0) - (a.score || 0);
    }
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return (b.wave || 0) - (a.wave || 0);
  }
  function getStatsTotals() {
    const t = stats.totals;
    const plays = {}, wins = {};
    for (let i = 0; i < BOARD_MODES.length; i++) {
      const m = BOARD_MODES[i];
      plays[m] = t.plays[m] || 0;
      wins[m] = t.wins[m] || 0;
    }
    return {
      plays: plays, wins: wins,
      timeSec: t.timeSec || 0, intercepted: t.intercepted || 0, hits: t.hits || 0,
      bestScore: t.bestScore || 0, bestWaves: t.bestWaves || 0,
    };
  }
  function getBoards() {
    const out = {};
    for (let i = 0; i < BOARD_MODES.length; i++) {
      const m = BOARD_MODES[i];
      out[m] = stats.boards[m].map(function (e) { return Object.assign({}, e); });
    }
    return out;
  }
  function getBoard(mode) {
    const list = stats.boards[mode];
    return Array.isArray(list) ? list.map(function (e) { return Object.assign({}, e); }) : [];
  }
  // 本局是否"够格上榜"：分数 > 0，或无尽模式至少推进过 1 波（避免首局 0 分占据榜首）
  function boardEntryQualifies(mode, e) {
    if (e.score > 0) return true;
    return mode === 'endless' && e.wave > 0;
  }
  // 写入榜单，返回 { mode, rank, size, qualifies }；rank 为 null 表示未进前 5
  function recordRunBoard() {
    const mode = state.mode;
    if (BOARD_MODES.indexOf(mode) < 0) return null;
    const entry = {
      mode: mode,
      score: integerScore(),
      wave: statsInt(state.wave),
      level: statsInt(state.levelIndex),
      levelName: state.level ? String(state.level.name || '') : '',
      stars: statsInt(state.lastStars),
      duration: statsInt(state.gameTime),
      date: todayKey(),
      hidden: isHiddenLevel(),
      won: state.endReason === 'win',
    };
    if (!boardEntryQualifies(mode, entry)) {
      return { mode: mode, rank: null, size: BOARD_SIZE, qualifies: false, entry: Object.assign({}, entry) };
    }
    const list = stats.boards[mode];
    list.push(entry);
    list.sort(function (a, b) { return compareBoardEntries(mode, a, b); });
    let rank = list.indexOf(entry) + 1;
    if (rank < 1 || rank > BOARD_SIZE) rank = null;
    stats.boards[mode] = list.slice(0, BOARD_SIZE);
    return { mode: mode, rank: rank, size: BOARD_SIZE, qualifies: true, entry: Object.assign({}, entry) };
  }
  // 累计统计累加（每局一次）。调用点：endGame() 末尾 —— 该函数顶部有 gameOver 幂等护栏，
  // 因此这里无需再判重；整段 try/catch 包裹，失败只提示、绝不影响结算面板。
  function accumulateStats() {
    const mode = state.mode;
    if (BOARD_MODES.indexOf(mode) < 0) return null;
    try {
      stats.totals.plays[mode] = (stats.totals.plays[mode] || 0) + 1;
      if (state.endReason === 'win') stats.totals.wins[mode] = (stats.totals.wins[mode] || 0) + 1;
      stats.totals.timeSec = statsInt(stats.totals.timeSec + Math.max(0, state.gameTime));
      stats.totals.intercepted = statsInt(stats.totals.intercepted + Math.max(0, state.asteroidsCleared));
      stats.totals.hits = statsInt(stats.totals.hits + Math.max(0, state.hitCount));
      const sc = integerScore();
      if (sc > stats.totals.bestScore) stats.totals.bestScore = sc;
      if (mode === 'endless' && state.wave > stats.totals.bestWaves) stats.totals.bestWaves = statsInt(state.wave);
      saveStats();
      return getStatsTotals();
    } catch (e) {
      setWarning('统计累加失败：本地存储不可用');
      return null;
    }
  }
  function getBoardModeNames() { return Object.assign({}, BOARD_MODE_NAMES); }

  // ===== 挑战模式进度存档（v1.10）=====
  // { unlocked, stars: {"<idx>":1|2|3}, best: {"<idx>":{bestScore,leastHits,fastestWin,won,plays}} }
  // 挑战星**不并入** getTotalStars()：闯关星级同时驱动成就与第四章门槛，混入会污染两处语义。
  let challenge = { unlocked: 0, stars: Object.create(null), best: Object.create(null) };
  function parseChallenge(raw) {
    const out = { unlocked: 0, stars: Object.create(null), best: Object.create(null) };
    if (!raw) return out;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    if (!obj || typeof obj !== 'object') {
      setWarning('挑战存档已损坏，已回退为空进度');   // 损坏不静默（M7 口径）
      return out;
    }
    out.unlocked = clampInt(obj.unlocked, 0, CAMPAIGN_LEVELS.length);
    if (obj.stars && typeof obj.stars === 'object') {
      for (const k in obj.stars) {
        if (!Object.prototype.hasOwnProperty.call(obj.stars, k)) continue;
        const idx = parseInt(k, 10);
        const v = parseInt(obj.stars[k], 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= CAMPAIGN_LEVELS.length) continue;
        if (!Number.isFinite(v) || v <= 0) continue;
        out.stars[String(idx)] = clamp(v, 1, STAR_MAX_PER_LEVEL);
      }
    }
    if (obj.best && typeof obj.best === 'object') {
      for (const k in obj.best) {
        if (!Object.prototype.hasOwnProperty.call(obj.best, k)) continue;
        const idx = parseInt(k, 10);
        const v = obj.best[k];
        if (!Number.isFinite(idx) || idx < 0 || idx >= CAMPAIGN_LEVELS.length) continue;
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
    challenge = parseChallenge(raw);
    return getChallengeUnlocked();
  }
  function saveChallenge() {
    try { localStorage.setItem(CHALLENGE_KEY, JSON.stringify(challenge)); return true; }
    catch (e) { setWarning('挑战存档保存失败：本地存储不可用或已满'); return false; }
  }
  function getChallengeUnlocked() { return challenge.unlocked; }
  function isChallengeUnlocked(idx) {
    const i = parseInt(idx, 10);
    return Number.isFinite(i) && i >= 0 && i <= challenge.unlocked;
  }
  function unlockNextChallenge() {
    if (state.mode !== 'challenge') return;
    const next = state.levelIndex + 1;
    if (next > challenge.unlocked && next < CAMPAIGN_LEVELS.length) {
      challenge.unlocked = next;
      saveChallenge();
    }
  }
  function challengeStarsForLevel(idx) {
    const v = parseInt(challenge.stars[String(idx)] || '0', 10);
    return Number.isFinite(v) ? clamp(v, 0, STAR_MAX_PER_LEVEL) : 0;
  }
  function getChallengeStarsTotal() {
    let sum = 0;
    for (const k in challenge.stars) {
      if (Object.prototype.hasOwnProperty.call(challenge.stars, k)) sum += challenge.stars[k];
    }
    return sum;
  }
  // 挑战成绩与闯关共用同一套择优逻辑，但落在独立的 best 表里
  function recordChallengeRun() {
    if (state.mode !== 'challenge') return null;
    const key = String(state.levelIndex);
    const cur = challenge.best[key] || null;
    const score = integerScore();
    const hits = Math.max(0, state.hitCount);
    const won = state.endReason === 'win';
    const duration = Math.max(0, Math.round(state.gameTime));
    const next = cur ? Object.assign({}, cur) : { bestScore: 0, leastHits: 0, fastestWin: 0, won: false, plays: 0 };
    if (!cur || score > next.bestScore) next.bestScore = score;
    if (!cur || hits < next.leastHits) next.leastHits = hits;
    if (won && (!next.won || !next.fastestWin || duration < next.fastestWin)) next.fastestWin = duration;
    next.won = next.won || won;
    next.plays += 1;
    challenge.best[key] = next;
    saveChallenge();
    return Object.assign({}, next);
  }
  function getChallengeBest(idx) { return challenge.best[String(idx)] || null; }

  // ===== 每日挑战存档（v1.10；v1.12 增加连胜）=====
  // 只保存"当天"的成绩；读取时若日期已变（跨日）会自动重置，无需定时器。
  // v1.12 扩展三个**跨日保留**的元数据（不随当日成绩重置）：
  //   streak       连续通关天数（同一日期重复通关只记一次，保证幂等）
  //   lastCleared  最近一次通关的日期键
  //   clearedTotal 累计通关天数
  const DAILY_EMPTY = {
    date: '', cleared: false, bestScore: 0, bestWave: 0,
    streak: 0, lastCleared: '', clearedTotal: 0,
  };
  function emptyDaily() { return Object.assign({}, DAILY_EMPTY); }
  let daily = emptyDaily();
  let dailyCache = null;                     // { key, level }：同一日期内复用同一关卡对象
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
  function getDailyStreak() { return Math.max(0, Math.round(Number(daily.streak) || 0)); }
  function loadDaily() {
    let raw = null;
    try { raw = localStorage.getItem(DAILY_KEY); } catch (e) { setWarning('每日挑战存档读取失败：本地存储不可用'); }
    daily = emptyDaily();
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        setWarning('每日挑战存档已损坏，已回退为空进度');
      } else {
        // 连胜元数据跨日保留（旧版存档缺这三个字段时按默认值回退，不视为损坏）
        daily.streak = Math.max(0, Math.round(Number(obj.streak) || 0));
        daily.lastCleared = String(obj.lastCleared || '');
        daily.clearedTotal = Math.max(0, Math.round(Number(obj.clearedTotal) || 0));
        // 当日成绩只在日期键匹配时恢复（跨日即视为新的一天）
        if (String(obj.date || '') === getDailyKey()) {
          daily.date = String(obj.date);
          daily.cleared = !!obj.cleared;
          daily.bestScore = Math.max(0, Math.round(Number(obj.bestScore) || 0));
          daily.bestWave = Math.max(0, Math.round(Number(obj.bestWave) || 0));
        }
      }
    }
    return getDailyState();
  }
  function saveDaily() {
    try { localStorage.setItem(DAILY_KEY, JSON.stringify(daily)); return true; }
    catch (e) { setWarning('每日挑战保存失败：本地存储不可用或已满'); return false; }
  }
  function getDailyState() {
    const key = getDailyKey();
    const fresh = (daily.date !== key);
    return {
      key: key,
      date: fresh ? key : daily.date,
      cleared: fresh ? false : daily.cleared,
      bestScore: fresh ? 0 : daily.bestScore,
      bestWave: fresh ? 0 : daily.bestWave,
      // v1.12：连胜元数据不受"跨日重置当日成绩"的影响
      streak: getDailyStreak(),
      lastCleared: daily.lastCleared || '',
      clearedTotal: Math.max(0, Math.round(Number(daily.clearedTotal) || 0)),
      level: getDailyLevel(),
    };
  }
  // 当天的确定性关卡（由 levels-campaign.js 的 makeDailyChallenge 生成；同一天复用同一对象）
  function getDailyLevel() {
    const key = getDailyKey();
    if (dailyCache && dailyCache.key === key) return dailyCache.level;
    const maker = (typeof window !== 'undefined' && typeof window.makeDailyChallenge === 'function')
      ? window.makeDailyChallenge : null;
    let level = null;
    if (maker) {
      try { level = maker(key); } catch (e) { level = null; }
    }
    if (!level) setWarning('每日挑战关卡生成失败');
    dailyCache = { key: key, level: level };
    return level;
  }
  function recordDaily() {
    const key = getDailyKey();
    // 跨日：只重置"当日成绩"，连胜元数据必须保留（否则连胜永远只能是 1）
    if (daily.date !== key) {
      const keep = { streak: getDailyStreak(), lastCleared: daily.lastCleared, clearedTotal: daily.clearedTotal };
      daily = Object.assign(emptyDaily(), keep);
      daily.date = key;
    }
    const score = integerScore();
    const won = state.endReason === 'win';
    const newBest = { score: score > daily.bestScore, wave: state.wave > daily.bestWave };
    daily.bestScore = Math.max(daily.bestScore, score);
    daily.bestWave = Math.max(daily.bestWave, state.wave);
    daily.cleared = daily.cleared || won;
    // 连胜推进（幂等）：同一天重复通关只记一次，避免"刷连胜"
    let streakUp = false;
    if (won && daily.lastCleared !== key) {
      daily.streak = (daily.lastCleared === prevDailyKey(key)) ? getDailyStreak() + 1 : 1;
      daily.lastCleared = key;
      daily.clearedTotal = Math.max(0, Math.round(Number(daily.clearedTotal) || 0)) + 1;
      streakUp = true;
    }
    saveDaily();
    return { state: getDailyState(), newBest: newBest, streakUp: streakUp };
  }

  // ===== 星体回收与就地升级（P1-B）=====
  // 与「撤销」的语义边界：撤销＝放置后 5 游戏秒内、全额返还、自动失效（纠错）；
  // 回收＝任意时刻、返还 70%、有代价（战术腾挪）。两者互不改写对方的数组与存档。
  function placedTypeKeyOf(body) {
    if (!body || body.type !== 'star') return null;
    return UPGRADE_CHAIN.indexOf(body.placedType) >= 0 ? body.placedType : null;
  }
  function nextTypeKeyOf(body) {
    const cur = placedTypeKeyOf(body);
    if (!cur) return null;
    const i = UPGRADE_CHAIN.indexOf(cur);
    return (i >= 0 && i + 1 < UPGRADE_CHAIN.length) ? UPGRADE_CHAIN[i + 1] : null;
  }
  // 回收返还按**该星体实际档位 + 专精**的成本计算（巨型档更贵 → 返还也更多），
  // 绝不按被协同放大后的 mass 换算，否则记账会随布防位置波动。
  function recycleRefundOf(body) {
    if (!body || !STAR_TYPES[body.placedType]) return 0;
    return Math.round(costOf(body.placedType, body.spec) * RECYCLE_REFUND_RATIO);
  }
  function recycleBody(body) {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法回收' };
    if (hasModifier('noRecycle')) return { ok: false, reason: '本关禁止回收' };
    const idx = state.bodies.indexOf(body);
    if (idx < 0) return { ok: false, reason: '该星体已不在场上' };
    if (!physics.isPickable(body)) return { ok: false, reason: '该天体不可回收' };
    const refund = recycleRefundOf(body);
    state.bodies.splice(idx, 1);
    state.budget = Math.min(99999, state.budget + refund);
    // totalSpent 口径＝本局净花费（已花 − 已返还），与撤销的记账方式保持一致
    state.totalSpent = Math.max(0, state.totalSpent - refund);
    state.recycles += 1;
    if (state.selectedBody === body) state.selectedBody = null;
    spawnShockwave(body.x, body.y, (body.radius || 12) + 50, 'rgba(255,178,122,0.7)', 0.38);
    spawnExplosion(body.x, body.y, '#ffb27a', 10);
    audio.play('flee');
    return { ok: true, reason: '', refund: refund };
  }
  function upgradeBody(body, opts) {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法升级' };
    if (hasModifier('noRecycle')) return { ok: false, reason: '本关禁止升级' };
    if (state.bodies.indexOf(body) < 0) return { ok: false, reason: '该星体已不在场上' };
    const curKey = placedTypeKeyOf(body);
    if (!curKey) return { ok: false, reason: body && body.type === 'blackhole' ? '黑洞不可升级' : '该天体不可升级' };
    const nextKey = nextTypeKeyOf(body);
    if (!nextKey) return { ok: false, reason: '已达最高档位' };
    const specId = (opts && opts.spec) || body.spec || DEFAULT_SPEC;   // 升级沿用当前专精
    const nextDef = getStarDef(nextKey, specId);
    const delta = nextDef.cost - costOf(curKey, specId);
    if (state.budget < delta) return { ok: false, reason: '星能不足（需 ' + delta + '）' };
    state.budget -= delta;
    state.totalSpent += delta;
    // 就地升级：保留位置与初速，仅替换质量/半径/档位/专精
    body.baseMass = nextDef.mass;
    body.spec = nextDef.spec;
    body.mass = nextDef.mass;
    body.radius = nextDef.radius;
    body.placedType = nextKey;
    state.upgrades += 1;
    // 升级改变了该星体的档位与花费，原「放置」记录不再成立：从撤销历史中移除，
    // 否则撤销会按旧价返还（既不符合直觉，也会与升级差价形成记账矛盾）。
    for (let i = state.placeHistory.length - 1; i >= 0; i--) {
      if (state.placeHistory[i].body === body) state.placeHistory.splice(i, 1);
    }
    spawnShockwave(body.x, body.y, body.radius + 60, 'rgba(120,190,255,0.7)', 0.4);
    audio.play('place');
    return { ok: true, reason: '', delta: delta };
  }
  // 点选场上星体（母星与来袭威胁不可选）
  function selectBodyAt(point) {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法选中' };
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, reason: '' };
    let found = null;
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (!physics.isPickable(b)) continue;      // 场景天体与威胁不可点选
      const r = (b.radius || 12) + BODY_PICK_PAD;
      if (Math.hypot(point.x - b.x, point.y - b.y) <= r) { found = b; break; }
    }
    state.selectedBody = found;
    return found ? { ok: true, reason: '', body: found } : { ok: false, reason: '' };
  }
  function clearSelection() { state.selectedBody = null; }
  // 操作面板数据（升级差价 / 回收返还 / 专精切换），UI 只读不改
  function getBodyActionInfo(body) {
    if (!body) return null;
    const isBH = body.type === 'blackhole';
    const def = body.placedType ? STAR_TYPES[body.placedType] : null;
    const specId = isBH ? null : (body.spec || DEFAULT_SPEC);
    const spec = isBH ? null : physics.specDef(specId);
    const nextKey = isBH ? null : nextTypeKeyOf(body);
    const delta = nextKey ? (costOf(nextKey, specId) - costOf(body.placedType, specId)) : 0;
    // 专精互转（同档）：目标为"另一种专精"，差价 = 目标价 − 当前价（可能为负 = 退还）
    const otherSpecId = (specId === 'gravity') ? 'giant' : 'gravity';
    const otherSpec = isBH ? null : physics.specDef(otherSpecId);
    const switchDelta = isBH ? 0 : (costOf(body.placedType, otherSpecId) - costOf(body.placedType, specId));
    const canSwitch = !isBH && (switchDelta <= 0 || state.budget >= switchDelta);
    return {
      typeKey: body.placedType || null,
      name: def ? def.name : (isBH ? '黑洞' : '星体'),
      spec: specId,
      specName: spec ? spec.name : '',
      refund: recycleRefundOf(body),
      canRecycle: true,
      canUpgrade: !!nextKey && state.budget >= delta,
      upgradeName: nextKey ? STAR_TYPES[nextKey].name : '',
      upgradeDelta: delta,
      upgradeReason: nextKey ? (state.budget >= delta ? '' : '星能不足') : (isBH ? '黑洞不可升级' : '已达最高档位'),
      // 专精互转信息（黑洞不参与）
      switchName: otherSpec ? otherSpec.name : '',
      switchDelta: switchDelta,
      canSwitch: canSwitch,
      switchReason: isBH ? '黑洞无专精' : (canSwitch ? '' : '星能不足'),
    };
  }
  // 同档专精互转（v1.11）：按差价补/退星能，位置与初速不变。
  // 与升级一致地**移除该星体的撤销历史条目**——原「放置」成本快照已不再成立，
  // 否则撤销会按旧价返还（与升级的记账处理保持同一口径）。
  function switchSpec(body, specId) {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法切换专精' };
    if (state.bodies.indexOf(body) < 0) return { ok: false, reason: '该星体已不在场上' };
    const curKey = placedTypeKeyOf(body);
    if (!curKey) return { ok: false, reason: '黑洞无专精' };
    const target = physics.specDef(specId).id;
    const cur = body.spec || DEFAULT_SPEC;
    if (target === cur) return { ok: false, reason: '已是该专精' };
    const delta = costOf(curKey, target) - costOf(curKey, cur);
    if (delta > 0 && state.budget < delta) return { ok: false, reason: '星能不足（需 ' + delta + '）' };
    state.budget = Math.min(99999, state.budget - delta);           // delta 为负时即退款
    state.totalSpent = Math.max(0, state.totalSpent + delta);
    const nextDef = getStarDef(curKey, target);
    body.spec = target;
    body.baseMass = nextDef.mass;
    body.mass = nextDef.mass;
    body.radius = nextDef.radius;
    state.specSwitches = (state.specSwitches || 0) + 1;
    for (let i = state.placeHistory.length - 1; i >= 0; i--) {
      if (state.placeHistory[i].body === body) state.placeHistory.splice(i, 1);
    }
    spawnShockwave(body.x, body.y, body.radius + 50, 'rgba(180,220,255,0.7)', 0.35);
    audio.play('place');
    return { ok: true, reason: '', delta: delta, spec: target, specName: nextDef.specName };
  }

  // ===== 一次性道具（P2）=====
  function getProps() {
    return PROP_DEFS.map(d => ({
      id: d.id, name: d.name, desc: d.desc,
      count: (state.props && Number.isFinite(state.props[d.id])) ? Math.max(0, state.props[d.id]) : 0,
    }));
  }
  // 释放道具：point 为画布坐标。返回 { ok, reason }
  function useProp(id, point) {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法使用道具' };
    if (!state.props || !Number.isFinite(state.props[id])) return { ok: false, reason: '未知道具' };
    if (state.props[id] <= 0) return { ok: false, reason: '该道具已用完' };
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, reason: '' };

    if (id === 'gravityWell') {
      if (state.bodies.length >= MAX_TOTAL_BODIES) {
        return { ok: false, reason: '场上天体过多，无法生成引力井' };
      }
      // 临时强引力井：lifespan 由 physics 按游戏时钟递减并回收（预测同样能看到它）
      state.bodies.push({
        type: 'gravityWell', mass: PROP_WELL_MASS, radius: 16,
        x: point.x, y: point.y, vx: 0, vy: 0,
        immovable: true, anchored: true, solid: true,
        lifespan: PROP_WELL_LIFE,
      });
      spawnShockwave(point.x, point.y, 170, 'rgba(140,240,255,0.8)', 0.45);
      addFlash('rgba(120,220,255,0.18)', 0.8);
    } else if (id === 'repulseWave') {
      // 瞬时冲量：把半径内的来袭威胁沿径向推离（一次性事件，不进入预测）
      let pushed = 0;
      for (let i = 0; i < state.bodies.length; i++) {
        const b = state.bodies[i];
        if (!physics.isThreat(b) || b.anchored) continue;
        const dx = b.x - point.x, dy = b.y - point.y;
        const d = Math.hypot(dx, dy);
        if (d > PROP_REPULSE_RADIUS || d < 1e-6) continue;
        const falloff = 1 - d / PROP_REPULSE_RADIUS;
        const dv = PROP_REPULSE_POWER * falloff / Math.max(1, Math.sqrt(b.mass || 1) * 0.35);
        b.vx += (dx / d) * dv;
        b.vy += (dy / d) * dv;
        pushed++;
      }
      spawnShockwave(point.x, point.y, PROP_REPULSE_RADIUS, 'rgba(150,205,255,0.85)', 0.5);
      addFlash('rgba(120,190,255,0.15)', 0.7);
      state.props[id]--;
      state.propsUsed++;
      audio.play('prop');
      return { ok: true, reason: pushed === 0 ? '附近没有可推离的威胁' : '', pushed: pushed };
    } else if (id === 'stasis') {
      state.stasisTime = STASIS_DURATION;
      spawnShockwave(point.x, point.y, 240, 'rgba(200,155,255,0.7)', 0.5);
      addFlash('rgba(200,155,255,0.16)', 0.9);
      state.props[id]--;
      state.propsUsed++;
      audio.play('stasis');
      return { ok: true, reason: '' };
    }

    state.props[id]--;
    state.propsUsed++;
    audio.play('prop');
    return { ok: true, reason: '' };
  }
  function loadBest() {
    try {
      bestScore = Math.max(0, parseInt(localStorage.getItem('starshield_best_score') || '0', 10) || 0);
      bestWaves = Math.max(0, parseInt(localStorage.getItem('starshield_best_waves') || '0', 10) || 0);
      // 解锁进度做区间收敛：存档可被手工篡改，越界值会让关卡列表/开局判定异常
      const unlocked = parseInt(localStorage.getItem('starshield_campaign_unlocked') || '0', 10) || 0;
      campaignUnlocked = clampInt(unlocked, 0, Math.max(0, CAMPAIGN_LEVELS.length));
    } catch (e) { bestScore = 0; bestWaves = 0; campaignUnlocked = 0; }
  }
  function saveBest() {
    try {
      localStorage.setItem('starshield_best_score', String(bestScore));
      localStorage.setItem('starshield_best_waves', String(bestWaves));
      localStorage.setItem('starshield_campaign_unlocked', String(campaignUnlocked));
    } catch (e) {
      setWarning('战绩保存失败：本地存储不可用或已满');
    }
  }
  // 一键清除进度：删除本游戏写入的全部 localStorage 键（各层级通用）
  function clearAllProgress() {
    try {
      for (const k of LS_KEYS) localStorage.removeItem(k);
    } catch (e) {}
    bestScore = 0; bestWaves = 0; campaignUnlocked = 0;
    // 设置同步复位为默认值（P0-4）：存档已删除，若内存不复位会出现"界面与存档不一致"
    settings = Object.assign({}, DEFAULT_SETTINGS);
    state.showHint = settings.showHint;
    state.showWarnings = settings.showWarnings;
    pendingNotice = '';
    // 星级 / 成就同样复位（P1）：存档已删除，内存若不复位会出现"界面与存档不一致"
    stars = Object.create(null);
    achievements = Object.create(null);
    pendingAchievements = [];
    state.lastStars = 0;
    state.selectedBody = null;
    // v1.10：挑战 / 每日挑战 / 额外任务 / 最佳记录 一并复位（存档已删除，内存不复位会与存档不一致）
    challenge = { unlocked: 0, stars: Object.create(null), best: Object.create(null) };
    daily = emptyDaily();
    tasksDone = Object.create(null);
    recordsByKey = Object.create(null);
    stats = emptyStats();        // v1.12：统计与榜单（存档已删除，内存必须同步复位）
    state.lastTask = null;
    state.lastRecord = null;
    state.lastDaily = null;
    state.lastEnding = null;
    state.lastBoardRank = null;
    state.modifiers = [];
    // 重新加载菜单时由调用方负责刷新显示
  }
  // 整数化总分：由四类计分明细（各自取整）代数求和推导，保证与结算面板明细严格一致、
  // 始终为整数（消除生存存活分浮点累加导致的显示漂移）。
  // 这是全游戏唯一的总分口径——不再维护一个浮点的 state.score 影子字段（M2）。
  function integerScore() {
    const n = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
    return Math.max(0,
      n(state.scoreIntercept)
      + n(state.scoreWaveBonus)
      + n(state.scoreSurvive)
      - n(state.scorePenalty));
  }
  function updateBest() {
    if (state.mode === 'campaign') {
      // 闯关模式的「成就」= 已通关到第几关（最高解锁索引 + 1），不记录波次
      // 仅在通关时由 unlockNextLevel() 推进 campaignUnlocked
    } else if (isFixedWaveMode()) {
      // 挑战 / 每日挑战：成绩记录在各自的存档里（recordChallengeRun / recordDaily），
      // 不得写入 survival/endless 共用的 bestScore / bestWaves，否则记录会互相污染
      return;
    } else {
      const rounded = integerScore();
      if (rounded > bestScore) bestScore = rounded;
      // 无尽模式额外记录「最高波数」（bestWaves 字段此前未被真正使用）
      if (state.mode === 'endless' && state.wave > bestWaves) bestWaves = state.wave;
    }
    saveBest();
  }
  // 通关当前关：解锁下一关（仅闯关模式）
  function unlockNextLevel() {
    if (state.mode !== 'campaign') return;
    if (isHiddenLevel()) return;        // 隐藏关不推进常规解锁进度
    const next = state.levelIndex + 1;
    if (next > campaignUnlocked) {
      campaignUnlocked = next;
      saveBest();
    }
  }
  function bestDisplay() {
    if (state.mode === 'campaign') return campaignUnlocked > 0 ? ('通关第 ' + campaignUnlocked + ' 关') : '未通关';
    if (state.mode === 'challenge') {
      return challenge.unlocked > 0 ? ('挑战已通关 ' + challenge.unlocked + ' 关') : '未通关';
    }
    if (state.mode === 'daily') {
      const d = getDailyState();
      if (d.cleared) return '今日已通关';
      return d.bestScore > 0 ? ('今日 ' + d.bestScore + ' 分') : '今日未挑战';
    }
    if (state.mode === 'endless') return bestWaves > 0 ? ('最高 ' + bestWaves + ' 波') : '—';
    return bestScore > 0 ? String(Math.round(bestScore)) : '—';
  }
  function bestForMode(mode) {
    if (mode === 'campaign') return campaignUnlocked;
    if (mode === 'challenge') return challenge.unlocked;
    if (mode === 'daily') return getDailyState().bestScore;   // 本机记录：当日最高分
    if (mode === 'endless') return bestWaves;
    return Math.round(bestScore);
  }
  // 关卡是否解锁（闯关模式：索引 <= 已解锁上限）
  // 第四章（idx >= 30，新增内容）额外要求累计星星达标——用于承接"满星解锁新内容"的目标感。
  // 前 30 关只按通关进度判定，逐位不变（不做进度倒退）。
  function isLevelUnlocked(idx) {
    const i = parseInt(idx, 10) || 0;
    if (isHiddenLevel(i)) return isHiddenUnlocked(i);   // 隐藏关：独立解锁条件（星数 / 任务全清）
    if (i > campaignUnlocked) return false;
    if (i < CH4_START) return true;
    return getTotalStars() >= CH4_STAR_GATE;
  }
  function getCh4StarGate() { return CH4_STAR_GATE; }

  // ===== 隐藏关（v1.11）=====
  // 定位：不属任何章节、不计星、不推进 campaignUnlocked 的"纯挑战关"；
  // 解锁条件写在关卡数据里（level.unlock），由内容层声明、此处只做判定与进度展示。
  function isHiddenLevel(idx) {
    const i = Number.isFinite(idx) ? idx : state.levelIndex;
    const lv = CAMPAIGN_LEVELS[i];
    return !!(lv && lv.hidden);
  }
  function countRegularTasksDone() {
    let n = 0;
    for (let i = 0; i < CAMPAIGN_LEVELS.length; i++) {
      if (CAMPAIGN_LEVELS[i].hidden) continue;
      if (isTaskDone('campaign', i)) n++;
    }
    return n;
  }
  // 隐藏关解锁进度（供菜单展示："累计星数 96/100" 之类）
  function getHiddenUnlockInfo(idx) {
    const i = parseInt(idx, 10) || 0;
    const lv = CAMPAIGN_LEVELS[i];
    if (!lv || !lv.hidden || !lv.unlock) return null;
    if (lv.unlock.type === 'stars') {
      const cur = getTotalStars();
      const need = lv.unlock.value || HIDDEN_STAR_GATE;
      return { type: 'stars', need: need, current: cur, ok: cur >= need,
               label: '累计星数 ' + Math.min(cur, need) + '/' + need };
    }
    const done = countRegularTasksDone();
    const need = lv.unlock.value || HIDDEN_TASK_NEED;
    return { type: 'tasks', need: need, current: done, ok: done >= need,
             label: '常规关额外任务 ' + done + '/' + need };
  }
  function isHiddenUnlocked(idx) {
    const info = getHiddenUnlockInfo(idx);
    return !!(info && info.ok);
  }
  function getHiddenLevels() {
    const out = [];
    for (let i = 0; i < CAMPAIGN_LEVELS.length; i++) {
      if (CAMPAIGN_LEVELS[i].hidden) out.push({ index: i, level: CAMPAIGN_LEVELS[i] });
    }
    return out;
  }

  // ===== 关卡初始化 =====
  function setupLevel() {
    const W = window.innerWidth, H = window.innerHeight;
    const cx = W / 2, cy = H / 2;
    const lvl = state.level;
    state.bodies = [];
    state.particles = [];
    state.shake = 0;
    state.wave = 0;
    state.waveElapsed = 0;
    state.endReason = null;
    state.comets = 0;
    state.asteroids = 0;
    state.starsPlaced = 0;
    state.asteroidsCleared = 0;
    state.hitCount = 0;
    state.totalSpent = 0;
    state.difficulty = 0.3;
    state.lastWaveBonus = 0;
    // 分数明细（用于结算面板分账展示）
    state.scoreIntercept = 0;   // 拦截清除累计
    state.scoreWaveBonus = 0;   // 波次奖励累计
    state.scoreSurvive = 0;     // 生存存活累计
    state.scorePenalty = 0;     // 失守扣分累计（正数）
    state.gameOver = false;
    state.waveActive = false;
    state.waveQueue = [];
    state.waveTimer = 0;
    state.waveInterval = 0;
    state.spawnAccumulator = 0;
    state.healthFlash = 0;

    // 挑战修饰符（v1.10）：本局生效的规则变体。
    //   闯关 = 无修饰；挑战 = 按关卡序号确定性挂载；每日挑战 = 由当日关卡自带（见 makeDailyChallenge）。
    state.modifiers = (lvl && Array.isArray(lvl.modifiers))
      ? lvl.modifiers.slice()
      : (state.mode === 'challenge' ? challengeModifiersFor(state.levelIndex) : []);
    state.blackholesPlaced = 0;
    state.specSwitches = 0;      // v1.11：专精互转次数逐局重置
    state.specGiantPlaced = 0;   // v1.12：巨型专精放置数逐局重置
    state.endlessStage = 0;      // v1.12：无尽阶段逐局重置（仅 endless 会在 startWave 里推进）
    // isLastWave 必须显式复位：它只在 startWave 里被写入，跨局残留会让新模式/异常路径误判终局
    state.isLastWave = false;
    // 天体上限告警只记一次：跨局不复位会吞掉后续告警（排查困难）
    state.spawnBlockedLogged = false;
    state.lastTask = null;
    state.lastRecord = null;
    state.lastDaily = null;
    state.lastEnding = null;     // v1.12：结局文案逐局重置（否则上一局的结局会残留到新一局结算）
    state.lastBoardRank = null;  // v1.12：榜单名次逐局重置

    // 减速额度 / 撤销历史 / 预警列表（P0-1 / P0-2 / P0-3）：每局从零开始。
    // 注意：timeScale 属会话级偏好，开局不重置（由额度耗尽机制兜底），
    // 避免与「直写 state.timeScale」的既有行为分叉。
    state.slowQuota = hasModifier('noSlow') ? 0 : SLOW_QUOTA_MAX;
    state.gameTime = 0;
    state.placeHistory = [];
    state.threatWarnings = [];
    // P1：选中态与本局统计（成就判定输入）逐局重置
    state.selectedBody = null;
    state.slowUsedSeconds = 0;
    state.upgrades = 0;
    state.recycles = 0;
    state.blackholeSwallowed = 0;
    state.lastStars = 0;
    // 道具配额（P2）：固定波次模式（闯关/挑战/每日）按关卡发放（2/1/1）；
    // 生存与无尽开局 1/1/1，之后每清 5 波补 1。「禁道具」修饰符下全部清零。
    state.props = hasModifier('noProps')
      ? { gravityWell: 0, repulseWave: 0, stasis: 0 }
      : (isFixedWaveMode()
          ? { gravityWell: 2, repulseWave: 1, stasis: 1 }
          : { gravityWell: 1, repulseWave: 1, stasis: 1 });
    state.propsUsed = 0;
    state.stasisTime = 0;

    state.health = lvl.health;
    // 「星能减半」修饰符：初始星能 ×0.5（四舍五入，保证是整数星能）
    state.budget = hasModifier('halfBudget') ? Math.round(lvl.budget * 0.5) : lvl.budget;
    // 记录**生效后**的初始星能：额外任务 thrifty（结余 ≥ 初始预算的一半）与关卡卡片展示
    // 都以此为准，避免"文案说一半、实际按未减半的预算判定"的不一致。
    state.initialBudget = state.budget;

    // 限时（生存模式）
    state.duration = lvl.duration || 0;
    state.remainingTime = state.duration;

    // 碰撞动画清空
    state.shockwaves = [];
    state.flashes = [];
    state.planetPunch = 0;

    // 母星
    state.bodies.push({
      type: 'planet', mass: 8000, radius: 30,
      x: cx, y: cy, vx: 0, vy: 0,
      immovable: true, anchored: true, isStar: true,
    });

    // 主题场景机关（P2）：按关卡 scene 规格生成（闯关模式专有；生存/无尽为空场景）
    spawnSceneBodies(lvl, cx, cy);

    // 注意：黑洞不再作为关卡初始场景放置（用户要求开局画布无黑洞）。
    // 黑洞仅由玩家在游戏中放置，且放置后固定位置、10 秒后自动消失。
  }

  // ===== 主题场景机关（P2）=====
  // 按关卡 scene 规格生成确定性场景天体：位置 = 屏幕中心 + 比例偏移（不同分辨率布局一致）。
  // 场景天体 immovable + anchored + solid（撞上它的运动天体被撞毁），
  // 不参与威胁结算，也不可点选/回收/升级（见 physics.isScene / isPickable）。
  function spawnSceneBodies(lvl, cx, cy) {
    const scene = lvl && lvl.scene;
    if (!scene || !Array.isArray(scene.bodies) || scene.bodies.length === 0) return 0;
    const W = window.innerWidth, H = window.innerHeight;
    let n = 0;
    for (let i = 0; i < scene.bodies.length; i++) {
      const spec = scene.bodies[i];
      if (!spec || physics.SCENE_TYPES.indexOf(spec.type) < 0) continue;
      if (state.bodies.length >= MAX_TOTAL_BODIES) break;
      const body = {
        type: spec.type,
        mass: spec.mass,
        radius: spec.radius,
        x: cx + spec.dx * W,
        y: cy + spec.dy * H,
        vx: 0, vy: 0,
        immovable: true, anchored: true, solid: true,
        scene: true,
        rotation: spec.rotation || 0,
      };
      if (spec.type === 'obstacle') {
        body.vertices = Array.isArray(spec.vertices)
          ? spec.vertices.slice()
          : [1, 0.92, 1.06, 0.9, 1.04];
      }
      if (spec.type === 'pulsar') {
        body.pulseStrength = Number.isFinite(spec.pulseStrength) ? spec.pulseStrength : 0;
        body.pulsePeriod = Number.isFinite(spec.pulsePeriod) ? spec.pulsePeriod : 0;
      }
      state.bodies.push(body);
      n++;
    }
    return n;
  }

  // ===== 母星禁放区 =====
  // 唯一权威实现：input.js 也调用此函数
  function canPlaceAt(p) {
    const planet = state.bodies[0];
    if (!planet) return true;
    return Math.hypot(p.x - planet.x, p.y - planet.y) >= PLANET_FORBIDDEN_RADIUS();
  }

  // ===== 星体档位 =====
  const STAR_TYPES = {
    small:   { name: '小行星', mass: 50,  radius: 9,  cost: 50 },
    mid:     { name: '中行星', mass: 150, radius: 13, cost: 150 },
    large:   { name: '大行星', mass: 300, radius: 17, cost: 300 },
    star:    { name: '恒星',   mass: 500, radius: 20, cost: 500 },
    blackhole: { name: '黑洞', mass: 1500, radius: 11, cost: 1500 },
  };

  // ===== 星体专精（v1.11）=====
  // 由「档位基础值 × 专精倍率」派生实际质量/半径/价格（与 physics.SPECS 同源，UI 与记账共用）。
  // 计价规则：价格 = round(基础成本 × 专精价格倍率 / 10) × 10（保持整十数、便于心算）。
  // 黑洞不参与专精（保持 1500 与既有语义）。
  function priceWithSpec(baseCost, specId) {
    const s = physics.specDef(specId);
    return Math.round(baseCost * s.costMul / 10) * 10;
  }
  function getStarDef(typeKey, specId) {
    const key = STAR_TYPES[typeKey] ? typeKey : 'mid';
    const base = STAR_TYPES[key];
    if (key === 'blackhole') {
      return { typeKey: key, spec: null, specName: '', name: base.name, baseCost: base.cost,
               mass: base.mass, radius: base.radius, cost: base.cost };
    }
    const spec = physics.specDef(specId || DEFAULT_SPEC);
    const applied = physics.applySpec(base.mass, base.radius, spec.id);
    return {
      typeKey: key, spec: spec.id, specName: spec.name, name: base.name, baseCost: base.cost,
      mass: applied.mass, radius: applied.radius, cost: priceWithSpec(base.cost, spec.id),
    };
  }
  function costOf(typeKey, specId) { return getStarDef(typeKey, specId).cost; }
  const specList = () => physics.SPEC_IDS.map(id => {
    const s = physics.specDef(id);
    return { id: s.id, name: s.name, desc: s.desc, massMul: s.massMul, radiusMul: s.radiusMul, costMul: s.costMul };
  });

  // 场上玩家星体数量（含黑洞），用于上限判定
  function countPlacedBodies() {
    let n = 0;
    for (let i = 0; i < state.bodies.length; i++) {
      if (physics.isPickable(state.bodies[i])) n++;
    }
    return n;
  }

  function placeStar(typeKey, p, opts) {
    const specId = (opts && opts.spec) || DEFAULT_SPEC;
    const def = getStarDef(typeKey, specId);
    // 修饰符（v1.10）：「禁黑洞」在扣星能之前拦截，避免出现"扣了钱又拒绝"的记账矛盾
    if (typeKey === 'blackhole' && hasModifier('noBlackhole')) {
      return { ok: false, reason: '本关禁用黑洞' };
    }
    // 数量上限优先于星能判断：物理与预测均为 O(N²)，无上限会随放置数增长而卡死页面
    if (countPlacedBodies() >= MAX_PLACED_BODIES) {
      return { ok: false, reason: '场上星体已达上限 ' + MAX_PLACED_BODIES };
    }
    if (state.budget < def.cost) return { ok: false, reason: '星能不足' };
    if (!canPlaceAt(p)) return { ok: false, reason: '离母星太近' };
    state.budget -= def.cost;
    state.totalSpent += def.cost;
    const isBH = typeKey === 'blackhole';
    const vx = (opts && Number.isFinite(opts.vx)) ? opts.vx : 0;
    const vy = (opts && Number.isFinite(opts.vy)) ? opts.vy : 0;
    let body;
    if (isBH) {
      // 玩家黑洞：固定位置（不随引力移动），BLACKHOLE_LIFE 游戏秒后自动消失
      body = {
        type: 'blackhole', mass: def.mass, radius: def.radius,
        x: p.x, y: p.y, vx: 0, vy: 0,
        anchored: true,                                  // 锚定，不被引力推动
        immovable: true,                                 // 物理上不动；撞来的被吞
        isCollectable: true, placedType: typeKey,
        lifeRemaining: BLACKHOLE_LIFE,                   // 剩余存活（游戏秒，见 M1）
        fading: false,                                   // 即将消失动画中
      };
    } else {
      body = {
        type: 'star', mass: def.mass, radius: def.radius,
        x: p.x, y: p.y, vx, vy,
        isCollectable: true, placedType: typeKey,
        // v1.11 专精与协同：baseMass 是"专精后的静态质量"，协同只在此基础上乘倍率。
        // 物理层每步会写回 mass = baseMass × synergyMul，因此其它模块读规格时应读 baseMass。
        spec: def.spec, baseMass: def.mass,
        synergyMul: 1, synergyBonus: 0, synergyNeighbors: 0,
      };
    }
    state.bodies.push(body);
    state.starsPlaced++;
    if (isBH) state.blackholesPlaced++;                   // v1.10：任务 noBlackhole 判定用
    // v1.12：统计本局放置的「巨型」专精星体数（成就 spec_giant_5 判定用）
    if (!isBH && def.spec === 'giant') state.specGiantPlaced = (state.specGiantPlaced || 0) + 1;
    recordPlacement(body, typeKey, def.cost);             // 记入撤销历史（P0-2）
    return { ok: true };
  }

  // ===== 撤销最近放置（P0-2）=====
  // 只允许撤销「最近一颗仍在场上、且未超过时间窗」的星体：
  //   - 时间窗按游戏时钟计（慢动作下窗口按比例延长，与 M1 黑洞寿命口径一致）；
  //   - 已被母星吸收 / 被黑洞吞噬 / 飞出边界的星体不可撤销（条目惰性失效）；
  //   - 保留布防决策的重量，避免撤销变成零成本试错工具。
  function recordPlacement(body, typeKey, cost) {
    state.placeHistory.push({ body: body, cost: cost, typeKey: typeKey, time: state.gameTime });
    // 上限保护：长局持续放置时淘汰最旧条目（历史只用于"最近一次"，淘汰旧条目无副作用）
    if (state.placeHistory.length > UNDO_HISTORY_MAX) {
      state.placeHistory.splice(0, state.placeHistory.length - UNDO_HISTORY_MAX);
    }
  }
  // 条目是否仍可撤销：仍在场上、未死亡、且在时间窗内
  function isUndoEntryValid(entry) {
    if (!entry || !entry.body) return false;
    if (entry.body.dead) return false;
    if (state.bodies.indexOf(entry.body) < 0) return false;
    return (state.gameTime - entry.time) <= UNDO_WINDOW;
  }
  // 惰性清理尾部失效条目：它们永远无法被撤销，留在栈里只会让状态失真
  function prunePlaceHistory() {
    while (state.placeHistory.length > 0
           && !isUndoEntryValid(state.placeHistory[state.placeHistory.length - 1])) {
      state.placeHistory.pop();
    }
  }
  function canUndo() {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '' };
    if (!Array.isArray(state.placeHistory)) return { ok: false, reason: '' };
    prunePlaceHistory();
    const entry = state.placeHistory[state.placeHistory.length - 1];
    if (!entry) return { ok: false, reason: '' };
    return { ok: true, reason: '', refund: entry.cost };
  }
  function undoLastPlacement() {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法撤销' };
    if (!Array.isArray(state.placeHistory)) return { ok: false, reason: '没有可撤销的放置' };
    prunePlaceHistory();
    const entry = state.placeHistory.pop();
    if (!entry) return { ok: false, reason: '没有可撤销的放置（仅可撤销最近 5 秒内放置且仍在场上的星体）' };
    const idx = state.bodies.indexOf(entry.body);
    if (idx < 0) return { ok: false, reason: '该星体已不在场上' };
    state.bodies.splice(idx, 1);
    // 全额返还：误投不应造成星能损失（黑洞同样整体返还，天体已移除、不涉及寿命折算）
    state.budget = Math.min(99999, state.budget + entry.cost);
    state.totalSpent = Math.max(0, state.totalSpent - entry.cost);
    if (state.starsPlaced > 0) state.starsPlaced--;
    // 反馈：蓝色冲击波 + 轻盈音效（与"被吸收"同源，语义为"收回"）
    spawnShockwave(entry.body.x, entry.body.y, (entry.body.radius || 12) + 40,
                   'rgba(150,205,255,0.65)', 0.35);
    audio.play('flee');
    return { ok: true, reason: '', refund: entry.cost };
  }

  // ===== 无尽模式阶段与风暴波（v1.12）=====
  // 节奏重写：把 v1.11 的"封顶后每超 1 单位 +10%"连续 ramp，升级为「阶段 + 每 10 波风暴」。
  //   阶段划分：stage = floor((wave-1) / 10) → 第 1~10 波为阶段 0（基准），11~20 为阶段 1，依此类推。
  //   风暴波：wave % 10 === 0（第 10 / 20 / 30 … 波）——每个阶段的**收尾波**，额外涌入一小群分裂彗星。
  // 单调性（硬约束）：阶段阶段加成随 stage 非递减，基础 ramp 随 wave 非递减，两者相加 → 难度进度 t 非递减，
  // 因此 difficulty 单调不减、interval 单调不增、count 单调不减（风暴前锋只改单波构成，不改曲线参数）。
  // 兼容性：阶段 0 的加成全为 1.0/0，故第 1~10 波与 v1.11 完全一致；阶段效果只在 endless 下生效。
  const ENDLESS_STAGE_SIZE = 10;
  const ENDLESS_T_CAP = 2.1;              // 难度进度上限（v1.11 为 1.6；阶段加成需要更高上限才有意义）
  const ENDLESS_STAGES = [
    // bump：叠加到难度进度 t；countMul：本波数量倍率；comet/splitter/disturberRatio：额外混入占比
    { bump: 0.00, countMul: 1.00, cometRatio: 0.00, splitterRatio: 0.00, disturberRatio: 0.00 },
    { bump: 0.08, countMul: 1.08, cometRatio: 0.05, splitterRatio: 0.04, disturberRatio: 0.03 },
    { bump: 0.18, countMul: 1.16, cometRatio: 0.09, splitterRatio: 0.07, disturberRatio: 0.05 },
    { bump: 0.30, countMul: 1.24, cometRatio: 0.13, splitterRatio: 0.09, disturberRatio: 0.07 },
    { bump: 0.44, countMul: 1.32, cometRatio: 0.17, splitterRatio: 0.11, disturberRatio: 0.09 },
    { bump: 0.60, countMul: 1.40, cometRatio: 0.21, splitterRatio: 0.13, disturberRatio: 0.11 },
  ];
  function endlessStageOf(wave) {
    const w = Math.max(1, parseInt(wave, 10) || 1);
    return Math.floor((w - 1) / ENDLESS_STAGE_SIZE);
  }
  function endlessStageDef(stage) {
    const s = Math.max(0, parseInt(stage, 10) || 0);
    return ENDLESS_STAGES[Math.min(s, ENDLESS_STAGES.length - 1)];
  }
  // 阶段信息（HUD 与测试共用）。
  // 非无尽模式**恒返回基准值**：阶段机制只属于无尽模式，这样即便将来有新的调用点
  // 忘记判模式，也不会让生存/固定波次模式意外吃到阶段加成（不可绕过的安全不变量）。
  function getEndlessStageInfo() {
    const w = Math.max(1, parseInt(state.wave, 10) || 1);
    const endless = (state.mode === 'endless');
    const stage = endlessStageOf(w);
    const idx = Math.min(stage, ENDLESS_STAGES.length - 1);
    const def = endlessStageDef(stage);
    const stormNow = endless && (w % ENDLESS_STAGE_SIZE === 0);
    return {
      stage: endless ? stage : 0,              // 0 基阶段序号（用于取表）
      stageNo: endless ? (idx + 1) : 1,        // 展示用阶段号（从 1 起）
      capped: endless ? (stage > idx) : false, // 是否已到最后一段（之后沿用其参数）
      size: ENDLESS_STAGE_SIZE,
      stormNow: stormNow,                      // 本波是否风暴波
      sinceStorm: stormNow ? 0 : (ENDLESS_STAGE_SIZE - (w % ENDLESS_STAGE_SIZE)),  // 距下次风暴还有几波
      bump: endless ? def.bump : 0,
      countMul: endless ? def.countMul : 1,
      cometRatio: endless ? def.cometRatio : 0,
      splitterRatio: endless ? def.splitterRatio : 0,
      disturberRatio: endless ? def.disturberRatio : 0,
    };
  }

  // ===== 随机波次生成 =====
  // difficulty: 0~1，随 wave 在关卡定义的区间内插值（仅生存模式使用随机生成）
  function waveParams() {
    const w = state.wave;
    const cfg = state.level.waves;
    // 难度随 wave 在 [startDifficulty, endDifficulty] 区间线性插值，封顶 wave 数量由 difficultyRamp 推断
    let t = clamp(w * cfg.difficultyRamp, 0, 1);
    // 无尽模式（v1.12）：基础连续 ramp（与 v1.11 同口径，保证第 1~10 波完全一致）+ 阶段加成
    if (state.mode === 'endless') {
      const base = t + Math.max(0, w * cfg.difficultyRamp - 1) * 0.10;
      t = Math.min(ENDLESS_T_CAP, base + endlessStageDef(endlessStageOf(w)).bump);
    }
    const difficulty = lerp(cfg.startDifficulty, cfg.endDifficulty, t);
    const interval = lerp(cfg.startInterval, cfg.endInterval, t);
    const count = Math.round(lerp(cfg.startCount, cfg.endCount, t) + randInt(-1, 1));
    return { difficulty, interval: clamp(interval, 0.4, 3.0), count: clamp(count, 3, 16) };
  }

  // 极限模式：从确定性关卡配置中按波次索引直接取波次（无随机）
  function generateWaveDeterministic() {
    const arr = state.level.waves;
    const idx = state.wave - 1;
    if (idx < 0 || idx >= arr.length) return null;   // 超出即通关
    const wv = arr[idx];
    const queue = wv.spawns.map(s => ({ kind: s.kind, difficulty: wv.difficulty, spawn: s }));
    return { queue, interval: wv.interval, difficulty: wv.difficulty, isLast: idx === arr.length - 1 };
  }

  function generateWave() {
    // 极限模式使用确定性配置
    if (Array.isArray(state.level.waves)) {
      return generateWaveDeterministic();
    }
    const p = waveParams();
    // 无尽阶段（v1.12）：数量与特殊威胁占比按阶段加成。
    // 生存模式 endless === null → 走与 v1.11 完全一致的原路径（连 rand 调用次数都保持一致）。
    const endless = (state.mode === 'endless') ? getEndlessStageInfo() : null;
    const baseCount = clamp(Math.round(p.count * (endless ? endless.countMul : 1)), 3, 20);
    const cometRatio = endless
      ? clamp(clamp(0.15 + p.difficulty * 0.30, 0.15, 0.5) + endless.cometRatio, 0.15, 0.7)
      : clamp(0.15 + p.difficulty * 0.30, 0.15, 0.5);
    // 特殊威胁（分裂彗星 / 引力干扰体）单项限量，避免单波出现大量分裂体把场上天体数顶到上限
    const splitterCount = endless ? Math.min(3, Math.round(baseCount * endless.splitterRatio)) : 0;
    const disturberCount = endless ? Math.min(2, Math.round(baseCount * endless.disturberRatio)) : 0;
    const rest = Math.max(1, baseCount - splitterCount - disturberCount);
    const cometCount = Math.round(rest * cometRatio);
    const asteroidCount = Math.max(0, rest - cometCount);
    const queue = [];
    for (let i = 0; i < cometCount; i++) queue.push({ kind: 'comet', difficulty: p.difficulty });
    for (let i = 0; i < asteroidCount; i++) queue.push({ kind: 'asteroid', difficulty: p.difficulty });
    for (let i = 0; i < splitterCount; i++) queue.push({ kind: 'splitter', difficulty: p.difficulty });
    for (let i = 0; i < disturberCount; i++) queue.push({ kind: 'disturber', difficulty: p.difficulty });
    // 风暴前锋（v1.12）：第 10/20/30… 波额外涌入一小群分裂彗星，让风暴波构成明显暴增
    if (endless && endless.stormNow) {
      const extra = 2 + Math.min(2, endless.stage);
      for (let i = 0; i < extra; i++) queue.push({ kind: 'splitter', difficulty: p.difficulty });
    }
    for (let i = queue.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    return { queue, interval: p.interval, difficulty: p.difficulty };
  }

  function startWave() {
    state.wave++;
    const g = generateWave();
    if (!g) {
      // 闯关模式：已无更多波次（理论上清波时已判通关，这里兜底）
      // 必须回退 wave，否则空转时波次计数会被每 0.5s 无限累加（HUD 显示 25/22 之类）
      state.wave--;
      state.waveActive = false;
      state.waveTimer = 0;
      return;
    }
    const { queue, interval, difficulty } = g;
    state.difficulty = difficulty;
    state.waveQueue = queue;
    state.waveInterval = interval;
    state.waveActive = true;
    state.spawnAccumulator = 0;
    state.waveElapsed = 0;                 // 波次超时计时（H3）
    // 记录是否最后一波（闯关模式通关判定用）
    state.isLastWave = !!g.isLast;
    // 无尽阶段与风暴提示（v1.12）：必须在 wave 自增之后读取；其它模式恒为 0，不影响任何既有行为
    if (state.mode === 'endless') {
      const info = getEndlessStageInfo();
      state.endlessStage = info.stage;
      if (info.stormNow) {
        pushNotice('风暴来袭 · 第 ' + state.wave + ' 波（阶段 ' + info.stageNo + ' 收尾）');
      }
    } else {
      state.endlessStage = 0;
    }
  }

  function spawnFromQueue() {
    if (state.waveQueue.length === 0) return;
    const item = state.waveQueue.shift();
    spawnThreat(item);
  }

  // 来袭边归一化：确定性配置用 'top'/'right'/'bottom'/'left'，生存随机用 0~3
  const EDGE_INDEX = { top: 0, right: 1, bottom: 2, left: 3 };
  function normalizeEdge(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return ((v % 4) + 4) % 4;
    const key = String(v == null ? '' : v).toLowerCase();
    return Object.prototype.hasOwnProperty.call(EDGE_INDEX, key) ? EDGE_INDEX[key] : null;
  }

  // 生成威胁天体。优先使用确定性配置描述的 {edge, spread, speed, mass, radius}，
  // 否则（生存模式）回退到随机生成。spread 为相对「母星方向」的偏角（弧度）。
  function spawnThreat(item) {
    const kind = item.kind;
    const difficulty = item.difficulty || 0;
    const spawn = item.spawn || null;       // 确定性模式携带的预生成描述
    const W = window.innerWidth, H = window.innerHeight;
    const cx = W / 2, cy = H / 2;

    let edge, spread, speed, mass, radius;
    if (spawn) {
      const e = normalizeEdge(spawn.edge);
      edge = (e === null) ? randInt(0, 3) : e;
      spread = Number.isFinite(spawn.spread) ? spawn.spread : 0;
      speed = spawn.speed;
      mass = spawn.mass;
      radius = spawn.radius;
    } else {
      // 生存模式：随机（允许差异，不影响公平性，因生存模式比拼分数而非固定挑战）
      // 瞄准母星，偏角随难度收窄（±0.60 rad → ±0.15 rad）：
      // 早期宽容、后期来袭更精准；同时避免大量威胁背向母星飞出边界白送拦截分。
      edge = randInt(0, 3);
      const spreadArc = lerp(0.60, 0.15, clamp(difficulty, 0, 1));
      spread = rand(-spreadArc, spreadArc);
      // 类型差异（v1.12 补齐分裂彗星/干扰体，供无尽阶段混入）：
      // 彗星快而小、分裂彗星更快更脆、干扰体慢而大（脉冲型）。
      // 注意：彗星与陨石的分支取值与 rand 调用顺序与 v1.11 完全一致（生存模式零行为变化）。
      const speedBase = (kind === 'comet') ? rand(120, 200)
        : (kind === 'splitter') ? rand(100, 170)
        : (kind === 'disturber') ? rand(50, 85)
        : rand(60, 110);
      speed = speedBase * (0.8 + difficulty * 0.6);
      mass = kind === 'comet' ? 30
        : (kind === 'splitter') ? 40
        : (kind === 'disturber') ? 60
        : (30 + difficulty * 40);
      radius = kind === 'comet' ? 7
        : (kind === 'splitter') ? 9
        : (kind === 'disturber') ? 15
        : (13 + difficulty * 6);
    }

    // 「来袭加速」修饰符（v1.10）：速度 ×1.5。放在方向/速度换算之前，
    // 保证生成方向与预测线读到的都是同一个 speed（预测一致性）。
    if (hasModifier('fastThreats')) speed *= 1.5;

    // 出屏幕外的生成点（各边外扩 margin）
    const margin = 60;
    let x, y;
    if (edge === 0) { x = rand(margin, W - margin); y = -margin; }
    else if (edge === 1) { x = W + margin; y = rand(margin, H - margin); }
    else if (edge === 2) { x = rand(margin, W - margin); y = H + margin; }
    else { x = -margin; y = rand(margin, H - margin); }

    // 基准朝母星，叠加偏角 → 绝对来袭角
    const baseAng = Math.atan2(cy - y, cx - x);
    const ang = baseAng + spread;
    const vx = Math.cos(ang) * speed;
    const vy = Math.sin(ang) * speed;
    pushThreatBody(kind, mass, radius, x, y, vx, vy, spawn);
  }

  function pushThreatBody(kind, mass, radius, x, y, vx, vy, spec) {
    // 总量上限保护：超限时不出生（避免 O(N²) 把页面拖垮），并只记一次告警便于排查
    if (state.bodies.length >= MAX_TOTAL_BODIES) {
      if (!state.spawnBlockedLogged) {
        state.spawnBlockedLogged = true;
        console.warn('StarShield: 场上天体达上限 ' + MAX_TOTAL_BODIES + '，后续威胁不再生成');
      }
      return null;
    }
    if (kind === 'boss') {
      // Boss：巨体 + 多段血（hp 由关卡配置给出，physics 负责逐段扣减）
      const hpMax = clamp((spec && Number.isFinite(spec.hp)) ? spec.hp : 3, 1, 6);
      state.bodies.push({
        type: 'boss', mass: mass, radius: radius,
        x, y, vx, vy,
        hp: hpMax, hpMax: hpMax,
        rotation: rand(0, Math.PI * 2),
      });
      return;
    }
    if (kind === 'disturber') {
      // 引力干扰体：周期性向外推挤附近天体（脉冲在 physics 层执行，保证预测一致）
      state.bodies.push({
        type: 'disturber', mass: mass, radius: radius,
        x, y, vx, vy,
        pulseStrength: (spec && Number.isFinite(spec.pulseStrength)) ? spec.pulseStrength : 130,
        pulsePeriod: (spec && Number.isFinite(spec.pulsePeriod)) ? spec.pulsePeriod : 2.8,
        rotation: rand(0, Math.PI * 2),
      });
      return;
    }
    if (kind === 'splitter' || kind === 'splitChild') {
      const isChild = (kind === 'splitChild');
      state.bodies.push({
        type: isChild ? 'splitChild' : 'splitter',
        mass: mass, radius: radius,
        x, y, vx, vy,
        trail: [],
        splitDepth: isChild ? 1 : 0,
      });
      return;
    }
    if (kind === 'comet') {
      state.comets++;
      state.bodies.push({
        type: 'comet', mass: mass, radius: radius,
        x, y, vx, vy, trail: [],
      });
    } else {
      state.asteroids++;
      state.bodies.push({
        type: 'asteroid', mass: mass, radius: radius,
        x, y, vx, vy, rotation: rand(0, Math.PI * 2),
        vertices: Array.from({ length: 9 }, () => rand(0.75, 1.2)),
      });
    }
  }

  // 分裂彗星：被拦截（撞毁）/ 被黑洞吞噬 / 超时收编后裂成两个子体。
  // 规则：撞母星不分裂（见调用点）、每个分裂体只裂一次（splitDone + splitDepth 双保险）、
  // 受场上天体总数上限保护（超限则不再产生子体，避免 O(N²) 失控）。
  function maybeSplitThreat(body) {
    if (!body || body.type !== 'splitter' || body.splitDone) return 0;
    body.splitDone = true;
    const speed = Math.hypot(body.vx || 0, body.vy || 0) || 60;
    const ux = (body.vx || 0) / speed, uy = (body.vy || 0) / speed;
    const px = -uy, py = ux;                       // 垂直于运动方向
    const childMass = Math.max(8, Math.round((body.mass || 30) * 0.5));
    const childRadius = Math.max(6, Math.round((body.radius || 9) * 0.8));
    let n = 0;
    for (const sign of [1, -1]) {
      if (state.bodies.length >= MAX_TOTAL_BODIES) break;
      state.bodies.push({
        type: 'splitChild', mass: childMass, radius: childRadius,
        x: body.x + px * 14 * sign, y: body.y + py * 14 * sign,
        vx: (body.vx || 0) + px * 60 * sign,
        vy: (body.vy || 0) + py * 60 * sign,
        trail: [], splitDepth: 1,
      });
      n++;
    }
    if (n > 0) {
      spawnShockwave(body.x, body.y, (body.radius || 9) + 60, 'rgba(255,220,160,0.8)', 0.35);
      spawnExplosion(body.x, body.y, '#ffe0a0', 14);
      audio.play('split');
    }
    return n;
  }

  function clearWave() {
    state.waveActive = false;
    state.waveQueue = [];
    state.spawnAccumulator = 0;
    state.waveElapsed = 0;
    // 波次清空奖励：基础 15 + 每波 5 分
    const wb = 15 + 5 * state.wave;
    state.lastWaveBonus = wb;
    state.scoreWaveBonus += wb;
    // 减速额度返还（P0-1）：清空一波即可换回少量慢动作时间（封顶）。
    // 与计分解耦——额度只影响操作手感，不改变任何得分口径。
    state.slowQuota = Math.min(SLOW_QUOTA_MAX, state.slowQuota + SLOW_REFUND_PER_WAVE);
    // 道具补给（P2）：生存/无尽每清 5 波补 1 个（按 引力脉冲→斥力波→凝滞 轮转），
    // 闯关按关卡发放固定配额，不额外补给，保持"资源稀缺"的紧张感。
    if (!isFixedWaveMode() && state.wave % 5 === 0) {
      const ids = ['gravityWell', 'repulseWave', 'stasis'];
      const id = ids[((state.wave / 5) - 1) % ids.length];
      if (state.props && Number.isFinite(state.props[id])) {
        state.props[id] = Math.min(PROP_MAX_EACH, state.props[id] + 1);
      }
    }
  }

  // ===== 减速额度（P0-1）=====
  // 切换慢动作的唯一入口（input.js 不再直接写 state.timeScale）：
  // 额度耗尽时拒绝进入减速并给出可读提示，返回 { ok, timeScale, reason }。
  function toggleSlowMotion() {
    if (!state.gameStarted || state.gameOver) {
      return { ok: false, timeScale: state.timeScale, reason: '当前无法切换时间' };
    }
    // 修饰符（v1.10）：「禁减速」本局完全没有慢动作（额度也在 setupLevel 里清零）
    if (hasModifier('noSlow')) {
      pushNotice('本关禁用时间减速');
      return { ok: false, timeScale: 1, reason: '本关禁用减速' };
    }
    if (state.timeScale === 1) {
      if (state.slowQuota <= 0) {
        pushNotice('减速额度已用尽：每清空一波返还 ' + SLOW_REFUND_PER_WAVE + ' 秒');
        return { ok: false, timeScale: 1, reason: '减速额度已用尽' };
      }
      state.timeScale = 0.25;
      return { ok: true, timeScale: 0.25, reason: '' };
    }
    state.timeScale = 1;
    return { ok: true, timeScale: 1, reason: '' };
  }
  function slowMotionState() {
    const max = SLOW_QUOTA_MAX;
    const quota = Math.max(0, Math.min(max, Number.isFinite(state.slowQuota) ? state.slowQuota : max));
    return {
      quota: quota,
      max: max,
      ratio: max > 0 ? quota / max : 0,
      low: quota / max <= SLOW_LOW_RATIO,
      exhausted: quota <= 0,
      disabled: hasModifier('noSlow'),   // v1.10：本关禁用减速（UI 显示"禁用"而非"已耗尽"）
    };
  }

  // ===== 撞击动画工具 =====
  // 在指定位置触发冲击波环（多色支持）
  function spawnShockwave(x, y, maxRadius, color, life) {
    state.shockwaves.push({
      x, y, radius: 0,
      maxRadius: maxRadius,
      life: life || 0.4, maxLife: life || 0.4,
      color: color || 'rgba(255,255,255,0.85)',
    });
  }
  // 在指定位置产生屏闪（颜色 + 强度）
  function addFlash(color, intensity) {
    state.flashes.push({
      color: color || 'rgba(255,80,90,0.35)',
      life: 0.30, maxLife: 0.30,
      intensity: intensity || 1,
    });
  }

  // 统一结算：一个威胁天体被清除（出界飞离 / 黑洞吞噬 / 星体互撞爆炸）
  // method ∈ {'flee','blackhole','clash','timeout'} 用于差异化统计；分值按威胁类型区分
  function registerClear(body, method) {
    // 分裂彗星：被清除时先裂成两个子体（撞母星不走这里，故不会分裂）
    maybeSplitThreat(body);
    const difficulty = Number.isFinite(state.difficulty) ? state.difficulty : 0.3;
    // 分档：Boss 远高于普通威胁（需要多段摧毁），分裂子体最低，干扰体/分裂彗星居中
    const base = body.type === 'boss'
      ? 60 + Math.round((body.mass || 40) / 12)
      : body.type === 'disturber' ? 20
      : body.type === 'splitter' ? 14
      : body.type === 'splitChild' ? 5
      : body.type === 'comet' ? 12
      : 6 + Math.round((body.mass || 40) / 8);
    // 难度加权：以 0.3 为基准，难度越高分越多
    const diffMul = 1 + Math.max(0, difficulty - 0.3) * 1.4;
    // 模式/关卡加权：闯关模式越靠后关卡倍率越高（生存模式恒为 1）
    const modeMul = state.mode === 'campaign' ? (1 + state.levelIndex * 0.15) : 1;
    const gain = Math.max(1, Math.round(base * diffMul * modeMul));
    state.scoreIntercept += gain;
    state.asteroidsCleared += 1;
    // 成就统计（P1-C）：黑洞吞噬数量（method 此前未差异化，正好作为钩子）
    if (method === 'blackhole') state.blackholeSwallowed += 1;
    // 闯关模式资源回收：每清除一个威胁返还少量星能（替代旧 rewards 硬编码）
    if (state.mode === 'campaign') {
      state.budget = Math.min(99999, state.budget + 2);
    }
    return gain;
  }

  // 母星受到来袭威胁撞击（仅威胁类型会走到这里，见 M6 的调用点判定）
  function damagePlanet(byBody) {
    // Boss 撞母星重罚 2 点（并自身消失，见 physics 的撞母星分支），其余威胁 1 点。
    // hitCount 仍按"受击次数"计（星级判定的口径保持简单），不随伤害点数放大。
    const dmg = (byBody && byBody.type === 'boss') ? 2 : 1;
    state.health -= dmg;
    state.hitCount += 1;
    // 失守惩罚：母星被击中扣 8 分（总分不低于 0）。
    // 总分由明细派生，故先记满额惩罚、再回退「未真正扣掉」的部分，保证
    // 结算面板的惩罚明细与实际扣分严格一致（M2）。
    const before = integerScore();
    state.scorePenalty += 8;
    state.scorePenalty -= (8 - (before - integerScore()));
    state.healthFlash = 1;
    state.shake = 14;
    state.planetPunch = 1;                       // 母星震缩
    // 母星冲击波环（红）
    const planet = state.bodies[0];
    if (planet) {
      spawnShockwave(planet.x, planet.y, planet.radius + 180,
                     'rgba(255,120,140,0.85)', 0.45);
    }
    addFlash('rgba(255,80,90,0.35)', 1);
    // 撞击点碎片（更鲜更密）
    if (byBody) {
      const color = byBody.type === 'asteroid' ? '#ff7a7a' : '#ffc266';
      spawnExplosion(byBody.x, byBody.y, color, 24);
    }
    audio.play('hit');
    if (state.health <= 0) {
      state.health = 0;
      endGame();
    }
  }

  // 玩家星体被母星吸收（M6）：母星只被来袭威胁伤害，玩家自己的星体撞上来
  // 只损失该星体、不扣母星血量——避免误投或被自身引力拽回造成"自伤"，
  // 与 README「陨石撞母星扣 1 点血」的规则一致。
  function absorbByPlanet(body) {
    const planet = state.bodies[0];
    if (planet) {
      spawnShockwave(planet.x, planet.y, planet.radius + 70,
                     'rgba(150,205,255,0.65)', 0.35);
    }
    if (body) {
      spawnExplosion(body.x, body.y, '#9ad0ff', 8);
    }
    audio.play('flee');
  }

  // 波次超时强制收编（H3）：被引力拘禁在稳定轨道、既不出界也不撞母星的威胁
  // 会让波次永远无法结算（闯关模式直接软锁）。这里按"已被引力收编"统一结算清除。
  function sweepRemainingThreats() {
    let swept = 0;
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (!physics.isThreat(b)) continue;
      registerClear(b, 'timeout');
      spawnShockwave(b.x, b.y, b.radius + 70, 'rgba(120,190,255,0.55)', 0.35);
      state.bodies.splice(i, 1);
      swept++;
    }
    if (swept > 0) addFlash('rgba(120,170,255,0.18)', 0.6);
    state.waveElapsed = 0;
    return swept;
  }

  // 黑洞吞任何天体（陨石/彗星/玩家星体）
  function consumeByBlackhole(victim, blackHole) {
    // 紫色粒子收缩
    spawnExplosion(victim.x, victim.y, '#c89bff', 18);
    // 紫色冲击波环（从黑洞位置）
    spawnShockwave(blackHole.x, blackHole.y, blackHole.radius + 120,
                   'rgba(200,155,255,0.85)', 0.40);
    // 紫色屏闪（轻微）
    addFlash('rgba(170,120,255,0.22)', 0.6);
    audio.play('suck');
  }

  // 玩家星体之间互撞（物理碰撞反弹）
  function starStarCollision(a, b) {
    // 蓝色火花
    spawnExplosion((a.x + b.x) / 2, (a.y + b.y) / 2, '#7fc6ff', 10);
    audio.play('boom');
    // 轻微屏震
    state.shake = Math.max(state.shake, 6);
  }

  // ===== 结局文案与完美收集（v1.12）=====
  // 只对「闯关模式第 40 关（第四章终关）」与「两个隐藏关」在通关时给出专属结局文案。
  // 文案来源：章节结局在 CHAPTERS[3].ending；隐藏关结语在 window.STORY.hidden（内容层导出，
  // 刻意不写进关卡对象——关卡对象有 fixture 逐字段精确比对）。
  // 口径：挑战/每日模式复用同一批关卡但**不播剧情**（同一段剧情讲两遍反而弱化收束感），
  // 因此这里严格限定 mode === 'campaign'。
  function getRunEnding() {
    if (state.endReason !== 'win' || state.mode !== 'campaign') return null;
    if (!state.level) return null;
    const story = (typeof window !== 'undefined') ? window.STORY : null;
    if (isHiddenLevel()) {
      const def = (story && story.hidden) ? story.hidden[state.level.id] : null;
      return def ? { id: state.level.id, title: def.title, text: def.text } : null;
    }
    if (state.levelIndex !== regularLevelCount() - 1) return null;
    const ch = (CHAPTERS && CHAPTERS.length) ? CHAPTERS[CHAPTERS.length - 1] : null;
    if (!ch || !ch.ending) return null;
    return { id: ch.id, title: ch.ending.title, text: ch.ending.text };
  }
  function getPerfectStory() {
    const story = (typeof window !== 'undefined') ? window.STORY : null;
    return (story && story.perfect) ? { title: story.perfect.title, text: story.perfect.text } : null;
  }
  // 100% 收集：满星 + 常规关任务全清 + 隐藏关全清（星图总览面板据此显示收束文案）
  function isPerfectCollected() {
    return regularLevelCount() > 0 && countHiddenLevels() > 0
      && getTotalStars() >= totalStarsMax()
      && countRegularTasksDone() >= regularLevelCount()
      && getHiddenClearedCount() >= countHiddenLevels();
  }

  function endGame(reason) {
    if (state.gameOver) return;
    state.gameOver = true;
    state.endReason = reason || 'defeat';    // 'defeat' | 'timeup' | 'win'
    // 通关当前关：解锁下一关（闯关/挑战各自独立推进）
    if (state.endReason === 'win') {
      unlockNextLevel();
      unlockNextChallenge();
    }
    // 星级评价（P1-A）：闯关与挑战通关计星，各自独立存档，只增不减
    if (state.mode === 'campaign' || state.mode === 'challenge') recordRunStars();
    // v1.10：额外任务（只判不罚）与最佳记录，均在结算面板渲染前算好
    state.lastTask = recordRunTask();
    state.lastRecord = recordRun();
    if (state.mode === 'challenge') recordChallengeRun();
    if (state.mode === 'daily') state.lastDaily = recordDaily();
    // 成就判定（P1-C）：必须放在星级写入之后——star_30/star_60/star_all 依赖最新总星数
    evaluateAchievements();
    // 结算时清空选中态（操作面板由 input 层同步隐藏）
    state.selectedBody = null;
    updateBest();
    // v1.12 结算链路（顺序即依赖）：结局文案 → 历史榜单 → 累计统计 → 弹结算面板。
    // 榜单要读 state.lastStars（recordRunStars 已写入）与 integerScore；统计为纯累加。
    state.lastEnding = getRunEnding();
    state.lastBoardRank = recordRunBoard();
    accumulateStats();
    // 音效：通关/时间到 → 庆祝；母星陨落/防线失守 → gameover
    audio.play(state.endReason === 'win' ? 'place' : (state.endReason === 'timeup' ? 'place' : 'gameover'));
    // 结算时：隐藏星体栏 + 控制条（避免误触），HUD 保留背景观感
    ['starBar', 'controls', 'propBar'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    // 通知 input 显示结算面板
    if (typeof window.__showResult === 'function') {
      window.__showResult(state.endReason);
    }
  }

  // ===== 粒子 =====
  function spawnExplosion(x, y, color, n) {
    const count = Math.max(0, n | 0);
    // 粒子上限（M8）：同帧大量爆炸/吞噬时淘汰最旧粒子，避免内存与绘制尖峰
    const overflow = state.particles.length + count - MAX_PARTICLES;
    if (overflow > 0) state.particles.splice(0, overflow);
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(40, 220);
      state.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.3, 0.8), maxLife: 0.8, color,
      });
    }
  }

  // ===== 主循环步进 =====
  // dtReal：本帧真实经过的秒数（由 input.js 的 rAF 循环传入）。
  // 内部按固定步长 DT 累加推进，返回时 state 已前进 0~MAX_SUBSTEPS 步。
  function stepFrame(dtReal) {
    if (state.gameOver || !state.gameStarted) { stepAccumulator = 0; return; }

    // 帧率无关的固定步长推进：按真实时间累加，攒够一个 DT 才走一步。
    // 这样 60Hz / 120Hz / 掉帧下的游戏速度一致，且物理步长恒为 DT
    // （若缩放步长本身，慢动作会让物理与预测积分不一致、预测线失真）。
    // dtReal 缺省时按一帧（DT）处理，便于脚本/测试直接调用 stepFrame()。
    const real = (typeof dtReal === 'number' && Number.isFinite(dtReal) && dtReal > 0)
      ? Math.min(dtReal, MAX_FRAME_DT)
      : DT;
    // 减速额度扣减（P0-1）：按真实帧时间，且必须放在下面 `steps === 0` 提前返回之前——
    // 否则 120Hz 高刷屏上偶数帧会漏扣，额度消耗速率减半。
    // 这里只做「额度耗尽 → 降级回常速」的单向处理，不改写正常的 timeScale，
    // 保持 stepFrame 对 state.timeScale 的既有直读语义（旧调用与测试兼容）。
    if (state.timeScale < 1) {
      state.slowUsedSeconds += real;          // 成就统计（P1-C）：本局实际减速时长（真实秒）
      state.slowQuota = Math.max(0, state.slowQuota - real);
      if (state.slowQuota <= 0) {
        state.timeScale = 1;
        pushNotice('减速额度已用尽，已恢复常速（每清空一波返还 ' + SLOW_REFUND_PER_WAVE + ' 秒）');
      }
    }
    // 凝滞道具（P2）：短时全局减速走独立因子，而非改写 state.timeScale——
    // 既不消耗减速额度，也不污染 slowUsedSeconds（成就判定）与玩家的减速偏好。
    const stasisFactor = state.stasisTime > 0 ? STASIS_FACTOR : 1;
    if (state.stasisTime > 0) state.stasisTime = Math.max(0, state.stasisTime - real);
    stepAccumulator += real * state.timeScale * stasisFactor;
    let steps = 0;
    while (stepAccumulator >= DT && steps < MAX_SUBSTEPS) {
      stepAccumulator -= DT;
      steps++;
    }
    if (steps === 0) return;                       // 还没攒够一步（高刷屏上常见）
    if (stepAccumulator >= DT) stepAccumulator = 0; // 积压过多 → 丢弃，避免追帧雪崩
    const dtFrame = DT * steps;
    // 本局游戏时钟（P0-2）：撤销时间窗与其它"游戏内时长"统一以此为准（慢动作下按比例延长）
    state.gameTime += dtFrame;

    if (!state.waveActive) {
      state.waveTimer += dtFrame;
      if (state.waveTimer >= 0.5) startWave();
    } else {
      state.spawnAccumulator += dtFrame;
      while (state.spawnAccumulator >= state.waveInterval && state.waveQueue.length > 0) {
        state.spawnAccumulator -= state.waveInterval;
        spawnFromQueue();
      }
    }

    for (let k = 0; k < steps; k++) physics.stepSystem(state.bodies, DT);

    // 尾迹（彗星 / 分裂彗星 / 分裂子体）
    for (const b of state.bodies) {
      if (b.type === 'comet' || b.type === 'splitter' || b.type === 'splitChild') {
        const maxLen = b.type === 'splitChild' ? 6 : 12;
        b.trail = b.trail || [];
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > maxLen) b.trail.shift();
      }
    }

    // 碰撞 / 出界
    const planet = state.bodies[0];
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (b.anchored) continue;
      if (b.type === 'planet') continue;
      if (b.dead) continue;                   // 已被 physics 标记死亡（黑洞吞噬等）的跳过

      const dx = b.x - planet.x, dy = b.y - planet.y;
      const dist = Math.hypot(dx, dy);
      if (dist < planet.radius + b.radius) {
        // 撞上母星：仅来袭威胁扣血，玩家星体被吸收但不造成伤害（M6）
        if (physics.isThreat(b)) damagePlanet(b);
        else absorbByPlanet(b);
        state.bodies.splice(i, 1);
        continue;
      }

      const m = 120;
      if (b.x < -m || b.x > window.innerWidth + m || b.y < -m || b.y > window.innerHeight + m) {
        // 出界：仅「来袭威胁」计入拦截清除。
        // 玩家星体飞出边界不得分，否则可反复投掷小行星出界刷分。
        if (physics.isThreat(b)) registerClear(b, 'flee');
        state.bodies.splice(i, 1);
      }
    }

    // 波次超时保护（H3）：队列已吐空、但场上仍有威胁长时间无法清场
    // （被引力拘禁在稳定轨道，既不出界也不撞母星）→ 强制收编，避免永久软锁。
    if (state.waveActive) {
      state.waveElapsed += dtFrame;
      if (state.waveQueue.length === 0 && state.waveElapsed >= WAVE_TIMEOUT) {
        sweepRemainingThreats();
      }
    }

    // 波次结束判定
    if (state.waveActive && state.waveQueue.length === 0) {
      const remaining = state.bodies.filter(
        b => physics.isThreat(b)
      ).length;
      if (remaining === 0) {
        clearWave();
        // 固定波次模式（闯关/挑战/每日）：最后一波清空即通关胜利
        if (isFixedWaveMode() && state.isLastWave) {
          endGame('win');
        }
      }
    }

    // 玩家放置的黑洞吞噬陨石（额外奖励）
    // 注：这里只计分 + 标记 dead，不播动画（统一由下方 dead 清理块调用 consumeByBlackhole）
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (!physics.isThreat(b)) continue;
      if (b.anchored) continue;
      if (b.dead) continue;                   // physics.resolveCollisions 已处理过的跳过
      // 玩家黑洞（非 anchored）也走此路径
      for (let j = 0; j < state.bodies.length; j++) {
        const h = state.bodies[j];
        if (h.type !== 'blackhole') continue;
        const dxh = b.x - h.x, dyh = b.y - h.y;
        if (Math.hypot(dxh, dyh) < h.radius + b.radius) {
          registerClear(b, 'blackhole');
          b.dead = true;
          b.captured = true;
          b.capturedBy = h;                   // 记录哪个黑洞
          break;
        }
      }
    }

    // 清理被 physics 标记为 dead 的天体（黑洞吞噬、互撞、撞母星等）
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (!b.dead) continue;
      // 补动画：
      if (b.hitStar) {
        // 撞上母星（physics 先标记了 dead，这里补发表现与结算）：
        // 仅来袭威胁扣血，玩家星体被吸收（M6）
        if (physics.isThreat(b)) damagePlanet(b);
        else absorbByPlanet(b);
      } else if (b.hitSolid) {
        // 撞上实心场景天体（伴星/引力井/障碍/脉冲源）：被撞毁。
        // 单独分支：不可走 captured（否则播紫黑洞吞噬特效并计入黑洞统计）。
        starStarCollision(b, b);
      } else if (b.exploded && !b.captured) {
        // 被玩家星体/场景机关撞毁的来袭威胁：计入拦截清除并给分（method='clash'），
        // 否则撞毁 Boss 这类"必须多段摧毁"的目标将完全没有收益，与计分规则不符。
        if (physics.isThreat(b)) {
          registerClear(b, 'clash');
          maybeSplitThreat(b);     // 分裂彗星：被撞毁后裂成两个子体（撞母星不分裂）
        }
        // 玩家星体互撞 → 蓝色火花。一次碰撞涉及两个天体，
        // 只触发一次（physics 通过 explodedWith 记录了对手）
        if (!b._clashHandled) {
          const other = b.explodedWith;
          if (other) other._clashHandled = true;
          starStarCollision(b, other || b);
        }
      } else if (b.captured) {
        // 被黑洞吞噬的分裂彗星同样分裂（黑洞吞噬属于"被拦截"）
        if (physics.isThreat(b)) maybeSplitThreat(b);
        // 被黑洞吞：优先使用 capturedBy，找不到则最近黑洞
        let bh = b.capturedBy;
        if (!bh || bh.dead) {
          let nd = Infinity;
          for (let k = 0; k < state.bodies.length; k++) {
            const h = state.bodies[k];
            if (h.type !== 'blackhole') continue;
            const d = Math.hypot(b.x - h.x, b.y - h.y);
            if (d < nd) { nd = d; bh = h; }
          }
        }
        if (bh) consumeByBlackhole(b, bh);
      }
      state.bodies.splice(i, 1);
    }

    // Boss 受击表现：physics 在扣段时写入 hpDrop，这里消费后清零（不重复播放）
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (!b.hpDrop) continue;
      b.hpDrop = 0;
      spawnShockwave(b.x, b.y, (b.radius || 20) + 90, 'rgba(240,200,255,0.85)', 0.35);
      spawnExplosion(b.x, b.y, '#e0b0ff', 16);
      state.shake = Math.max(state.shake, 8);
      state.planetPunch = Math.max(state.planetPunch, 0);
      audio.play('bossHit');
    }

    // 脉冲源开火反馈：physics 每发一次脉冲累加 pulseFired，这里消费并播放一次音效
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (!b.pulseFired) continue;
      b.pulseFired = 0;
      spawnShockwave(b.x, b.y, (b.radius || 16) + 120, 'rgba(200,155,255,0.5)', 0.35);
      audio.play('pulse');
    }

    // 粒子
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.x += p.vx * dtFrame;
      p.y += p.vy * dtFrame;
      p.life -= dtFrame;
      if (p.life <= 0) state.particles.splice(i, 1);
    }

    // 冲击波环扩散 + 渐隐
    for (let i = state.shockwaves.length - 1; i >= 0; i--) {
      const s = state.shockwaves[i];
      const t = 1 - (s.life / s.maxLife);
      s.radius = s.radius + (s.maxRadius - s.radius) * 0.12 + 4;   // 平滑扩张
      s.life -= dtFrame;
      if (s.life <= 0) state.shockwaves.splice(i, 1);
    }
    // 屏闪渐弱
    for (let i = state.flashes.length - 1; i >= 0; i--) {
      state.flashes[i].life -= dtFrame;
      if (state.flashes[i].life <= 0) state.flashes.splice(i, 1);
    }

    // 玩家黑洞生命周期 + 消失动画（M1：统一用游戏时钟 dtFrame，而非墙钟 performance.now()）
    // 用游戏时钟后：慢动作下寿命按游戏时间消耗（不再被放大 4 倍），
    // 切后台时主循环暂停 → 寿命也暂停，不会回到页面就整批过期。
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (b.type !== 'blackhole') continue;
      if (!b.anchored || !Number.isFinite(b.lifeRemaining)) continue;   // 仅玩家黑洞
      b.lifeRemaining = Math.max(0, b.lifeRemaining - dtFrame);
      // 剩余 BLACKHOLE_FADE 时进入收缩动画
      if (!b.fading && b.lifeRemaining <= BLACKHOLE_FADE) {
        b.fading = true;
        b.fadeLife = BLACKHOLE_FADE;
      }
      // fading 阶段递减 fadeLife
      if (b.fading) {
        b.fadeLife = Math.max(0, b.fadeLife - dtFrame);
      }
      // 到期 → 触发消失动画 + 移除
      if (b.lifeRemaining <= 0) {
        // 紫色冲击波 + 粒子
        spawnShockwave(b.x, b.y, b.radius + 160,
                       'rgba(200,155,255,0.85)', 0.50);
        spawnExplosion(b.x, b.y, '#c89bff', 22);
        addFlash('rgba(170,120,255,0.25)', 0.8);
        audio.play('suck');
        state.bodies.splice(i, 1);
      }
    }
    // 母星震缩渐弱
    if (state.planetPunch > 0) state.planetPunch = Math.max(0, state.planetPunch - dtFrame * 4);

    if (state.shake > 0) state.shake = Math.max(0, state.shake - dtFrame * 40);
    if (state.healthFlash > 0) state.healthFlash = Math.max(0, state.healthFlash - dtFrame * 2);

    if (state.mode === 'survival' && !state.gameOver) {
      const sv = dtFrame * 2;
      state.scoreSurvive += sv;
      // 限时倒计时
      if (state.duration > 0) {
        state.remainingTime = Math.max(0, state.remainingTime - dtFrame);
        if (state.remainingTime <= 0) {
          endGame('timeup');   // 时间到，未陨落
        }
      }
    }
  }

  // ===== HUD 更新 =====
  // HUD 每帧刷新，但绝大多数帧数值不变；用一层脏检查避免无谓的 DOM 写入
  // （textContent 写入会触发样式重算，60fps × 8 个节点是实打实的开销）。
  const hudCache = Object.create(null);
  function setText(id, txt) {
    if (hudCache[id] === txt) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = txt;
    hudCache[id] = txt;
  }
  function clearHudCache() {
    for (const k in hudCache) delete hudCache[k];
  }

  function updateHud() {
    // 游戏中才更新 HUD；菜单状态下不写 DOM，避免覆盖默认显示
    if (!state.gameStarted) return;
    if (!state.level) return;
    const set = setText;
    set('budgetVal', Math.round(state.budget));
    const waveGroup = document.getElementById('waveGroup');
    if (waveGroup) waveGroup.style.display = isFixedWaveMode() ? '' : 'none';
    // 固定波次模式常驻显示「当前波/总波」，便于了解剩余波数
    if (isFixedWaveMode() && state.level && Array.isArray(state.level.waves)) {
      set('waveVal', state.wave + '/' + state.level.waves.length);
    } else {
      set('waveVal', state.wave);
    }
    // 生存模式限时
    const timeGroup = document.getElementById('timeGroup');
    const timeVal = document.getElementById('timeVal');
    if (timeGroup && timeVal) {
      if (state.duration > 0) {
        timeGroup.style.display = '';
        const sec = Math.ceil(state.remainingTime);
        set('timeVal', sec + 's');
        timeVal.style.color = sec <= 10 ? '#ff7a7a' : '';
      } else {
        timeGroup.style.display = 'none';
      }
    }
    // 无尽阶段胶囊（v1.12）：仅无尽模式显示「阶段 N · 距风暴 X 波」；风暴波整条转红。
    // 走 hudCache 脏检查：每帧比较 key，只有阶段/倒计时变化时才写 DOM 与 class。
    const stageGroup = document.getElementById('endlessStage');
    if (stageGroup) {
      if (state.mode === 'endless') {
        const info = getEndlessStageInfo();
        if (stageGroup.style.display !== '') stageGroup.style.display = '';
        const key = info.stormNow
          ? ('storm:' + state.wave)
          : ('wave:' + state.wave + ':' + info.stageNo);
        if (hudCache.__stageKey !== key) {
          hudCache.__stageKey = key;
          if (info.stormNow) {
            stageGroup.classList.add('storm');
            set('endlessStageVal', '风暴波 · 第 ' + state.wave + ' 波');
          } else {
            stageGroup.classList.remove('storm');
            // 无尽模式的波次只在此显示（waveGroup 只在固定波次模式展开），故这里必须带上当前波数
            set('endlessStageVal', '第 ' + state.wave + ' 波 · 阶段 ' + info.stageNo
              + ' · 距风暴 ' + info.sinceStorm + ' 波');
          }
        }
      } else if (stageGroup.style.display !== 'none') {
        stageGroup.style.display = 'none';
        hudCache.__stageKey = '';
      }
    }
    // 模式标签：新增挑战/每日/无尽分支（此前只有闯关/其它两支，新模式会显示成"生存·…"）
    const MODE_TAG = { campaign: '闯关', challenge: '挑战', daily: '每日', endless: '无尽', survival: '生存' };
    set('modeTag', (MODE_TAG[state.mode] || '生存') + '·' + state.level.name);
    const healthFill = document.getElementById('healthFill');
    if (healthFill) {
      const pct = clamp(state.health / (state.level.health || 1), 0, 1) * 100;
      const pctStr = pct.toFixed(1) + '%';
      if (hudCache.__healthPct !== pctStr) {          // 血条同样做脏检查
        hudCache.__healthPct = pctStr;
        healthFill.style.width = pctStr;
        healthFill.style.background = pct < 30
          ? 'linear-gradient(90deg,#ff6b6b,#ffa36b)'
          : 'linear-gradient(90deg,#43e0a0,#6fdcff)';
      }
    }
    set('healthVal', String(state.health));
    const healthVal = document.getElementById('healthVal');
    if (healthVal) {
      // 仅在闪烁时临时改色；结束后清空 inline style，回退到 CSS 默认色
      healthVal.style.color = state.healthFlash > 0 ? '#ff7a7a' : '';
    }
    set('scoreVal', integerScore());
    set('bestVal', bestDisplay());
  }

  // ===== 关卡选择 API =====
  function getLevelsForMode(mode) {
    if (mode === 'campaign') return CAMPAIGN_LEVELS;
    // 挑战模式只含 40 个常规关：隐藏关自带特殊规则（level.modifiers），
    // 与挑战模式的递增修饰符叠加会出现"卡片显示的规则 ≠ 实际生效的规则"，故不纳入挑战模式。
    if (mode === 'challenge') return REGULAR_LEVELS;
    if (mode === 'daily') {
      const lvl = getDailyLevel();
      return lvl ? [lvl] : [];
    }
    if (mode === 'endless') return [ENDLESS_LEVEL];
    return SURVIVAL_LEVELS;
  }

  // ===== 下一波来袭预告（v1.10，只读信息）=====
  // 索引口径与 HUD 的「当前波/总波」完全一致：state.wave 表示"已开始的波数"，
  // 因此 waves[state.wave] 就是下一波（波已清、下一波未开始的间隙里 state.wave 不变，预告不跳变）。
  // 生存/无尽没有预定义波次 → available=false（UI 隐藏该项）。
  function getWavePreview() {
    const lvl = state.level;
    const empty = { available: false, waveNo: 0, total: 0, boss: false, counts: [], sides: [], label: '' };
    if (!isFixedWaveMode() || !lvl || !Array.isArray(lvl.waves)) return empty;
    const total = lvl.waves.length;
    const idx = state.wave;
    if (idx >= total) {
      return { available: false, waveNo: total, total: total, boss: false, counts: [], sides: [], label: '最终波进行中' };
    }
    const wv = lvl.waves[idx] || { spawns: [] };
    const spawns = Array.isArray(wv.spawns) ? wv.spawns : [];
    const counts = Object.create(null);
    let left = 0, right = 0, other = 0;
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[i];
      const kind = s.kind || 'asteroid';
      counts[kind] = (counts[kind] || 0) + 1;
      const e = normalizeEdge(s.edge);
      if (e === 1) right++;
      else if (e === 3) left++;
      else if (e !== null) other++;
    }
    const NAMES = { asteroid: '陨石', comet: '彗星', splitter: '分裂彗星', disturber: '干扰体', boss: 'BOSS' };
    const ORDER = ['asteroid', 'comet', 'splitter', 'disturber', 'boss'];
    const list = [];
    for (let i = 0; i < ORDER.length; i++) {
      const k = ORDER[i];
      if (counts[k]) list.push({ kind: k, name: NAMES[k] || k, count: counts[k] });
    }
    const sides = [];
    if (left) sides.push('左');
    if (right) sides.push('右');
    if (!left && !right && other) sides.push('上下');
    return {
      available: true,
      waveNo: idx + 1,
      total: total,
      boss: !!wv.boss || list.some(c => c.kind === 'boss'),
      counts: list,
      sides: sides,
      label: list.map(c => c.name + ' ×' + c.count).join(' · '),
    };
  }

  // ===== 开始游戏 =====
  function startGame(opts) {
    // 兼容/防御：允许不传或误传非对象（历史调用曾有 startGame('survival', 0)）
    const o = (opts && typeof opts === 'object') ? opts : (typeof opts === 'string' ? { mode: opts } : {});
    clearHudCache();
    stepAccumulator = 0;        // 丢弃上一局残留的时间片
    state.mode = o.mode || 'survival';
    state.levelIndex = o.levelIndex || 0;
    // 解锁校验：闯关按通关进度（第四章另加累计星星门槛）；挑战模式有独立的挑战进度
    if (state.mode === 'campaign' && !isLevelUnlocked(state.levelIndex)) {
      return false;
    }
    if (state.mode === 'challenge' && !isChallengeUnlocked(state.levelIndex)) {
      return false;
    }
    const levels = getLevelsForMode(state.mode);
    if (!levels[state.levelIndex]) return false;
    state.level = levels[state.levelIndex];
    state.gameStarted = true;
    // 每局都从零开始：场上只有母星，所有星体由玩家自行摆放（不存在预设布防）
    setupLevel();

    // 同步菜单高亮（用户用「再来一局」/「重新开始」时 input 内的选择状态需对齐）
    if (typeof window.__syncMenuSelection === 'function') {
      window.__syncMenuSelection(state.mode, state.levelIndex);
    }

    // 显隐 UI
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('starBar').classList.remove('hidden');
    document.getElementById('controls').classList.remove('hidden');
    const propBarEl = document.getElementById('propBar');
    if (propBarEl) propBarEl.classList.remove('hidden');
    // 兜底：万一结算面板/message 还残留
    const msg = document.getElementById('message');
    if (msg) { msg.classList.remove('show'); msg.textContent = ''; }
    const res = document.getElementById('result');
    if (res) res.classList.add('hidden');

    // 关卡横幅：展示本关目标与结束条件，停留更久、置顶居中且不遮挡核心区域
    const banner = document.getElementById('levelBanner');
    if (banner) {
      const lvl = state.level;
      const goal = lvl.objective || lvl.desc || '';
      const fail = lvl.failCondition || '';
      // 章首关叠加一句剧情文案（极简叙事，纯文本；每日挑战不套用闯关章节的剧情）
      let story = '';
      if (state.mode === 'campaign' || state.mode === 'challenge') {
        const ch = (CHAPTERS || []).filter(c => c.from === state.levelIndex && c.story)[0];
        if (ch) story = ch.story;
      }
      // 额外任务提示（只判不罚的附加目标）
      const task = lvl.task ? lvl.task.text : '';
      banner.innerHTML =
        `<div class="lb-name">${lvl.name}</div>` +
        (story ? `<div class="lb-story">${story}</div>` : '') +
        `<div class="lb-goal">🎯 目标：${goal}</div>` +
        (task ? `<div class="lb-task">✦ 额外任务：${task}</div>` : '') +
        (fail ? `<div class="lb-fail">⚠️ 失败：${fail}</div>` : '');
      banner.classList.add('show');
      clearTimeout(banner._t);
      banner._t = setTimeout(() => banner.classList.remove('show'), 3600);
    }

    // 若主循环曾因连续异常被停止，开新局时恢复（否则画面会一直不动）
    if (typeof window.__resumeLoop === 'function') {
      window.__resumeLoop();
    }
  }

  // 返回菜单
  function backToMenu() {
    state.gameStarted = false;
    state.gameOver = false;
    clearHudCache();
    stepAccumulator = 0;
    // 重置 controls 按钮状态（避免重开二次确认武装残留）
    const restartBtn = document.getElementById('restartBtn');
    if (restartBtn) {
      restartBtn.dataset.armed = '0';
      restartBtn.textContent = '重新开始';
      restartBtn.classList.remove('armed');
    }
    const menuBtn = document.getElementById('menuBtn');
    if (menuBtn) {
      menuBtn.dataset.armed = '0';
      menuBtn.textContent = '返回菜单';
    }
    // 清理所有动态状态
    state.shake = 0;
    state.healthFlash = 0;
    state.selectedBody = null;      // 回菜单时清空选中态，避免残留光环
    document.getElementById('menu').classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('starBar').classList.add('hidden');
    document.getElementById('controls').classList.add('hidden');
    const propBarBack = document.getElementById('propBar');
    if (propBarBack) propBarBack.classList.add('hidden');
    const res = document.getElementById('result');
    if (res) res.classList.add('hidden');
    // 通知 input 刷新最佳战绩（可能在本局中更新过）
    if (typeof window.__refreshMenuBest === 'function') {
      window.__refreshMenuBest();
    }
  }

  // 当前关卡与最佳战绩快照
  function getCurrentRunStats() {
    return {
      mode: state.mode,
      levelName: state.level ? state.level.name : '',
      wave: state.wave,
      totalWaves: (isFixedWaveMode() && state.level && Array.isArray(state.level.waves)) ? state.level.waves.length : null,
      score: integerScore(),
      cleared: state.asteroidsCleared,
      spent: state.totalSpent,
      hits: state.hitCount,
      difficulty: Number.isFinite(state.difficulty) ? Number(state.difficulty.toFixed(2)) : 0.3,
      waveBonus: state.lastWaveBonus,
      duration: state.duration,                    // 限时秒数（生存模式）
      endReason: state.endReason,                  // 'defeat' | 'timeup' | 'win' | null
      // 分数明细（分账展示）
      scoreIntercept: Math.round(state.scoreIntercept),
      interceptCount: state.asteroidsCleared,    // 拦截清除的威胁总数（用于结算明细）
      scoreWaveBonus: Math.round(state.scoreWaveBonus),
      scoreSurvive: Math.round(state.scoreSurvive),
      scorePenalty: Math.round(state.scorePenalty),
      // 计分权重说明参数
      diffMul: Number((1 + Math.max(0, state.difficulty - 0.3) * 1.4).toFixed(2)),
      modeMul: state.mode === 'campaign' ? Number((1 + state.levelIndex * 0.15).toFixed(2)) : 1,
      // P1 扩展字段（只增不改：既有字段名与口径保持原样，成就判定与结算展示共用）
      levelIndex: state.levelIndex,
      slowUsedSeconds: Math.round(state.slowUsedSeconds * 100) / 100,
      upgrades: state.upgrades,
      recycles: state.recycles,
      blackholeSwallowed: state.blackholeSwallowed,
      propsUsed: state.propsUsed,
      stasisTime: Math.round(state.stasisTime * 100) / 100,
      budgetLeft: Math.round(state.budget),
      stars: state.lastStars,
      totalStars: getTotalStars(),
      // v1.10 扩展字段（同样只增不改）：模式扩展、额外任务判定与结算展示共用
      // levelBudget = 本局**生效后**的初始星能（已计入「星能减半」等修饰符）
      levelBudget: (Number.isFinite(state.initialBudget) && state.initialBudget > 0)
        ? state.initialBudget
        : ((state.level && Number.isFinite(state.level.budget)) ? state.level.budget : 0),
      blackholesPlaced: state.blackholesPlaced,
      gameTime: Math.round(state.gameTime),          // 本局游戏时钟（秒），结算"用时"口径
      modifiers: Array.isArray(state.modifiers) ? state.modifiers.slice() : [],
      taskId: (state.level && state.level.task) ? state.level.task.id : '',
      taskText: (state.level && state.level.task) ? state.level.task.text : '',
      challengeStars: getChallengeStarsTotal(),
      tasksDone: getTasksDoneCount(),
      // v1.11 扩展字段：隐藏关与专精/协同（结算面板与成就判定共用）
      hidden: isHiddenLevel(),
      hiddenInfo: isHiddenLevel() ? getHiddenUnlockInfo(state.levelIndex) : null,
      specSwitches: state.specSwitches || 0,
      synergyMaxBonus: maxSynergyBonus(),
      // v1.12 扩展字段（只增不改）：专精 / 无尽阶段 / 结局 / 榜单 / 每日连胜 / 完美收集
      specGiantPlaced: state.specGiantPlaced || 0,
      endlessStage: state.endlessStage || 0,
      ending: state.lastEnding ? state.lastEnding.id : '',
      boardMode: state.lastBoardRank ? state.lastBoardRank.mode : '',
      boardRank: (state.lastBoardRank && Number.isFinite(state.lastBoardRank.rank)) ? state.lastBoardRank.rank : 0,
      dailyStreak: getDailyStreak(),
      hiddenCleared: getHiddenClearedCount(),
      perfect: isPerfectCollected(),
    };
  }
  // 本局场上最高的协同加成（结算/展示用；无玩家星体时为 0）
  function maxSynergyBonus() {
    let best = 0;
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (b && b.type === 'star' && Number.isFinite(b.synergyBonus) && b.synergyBonus > best) {
        best = b.synergyBonus;
      }
    }
    return Math.round(best * 1000) / 1000;
  }

  // 对外
  window.game = {
    state,
    startGame,
    backToMenu,
    stepFrame,
    updateHud,
    placeStar,
    canPlaceAt,
    loadBest,
    saveBest,
    clearAllProgress,
    bestDisplay,
    bestForMode,
    getCurrentRunStats,
    getLevelsForMode,
    isLevelUnlocked,
    getCampaignUnlocked: function () { return campaignUnlocked; },
    takeWarning,
    takeNotice,
    // P0-1 减速额度
    toggleSlowMotion,
    slowMotionState,
    // P0-2 撤销最近放置
    canUndo,
    undoLastPlacement,
    // P0-4 设置持久化
    loadSettings,
    saveSettings,
    getSettings,
    setSetting,
    // P1-A 星级评价
    loadStars,
    saveStars,
    getStars,
    starsForLevel,
    getTotalStars,
    totalStarsMax,
    getStarCriteria,
    computeStars,
    // P1-B 回收 / 升级 / 选中
    recycleBody,
    upgradeBody,
    selectBodyAt,
    clearSelection,
    getBodyActionInfo,
    // P2 一次性道具
    getProps,
    useProp,
    // v1.11 星体专精与隐藏关
    getStarDef,
    costOf,
    getSpecs: specList,
    switchSpec,
    isHiddenLevel,
    isHiddenUnlocked,
    getHiddenUnlockInfo,
    getHiddenLevels,
    regularLevelCount,
    DEFAULT_SPEC,
    HIDDEN_STAR_GATE,
    HIDDEN_TASK_NEED,
    countHiddenLevels,
    getHiddenClearedCount,
    getStarDistribution,
    // v1.12 结局文案 / 完美收集 / 无尽阶段 / 榜单与统计
    getRunEnding,
    getPerfectStory,
    isPerfectCollected,
    getEndlessStageInfo,
    ENDLESS_STAGES,
    ENDLESS_STAGE_SIZE,
    // 只读：按当前 state.wave / state.mode 推导本波参数（无副作用，供节奏校验与外部展示）
    getWaveParams: waveParams,
    BOARD_SIZE,
    BOARD_MODES,
    BOARD_MODE_NAMES,
    loadStats,
    getStatsTotals,
    getBoards,
    getBoard,
    getBoardModeNames,
    getDailyStreak,
    prevDailyKey,
    // v1.10 模式 / 修饰符 / 任务 / 记录 / 挑战 / 每日挑战
    isFixedWaveMode,
    MODIFIERS,
    challengeModifiersFor,
    getActiveModifiers,
    hasModifier,
    isTaskDone,
    getTasksDoneCount,
    TASK_CHECKS,
    getRecord,
    loadRecords,
    loadChallenge,
    getChallengeUnlocked,
    isChallengeUnlocked,
    challengeStarsForLevel,
    getChallengeStarsTotal,
    getChallengeBest,
    loadDaily,
    getDailyState,
    getDailyLevel,
    getWavePreview,
    getCh4StarGate,
    // P1-C 成就
    loadAchievements,
    saveAchievements,
    getAchievementList,
    evaluateAchievements,
    takeNewAchievements,
    ACHIEVEMENTS,
    STAR_TYPES,
    SURVIVAL_LEVELS,
    CAMPAIGN_LEVELS,
    ENDLESS_LEVEL,
    CHAPTERS,
    getBestWaves: function () { return bestWaves; },
    PLANET_FORBIDDEN_PAD,
    SLOW_QUOTA_MAX,
    SLOW_REFUND_PER_WAVE,
    UNDO_WINDOW,
    RECYCLE_REFUND_RATIO,
    UPGRADE_CHAIN,
    STAR_MAX_PER_LEVEL,
  };

  loadSettings();
  loadBest();
  // 星级迁移依赖 campaignUnlocked，必须放在 loadBest() 之后
  loadStars();
  loadAchievements();
  // v1.10：挑战进度 / 额外任务 / 最佳记录 / 每日挑战（每日按日期自动判定是否跨日）
  loadChallenge();
  loadTasks();
  loadRecords();
  loadDaily();
  // v1.12：历史榜单与累计统计（只读展示数据，损坏时回退默认并给出提示）
  loadStats();
})();