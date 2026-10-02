// js/world.js —— 关卡初始化 / 母星禁放区 / 星体档位（v1.13 从 game.js 拆出）
// 依赖 core.js 的常量与全局状态（解构别名），以及同层其它文件经 window.SS 暴露的函数。
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    MAX_PLACED_BODIES, MAX_TOTAL_BODIES, PROP_DEFS, PROP_WELL_LIFE, PROP_WELL_MASS,
    PROP_REPULSE_RADIUS, PROP_REPULSE_POWER, STASIS_DURATION, BLACKHOLE_LIFE, SLOW_QUOTA_MAX,
    UNDO_WINDOW, UNDO_HISTORY_MAX, RECYCLE_REFUND_RATIO, UPGRADE_CHAIN, BODY_PICK_PAD,
    DEFAULT_SPEC, PLANET_FORBIDDEN_RADIUS, state,
  } = SS;

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
      : (state.mode === 'challenge' ? SS.challengeModifiersFor(state.levelIndex) : []);
    state.blackholesPlaced = 0;
    state.specSwitches = 0;      // v1.11：专精互转次数逐局重置
    state.specGiantPlaced = 0;   // v1.11：巨型专精放置数逐局重置
    state.endlessStage = 0;      // v1.11：无尽阶段逐局重置（仅 endless 会在 SS.startWave 里推进）
    // isLastWave 必须显式复位：它只在 SS.startWave 里被写入，跨局残留会让新模式/异常路径误判终局
    state.isLastWave = false;
    // 天体上限告警只记一次：跨局不复位会吞掉后续告警（排查困难）
    state.spawnBlockedLogged = false;
    state.lastTask = null;
    state.lastRecord = null;
    state.lastDaily = null;
    state.lastEnding = null;     // v1.11：结局文案逐局重置（否则上一局的结局会残留到新一局结算）

    // 减速额度 / 撤销历史 / 预警列表（P0-1 / P0-2 / P0-3）：每局从零开始。
    // v1.12 行为变更：时间流速**每局复位为常速**。旧实现把 timeScale 当会话级偏好、开局不重置，
    // 于是"在 0.25× 下结束本局 → 新一局开局即慢动作"，并与每局复位的 slowQuota 组合成
    // "静默消耗新一局减速额度"的不一致状态。现在额度与流速同口径：都从零开始。
    state.timeScale = 1;
    state.slowQuota = SS.hasModifier('noSlow') ? 0 : SLOW_QUOTA_MAX;
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
    state.props = SS.hasModifier('noProps')
      ? { gravityWell: 0, repulseWave: 0, stasis: 0 }
      : (SS.isFixedWaveMode()
          ? { gravityWell: 2, repulseWave: 1, stasis: 1 }
          : { gravityWell: 1, repulseWave: 1, stasis: 1 });
    state.propsUsed = 0;
    state.stasisTime = 0;

    state.health = lvl.health;
    // 「星能减半」修饰符：初始星能 ×0.5（四舍五入，保证是整数星能）
    state.budget = SS.hasModifier('halfBudget') ? Math.round(lvl.budget * 0.5) : lvl.budget;
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
    if (typeKey === 'blackhole' && SS.hasModifier('noBlackhole')) {
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
    // v1.11：统计本局放置的「巨型」专精星体数（成就 spec_giant_5 判定用）
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
    prunePlaceHistory();
    const entry = state.placeHistory[state.placeHistory.length - 1];
    if (!entry) return { ok: false, reason: '' };
    return { ok: true, reason: '', refund: entry.cost };
  }
  function undoLastPlacement() {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法撤销' };
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
    SS.spawnShockwave(entry.body.x, entry.body.y, (entry.body.radius || 12) + 40,
                   'rgba(150,205,255,0.65)', 0.35);
    audio.play('flee');
    return { ok: true, reason: '', refund: entry.cost };
  }

  // ===== 无尽模式阶段与风暴波（v1.11）=====
  // 节奏重写：把上一版的"封顶后每超 1 单位 +10%"连续 ramp，升级为「阶段 + 每 10 波风暴」。
  //   阶段划分：stage = floor((wave-1) / 10) → 第 1~10 波为阶段 0（基准），11~20 为阶段 1，依此类推。
  //   风暴波：wave % 10 === 0（第 10 / 20 / 30 … 波）——每个阶段的**收尾波**，额外涌入一小群分裂彗星。
  // 单调性（硬约束）：阶段阶段加成随 stage 非递减，基础 ramp 随 wave 非递减，两者相加 → 难度进度 t 非递减，
  // 因此 difficulty 单调不减、interval 单调不增、count 单调不减（风暴前锋只改单波构成，不改曲线参数）。
  // 兼容性：阶段 0 的加成全为 1.0/0，故第 1~10 波与上一版完全一致；阶段效果只在 endless 下生效。
  const ENDLESS_STAGE_SIZE = 10;
  const ENDLESS_T_CAP = 2.1;              // 难度进度上限（上一版为 1.6；阶段加成需要更高上限才有意义）
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
    if (!body || !SS.STAR_TYPES[body.placedType]) return 0;
    return Math.round(SS.costOf(body.placedType, body.spec) * RECYCLE_REFUND_RATIO);
  }
  function recycleBody(body) {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法回收' };
    if (SS.hasModifier('noRecycle')) return { ok: false, reason: '本关禁止回收' };
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
    SS.spawnShockwave(body.x, body.y, (body.radius || 12) + 50, 'rgba(255,178,122,0.7)', 0.38);
    SS.spawnExplosion(body.x, body.y, '#ffb27a', 10);
    audio.play('flee');
    return { ok: true, reason: '', refund: refund };
  }
  function upgradeBody(body, opts) {
    if (!state.gameStarted || state.gameOver) return { ok: false, reason: '当前无法升级' };
    if (SS.hasModifier('noRecycle')) return { ok: false, reason: '本关禁止升级' };
    if (state.bodies.indexOf(body) < 0) return { ok: false, reason: '该星体已不在场上' };
    const curKey = placedTypeKeyOf(body);
    if (!curKey) return { ok: false, reason: body && body.type === 'blackhole' ? '黑洞不可升级' : '该天体不可升级' };
    const nextKey = nextTypeKeyOf(body);
    if (!nextKey) return { ok: false, reason: '已达最高档位' };
    const specId = (opts && opts.spec) || body.spec || DEFAULT_SPEC;   // 升级沿用当前专精
    const nextDef = SS.getStarDef(nextKey, specId);
    const delta = nextDef.cost - SS.costOf(curKey, specId);
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
    SS.spawnShockwave(body.x, body.y, body.radius + 60, 'rgba(120,190,255,0.7)', 0.4);
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
    const def = body.placedType ? SS.STAR_TYPES[body.placedType] : null;
    const specId = isBH ? null : (body.spec || DEFAULT_SPEC);
    const spec = isBH ? null : physics.specDef(specId);
    const nextKey = isBH ? null : nextTypeKeyOf(body);
    const delta = nextKey ? (SS.costOf(nextKey, specId) - SS.costOf(body.placedType, specId)) : 0;
    // 专精互转（同档）：目标为"另一种专精"，差价 = 目标价 − 当前价（可能为负 = 退还）
    const otherSpecId = (specId === 'gravity') ? 'giant' : 'gravity';
    const otherSpec = isBH ? null : physics.specDef(otherSpecId);
    const switchDelta = isBH ? 0 : (SS.costOf(body.placedType, otherSpecId) - SS.costOf(body.placedType, specId));
    const canSwitch = !isBH && (switchDelta <= 0 || state.budget >= switchDelta);
    return {
      typeKey: body.placedType || null,
      name: def ? def.name : (isBH ? '黑洞' : '星体'),
      spec: specId,
      specName: spec ? spec.name : '',
      refund: recycleRefundOf(body),
      canRecycle: true,
      canUpgrade: !!nextKey && state.budget >= delta,
      upgradeName: nextKey ? SS.STAR_TYPES[nextKey].name : '',
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
    const delta = SS.costOf(curKey, target) - SS.costOf(curKey, cur);
    if (delta > 0 && state.budget < delta) return { ok: false, reason: '星能不足（需 ' + delta + '）' };
    state.budget = Math.min(99999, state.budget - delta);           // delta 为负时即退款
    state.totalSpent = Math.max(0, state.totalSpent + delta);
    const nextDef = SS.getStarDef(curKey, target);
    body.spec = target;
    body.baseMass = nextDef.mass;
    body.mass = nextDef.mass;
    body.radius = nextDef.radius;
    state.specSwitches = (state.specSwitches || 0) + 1;
    for (let i = state.placeHistory.length - 1; i >= 0; i--) {
      if (state.placeHistory[i].body === body) state.placeHistory.splice(i, 1);
    }
    SS.spawnShockwave(body.x, body.y, body.radius + 50, 'rgba(180,220,255,0.7)', 0.35);
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
      SS.spawnShockwave(point.x, point.y, 170, 'rgba(140,240,255,0.8)', 0.45);
      SS.addFlash('rgba(120,220,255,0.18)', 0.8);
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
      SS.spawnShockwave(point.x, point.y, PROP_REPULSE_RADIUS, 'rgba(150,205,255,0.85)', 0.5);
      SS.addFlash('rgba(120,190,255,0.15)', 0.7);
      state.props[id]--;
      state.propsUsed++;
      audio.play('prop');
      return { ok: true, reason: pushed === 0 ? '附近没有可推离的威胁' : '', pushed: pushed };
    } else if (id === 'stasis') {
      state.stasisTime = STASIS_DURATION;
      SS.spawnShockwave(point.x, point.y, 240, 'rgba(200,155,255,0.7)', 0.5);
      SS.addFlash('rgba(200,155,255,0.16)', 0.9);
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

  // ===== 导出到共享命名空间 =====
  SS.placedTypeKeyOf = placedTypeKeyOf;
  SS.nextTypeKeyOf = nextTypeKeyOf;
  SS.recycleRefundOf = recycleRefundOf;
  SS.recycleBody = recycleBody;
  SS.upgradeBody = upgradeBody;
  SS.selectBodyAt = selectBodyAt;
  SS.clearSelection = clearSelection;
  SS.getBodyActionInfo = getBodyActionInfo;
  SS.switchSpec = switchSpec;
  SS.getProps = getProps;
  SS.useProp = useProp;
  SS.setupLevel = setupLevel;
  SS.spawnSceneBodies = spawnSceneBodies;
  SS.canPlaceAt = canPlaceAt;
  SS.STAR_TYPES = STAR_TYPES;
  SS.priceWithSpec = priceWithSpec;
  SS.getStarDef = getStarDef;
  SS.costOf = costOf;
  SS.specList = specList;
  SS.countPlacedBodies = countPlacedBodies;
  SS.placeStar = placeStar;
  SS.recordPlacement = recordPlacement;
  SS.isUndoEntryValid = isUndoEntryValid;
  SS.prunePlaceHistory = prunePlaceHistory;
  SS.canUndo = canUndo;
  SS.undoLastPlacement = undoLastPlacement;
  SS.ENDLESS_STAGE_SIZE = ENDLESS_STAGE_SIZE;
  SS.ENDLESS_T_CAP = ENDLESS_T_CAP;
  SS.ENDLESS_STAGES = ENDLESS_STAGES;
  SS.endlessStageOf = endlessStageOf;
  SS.endlessStageDef = endlessStageDef;
  SS.getEndlessStageInfo = getEndlessStageInfo;
})();
