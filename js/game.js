(function () {
  'use strict';

  // ===== 常量 =====
  const DT = 1 / 60;
  const STEPS = 1;
  const BASE_HEALTH = 20;
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
      scene: { blackholes: [] },                          // 修正：默认无黑洞
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
      scene: { blackholes: [] },
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
      scene: { blackholes: [] },
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
    screenShake: 0,
    shake: 0,
    health: BASE_HEALTH,
    budget: 0,
    score: 0,
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
    healthFlash: 0,
    // 碰撞动画
    shockwaves: [],         // { x, y, radius, maxRadius, life, maxLife, color }
    flashRed: 0,            // 0~1，兼容旧调用
    flashes: [],            // { color, life, maxLife, intensity }
    planetPunch: 0,         // 母星受击震缩 0~1，>0 时缩放抖动
    // 生存模式限时
    duration: 0,            // 0 表示无限；>0 表示秒数
    remainingTime: 0,       // 剩余秒数（生存模式）
  };
  let bestScore = 0, bestWaves = 0;
  let campaignUnlocked = 0;   // 已解锁的最大关卡索引（成就：通关到「第 N 关」）

  // ===== 工具 =====
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ===== 本地战绩 / 进度 =====
  const LS_KEYS = [
    'starshield_best_score', 'starshield_best_waves',
    'starshield_setup', 'starshield_campaign_unlocked', 'starshield_audio',
  ];
  function loadBest() {
    try {
      bestScore = parseInt(localStorage.getItem('starshield_best_score') || '0', 10) || 0;
      bestWaves = parseInt(localStorage.getItem('starshield_best_waves') || '0', 10) || 0;
      campaignUnlocked = parseInt(localStorage.getItem('starshield_campaign_unlocked') || '0', 10) || 0;
    } catch (e) { bestScore = 0; bestWaves = 0; campaignUnlocked = 0; }
  }
  function saveBest() {
    try {
      localStorage.setItem('starshield_best_score', String(bestScore));
      localStorage.setItem('starshield_best_waves', String(bestWaves));
      localStorage.setItem('starshield_campaign_unlocked', String(campaignUnlocked));
    } catch (e) {}
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
  function integerScore() {
    return Math.max(0,
      Math.round(state.scoreIntercept)
      + Math.round(state.scoreWaveBonus)
      + Math.round(state.scoreSurvive)
      - Math.round(state.scorePenalty));
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
    state.screenShake = 0;
    state.score = 0;
    state.wave = 0;
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
    state.spawnTimer = 0;
    state.healthFlash = 0;

    state.health = lvl.health;
    state.budget = lvl.budget;

    // 限时（生存模式）
    state.duration = lvl.duration || 0;
    state.remainingTime = state.duration;

    // 碰撞动画清空
    state.shockwaves = [];
    state.flashRed = 0;
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

  function applySavedSetup() {
    try {
      const raw = localStorage.getItem('starshield_setup');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved) || saved.length === 0) return false;
      const now = performance.now();
      for (const s of saved) {
        const isBH = s.type === 'blackhole';
        const body = {
          type: isBH ? 'blackhole' : 'star',
          mass: s.mass || 300, radius: s.radius || 14,
          x: s.x, y: s.y, vx: 0, vy: 0,
          isCollectable: true, placedType: s.type || 'star',
          placedAt: now,
        };
        if (isBH) {
          // 沿用的玩家黑洞：锚定 + 10秒后消失（重新计时）
          body.anchored = true;
          body.immovable = true;
          body.expiresAt = now + 10000;
          body.fading = false;
        }
        state.bodies.push(body);
        state.budget -= (s.mass || 300);
        state.totalSpent += (s.mass || 300);
        state.starsPlaced++;
      }
      state.budget = Math.max(0, state.budget);
      return true;
    } catch (e) { return false; }
  }
  function saveSetup() {
    try {
      const stars = state.bodies
        .filter(b => b.type === 'star' || b.type === 'blackhole')
        .filter(b => !b.anchored)              // 只保存玩家放置的
        .map(b => ({ x: b.x, y: b.y, type: b.type, mass: b.mass, radius: b.radius }));
      localStorage.setItem('starshield_setup', JSON.stringify(stars));
    } catch (e) {}
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

  function placeStar(typeKey, p, opts) {
    const def = STAR_TYPES[typeKey] || STAR_TYPES.mid;
    if (state.budget < def.cost) return { ok: false, reason: '星能不足' };
    if (!canPlaceAt(p)) return { ok: false, reason: '离母星太近' };
    state.budget -= def.cost;
    state.totalSpent += def.cost;
    const isBH = typeKey === 'blackhole';
    const vx = (opts && Number.isFinite(opts.vx)) ? opts.vx : 0;
    const vy = (opts && Number.isFinite(opts.vy)) ? opts.vy : 0;
    if (isBH) {
      // 玩家黑洞：固定位置（不随引力移动），10秒后自动消失
      state.bodies.push({
        type: 'blackhole', mass: def.mass, radius: def.radius,
        x: p.x, y: p.y, vx: 0, vy: 0,
        anchored: true,                                  // 锚定，不被引力推动
        immovable: true,                                 // 物理上不动；撞来的被吞
        isCollectable: true, placedType: typeKey,
        placedAt: performance.now(),
        expiresAt: performance.now() + 10000,            // 10s 后消失
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
      // 极端模式：已无更多波次（理论上清波时已判通关，这里兜底）
      state.waveActive = false;
      return;
    }
    const { queue, interval, difficulty } = g;
    state.difficulty = difficulty;
    state.waveQueue = queue;
    state.waveInterval = interval;
    state.waveActive = true;
    state.spawnAccumulator = 0;
    // 记录是否最后一波（极端模式通关判定用）
    state.isLastWave = !!g.isLast;
  }

  function spawnFromQueue() {
    if (state.waveQueue.length === 0) return;
    const item = state.waveQueue.shift();
    spawnThreat(item);
  }

  // 生成威胁天体。优先使用确定性配置描述的 {edge, angle, speed, mass, radius}，
  // 否则（生存模式）回退到随机生成。angle 为来袭方向（指向母星的偏角）。
  function spawnThreat(item) {
    const kind = item.kind;
    const difficulty = item.difficulty || 0;
    const spawn = item.spawn || null;       // 确定性模式携带的预生成描述
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    let edge, angle, speed, mass, radius;
    if (spawn) {
      edge = spawn.edge;
      angle = spawn.angle;
      speed = spawn.speed;
      mass = spawn.mass;
      radius = spawn.radius;
    } else {
      // 生存模式：随机（允许差异，不影响公平性，因生存模式比拼分数而非固定挑战）
      edge = randInt(0, 3);
      angle = Math.random() * Math.PI * 2;
      speed = (kind === 'comet')
        ? rand(120, 200) * (0.8 + difficulty * 0.6)
        : rand(60, 110) * (0.8 + difficulty * 0.6);
      mass = kind === 'comet' ? 30 : (30 + difficulty * 40);
      radius = kind === 'comet' ? 7 : (13 + difficulty * 6);
    }

    const margin = 60;
    let x, y;
    if (edge === 0) { x = rand(margin, cx * 2 - margin); y = -margin; }
    else if (edge === 1) { x = cx * 2 + margin; y = rand(margin, cy * 2 - margin); }
    else if (edge === 2) { x = rand(margin, cx * 2 - margin); y = cy * 2 + margin; }
    else { x = -margin; y = rand(margin, cy * 2 - margin); }

    // angle 为相对「母星方向」的偏角：基准朝母星，叠加偏角
    const baseAng = Math.atan2(cy - y, cx - x);
    const ang = baseAng + (spawn ? angle : (angle - baseAng)); // 生存随机用原始 angle
    if (spawn) {
      // 确定性：spread 为相对母星方向的偏角，换算为绝对来袭角
      const baseAng = Math.atan2(cy - y, cx - x);
      const ang = baseAng + (spawn.spread || 0);
      const vx = Math.cos(ang) * speed;
      const vy = Math.sin(ang) * speed;
      pushThreatBody(kind, mass, radius, x, y, vx, vy);
      return;
    }
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
    // 波次清空奖励：基础 15 + 每波 5 分
    const wb = 15 + 5 * state.wave;
    state.score += wb;
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
    state.score += gain;
    state.scoreIntercept += gain;
    state.asteroidsCleared += 1;
    // 闯关模式资源回收：每清除一个威胁返还少量星能（替代旧 rewards 硬编码）
    if (state.mode === 'campaign') {
      state.budget = Math.min(99999, state.budget + 2);
    }
    return gain;
  }

  // 撞击母星
  function damagePlanet(byBody) {
    state.health -= 1;
    state.hitCount += 1;
    // 失守惩罚：母星被击中扣 8 分（得分不低于 0）
    if (state.score > 0) state.score = Math.max(0, state.score - 8);
    state.scorePenalty += 8;
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
    // 立刻保存布防供下次「沿用上次布防」
    saveSetup();
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
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(40, 220);
      state.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.3, 0.8), maxLife: 0.8, color,
      });
    }
  }

  // ===== 主循环步进 =====
  function stepFrame() {
    if (state.gameOver || !state.gameStarted) return;
    const dtFrame = DT * STEPS * state.timeScale;

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

    const dtSub = DT * state.timeScale;
    for (let k = 0; k < STEPS; k++) physics.stepSystem(state.bodies, dtSub);

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
        if (b.type === 'asteroid') {
          damagePlanet(b);
          state.bodies.splice(i, 1);
          continue;
        } else {
          damagePlanet(b);
          state.bodies.splice(i, 1);
          continue;
        }
      }

      const m = 120;
      if (b.x < -m || b.x > window.innerWidth + m || b.y < -m || b.y > window.innerHeight + m) {
        // 出界（被引力偏转后飞离）：计入拦截清除
        registerClear(b, 'flee');
        state.bodies.splice(i, 1);
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
        // 撞上母星 → 扣血 + 红色受击动画 + 碎片（physics 先标记了 dead，这里补发）
        damagePlanet(b);
      } else if (b.exploded && !b.captured) {
        // 玩家星体互撞 → 蓝色火花
        starStarCollision(b, b);
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
    if (state.flashRed > 0) state.flashRed = Math.max(0, state.flashRed - dtFrame * 3);
    for (let i = state.flashes.length - 1; i >= 0; i--) {
      state.flashes[i].life -= dtFrame;
      if (state.flashes[i].life <= 0) state.flashes.splice(i, 1);
    }

    // 玩家黑洞过期检测 + 消失动画
    const tnow = performance.now();
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (b.type !== 'blackhole') continue;
      if (!b.anchored || !b.expiresAt) continue;     // 仅玩家黑洞
      // 提前 1.5s 标记 fading，进入收缩动画
      if (!b.fading && tnow >= b.expiresAt - 1500) {
        b.fading = true;
        b.fadeLife = 1.5;
      }
      // fading 阶段递减 fadeLife
      if (b.fading) {
        b.fadeLife = Math.max(0, b.fadeLife - dtFrame);
      }
      // 到期 → 触发消失动画 + 移除
      if (tnow >= b.expiresAt) {
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
      state.score += sv;
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
  function updateHud() {
    // 游戏中才更新 HUD；菜单状态下不写 DOM，避免覆盖默认显示
    if (!state.gameStarted) return;
    if (!state.level) return;
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
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
        timeVal.textContent = sec + 's';
        timeVal.style.color = sec <= 10 ? '#ff7a7a' : '';
      } else {
        timeGroup.style.display = 'none';
      }
    }
    const modeTag = document.getElementById('modeTag');
    if (modeTag) {
      modeTag.textContent = state.mode === 'campaign'
        ? `闯关·${state.level.name}`
        : `生存·${state.level.name}`;
    }
    const healthFill = document.getElementById('healthFill');
    if (healthFill) {
      const pct = clamp(state.health / (state.level.health || 1), 0, 1) * 100;
      healthFill.style.width = pct + '%';
      healthFill.style.background = pct < 30
        ? 'linear-gradient(90deg,#ff6b6b,#ffa36b)'
        : 'linear-gradient(90deg,#43e0a0,#6fdcff)';
    }
    const healthVal = document.getElementById('healthVal');
    if (healthVal) {
      healthVal.textContent = state.health;
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
    state.mode = opts.mode || 'survival';
    state.levelIndex = opts.levelIndex || 0;
    // 闯关模式解锁校验：仅允许已解锁的关卡
    if (state.mode === 'campaign' && !isLevelUnlocked(state.levelIndex)) {
      return false;
    }
    const levels = getLevelsForMode(state.mode);
    if (!levels[state.levelIndex]) return false;
    state.level = levels[state.levelIndex];
    state.gameStarted = true;
    setupLevel();
    // 按用户选择的开局方式处理「沿用上次布防」：
    // - keepSetup 为 true：尝试应用上次结算时保存的布防
    // - keepSetup 为 false / 未提供：从空场开始（仅母星），不读取存档
    if (opts.keepSetup) {
      applySavedSetup();
    }
    // 注意：开局不再调用 saveSetup（避免把空场覆盖真实存档）；
    // 布防存档在 endGame 时由 saveSetup() 记录。

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
  }

  // 返回菜单
  function backToMenu() {
    state.gameStarted = false;
    state.gameOver = false;
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
      totalWaves: (state.mode === 'campaign' && Array.isArray(state.level.waves)) ? state.level.waves.length : null,
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
    STAR_TYPES,
    SURVIVAL_LEVELS,
    CAMPAIGN_LEVELS,
    PLANET_FORBIDDEN_PAD,
  };

  loadBest();
})();