/*
 * physics.js —— 《星盾防线》物理引擎（成员1）
 * 真实引力物理：万有引力 + 全 N 体 + 动量合并 + 暂停演化
 *
 * 坐标系：画布像素坐标，时间单位秒，速度单位 px/s（输入时用 ARROW_SCALE 换算为 m/s 显示）。
 * 所有常量均为"可调玩法参数"，成员2/3 可直接引用 physics.G 等按需微调。
 *
 * 导出（全局命名空间，供其他脚本以 physics.xxx 调用）：
 *   physics.createBody / stepSystem / computeForce / fieldAt
 *   physics.pruneBodies（辅助：移除 dead 天体）
 *   physics.<常量>
 */

(function (global) {
  'use strict';

  /* ============ 共享常量（成员1 定义，其他人引用） ============ */
  const G = 600;            // 万有引力常数（玩法调参）
  const SOFTENING = 6;      // 软化长度(px)，防止 r→0 时除零炸裂
  const RADIUS_K = 2.5;     // 半径系数：radius = RADIUS_K * mass^(1/3)
  const STAR_R = 30;        // 母星半径(px)
  const STAR_MASS = 8000;   // 母星质量（与 game.js setupLevel 创建的母星一致）
  const PREDICT_DT = 0.05;  // 预测积分步长(s)：细步长→高保真，与真实 stepSystem 偏差更小、轨迹更顺滑
  const PREDICT_DUR = 6;    // 预测时长(s) = 3 段 × 2s，与提示线分段一致（绘制端统一取此值）
  const ARROW_SCALE = 0.5;  // 拖拽箭头：1px = 0.5 m/s（输入换算用）
  const HP_HIT_CD = 0.4;    // 多段天体（Boss）两次受伤的最小间隔(s)：防止贴住不可动天体时逐帧掉段
  const PULSE_RADIUS = 260; // 引力干扰体脉冲的作用半径(px)

  /* ============ 天体类型分类（单一真源） ============ */
  // 背景：新增类型后，散落各处的 `type === 'asteroid' || type === 'comet'` 必然漏改，
  // 会造成"击退不计分 / 撞母星不扣血 / 波次永不结算"等连锁缺陷，因此在这里集中定义。
  // THREAT：参与波次结算、出界计分、撞母星扣血、黑洞吞噬计分与撞母星预警。
  const THREAT_TYPES = ['asteroid', 'comet', 'splitter', 'splitChild', 'disturber', 'boss'];
  // SCENE：场景天体（伴星/引力井/障碍/脉冲源），只参与引力与碰撞，不计威胁。
  const SCENE_TYPES = ['companion', 'well', 'obstacle', 'pulsar'];
  // PROP：一次性道具产生的临时场（引力井为临时天体；斥力波/凝滞为瞬时效应）
  const PROP_TYPES = ['gravityWell', 'repulseWave', 'stasis'];

  function isThreat(b) { return !!b && THREAT_TYPES.indexOf(b.type) >= 0; }
  function isScene(b) { return !!b && SCENE_TYPES.indexOf(b.type) >= 0; }
  // 可点选/回收/升级的天体：仅玩家放置的星体与黑洞（场景天体与道具场一律不可操作）
  function isPickable(b) { return !!b && (b.type === 'star' || b.type === 'blackhole'); }
  // 需要按时间演化的天体（多段 hp / 周期脉冲 / 有时限）
  function needsAge(b) {
    return !!b && ((b.lifespan || 0) > 0 || (b.pulseStrength || 0) !== 0 || (Number.isFinite(b.hp) && b.hp > 1));
  }

  /* ============ 天体结构 ============ */
  // Body(mass, x, y, vx, vy, opts)
  // opts: { isStar, isCollectable, isMeteorite, radius }
  // 半径推导：r ∝ mass^(1/3)；母星强制 STAR_R；也可显式给定 radius。
  function Body(mass, x, y, vx, vy, opts) {
    const o = opts || {};
    let radius;
    if (o.radius != null) radius = o.radius;
    else if (o.isStar) radius = STAR_R;
    else radius = RADIUS_K * Math.cbrt(Math.max(mass, 1e-4));

    return {
      mass: mass,
      x: x, y: y,
      vx: vx || 0, vy: vy || 0,
      radius: radius,
      isStar: !!o.isStar,
      isCollectable: !!o.isCollectable,   // 玩家放置的星体（可收编/计分）
      isMeteorite: !!o.isMeteorite,       // 来袭陨石（撞母星才扣血）
      immovable: !!o.immovable,           // 不可动（黑洞）：只施加引力、自身不移动、吞噬撞来的天体
      dead: false,
      captured: false,                    // 被黑洞吞噬（stepSystem 写入）
      lifespan: o.lifespan || 0,         // 存活时限(s)，0 = 永久（母星/玩家星体/道具井）
      age: 0,                            // 已存活时间(s)
      // 多段摧毁（Boss）：hp 默认 1（一次碰撞即毁）；>1 时每次碰撞扣 1 段
      hp: Number.isFinite(o.hp) ? o.hp : 1,
      hpCd: 0,                           // 受伤冷却(s)：避免贴住不可动天体时逐帧掉段
      hpDrop: 0,                         // 本帧是否掉段（game.js 读取后清零，用于表现）
      // 实心场景天体（伴星/引力井/障碍/脉冲源）：撞上它的运动天体被撞毁，自身不受影响
      solid: !!o.solid,
      // 周期脉冲（引力干扰体/脉冲源）：每 pulsePeriod 秒对半径 PULSE_RADIUS 内的天体施加一次冲量
      pulseStrength: Number.isFinite(o.pulseStrength) ? o.pulseStrength : 0,
      pulsePeriod: Number.isFinite(o.pulsePeriod) ? o.pulsePeriod : 0,
      // 状态标记（stepSystem 过程中写入，供 game.js 处理得分/扣血后清除）
      hitStar: false, // 撞上母星（母星扣血）
      hitSolid: false,// 撞上实心场景天体（被撞毁，播蓝白碎裂而非黑洞吞噬特效）
      merged: false,  // 被合并吸收（保留字段，当前版本互撞改为双毁）
      exploded: false // 与其他星体相撞被炸毁（双方同时标记）
    };
  }

  // 工厂：创建天体（契约主接口）
  function createBody(mass, x, y, vx, vy, opts) {
    return Body(mass, x, y, vx, vy, opts);
  }

  /* ============ 万有引力 ============ */
  // computeForce(a, b) → 作用在 a 上的引力矢量（含 softening）
  function computeForce(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const r2 = dx * dx + dy * dy + SOFTENING * SOFTENING;
    const invR3 = 1 / (r2 * Math.sqrt(r2)); // 1/r^3
    const f = G * a.mass * b.mass * invR3;
    return { fx: f * dx, fy: f * dy };
  }

  // fieldAt(bodies, x, y, exclude) → 某点处单位质量所受合力（加速度 {fx, fy}）
  // exclude：跳过自身（传 body 引用，或 null）
  function fieldAt(bodies, x, y, exclude) {
    let ax = 0, ay = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b === exclude || b.dead) continue;
      const dx = b.x - x;
      const dy = b.y - y;
      const r2 = dx * dx + dy * dy + SOFTENING * SOFTENING;
      const invR3 = 1 / (r2 * Math.sqrt(r2));
      const a = G * b.mass * invR3; // 单位质量加速度
      ax += a * dx;
      ay += a * dy;
    }
    return { fx: ax, fy: ay };
  }

  /* ============ 碰撞处理（stepSystem 内部） ============ */
  // 一次撞击对单个天体的结算：hp > 1（Boss 等多段天体）时扣一段并进入冷却，
  // 未归零则存活；否则直接销毁。返回 true 表示本次被销毁。
  function applyImpact(b) {
    const hp = Number.isFinite(b.hp) ? b.hp : 1;
    if (hp > 1) {
      if ((b.hpCd || 0) > 0) return false;         // 冷却中：本帧不再掉段
      b.hp = hp - 1;
      b.hpCd = HP_HIT_CD;
      b.hpDrop = (b.hpDrop || 0) + 1;              // 供 game.js 播放受击表现后清零
      if (b.hp <= 0) { b.dead = true; b.exploded = true; return true; }
      return false;
    }
    b.dead = true;
    b.exploded = true;
    return true;
  }

  function resolveCollisions(bodies) {
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (a.dead) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (b.dead || a.dead) continue;

        // 物理接触（非母星天体相撞 → 一起炸毁；撞母星 → 母星扣血）
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > a.radius + b.radius) continue;

        // 两个不可动天体（如两个黑洞）互不作用
        if (a.immovable && b.immovable) continue;

        // 实心场景天体（伴星 / 引力井 / 障碍 / 脉冲源）：撞上来的运动天体被撞毁，实心体不受影响。
        // 必须放在「不可动吞噬」分支之前——否则会被当成黑洞吞噬（播紫特效并计入黑洞统计）。
        if (a.solid || b.solid) {
          const sMover = a.solid ? b : a;
          if (sMover.solid) continue;                 // 两个实心体互不处理
          if (!sMover.immovable) {
            sMover.dead = true;
            sMover.hitSolid = true;                   // 蓝白碎裂，而非紫黑洞吞噬
          }
          continue;
        }

        // 不可动大质量天体（黑洞 / 母星 / 部分场景天体）：处理撞上来的运动天体
        if (a.immovable || b.immovable) {
          const mover = a.immovable ? b : a;   // 运动天体（撞上来的）
          const anchor = a.immovable ? a : b;  // 不可动天体（母星 / 黑洞）
          if (anchor.isStar) {
            // 运动天体撞母星：一律摧毁来袭者（Boss 撞母星也在此消失），母星伤害由 game.js 结算
            mover.dead = true;
            mover.hitStar = true;
            continue;
          }
          // 多段天体撞黑洞等不可动天体：冷却内只扣一段，段数归零才算被吞噬（黑洞能重伤 Boss）
          const mHp = Number.isFinite(mover.hp) ? mover.hp : 1;
          if (mHp > 1) {
            if (applyImpact(mover)) mover.captured = true;
            continue;
          }
          mover.dead = true;
          mover.captured = true;
          continue;
        }

        if (a.isStar || b.isStar) {
          // 非母星天体撞上母星 → 母星扣血
          const other = a.isStar ? b : a;
          other.dead = true;
          other.hitStar = true;
        } else {
          // 任意两个非母星天体物理接触
          const aHp = Number.isFinite(a.hp) ? a.hp : 1;
          const bHp = Number.isFinite(b.hp) ? b.hp : 1;
          if (aHp > 1 || bHp > 1) {
            // 含多段天体（Boss）：普通天体照旧被毁，多段天体每次只扣一段（未归零则存活）
            const aHit = applyImpact(a);
            const bHit = applyImpact(b);
            if (aHit) a.explodedWith = b;
            if (bHit) b.explodedWith = a;
          } else {
            // 一起炸毁（双方 exploded）
            a.dead = true; a.exploded = true;
            b.dead = true; b.exploded = true;
            // 记录撞击对手，供 game.js 只触发一次爆炸动画/音效（避免同一次碰撞播两遍）
            a.explodedWith = b;
            b.explodedWith = a;
          }
        }
      }
    }
  }

  /* ============ 加速度累加（成对对称 · 零临时对象） ============ */
  // 原实现每步对每个天体调用两次 fieldAt，每次返回 {fx,fy} 新对象：
  // 预测器每帧要跑上百步积分，会产生数万次临时分配与 GC 压力。
  // 这里改为复用模块级暂存数组 + 利用牛顿第三定律（每对天体只算一次，
  // a 受 +f、b 受 −f），计算量减半、分配为零，数值结果与 fieldAt 完全一致。
  let _ax = new Float64Array(256), _ay = new Float64Array(256);
  let _bx = new Float64Array(256), _by = new Float64Array(256);
  const _live = [];

  function ensureCapacity(n) {
    if (n <= _ax.length) return;
    let cap = _ax.length;
    while (cap < n) cap *= 2;
    _ax = new Float64Array(cap); _ay = new Float64Array(cap);
    _bx = new Float64Array(cap); _by = new Float64Array(cap);
  }

  // 将 list 中每个天体所受引力加速度写入 outX/outY（单位质量）
  function accumulateAccel(list, outX, outY) {
    const n = list.length;
    const s2 = SOFTENING * SOFTENING;
    outX.fill(0, 0, n);
    outY.fill(0, 0, n);
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (a.dead) continue;
      let axi = 0, ayi = 0;
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (b.dead) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const r2 = dx * dx + dy * dy + s2;
        const invR3 = 1 / (r2 * Math.sqrt(r2));
        const ka = G * b.mass * invR3;   // a 的加速度系数
        const kb = G * a.mass * invR3;   // b 的加速度系数（方向相反）
        axi += ka * dx; ayi += ka * dy;
        outX[j] -= kb * dx; outY[j] -= kb * dy;
      }
      outX[i] += axi; outY[i] += ayi;
    }
  }

  /* ============ 全 N 体一步积分（Verlet 辛积分） ============ */
  // stepSystem(bodies, dt) → 原地更新所有天体位置/速度，含碰撞判定。
  // 母星固定不动（被守护对象）；暂停时 game.js 不调用本函数即可冻结演化。
  function stepSystem(bodies, dt) {
    ensureCapacity(bodies.length);
    _live.length = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.dead) _live.push(b);
    }
    const n = _live.length;

    // 生命周期：存活计时、受伤冷却、限时天体到期。
    // 这里只依赖 age 与固定常量（不含随机、不依赖墙钟），因此预测器的克隆系统
    // 会走出与真实完全一致的演化——这是"预测线与实际不飘"承诺的前提。
    for (let i = 0; i < n; i++) {
      const b = _live[i];
      b.age = (b.age || 0) + dt;
      if (b.hpCd > 0) b.hpCd = Math.max(0, b.hpCd - dt);
      if (b.lifespan > 0 && b.age >= b.lifespan) { b.dead = true; b.expired = true; }
    }
    // 周期脉冲（引力干扰体 / 脉冲源）：跨越周期边界时对附近天体施加一次冲量。
    // 用 floor(age/period) 判定跨越，避免因步长变化而漏发或重发。
    for (let i = 0; i < n; i++) {
      const src = _live[i];
      if (src.dead || !(src.pulsePeriod > 0) || !src.pulseStrength) continue;
      const kPrev = Math.floor((src.age - dt) / src.pulsePeriod);
      const kNow = Math.floor(src.age / src.pulsePeriod);
      if (kNow <= kPrev) continue;
      for (let j = 0; j < n; j++) {
        const t = _live[j];
        if (t === src || t.dead) continue;
        if (t.immovable || t.isStar) continue;            // 锚定天体不受脉冲影响
        const pdx = t.x - src.x, pdy = t.y - src.y;
        const pd = Math.hypot(pdx, pdy);
        if (pd > PULSE_RADIUS || pd < 1e-6) continue;
        const falloff = 1 - pd / PULSE_RADIUS;            // 越近冲量越强
        const dv = src.pulseStrength * falloff / Math.max(1, Math.sqrt(t.mass || 1) * 0.35);
        t.vx += (pdx / pd) * dv;                          // 沿径向推离脉冲源
        t.vy += (pdy / pd) * dv;
      }
      src.pulseFired = (src.pulseFired || 0) + 1;          // 供渲染端画扩散环
    }

    // 当前加速度
    accumulateAccel(_live, _ax, _ay);
    // 位置推进（速度 Verlet）
    for (let i = 0; i < n; i++) {
      const b = _live[i];
      if (b.dead) continue;                  // 本步已到期/已毁
      if (b.isStar || b.immovable) continue; // 母星/黑洞锚定
      b.x += b.vx * dt + 0.5 * _ax[i] * dt * dt;
      b.y += b.vy * dt + 0.5 * _ay[i] * dt * dt;
    }
    // 新加速度
    accumulateAccel(_live, _bx, _by);
    // 速度推进
    for (let i = 0; i < n; i++) {
      const b = _live[i];
      if (b.dead) continue;
      if (b.isStar || b.immovable) continue;
      b.vx += 0.5 * (_ax[i] + _bx[i]) * dt;
      b.vy += 0.5 * (_ay[i] + _by[i]) * dt;
    }

    // 撞星 / 互撞 / 黑洞吞噬
    resolveCollisions(_live);
  }

  /* ============ 辅助：移除 dead 天体 ============ */
  // 返回新的存活天体数组（game.js 调用：state.bodies = physics.pruneBodies(state.bodies)）
  function pruneBodies(bodies) {
    return bodies.filter(function (b) { return !b.dead; });
  }

  /* ============ 导出 ============ */
  const physics = {
    // 常量
    G: G, SOFTENING: SOFTENING,
    RADIUS_K: RADIUS_K, STAR_R: STAR_R, STAR_MASS: STAR_MASS,
    PREDICT_DT: PREDICT_DT, PREDICT_DUR: PREDICT_DUR,
    ARROW_SCALE: ARROW_SCALE,
    HP_HIT_CD: HP_HIT_CD, PULSE_RADIUS: PULSE_RADIUS,
    // 天体类型分类（单一真源，供 game.js / 渲染 / 预测统一判定）
    THREAT_TYPES: THREAT_TYPES, SCENE_TYPES: SCENE_TYPES, PROP_TYPES: PROP_TYPES,
    isThreat: isThreat, isScene: isScene, isPickable: isPickable, needsAge: needsAge,
    // 函数
    Body: Body,
    createBody: createBody,
    computeForce: computeForce,
    fieldAt: fieldAt,
    stepSystem: stepSystem,
    pruneBodies: pruneBodies,
  };

  global.physics = physics;
  if (typeof module !== 'undefined' && module.exports) module.exports = physics;
})(typeof window !== 'undefined' ? window : globalThis);
