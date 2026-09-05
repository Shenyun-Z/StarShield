(function (global) {
  'use strict';

  let dpr = 1;
  const GLOW = 'rgba(120,170,255,0.85)';
  // 缓存 canvas 上下文：render() 每帧调用，getContext 没必要每帧走一遍查找
  let cachedCanvas = null;
  let cachedCtx = null;
  function contextOf(canvas) {
    if (canvas !== cachedCanvas) {
      cachedCanvas = canvas;
      cachedCtx = canvas.getContext('2d');
    }
    return cachedCtx;
  }

  // 引力场流线缓存
  let fieldLines = [];   // {x,y,dx,dy,strength}
  let fieldTimer = 0;

  function resize(canvas) {
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  }

  function rebuildField(state) {
    const W = window.innerWidth, H = window.innerHeight;
    const spacing = 90;        // 网格间距（稀疏，不抢眼）
    const stepLen = 26;        // 每条流线长度
    fieldLines = [];
    const masses = state.bodies.filter(b => b.type !== 'comet' && b.type !== 'asteroid');
    for (let gx = spacing / 2; gx < W; gx += spacing) {
      for (let gy = spacing / 2; gy < H; gy += spacing) {
        const f = physics.fieldAt(masses, gx, gy);
        const mag = Math.hypot(f.x, f.y);
        if (mag < 8) continue;           // 太弱不画
        const ux = f.x / mag, uy = f.y / mag;
        // 沿力方向画一小段流线
        fieldLines.push({
          x: gx, y: gy,
          ex: gx + ux * stepLen, ey: gy + uy * stepLen,
          strength: clamp01(mag / 600),
        });
      }
    }
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function drawField(ctx, state) {
    fieldTimer -= 1;
    if (fieldTimer <= 0) { rebuildField(state); fieldTimer = 6; }
    ctx.save();
    ctx.lineWidth = 1;
    for (const l of fieldLines) {
      const alpha = 0.05 + l.strength * 0.10;   // 极淡
      ctx.strokeStyle = `rgba(130,170,230,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(l.ex, l.ey);
      ctx.stroke();
      // 末端小箭头，方向清晰
      const ang = Math.atan2(l.ey - l.y, l.ex - l.x);
      const ah = 3.2;
      ctx.beginPath();
      ctx.moveTo(l.ex, l.ey);
      ctx.lineTo(l.ex - ah * Math.cos(ang - 0.5), l.ey - ah * Math.sin(ang - 0.5));
      ctx.moveTo(l.ex, l.ey);
      ctx.lineTo(l.ex - ah * Math.cos(ang + 0.5), l.ey - ah * Math.sin(ang + 0.5));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBody(ctx, b, t, state) {
    if (b.type === 'planet') {
      // 震缩：半径抖动 + 红光
      const punch = (state && state.planetPunch) || 0;
      const jitter = punch > 0 ? (Math.sin(t * 30) * 0.08 * punch) : 0;
      const r = b.radius * (1 + jitter);
      // 受击红光
      if (punch > 0) {
        const grd = ctx.createRadialGradient(b.x, b.y, 4, b.x, b.y, r * 2.4);
        grd.addColorStop(0, '#ff9b9b');
        grd.addColorStop(0.4, '#ff5d5d');
        grd.addColorStop(1, 'rgba(150,30,30,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      const grd = ctx.createRadialGradient(b.x, b.y, 4, b.x, b.y, r * 2.4);
      grd.addColorStop(0, '#bfe0ff');
      grd.addColorStop(0.4, '#5b8fd6');
      grd.addColorStop(1, 'rgba(30,60,110,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = punch > 0.4 ? '#ffb0b0' : '#dff0ff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (b.type === 'blackhole') {
      // 玩家黑洞 fading 动画：半径收缩 + 紫色脉冲
      let r = b.radius;
      let alphaBoost = 0;
      if (b.fading && b.fadeLife != null) {
        // fadeLife 从 1.5 → 0，收缩
        const t = clamp01(b.fadeLife / 1.5);
        r = b.radius * (0.6 + 0.4 * t);          // 收缩到 60%
        alphaBoost = (1 - t) * 0.5;
      }
      // 剩余时间紫色脉冲（最后 5 秒）
      let remaining = 0;
      if (b.expiresAt) remaining = Math.max(0, (b.expiresAt - performance.now()) / 1000);
      const pulse = remaining > 0 && remaining <= 5
        ? 0.3 + 0.3 * Math.abs(Math.sin(t * 12))
        : 0;

      ctx.fillStyle = '#0a0d18';
      ctx.beginPath();
      ctx.arc(b.x, b.y, r + 6, 0, Math.PI * 2);
      ctx.fill();
      const ring = ctx.createRadialGradient(b.x, b.y, r, b.x, b.y, r + 8);
      ring.addColorStop(0, `rgba(150,120,255,${0.9 + alphaBoost + pulse})`);
      ring.addColorStop(1, 'rgba(150,120,255,0)');
      ctx.strokeStyle = ring;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
    } else if (b.type === 'star') {
      const grd = ctx.createRadialGradient(b.x, b.y, 2, b.x, b.y, b.radius * 2);
      grd.addColorStop(0, '#fff3c4');
      grd.addColorStop(0.5, 'rgba(255,200,90,0.6)');
      grd.addColorStop(1, 'rgba(255,180,60,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffe9a8';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (b.type === 'asteroid') {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rotation || 0);
      ctx.fillStyle = '#8a96ad';
      ctx.strokeStyle = '#c2ccdf';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const verts = b.vertices || [];
      for (let i = 0; i < verts.length; i++) {
        const a = (i / verts.length) * Math.PI * 2;
        const rr = b.radius * (verts[i] || 1);
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else if (b.type === 'comet') {
      // 尾迹
      if (b.trail && b.trail.length > 1) {
        ctx.strokeStyle = 'rgba(255,200,120,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(b.trail[0].x, b.trail[0].y);
        for (let i = 1; i < b.trail.length; i++) ctx.lineTo(b.trail[i].x, b.trail[i].y);
        ctx.stroke();
      }
      const grd = ctx.createRadialGradient(b.x, b.y, 1, b.x, b.y, b.radius * 2.2);
      grd.addColorStop(0, '#fff');
      grd.addColorStop(0.4, 'rgba(255,190,90,0.8)');
      grd.addColorStop(1, 'rgba(255,150,60,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function render(canvas, state) {
    if (canvas.width !== window.innerWidth * dpr) resize(canvas);
    const ctx = contextOf(canvas);
    if (!ctx) return;                       // 上下文不可用（极端环境）时安全退出
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 背景
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    // 屏震
    ctx.save();
    if (state.shake > 0) {
      const s = state.shake;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    // 引力场流线（绘制在背景之上、星体之下）
    drawField(ctx, state);

    // 预测轨迹
    if (state.showHint && state.gameStarted && !state.gameOver
        && typeof predictorRenderer !== 'undefined' && predictorRenderer) {
      predictorRenderer.renderTrajectories(state);
    }

    // 星体
    for (const b of state.bodies) drawBody(ctx, b, performance.now() / 1000, state);

    // 拖放预测线（先把 placingStars 注入当前系统，模拟其轨迹）
    const ps = window.__placingStars;
    if (ps && ps.length && state.showHint && state.gameStarted && !state.gameOver) {
      if (typeof predictorRenderer !== 'undefined' && predictorRenderer
          && predictorRenderer.drawPlacementPrediction) {
        predictorRenderer.drawPlacementPrediction(state, ps);
      }
    }

    // 布防预览（未提交星体）
    if (ps && ps.length) {
      for (const s of ps) {
        if (s.forbidden) {
          ctx.strokeStyle = 'rgba(255,90,90,0.85)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.radius || 14, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          continue;
        }
        // 按档位选色
        let color = 'rgba(255,220,120,0.7)';
        if (s.type === 'blackhole') color = 'rgba(200,155,255,0.85)';
        else if (s.type === 'star') color = 'rgba(255,236,180,0.85)';
        else if (s.type === 'mid') color = 'rgba(180,200,230,0.7)';
        else if (s.type === 'small') color = 'rgba(150,170,200,0.7)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // 拖拽方向箭头（投掷向量可视化）
        const dx = s.dragDx || 0, dy = s.dragDy || 0;
        const dragLen = Math.hypot(dx, dy);
        if (dragLen > 6) {
          // 力度按比例放大（与 placeStar 中 DRAG_SPEED_SCALE 一致感）
          const speedPx = Math.min(dragLen * 1.6, 420);
          const scale = speedPx / dragLen;
          const ex = s.x + dx * scale * 0.18;   // 视觉长度缩到 0.18 比例（避免过长）
          const ey = s.y + dy * scale * 0.18;
          const ang = Math.atan2(ey - s.y, ex - s.x);
          // 强度线：随距离加粗变亮
          const intensity = Math.min(dragLen / 80, 1);
          ctx.lineWidth = 1.6 + intensity * 2.2;
          ctx.strokeStyle = `rgba(255,255,255,${0.5 + intensity * 0.4})`;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          // 箭头三角
          const ah = 7 + intensity * 4;
          ctx.fillStyle = `rgba(255,255,255,${0.6 + intensity * 0.35})`;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ah * Math.cos(ang - 0.45), ey - ah * Math.sin(ang - 0.45));
          ctx.lineTo(ex - ah * Math.cos(ang + 0.45), ey - ah * Math.sin(ang + 0.45));
          ctx.closePath();
          ctx.fill();
          // 力度数字（可选；保留简洁：注释掉以免抢眼）
        }
      }
    }

    // 冲击波环（从母星位置扩散）
    if (state.shockwaves && state.shockwaves.length) {
      for (const w of state.shockwaves) {
        const a = clamp01(w.life / w.maxLife);
        ctx.strokeStyle = w.color.replace(/[\d.]+\)$/g, (a * 0.85).toFixed(2) + ')');
        ctx.lineWidth = 2 + (1 - a) * 4;
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 粒子
    for (const p of state.particles) {
      const a = clamp01(p.life / (p.maxLife || 0.8));
      ctx.fillStyle = p.color || '#fff';
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // 屏闪（覆盖全屏），在 ctx.restore() 之后画，不受屏震影响。
    // state.flashes 由 game.addFlash() 写入（红=母星受击、紫=黑洞吞噬/消失）。
    if (state.flashes && state.flashes.length) {
      for (const f of state.flashes) {
        const a = clamp01(f.life / (f.maxLife || 0.3)) * (f.intensity || 1);
        ctx.fillStyle = String(f.color || 'rgba(255,80,90,0.35)')
          .replace(/[\d.]+\)$/g, (a * 0.35).toFixed(2) + ')');
        ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      }
    }
  }

  global.render = render;
  global.addEventListener('resize', function () {
    const c = document.getElementById('game');
    if (c) resize(c);
  });
})(typeof window !== 'undefined' ? window : globalThis);
