/* =========================================================================
 * render.js  —— 成员2（渲染/视觉）参考实现
 * 契约：initRender(canvas) / drawFrame(bodies, state)
 *       colorBySpeed(body) / drawCollectRing(ring) / drawHUD(state)
 * ========================================================================= */
const render = (function () {
  let ctx, canvas;
  let bgStars = [];

  function initRender(c) {
    canvas = c;
    ctx = c.getContext('2d');
    bgStars = [];
    for (let i = 0; i < 120; i++) {
      bgStars.push({
        x: Math.random() * c.width,
        y: Math.random() * c.height,
        r: Math.random() * 1.2 + 0.2,
        a: Math.random() * 0.5 + 0.2
      });
    }
    return ctx;
  }

  function colorBySpeed(b) {
    const sp = Math.hypot(b.vx, b.vy);
    const t = Math.min(1, sp / 200);     // 0 慢 -> 1 快
    const hue = 220 - 220 * t;           // 220 蓝 -> 0 红
    return 'hsl(' + hue + ',80%,62%)';
  }

  function drawTrail(b) {
    if (!b.trail || b.trail.length < 2) return;
    ctx.save();
    ctx.strokeStyle = b.isMeteorite ? 'rgba(255,112,67,0.4)' : 'rgba(150,200,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(b.trail[0].x, b.trail[0].y);
    for (let i = 1; i < b.trail.length; i++) ctx.lineTo(b.trail[i].x, b.trail[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function drawBody(b) {
    if (b.isStar) ctx.fillStyle = '#ffd54a';
    else if (b.isMeteorite) ctx.fillStyle = '#ff7043';
    else if (b.immovable) ctx.fillStyle = '#05050a';   // 黑洞：近黑圆盘
    else ctx.fillStyle = colorBySpeed(b);

    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
    ctx.fill();
    if (b.isStar) {
      ctx.strokeStyle = 'rgba(255,213,74,0.4)';
      ctx.lineWidth = 6;
      ctx.stroke();
    } else if (b.immovable) {
      ctx.strokeStyle = 'rgba(170,90,255,0.9)';        // 事件视界光晕
      ctx.lineWidth = 3;
      ctx.stroke();
      // 黑洞剩余寿命：冷却环 + 文字（实时倒数）
      if (b.lifespan > 0) {
        const remain = Math.max(0, b.lifespan - b.age);
        const frac = remain / b.lifespan;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(176,107,255,' + (0.35 + 0.5 * frac) + ')';
        ctx.lineWidth = 2.5;
        ctx.arc(b.x, b.y, b.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx.stroke();
        ctx.save();
        ctx.fillStyle = '#d9b3ff';
        ctx.font = '11px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(remain.toFixed(1) + 's', b.x, b.y - b.radius - 11);
        ctx.restore();
      }
    }
  }

  function drawHUD(state) {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.font = '16px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('得分: ' + state.score, 16, 26);
    ctx.fillText('波次: ' + state.wave, 16, 48);
    ctx.fillText('已花费: ' + state.spent, 16, 70);
    ctx.fillStyle = '#ff9e5e';
    ctx.fillText('撞毁: ' + (state.destroyed || 0), 16, 92);
    ctx.fillStyle = '#b06bff';
    ctx.fillText('吸入: ' + (state.captured || 0), 16, 114);
    ctx.fillStyle = '#ffd54a';
    ctx.fillText('最高分: ' + (state.best || 0), 16, 136);
    ctx.fillStyle = '#fff';

    ctx.fillText('母星血量', 16, 162);
    ctx.fillStyle = '#333';
    ctx.fillRect(16, 170, 160, 14);
    ctx.fillStyle = state.health > 30 ? '#4caf50' : '#e53935';
    const w = 160 * Math.max(0, state.health) / 100;
    if (w > 0) ctx.fillRect(16, 170, w, 14);
    ctx.restore();
  }

  // 特效：按 type 渲染三种独立死亡动画
  //   explode：橙红中心闪光 + 扩散冲击波 + 碎片四溅
  //   capture：紫色漩涡（中心亮核 + 收缩环 + 螺旋吸入粒子）
  //   escape ：青蓝柔和环扩散 + 轻盈漂浮雾点
  function drawFx(state) {
    if (!state.fx || !state.fx.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of state.fx) {
      const t = e.age / e.life;                 // 0 → 1
      const fade = 1 - t;

      if (e.type === 'explode') {
        // 1) 中心闪光（前 35% 生命最亮，快速收缩）
        if (t < 0.35) {
          const fr = (1 - t / 0.35);
          const R = 18 * fr + 4;
          const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, R);
          g.addColorStop(0, 'rgba(255,255,230,' + (0.9 * fr) + ')');
          g.addColorStop(1, 'rgba(255,160,60,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(e.x, e.y, R, 0, Math.PI * 2); ctx.fill();
        }
        // 2) 冲击波环（扩散 + 变淡）
        const rr = e.ringMax * Math.sqrt(t);
        ctx.strokeStyle = 'rgba(255,200,120,' + (0.7 * fade) + ')';
        ctx.lineWidth = 2.5 * fade + 0.5;
        ctx.beginPath(); ctx.arc(e.x, e.y, rr, 0, Math.PI * 2); ctx.stroke();
        // 3) 碎片粒子（橙红-金黄）
        for (const p of e.parts) {
          ctx.fillStyle = 'hsla(' + p.hue + ',100%,60%,' + (0.9 * fade) + ')';
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.3, p.r * fade), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      else if (e.type === 'capture') {
        // 1) 中心亮核（紫色）
        const cr = (6 * (1 - t * 0.6) + 2) + 8;
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, cr);
        g.addColorStop(0, 'rgba(220,180,255,' + (0.9 * fade) + ')');
        g.addColorStop(1, 'rgba(150,80,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(e.x, e.y, cr, 0, Math.PI * 2); ctx.fill();
        // 2) 收缩漩涡环
        const rr = Math.max(1, e.baseR * (1 - t));
        ctx.strokeStyle = 'rgba(176,107,255,' + (0.8 * fade) + ')';
        ctx.lineWidth = 2 * fade + 0.5;
        ctx.beginPath(); ctx.arc(e.x, e.y, rr, 0, Math.PI * 2); ctx.stroke();
        // 3) 螺旋吸入粒子（先算极坐标位置）
        for (const p of e.parts) {
          const pr = Math.max(0, p.r);
          const px = e.x + Math.cos(p.ang) * pr;
          const py = e.y + Math.sin(p.ang) * pr;
          ctx.fillStyle = 'hsla(' + p.hue + ',90%,65%,' + (0.9 * fade) + ')';
          ctx.beginPath(); ctx.arc(px, py, 1.4, 0, Math.PI * 2); ctx.fill();
        }
      }
      else if (e.type === 'escape') {
        // 1) 柔和扩散环（青蓝）
        const rr = 24 * Math.sqrt(t) + 6;
        ctx.strokeStyle = 'rgba(120,220,255,' + (0.6 * fade) + ')';
        ctx.lineWidth = 1.8 * fade + 0.3;
        ctx.beginPath(); ctx.arc(e.x, e.y, rr, 0, Math.PI * 2); ctx.stroke();
        // 2) 轻盈漂浮雾点
        for (const p of e.parts) {
          ctx.fillStyle = 'hsla(' + p.hue + ',90%,70%,' + (0.7 * fade) + ')';
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.3, p.r * fade), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // 飘字：得分 / 扣血浮动文字（向上飘 + 淡出），加描边提升可读性
  function drawFloaters(state) {
    if (!state.floaters || !state.floaters.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 17px "Segoe UI", sans-serif';
    for (const f of state.floaters) {
      const t = f.age / f.life;                 // 0 → 1
      const alpha = Math.max(0, 1 - t);
      const yy = f.y - 22 * t;                  // 向上飘
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(f.text, f.x, yy);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, yy);
    }
    ctx.restore();
  }

  function drawFrame(bodies, state) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 背景
    ctx.fillStyle = '#05060f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    for (const s of bgStars) {
      ctx.fillStyle = 'rgba(255,255,255,' + s.a + ')';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // 屏震
    ctx.save();
    if (state.shake > 0) {
      const s = state.shake;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    for (const b of bodies) drawTrail(b);
    for (const b of bodies) drawBody(b);
    drawFx(state);
    drawFloaters(state);
    ctx.restore();

    drawHUD(state);

    if (state.gameOver) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = '42px "Segoe UI", sans-serif';
      ctx.fillText('游戏结束', canvas.width / 2, canvas.height / 2 - 20);
      ctx.font = '20px "Segoe UI", sans-serif';
      ctx.fillText('到达波次: ' + state.wave,
                   canvas.width / 2, canvas.height / 2 + 20);
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.fillText('撞毁 ' + (state.destroyed || 0) + '   ·   吸入 ' + (state.captured || 0),
                   canvas.width / 2, canvas.height / 2 + 46);
      ctx.fillText('得分 ' + state.score + '  −  已花费 ' + state.spent,
                   canvas.width / 2, canvas.height / 2 + 72);
      ctx.font = '26px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ffd54a';
      ctx.fillText('最终得分: ' + state.finalScore,
                   canvas.width / 2, canvas.height / 2 + 106);
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.fillText('最高分: ' + (state.best || 0),
                   canvas.width / 2, canvas.height / 2 + 136);
      if (state.newRecord) {
        ctx.font = '22px "Segoe UI", sans-serif';
        ctx.fillStyle = '#ffd54a';
        ctx.fillText('★ 新纪录！', canvas.width / 2, canvas.height / 2 + 166);
      }
      ctx.fillStyle = '#fff';
      ctx.font = '18px "Segoe UI", sans-serif';
      ctx.fillText('点击右侧"重新开始"再来一局',
                   canvas.width / 2, canvas.height / 2 + (state.newRecord ? 196 : 166));
      ctx.restore();
    }
  }

  return { initRender, drawFrame, colorBySpeed, drawHUD, drawFloaters };
})();
