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
  // 单波超时（游戏秒）：队列吐空后仍无法清场（威胁被引力拘禁在稳定轨道）时强制收编，避免软锁
  const WAVE_TIMEOUT = 40;
  // 玩家黑洞：存活时长与消失前收缩动画时长（均为游戏时钟秒，见 M1）
  const BLACKHOLE_LIFE = 10;
  const BLACKHOLE_FADE = 1.5;
  // 粒子总量上限（超出时淘汰最旧粒子，避免同帧大量爆炸造成内存/绘制尖峰）
  const MAX_PARTICLES = 800;
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

  // ===== 全局状态 =====
  const state = {
    bodies: [],
    particles: [],
    shake: 0,
    health: BASE_HEALTH,
    budget: 0,
    // 注意：不再保存总分字段。总分一律由 integerScore() 从四类明细派生，
    // 避免「浮点累加值」与「明细代数和」两套真值漂移（见 M2）。
    wave: 0,
    mode: 'survival',
    level: null,
    levelIndex: 0,
    timeScale: 1,
    gameOver: false,
    showHint: true,
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
    } else {
      const rounded = integerScore();
      if (rounded > bestScore) bestScore = rounded;
    }
    saveBest();
  }
  // 通关当前关：解锁下一关（仅闯关模式）
  function unlockNextLevel() {
    if (state.mode !== 'campaign') return;
    const next = state.levelIndex + 1;
    if (next > campaignUnlocked) {
      campaignUnlocked = next;
      saveBest();
    }
  }
  function bestDisplay() {
    if (state.mode === 'campaign') return campaignUnlocked > 0 ? ('通关第 ' + campaignUnlocked + ' 关') : '未通关';
    return bestScore > 0 ? String(Math.round(bestScore)) : '—';
  }
  function bestForMode(mode) {
    return mode === 'campaign' ? campaignUnlocked : Math.round(bestScore);
  }
  // 关卡是否解锁（闯关模式：索引 <= 已解锁上限）
  function isLevelUnlocked(idx) {
    return idx <= campaignUnlocked;
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

    state.health = lvl.health;
    state.budget = lvl.budget;

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

    // 注意：黑洞不再作为关卡初始场景放置（用户要求开局画布无黑洞）。
    // 黑洞仅由玩家在游戏中放置，且放置后固定位置、10 秒后自动消失。
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

  // 场上玩家星体数量（含黑洞），用于上限判定
  function countPlacedBodies() {
    let n = 0;
    for (let i = 0; i < state.bodies.length; i++) {
      const t = state.bodies[i].type;
      if (t === 'star' || t === 'blackhole') n++;
    }
    return n;
  }

  function placeStar(typeKey, p, opts) {
    const def = STAR_TYPES[typeKey] || STAR_TYPES.mid;
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
    if (isBH) {
      // 玩家黑洞：固定位置（不随引力移动），BLACKHOLE_LIFE 游戏秒后自动消失
      state.bodies.push({
        type: 'blackhole', mass: def.mass, radius: def.radius,
        x: p.x, y: p.y, vx: 0, vy: 0,
        anchored: true,                                  // 锚定，不被引力推动
        immovable: true,                                 // 物理上不动；撞来的被吞
        isCollectable: true, placedType: typeKey,
        lifeRemaining: BLACKHOLE_LIFE,                   // 剩余存活（游戏秒，见 M1）
        fading: false,                                   // 即将消失动画中
      });
    } else {
      state.bodies.push({
        type: 'star', mass: def.mass, radius: def.radius,
        x: p.x, y: p.y, vx, vy,
        isCollectable: true, placedType: typeKey,
      });
    }
    state.starsPlaced++;
    return { ok: true };
  }

  // ===== 随机波次生成 =====
  // difficulty: 0~1，随 wave 在关卡定义的区间内插值（仅生存模式使用随机生成）
  function waveParams() {
    const w = state.wave;
    const cfg = state.level.waves;
    // 难度随 wave 在 [startDifficulty, endDifficulty] 区间线性插值，封顶 wave 数量由 difficultyRamp 推断
    const t = clamp(w * cfg.difficultyRamp, 0, 1);
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
    const queue = [];
    const cometRatio = clamp(0.15 + p.difficulty * 0.30, 0.15, 0.5);
    const cometCount = Math.round(p.count * cometRatio);
    const asteroidCount = p.count - cometCount;
    for (let i = 0; i < cometCount; i++) queue.push({ kind: 'comet', difficulty: p.difficulty });
    for (let i = 0; i < asteroidCount; i++) queue.push({ kind: 'asteroid', difficulty: p.difficulty });
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
      speed = (kind === 'comet')
        ? rand(120, 200) * (0.8 + difficulty * 0.6)
        : rand(60, 110) * (0.8 + difficulty * 0.6);
      mass = kind === 'comet' ? 30 : (30 + difficulty * 40);
      radius = kind === 'comet' ? 7 : (13 + difficulty * 6);
    }

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
    pushThreatBody(kind, mass, radius, x, y, vx, vy);
  }

  function pushThreatBody(kind, mass, radius, x, y, vx, vy) {
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

  function clearWave() {
    state.waveActive = false;
    state.waveQueue = [];
    state.spawnAccumulator = 0;
    state.waveElapsed = 0;
    // 波次清空奖励：基础 15 + 每波 5 分
    const wb = 15 + 5 * state.wave;
    state.lastWaveBonus = wb;
    state.scoreWaveBonus += wb;
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
  // method ∈ {'flee','blackhole','clash'} 仅用于潜在差异化，当前统一计分
  function registerClear(body, method) {
    const difficulty = Number.isFinite(state.difficulty) ? state.difficulty : 0.3;
    const base = body.type === 'comet'
      ? 12
      : 6 + Math.round((body.mass || 40) / 8);
    // 难度加权：以 0.3 为基准，难度越高分越多
    const diffMul = 1 + Math.max(0, difficulty - 0.3) * 1.4;
    // 模式/关卡加权：闯关模式越靠后关卡倍率越高（生存模式恒为 1）
    const modeMul = state.mode === 'campaign' ? (1 + state.levelIndex * 0.15) : 1;
    const gain = Math.max(1, Math.round(base * diffMul * modeMul));
    state.scoreIntercept += gain;
    state.asteroidsCleared += 1;
    // 闯关模式资源回收：每清除一个威胁返还少量星能（替代旧 rewards 硬编码）
    if (state.mode === 'campaign') {
      state.budget = Math.min(99999, state.budget + 2);
    }
    return gain;
  }

  // 母星受到来袭威胁撞击（仅 asteroid/comet 会走到这里，见 M6 的调用点判定）
  function damagePlanet(byBody) {
    state.health -= 1;
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
      if (b.type !== 'asteroid' && b.type !== 'comet') continue;
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

  function endGame(reason) {
    if (state.gameOver) return;
    state.gameOver = true;
    state.endReason = reason || 'defeat';    // 'defeat' | 'timeup' | 'win'
    // 通关当前关：解锁下一关（闯关模式成就推进）
    if (state.endReason === 'win') unlockNextLevel();
    updateBest();
    // 音效：通关/时间到 → 庆祝；母星陨落/防线失守 → gameover
    audio.play(state.endReason === 'win' ? 'place' : (state.endReason === 'timeup' ? 'place' : 'gameover'));
    // 结算时：隐藏星体栏 + 控制条（避免误触），HUD 保留背景观感
    ['starBar', 'controls'].forEach(id => {
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
    stepAccumulator += real * state.timeScale;
    let steps = 0;
    while (stepAccumulator >= DT && steps < MAX_SUBSTEPS) {
      stepAccumulator -= DT;
      steps++;
    }
    if (steps === 0) return;                       // 还没攒够一步（高刷屏上常见）
    if (stepAccumulator >= DT) stepAccumulator = 0; // 积压过多 → 丢弃，避免追帧雪崩
    const dtFrame = DT * steps;

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

    // 彗星尾迹
    for (const b of state.bodies) {
      if (b.type === 'comet') {
        b.trail = b.trail || [];
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > 12) b.trail.shift();
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
        if (b.type === 'asteroid' || b.type === 'comet') damagePlanet(b);
        else absorbByPlanet(b);
        state.bodies.splice(i, 1);
        continue;
      }

      const m = 120;
      if (b.x < -m || b.x > window.innerWidth + m || b.y < -m || b.y > window.innerHeight + m) {
        // 出界：仅「来袭威胁」（陨石/彗星）计入拦截清除。
        // 玩家星体飞出边界不得分，否则可反复投掷小行星出界刷分。
        if (b.type === 'asteroid' || b.type === 'comet') registerClear(b, 'flee');
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
        b => (b.type === 'comet' || b.type === 'asteroid')
      ).length;
      if (remaining === 0) {
        clearWave();
        // 闯关模式：最后一波清空即通关胜利
        if (state.mode === 'campaign' && state.isLastWave) {
          endGame('win');
        }
      }
    }

    // 玩家放置的黑洞吞噬陨石（额外奖励）
    // 注：这里只计分 + 标记 dead，不播动画（统一由下方 dead 清理块调用 consumeByBlackhole）
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (b.type !== 'asteroid' && b.type !== 'comet') continue;
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
        if (b.type === 'asteroid' || b.type === 'comet') damagePlanet(b);
        else absorbByPlanet(b);
      } else if (b.exploded && !b.captured) {
        // 玩家星体互撞 → 蓝色火花。一次碰撞涉及两个天体，
        // 只触发一次（physics 通过 explodedWith 记录了对手）
        if (!b._clashHandled) {
          const other = b.explodedWith;
          if (other) other._clashHandled = true;
          starStarCollision(b, other || b);
        }
      } else if (b.captured) {
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
    if (waveGroup) waveGroup.style.display = state.mode === 'campaign' ? '' : 'none';
    // 闯关模式常驻显示「当前波/总波」，便于了解剩余波数
    if (state.mode === 'campaign' && state.level && Array.isArray(state.level.waves)) {
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
    set('modeTag', state.mode === 'campaign'
      ? `闯关·${state.level.name}`
      : `生存·${state.level.name}`);
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
    return mode === 'campaign' ? CAMPAIGN_LEVELS : SURVIVAL_LEVELS;
  }

  // ===== 开始游戏 =====
  function startGame(opts) {
    // 兼容/防御：允许不传或误传非对象（历史调用曾有 startGame('survival', 0)）
    const o = (opts && typeof opts === 'object') ? opts : (typeof opts === 'string' ? { mode: opts } : {});
    clearHudCache();
    stepAccumulator = 0;        // 丢弃上一局残留的时间片
    state.mode = o.mode || 'survival';
    state.levelIndex = o.levelIndex || 0;
    // 闯关模式解锁校验：仅允许已解锁的关卡
    if (state.mode === 'campaign' && !isLevelUnlocked(state.levelIndex)) {
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
      banner.innerHTML =
        `<div class="lb-name">${lvl.name}</div>` +
        `<div class="lb-goal">🎯 目标：${goal}</div>` +
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
    document.getElementById('menu').classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('starBar').classList.add('hidden');
    document.getElementById('controls').classList.add('hidden');
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
      totalWaves: (state.mode === 'campaign' && state.level && Array.isArray(state.level.waves)) ? state.level.waves.length : null,
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
    };
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
    STAR_TYPES,
    SURVIVAL_LEVELS,
    CAMPAIGN_LEVELS,
    PLANET_FORBIDDEN_PAD,
  };

  loadBest();
})();