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
  const DT = 0.01;          // 物理积分步长(s)
  const RADIUS_K = 2.5;     // 半径系数：radius = RADIUS_K * mass^(1/3)
  const STAR_R = 30;        // 母星半径(px)
  const STAR_MASS = 4000;   // 母星默认质量（建议值，game.js 创建母星时参考）
  const PREDICT_DT = 0.05;  // 预测积分步长(s)：细步长→高保真，与真实 stepSystem 偏差更小、轨迹更顺滑
  const PREDICT_DUR = 6;    // 预测时长(s) = 3 段 × 2s，与提示线分段一致
  const ARROW_SCALE = 0.5;  // 拖拽箭头：1px = 0.5 m/s（输入换算用）

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
      lifespan: o.lifespan || 0,         // 存活时限(s)，0 = 永久（母星/玩家星体）
      age: 0,                            // 已存活时间(s)
      // 状态标记（stepSystem 过程中写入，供 game.js 处理得分/扣血后清除）
      hitStar: false, // 撞上母星（母星扣血）
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

        // 不可动大质量天体（黑洞 / 母星）：吞掉撞上来的运动天体
        if (a.immovable || b.immovable) {
          const mover = a.immovable ? b : a;   // 运动天体（撞上来的）
          const anchor = a.immovable ? a : b;  // 不可动天体（母星 / 黑洞）
          if (anchor.isStar) {
            // 运动天体撞母星：母星扣血，而非被吞噬
            mover.dead = true;
            mover.hitStar = true;
          } else {
            mover.dead = true;
            mover.captured = true;
          }
          continue;
        }

        if (a.isStar || b.isStar) {
          // 非母星天体撞上母星 → 母星扣血
          const other = a.isStar ? b : a;
          other.dead = true;
          other.hitStar = true;
        } else {
          // 任意两个非母星天体物理接触 → 一起炸毁（双方 exploded）
          a.dead = true; a.exploded = true;
          b.dead = true; b.exploded = true;
        }
      }
    }
  }

  /* ============ 全 N 体一步积分（Verlet 辛积分） ============ */
  // stepSystem(bodies, dt) → 原地更新所有天体位置/速度，含合并与洛希判定。
  // 母星固定不动（被守护对象）；暂停时 game.js 不调用本函数即可冻结演化。
  function stepSystem(bodies, dt) {
    const live = bodies.filter(function (b) { return !b.dead; });

    // 当前加速度
    const acc = new Map();
    for (let i = 0; i < live.length; i++) {
      const b = live[i];
      acc.set(b, fieldAt(live, b.x, b.y, b));
    }
    // 位置推进（速度 Verlet）
    for (let i = 0; i < live.length; i++) {
      const b = live[i];
      if (b.isStar || b.immovable) continue; // 母星锚定
      const a = acc.get(b);
      b.x += b.vx * dt + 0.5 * a.fx * dt * dt;
      b.y += b.vy * dt + 0.5 * a.fy * dt * dt;
    }
    // 新加速度
    const acc2 = new Map();
    for (let i = 0; i < live.length; i++) {
      const b = live[i];
      acc2.set(b, fieldAt(live, b.x, b.y, b));
    }
    // 速度推进
    for (let i = 0; i < live.length; i++) {
      const b = live[i];
      if (b.isStar || b.immovable) continue;
      const a1 = acc.get(b), a2 = acc2.get(b);
      b.vx += 0.5 * (a1.fx + a2.fx) * dt;
      b.vy += 0.5 * (a1.fy + a2.fy) * dt;
    }

    // 合并 + 洛希撕裂 + 撞星
    resolveCollisions(live);
  }

  /* ============ 辅助：移除 dead 天体 ============ */
  // 返回新的存活天体数组（game.js 调用：state.bodies = physics.pruneBodies(state.bodies)）
  function pruneBodies(bodies) {
    return bodies.filter(function (b) { return !b.dead; });
  }

  /* ============ 导出 ============ */
  const physics = {
    // 常量
    G: G, SOFTENING: SOFTENING, DT: DT,
    RADIUS_K: RADIUS_K, STAR_R: STAR_R, STAR_MASS: STAR_MASS,
    PREDICT_DT: PREDICT_DT, PREDICT_DUR: PREDICT_DUR,
    ARROW_SCALE: ARROW_SCALE,
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
