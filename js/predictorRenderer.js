/* =========================================================================
 * predictorRenderer.js  —— 成员2（渲染/视觉）参考实现
 * 契约：drawGhost(x,y,mass) / drawPredictionLine(path, risk) / drawDragArrow(x0,y0,x1,y1)
 * ========================================================================= */
const predictorRenderer = (function () {
  let ctx, canvas;

  function attach(c) { canvas = c; ctx = c.getContext('2d'); }

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
  const BASE_T = 1.0;        // 元时间间隔(s)：每段实线的分界点
  const GAP_T  = 0.15;       // 分界点留空时长(s)：每段开头跳过这么久的点不画
  const BASE_W = 4.0;        // 第 0 段（0~1s）线宽
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
  // dt：路径相邻点真实时间间隔（hint 线传 physics.DT，drag 线传 physics.PREDICT_DT）
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

  return { attach, drawGhost, drawPredictionLine, drawDragArrow, drawNoHoleZone };
})();
