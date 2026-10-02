// js/core.js —— 游戏层共享常量 / 关卡定义 / 全局状态 / 纯工具（v1.13 从 game.js 拆出）
// 经 window.SS 暴露给同层其它文件（persist / progress / waves / world / flow）与聚合入口 js/game.js。
// 说明：对象/数组与不可变常量可直接解构别名复用（值拷贝或引用共享均安全）；
//       需被赋值的可变标量（如 stepAccumulator / bestScore）留在各自文件本地声明。
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});

  // ===== 常量 =====
  const DT = 1 / 60;              // 固定物理步长(s)：主循环按真实时间累加，攒够一步才推进
  const MAX_SUBSTEPS = 3;         // 单帧最多补 3 个物理步（防止卡顿后追帧雪崩）
  const MAX_FRAME_DT = 0.25;      // 单帧真实时间上限(s)（切后台回来时防止一次补太多）
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
  // v1.13：新增 reduceMotion（减少动效）与 volume（主音量 0~1）。加进白名单后，
  // loadSettings / setSetting / clearAllProgress 的既有通道会自动覆盖它们
  // （键白名单 + 同型校验 + 复位），无需新增存档键。
  const DEFAULT_SETTINGS = { showHint: true, showWarnings: true, reduceMotion: false, volume: 0.8 };
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
  // ===== v1.11 新增存档键（累计统计）=====
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
  const CAMPAIGN_LEVELS = window.CAMPAIGN_LEVELS || [];
  // 章节划分（4 章 × 10 关）：菜单按章分组并显示该章星数完成度（数据来自 levels-campaign.js）
  const CHAPTERS = window.CHAPTERS || [];
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
    // v1.13 暂停：独立布尔字段，**刻意不复用 timeScale**（loop-mechanics 与 result-actions
    // 直读 timeScale 判定"开局即常速"，复用会污染该语义）。暂停只在 stepFrame 顶部早退。
    paused: false,
    showHint: true,
    showWarnings: true,      // 撞母星预警开关（P0-3，独立于提示线）
    reduceMotion: false,     // 减少动效开关（v1.13，与设置存档同步；UI 层映射到 html[data-motion]）
    volume: 0.8,             // 主音量（v1.13，0~1；由 audio.setVolume 应用）
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
    specGiantPlaced: 0,      // 本局放置的「巨型」专精星体数（v1.11，成就判定用）
    isLastWave: false,       // 当前波是否为该关最后一波（跨局必须复位，见 setupLevel）
    endlessStage: 0,         // 无尽模式当前阶段（v1.11：每 10 波一段，跨局必须复位）
    lastTask: null,          // 最近一局的任务结果（结算面板用）
    lastRecord: null,        // 最近一局的纪录对比（结算面板用）
    lastDaily: null,         // 最近一局的每日挑战成绩（结算面板用）
    lastEnding: null,        // 最近一局的结局文案（v1.11，结算面板用；仅闯关终关/隐藏关）
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

  // ===== 工具 =====
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clampInt(v, a, b) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? clamp(n, a, b) : a;
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ===== 导出到共享命名空间 =====
  SS.DT = DT;
  SS.MAX_SUBSTEPS = MAX_SUBSTEPS;
  SS.MAX_FRAME_DT = MAX_FRAME_DT;
  SS.BASE_HEALTH = BASE_HEALTH;
  SS.MAX_PLACED_BODIES = MAX_PLACED_BODIES;
  SS.MAX_TOTAL_BODIES = MAX_TOTAL_BODIES;
  SS.PROP_DEFS = PROP_DEFS;
  SS.PROP_WELL_LIFE = PROP_WELL_LIFE;
  SS.PROP_WELL_MASS = PROP_WELL_MASS;
  SS.PROP_REPULSE_RADIUS = PROP_REPULSE_RADIUS;
  SS.PROP_REPULSE_POWER = PROP_REPULSE_POWER;
  SS.STASIS_FACTOR = STASIS_FACTOR;
  SS.STASIS_DURATION = STASIS_DURATION;
  SS.PROP_MAX_EACH = PROP_MAX_EACH;
  SS.WAVE_TIMEOUT = WAVE_TIMEOUT;
  SS.BLACKHOLE_LIFE = BLACKHOLE_LIFE;
  SS.BLACKHOLE_FADE = BLACKHOLE_FADE;
  SS.MAX_PARTICLES = MAX_PARTICLES;
  SS.SLOW_QUOTA_MAX = SLOW_QUOTA_MAX;
  SS.SLOW_REFUND_PER_WAVE = SLOW_REFUND_PER_WAVE;
  SS.SLOW_LOW_RATIO = SLOW_LOW_RATIO;
  SS.UNDO_WINDOW = UNDO_WINDOW;
  SS.UNDO_HISTORY_MAX = UNDO_HISTORY_MAX;
  SS.SETTINGS_KEY = SETTINGS_KEY;
  SS.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  SS.STARS_KEY = STARS_KEY;
  SS.STAR2_HIT_RATIO = STAR2_HIT_RATIO;
  SS.STAR2_HIT_MIN = STAR2_HIT_MIN;
  SS.STAR_MAX_PER_LEVEL = STAR_MAX_PER_LEVEL;
  SS.RECYCLE_REFUND_RATIO = RECYCLE_REFUND_RATIO;
  SS.UPGRADE_CHAIN = UPGRADE_CHAIN;
  SS.BODY_PICK_PAD = BODY_PICK_PAD;
  SS.ACHIEVEMENTS_KEY = ACHIEVEMENTS_KEY;
  SS.CHALLENGE_KEY = CHALLENGE_KEY;
  SS.DAILY_KEY = DAILY_KEY;
  SS.TASKS_KEY = TASKS_KEY;
  SS.RECORDS_KEY = RECORDS_KEY;
  SS.STATS_KEY = STATS_KEY;
  SS.CH4_START = CH4_START;
  SS.CH4_STAR_GATE = CH4_STAR_GATE;
  SS.DEFAULT_SPEC = DEFAULT_SPEC;
  SS.HIDDEN_STAR_GATE = HIDDEN_STAR_GATE;
  SS.HIDDEN_TASK_NEED = HIDDEN_TASK_NEED;
  SS.PLANET_FORBIDDEN_PAD = PLANET_FORBIDDEN_PAD;
  SS.PLANET_FORBIDDEN_RADIUS = PLANET_FORBIDDEN_RADIUS;
  SS.SURVIVAL_LEVELS = SURVIVAL_LEVELS;
  SS.CAMPAIGN_LEVELS = CAMPAIGN_LEVELS;
  SS.CHAPTERS = CHAPTERS;
  SS.ENDLESS_LEVEL = ENDLESS_LEVEL;
  SS.state = state;
  SS.clamp = clamp;
  SS.clampInt = clampInt;
  SS.rand = rand;
  SS.randInt = randInt;
  SS.lerp = lerp;
  // ===== 可变标量（需被赋值；作为 SS 属性跨文件共享，避免值拷贝失效）=====
  SS.stepAccumulator = 0;   // 未消耗的真实时间（秒）
  SS.bestScore = 0;
  SS.bestWaves = 0;
  SS.campaignUnlocked = 0;  // 已解锁的最大关卡索引（成就：通关到「第 N 关」）
})();
