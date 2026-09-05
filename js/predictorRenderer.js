/* =========================================================================
 * predictorRenderer.js  —— 成员2（渲染/视觉）参考实现
 * 契约：drawGhost(x,y,mass) / drawPredictionLine(path, risk) / drawDragArrow(x0,y0,x1,y1)
 * ========================================================================= */
const predictorRenderer = (function () {
  let ctx, canvas;

  function attach(c) { canvas = c; ctx = c.getContext('2d'); }
  // 未被 attach（或 canvas 缺失）时静默降级，避免绘制阶段抛异常打断主循环
  function ready() {
    if (!ctx && canvas) attach(canvas);
    return !!ctx;
  }

  // 半透明虚影星体（拖拽时跟随鼠标）
  function drawGhost(x, y, mass) {
    const r = physics.RADIUS_K * Math.cbrt(mass);
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#9ad0ff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 统一预测线规范：
  //  - 实线，按"元时间间隔 BASE_T 秒"分段，段间在分界点短暂留空（抬笔）
  //  - 每段线宽固定，越往后（未来越久）越细，粗细分明
  //  - 拖拽放置线与运动提示线共用同一规范
  //  - 预测总时长 6s，每 2s 一段，共 3 段（BASE_T=2.0）
  const BASE_T = 2.0;        // 元时间间隔(s)：每段实线的分界点（每 2 秒一段）
  const GAP_T  = 0.3;        // 分界点留空时长(s)：每段开头跳过这么久的点不画（分段更清晰）
  const BASE_W = 4.0;        // 第 0 段（0~2s）线宽
  const STEP_W = 0.9;        // 每往后一段减小的线宽
  const MIN_W  = 0.8;        // 最细下限

  function strokeTrajectory(path, color, alpha, dt) {
    if (!path || path.length < 2) return;
    const step = (dt != null) ? dt : physics.PREDICT_DT;   // 路径相邻点真实时间间隔
    // 留空按"固定时长"折算成点数（至少 1 点），与采样密度无关，缺口肉眼可见
    const gapPts = Math.max(1, Math.round(GAP_T / step));
    ctx.save();
    ctx.setLineDash([]);                 // 实线（分界点靠"抬笔留空"体现）
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let i = 1;
    while (i < path.length) {
      const sec = Math.floor(i * step / BASE_T);   // 该段所处"未来第几秒"（0 起）
      let w = BASE_W - sec * STEP_W;
      if (w < MIN_W) w = MIN_W;
      ctx.lineWidth = w;
      // 找到本段终点（同 sec 的最后一点）
      let j = i;
      while (j < path.length && Math.floor(j * step / BASE_T) === sec) j++;
      // 段起点：首段从头画；后续段跳过开头 gapPts 个点 → 分界处留出明显缺口
      let s = (sec === 0) ? i : i + gapPts;
      if (s < j - 1) {
        ctx.beginPath();
        ctx.moveTo(path[s].x, path[s].y);
        for (let k = s + 1; k < j; k++) ctx.lineTo(path[k].x, path[k].y);
        ctx.stroke();
      }
      i = j;
    }
    ctx.restore();
  }

  // 三色预测线（拖拽放置 + 运动星体提示线共用）。steady=true 时不闪烁，始终稳定显示
  // dt：路径相邻点真实时间间隔（= simulateFuture 返回的 sampleDt = PREDICT_DT * sampleEvery）
  function drawPredictionLine(path, risk, steady, dt) {
    if (!path || path.length < 2) return;
    const color = risk.level === 'red' ? '#ff3b3b'
                : risk.level === 'green' ? '#3bff6b'
                : '#3b9bff';
    const blink = steady ? 1
                : (risk.level !== 'blue' ? (0.5 + 0.5 * Math.sin(performance.now() / 120)) : 1);
    strokeTrajectory(path, color, blink, dt);
  }

  // 白色半透明拖拽箭头：方向=初速方向，长度=初速大小（1px = 0.5 m/s 由 input 换算）
  function drawDragArrow(x0, y0, x1, y1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const ah = 9;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ah * Math.cos(ang - 0.4), y1 - ah * Math.sin(ang - 0.4));
    ctx.lineTo(x1 - ah * Math.cos(ang + 0.4), y1 - ah * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 黑洞禁放区：拖拽黑洞时，在母星周围画出红色禁放圈（红虚线 + 淡红填充）
  // 半径 = 母星半径 + 黑洞半径 + 安全余量（由 game.js 计算后传入）
  function drawNoHoleZone(x, y, r) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,60,60,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,60,60,0.07)';
    ctx.fill();
    ctx.restore();
  }

  // 统一预测：对当前系统里所有运动星体/陨石绘制三色轨迹（提示线）
  // 优化：每帧只 simulateFuture 一次，避免 O(N²) 重复积分。
  function renderTrajectories(state) {
    if (typeof predictor === 'undefined' || !predictor) return;
    if (!ready()) return;
    const planet = state.bodies[0];
    if (!planet) return;
    if (!state.bodies || state.bodies.length === 0) return;
    // 一次前向模拟，复用给所有运动天体
    const sim = predictor.simulateFuture(state.bodies, {
      duration: physics.PREDICT_DUR,   // 统一取物理常量（3 段 × 2s = 6s），避免与常量分叉
      dt: physics.PREDICT_DT,
      sampleEvery: 2,
    });
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (b.immovable) continue;
      if (b.type === 'planet') continue;
      if (b.x == null) continue;
      const risk = predictor.evaluateRisk(sim, i, planet);
      drawPredictionLine(risk.path, risk, true, sim.sampleDt);
    }
  }

  // 拖放预测：对每个 placingStar 临时注入一份 bodies，模拟其轨迹
  // placingStars: [{x,y,vx,vy,mass,radius,type}, ...]
  // 返回：成功返回 true（至少画了一条预测线）
  function drawPlacementPrediction(state, placingStars) {
    if (typeof predictor === 'undefined' || !predictor) return false;
    if (!ready()) return false;
    if (!placingStars || placingStars.length === 0) return false;
    const planet = state.bodies[0];
    if (!planet) return false;
    // 浅克隆 state.bodies（保留母星/黑洞/玩家星体的真实位置）
    const snapshot = state.bodies.map(b => Object.assign({}, b));
    // 把 placingStars 作为"假定放置"追加到末尾
    const injected = [];
    for (let k = 0; k < placingStars.length; k++) {
      const ps = placingStars[k];
      if (ps.forbidden) continue;                 // 禁区的不预测
      const b = {
        type: ps.type === 'blackhole' ? 'blackhole' : 'star',
        mass: ps.mass || 300, radius: ps.radius || 14,
        x: ps.x, y: ps.y,
        vx: ps.vx || 0, vy: ps.vy || 0,
        isCollectable: true,
        // 玩家放置的恒星不会被 anchored/immovable（黑洞例外）
        ...(ps.type === 'blackhole' ? { anchored: true, immovable: true } : {}),
      };
      snapshot.push(b);
      injected.push({ index: snapshot.length - 1, body: b });
    }
    if (injected.length === 0) return false;
    // 一次前向模拟
    const sim = predictor.simulateFuture(snapshot, {
      duration: physics.PREDICT_DUR,
      dt: physics.PREDICT_DT,
      sampleEvery: 2,
    });
    // 对每个注入的天体画预测线
    for (const item of injected) {
      // 索引已稳定，simulateFuture 内部克隆 snapshot 时保持顺序
      const risk = predictor.evaluateRisk(sim, item.index, planet);
      // placing 的预测线：稳态（不闪烁），颜色与渲染规范一致
      drawPredictionLine(risk.path, risk, true, sim.sampleDt);
    }
    return true;
  }

  return { attach, drawGhost, drawPredictionLine, drawDragArrow, drawNoHoleZone, renderTrajectories, drawPlacementPrediction };
})();
