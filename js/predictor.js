/*
 * predictor.js —— 《星盾防线》轨迹预测（成员1）
 * 整系统前向 N 体模拟（simulateFuture）：把当前所有天体整体克隆后，用与真实游戏
 * 相同的 stepSystem 向前演化，记录每个天体轨迹；因与真实积分一致，预测线不会"飘忽"。
 * 拖拽时把虚影星体拼入系统一并模拟，使预览线与放置后实际轨迹严格一致。
 *
 * 性能红线：星体数 N>50 时缩短预测时长；预测内部用细步长 PREDICT_DT(0.05s) 积分，
 * 再按 sampleEvery 降采样输出（保真且不过慢）。
 *
 * 导出（全局命名空间 predictor.xxx）：
 *   predictor.simulateFuture(bodies, {duration, dt}) → {paths:[{x,y}...], bodies, sampleDt}
 *   predictor.evaluateRisk(sim, ownerIndex, star)
 *        → {level, path(已按碰撞点截断), endX, endY, captured, hitMother}
 *      sim 为 simulateFuture 的返回值；碰撞检测使用与预测线同一时刻、同步演化的
 *      其它天体未来位置（而非当前静止快照），修正在多运动天体下预测线判色失真的问题。
 */

(function (global) {
  'use strict';

  // 依赖 physics（同页面已加载）。若独立运行则兜底取全局。
  const physics = global.physics;

  // 线段(px,py)->(x,y) 首次进入以(cx,cy)为圆心、r 为半径的圆的"入口点"；
  // 若整段都不进圆则返回 null，否则返回入口坐标 {x,y}（含起点已在圆内的情况）。
  // 用整段检测可避免大步长(dt=0.3)下"穿过天体却漏判"的隧穿问题。
  function segCircleEntry(px, py, x, y, cx, cy, r) {
    const dx = x - px, dy = y - py;
    const fx = px - cx, fy = py - cy;
    const a = dx * dx + dy * dy;
    if (a < 1e-12) {
      // 退化线段（退化为点）：在圆内即视为命中，返回该点
      return (fx * fx + fy * fy <= r * r) ? { x: px, y: py } : null;
    }
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - r * r;
    let disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    disc = Math.sqrt(disc);
    const t1 = (-b - disc) / (2 * a);
    const t2 = (-b + disc) / (2 * a);
    let t = null;
    if (t1 >= 0 && t1 <= 1) t = t1;
    else if (t2 >= 0 && t2 <= 1) t = t2;
    if (t === null) return null;
    return { x: px + t * dx, y: py + t * dy };
  }

  /* ============ 整系统前向 N 体模拟（精确提示线用） ============ */
  // 把当前所有星体整体克隆后，用与真实游戏相同的 stepSystem 向前推进 duration 秒，
  // 记录每个星体的轨迹。由于是全系统真实演化（含引力互扰、合并、撞星），
  // 预测线会与星体实际运行高度一致，不会"飘忽"。
  // 返回 { paths:[{x,y}...] }，与传入 bodies 顺序一一对应（含母星，母星为单点）。
  function simulateFuture(bodies, opts) {
    opts = opts || {};
    const dt = (opts.dt != null) ? opts.dt : physics.PREDICT_DT;
    let duration = (opts.duration != null) ? opts.duration : physics.PREDICT_DUR;
    const N = bodies.length;
    if (N > 50) duration = Math.max(2, 5 - (N - 50) / 10);   // 性能红线

    // 降采样：每 sampleEvery 步记录一个轨迹点，兼顾"细步长高保真"与"绘制不过密"。
    const sampleEvery = (opts.sampleEvery != null) ? opts.sampleEvery : 2;

    // 浅克隆整系统（星体为纯数据对象、无方法，浅拷贝即可，绝不污染真实 state）
    const clones = bodies.map(function (b) { return Object.assign({}, b); });
    const paths = clones.map(function (c) { return [{ x: c.x, y: c.y }]; });
    const prevDead = clones.map(function (c) { return c.dead; });  // 上一步是否已死

    const steps = Math.max(1, Math.round(duration / dt));
    for (let s = 1; s <= steps; s++) {
      physics.stepSystem(clones, dt);          // 与真实游戏同一积分器（细步长→高保真）
      if (s % sampleEvery === 0) {
        for (let i = 0; i < clones.length; i++) {
          const c = clones[i];
          if (prevDead[i]) continue;           // 早已死亡的天体不再记录（避免重复冻结点）
          // 本步"刚死"（被黑洞吞噬/撞星）也记录其归宿点 → 预测线真正扎进黑洞/撞点，
          // 否则路径终点停在碰撞圈外，evaluateRisk 的线段检测会漏判、吞噬显示为蓝色。
          paths[i].push({ x: c.x, y: c.y });
        }
      }
      for (let i = 0; i < clones.length; i++) prevDead[i] = clones[i].dead;
    }
    // 返回：全部天体路径 paths、原始 bodies（供按索引发掘碰撞特征）、相邻点真实时间间隔 sampleDt
    return { paths: paths, bodies: bodies, sampleDt: sampleEvery * dt };
  }

  /* ============ 风险评估：三色 + 轨迹截断 ============ */
  // sim: simulateFuture 的返回值；ownerIndex: 该路径在 paths/bodies 中的索引；star: 母星 Body。
  // 返回 {level:'blue'|'red'|'green', path(已按碰撞点截断), endX, endY, captured, hitMother}
  //   绿：预测轨迹将被某黑洞（不可动天体）吞噬
  //   红：预测轨迹将撞上母星 或 撞上其它星体（轨迹被阻断）
  //   蓝：其余（安全 / 引力弹弓）
  // 关键修复：
  //   1) 碰撞检测使用"与预测线同一步、同步演化的其它天体未来位置"（取 paths[k][i]），
  //      而非当前静止快照，修正多运动天体下预测线判色失真（原 bug：应红却蓝 / 误报红）；
  //   2) 黑洞吞噬判定半径 = 黑洞半径 + 自身半径（与 stepSystem 一致，原只比黑洞半径→永为蓝）；
  //   3) 沿路径逐段求"入口点"并从碰撞点截断轨迹，避免画穿天体还被判可通行（整段检测防隧穿）；
  //   4) 删除"末端点落在母星 2R 内即无条件标红"的启发式——擦边/转向也会中招，误导玩家。
  function evaluateRisk(sim, ownerIndex, star) {
    const paths = sim.paths;
    const bodies = sim.bodies;
    const owner = bodies[ownerIndex];
    const ownerPath = paths[ownerIndex];
    const ownerR = (owner && owner.radius) ? owner.radius : 0;
    let collideIdx = -1, entry = null, level = 'blue', captured = false, hitMother = false;

    // 沿路径逐段找最早碰撞（最先发生者决定颜色与截断点）
    // 第 i 段（path[i]→path[i+1]）对应其它天体第 i 个采样点 paths[k][i]，时刻一致
    for (let i = 0; i < ownerPath.length - 1; i++) {
      const p0 = ownerPath[i], p1 = ownerPath[i + 1];
      for (let k = 0; k < bodies.length; k++) {
        if (k === ownerIndex) continue;
        const o = bodies[k];
        const op = paths[k];
        if (!op || i >= op.length) continue;     // 该天体此刻已提前死亡/无坐标，跳过
        if (o.immovable && owner && owner.immovable) continue;  // 两不可动天体互不作用
        const rr = o.radius + ownerR;            // 真实碰撞阈值（两球表面接触）
        const pt = segCircleEntry(p0.x, p0.y, p1.x, p1.y, op[i].x, op[i].y, rr);
        if (!pt) continue;
        collideIdx = i;
        entry = pt;
        if (o.isStar)         { level = 'red';  hitMother = true; }
        else if (o.immovable) { level = 'green'; captured = true; }
        else                  { level = 'red'; }
        break;  // 同段取首个命中即可
      }
      if (collideIdx >= 0) break;
    }

    let outPath, endX, endY;
    if (collideIdx >= 0) {
      outPath = ownerPath.slice(0, collideIdx + 1);
      outPath.push(entry);    // 截到进入碰撞圈的那一点，避免画穿天体
      endX = entry.x; endY = entry.y;
    } else {
      outPath = ownerPath;
      const e = ownerPath[ownerPath.length - 1];
      endX = e.x; endY = e.y;
    }

    return { level: level, path: outPath, endX: endX, endY: endY, captured: captured, hitMother: hitMother };
  }

  /* ============ 导出 ============ */
  const predictor = {
    simulateFuture: simulateFuture,
    evaluateRisk: evaluateRisk,
  };

  global.predictor = predictor;
  if (typeof module !== 'undefined' && module.exports) module.exports = predictor;
})(typeof window !== 'undefined' ? window : globalThis);
