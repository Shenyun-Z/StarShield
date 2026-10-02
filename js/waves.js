// js/waves.js —— 随机波次生成 / 撞击动画工具 / 粒子（v1.13 从 game.js 拆出）
// 依赖 core.js 的常量与全局状态（解构别名），以及同层其它文件经 window.SS 暴露的函数。
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    MAX_TOTAL_BODIES, PROP_MAX_EACH, MAX_PARTICLES, SLOW_QUOTA_MAX, SLOW_REFUND_PER_WAVE,
    SLOW_LOW_RATIO, CHAPTERS, state, clamp, rand,
    randInt, lerp,
  } = SS;

  // ===== 随机波次生成 =====
  // difficulty: 0~1，随 wave 在关卡定义的区间内插值（仅生存模式使用随机生成）
  function waveParams() {
    const w = state.wave;
    const cfg = state.level.waves;
    // 难度随 wave 在 [startDifficulty, endDifficulty] 区间线性插值，封顶 wave 数量由 difficultyRamp 推断
    let t = clamp(w * cfg.difficultyRamp, 0, 1);
    // 无尽模式（v1.11）：基础连续 ramp（与上一版同口径，保证第 1~10 波完全一致）+ 阶段加成
    if (state.mode === 'endless') {
      const base = t + Math.max(0, w * cfg.difficultyRamp - 1) * 0.10;
      t = Math.min(SS.ENDLESS_T_CAP, base + SS.endlessStageDef(SS.endlessStageOf(w)).bump);
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
    // 无尽阶段（v1.11）：数量与特殊威胁占比按阶段加成。
    // 生存模式 endless === null → 走与上一版完全一致的原路径（连 rand 调用次数都保持一致）。
    const endless = (state.mode === 'endless') ? SS.getEndlessStageInfo() : null;
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
    // 风暴前锋（v1.11）：第 10/20/30… 波额外涌入一小群分裂彗星，让风暴波构成明显暴增
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
    // 无尽阶段与风暴提示（v1.11）：必须在 wave 自增之后读取；其它模式恒为 0，不影响任何既有行为
    if (state.mode === 'endless') {
      const info = SS.getEndlessStageInfo();
      state.endlessStage = info.stage;
      if (info.stormNow) {
        SS.pushNotice('风暴来袭 · 第 ' + state.wave + ' 波（阶段 ' + info.stageNo + ' 收尾）');
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
      // 类型差异（v1.11 补齐分裂彗星/干扰体，供无尽阶段混入）：
      // 彗星快而小、分裂彗星更快更脆、干扰体慢而大（脉冲型）。
      // 注意：彗星与陨石的分支取值与 rand 调用顺序与上一版完全一致（生存模式零行为变化）。
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
    if (SS.hasModifier('fastThreats')) speed *= 1.5;

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
    if (!SS.isFixedWaveMode() && state.wave % 5 === 0) {
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
    // 修饰符（v1.10）：「禁减速」本局完全没有慢动作（额度也在 SS.setupLevel 里清零）
    if (SS.hasModifier('noSlow')) {
      SS.pushNotice('本关禁用时间减速');
      return { ok: false, timeScale: 1, reason: '本关禁用减速' };
    }
    if (state.timeScale === 1) {
      if (state.slowQuota <= 0) {
        SS.pushNotice('减速额度已用尽：每清空一波返还 ' + SLOW_REFUND_PER_WAVE + ' 秒');
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
      disabled: SS.hasModifier('noSlow'),   // v1.10：本关禁用减速（UI 显示"禁用"而非"已耗尽"）
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
    const before = SS.integerScore();
    state.scorePenalty += 8;
    state.scorePenalty -= (8 - (before - SS.integerScore()));
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

  // ===== 结局文案与完美收集（v1.11）=====
  // 只对「闯关模式第 40 关（第四章终关）」与「两个隐藏关」在通关时给出专属结局文案。
  // 文案来源：章节结局在 CHAPTERS[3].ending；隐藏关结语在 window.STORY.hidden（内容层导出，
  // 刻意不写进关卡对象——关卡对象有 fixture 逐字段精确比对）。
  // 口径：挑战/每日模式复用同一批关卡但**不播剧情**（同一段剧情讲两遍反而弱化收束感），
  // 因此这里严格限定 mode === 'campaign'。
  function getRunEnding() {
    if (state.endReason !== 'win' || state.mode !== 'campaign') return null;
    if (!state.level) return null;
    const story = window.STORY;
    if (SS.isHiddenLevel()) {
      const def = (story && story.hidden) ? story.hidden[state.level.id] : null;
      return def ? { id: state.level.id, title: def.title, text: def.text } : null;
    }
    if (state.levelIndex !== SS.regularLevelCount() - 1) return null;
    const ch = (CHAPTERS && CHAPTERS.length) ? CHAPTERS[CHAPTERS.length - 1] : null;
    if (!ch || !ch.ending) return null;
    return { id: ch.id, title: ch.ending.title, text: ch.ending.text };
  }
  function getPerfectStory() {
    const story = window.STORY;
    return (story && story.perfect) ? { title: story.perfect.title, text: story.perfect.text } : null;
  }
  // 100% 收集：满星 + 常规关任务全清 + 隐藏关全清（星图总览面板据此显示收束文案）
  function isPerfectCollected() {
    return SS.regularLevelCount() > 0 && SS.countHiddenLevels() > 0
      && SS.getTotalStars() >= SS.totalStarsMax()
      && SS.countRegularTasksDone() >= SS.regularLevelCount()
      && SS.getHiddenClearedCount() >= SS.countHiddenLevels();
  }

  function endGame(reason) {
    if (state.gameOver) return;
    state.gameOver = true;
    state.paused = false;                    // v1.13：结算面板必须可交互，结束时强制解除暂停
    state.endReason = reason || 'defeat';    // 'defeat' | 'timeup' | 'win'
    // 通关当前关：解锁下一关（闯关/挑战各自独立推进）
    if (state.endReason === 'win') {
      SS.unlockNextLevel();
      SS.unlockNextChallenge();
    }
    // 星级评价（P1-A）：闯关与挑战通关计星，各自独立存档，只增不减
    if (state.mode === 'campaign' || state.mode === 'challenge') SS.recordRunStars();
    // v1.10：额外任务（只判不罚）与最佳记录，均在结算面板渲染前算好
    state.lastTask = SS.recordRunTask();
    state.lastRecord = SS.recordRun();
    if (state.mode === 'challenge') SS.recordChallengeRun();
    if (state.mode === 'daily') state.lastDaily = SS.recordDaily();
    // 成就判定（P1-C）：必须放在星级写入之后——star_30/star_60/star_all 依赖最新总星数
    SS.evaluateAchievements();
    // 结算时清空选中态（操作面板由 input 层同步隐藏）
    state.selectedBody = null;
    SS.updateBest();
    // v1.11 结算链路（顺序即依赖）：结局文案 → 累计统计 → 弹结算面板。
    state.lastEnding = getRunEnding();
    SS.accumulateStats();
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

  // ===== 暂停（v1.13）=====
  // 只在「对局进行中」可暂停：菜单态与结算态一律拒绝（避免暂停覆盖层与菜单/结算面板互抢层级）。
  // 关键取舍：**不改写 state.timeScale**，而是在 SS.stepFrame 顶部早退——这样物理、gameTime、
  // 黑洞寿命、减速额度、波次计时与生存存活分全部冻结，且 timeScale 的既有语义（开局常速）不受影响。
  // 主循环仍须每帧照常 render 并 requestAnimationFrame（robustness 的 H1 要求每帧恰好一次调度）。
  function setPaused(on) {
    const next = !!on;
    if (next === !!state.paused) return !!state.paused;                       // 幂等
    if (next && (!state.gameStarted || state.gameOver)) return !!state.paused; // 未开局/已结束不可暂停
    state.paused = next;
    return !!state.paused;
  }
  function togglePause() { return setPaused(!state.paused); }
  function isPaused() { return !!state.paused; }


  // ===== 导出到共享命名空间 =====
  SS.waveParams = waveParams;
  SS.generateWaveDeterministic = generateWaveDeterministic;
  SS.generateWave = generateWave;
  SS.startWave = startWave;
  SS.spawnFromQueue = spawnFromQueue;
  SS.EDGE_INDEX = EDGE_INDEX;
  SS.normalizeEdge = normalizeEdge;
  SS.spawnThreat = spawnThreat;
  SS.pushThreatBody = pushThreatBody;
  SS.maybeSplitThreat = maybeSplitThreat;
  SS.clearWave = clearWave;
  SS.toggleSlowMotion = toggleSlowMotion;
  SS.slowMotionState = slowMotionState;
  SS.spawnShockwave = spawnShockwave;
  SS.addFlash = addFlash;
  SS.registerClear = registerClear;
  SS.damagePlanet = damagePlanet;
  SS.absorbByPlanet = absorbByPlanet;
  SS.sweepRemainingThreats = sweepRemainingThreats;
  SS.consumeByBlackhole = consumeByBlackhole;
  SS.starStarCollision = starStarCollision;
  SS.getRunEnding = getRunEnding;
  SS.getPerfectStory = getPerfectStory;
  SS.isPerfectCollected = isPerfectCollected;
  SS.endGame = endGame;
  SS.spawnExplosion = spawnExplosion;
  SS.setPaused = setPaused;
  SS.togglePause = togglePause;
  SS.isPaused = isPaused;
})();
