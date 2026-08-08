/* =========================================================================
 * input.js  —— 成员3（交互/游戏系统）核心文件
 * 职责：拖拽绘图法三阶段（按下->移动30Hz刷预测线->松开实体化）
 *       质量档+预算 / 暂停 / 提示线·预测线开关
 * 严格对接 PLAN.md 第8节：调用 physics / predictor / predictorRenderer。
 * ========================================================================= */
const input = (function () {
  let canvas;
  // 拖拽状态（game.renderFrame 会读取用于绘制）
  const api = {
    dragging: false,
    sx: 0, sy: 0, mx: 0, my: 0,
    smx: 0, smy: 0,          // 平滑后的鼠标坐标（去抖，避免高频微抖放大成线端跳动）
    path: null, risk: null, pathDt: 0,
    lastPredict: 0
  };

  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    // 画布显示尺寸已按分辨率缩放，需把屏幕坐标映射回逻辑世界（960x600）
    return {
      x: (e.clientX - r.left) * (game.W / r.width),
      y: (e.clientY - r.top) * (game.H / r.height)
    };
  }

  // 计算当前幽灵星体的初速：拖拽矢量换算（1px = ARROW_SCALE m/s）。
  // 黑洞不可动：初速恒为 0，仅靠其超大质量施加引力改变其它天体轨道。
  // （精确 vx,vy 输入逻辑已按需求移除）
  function ghostVelocity() {
    const tier = game.TIERS[game.state.currentTier];
    if (tier.immovable) return { vx: 0, vy: 0 };
    const dx = api.smx - api.sx, dy = api.smy - api.sy;
    return { vx: dx * physics.ARROW_SCALE, vy: dy * physics.ARROW_SCALE };
  }

  // 30Hz 节流刷新预测线
  function refreshPrediction() {
    const now = performance.now();
    if (now - api.lastPredict < 33) return;
    api.lastPredict = now;

    const tier = game.TIERS[game.state.currentTier];
    // 用平滑后的鼠标坐标计算初速/位置，抑制高频抖动
    let v;
    if (tier.immovable) {
      v = { vx: 0, vy: 0 };   // 黑洞不可动
    } else {
      v = { vx: (api.smx - api.sx) * physics.ARROW_SCALE,
            vy: (api.smy - api.sy) * physics.ARROW_SCALE };
    }
    const ghost = physics.createBody(tier.mass, api.sx, api.sy, v.vx, v.vy,
                                     { isCollectable: true, immovable: !!tier.immovable,
                                       lifespan: tier.lifespan || 0 });
    // 预览与放置后的提示线用同一算法：把虚影星体拼进整系统做前向 N 体模拟，
    // 取虚影自己的轨迹 → 预览线与放置后实际轨迹严格一致
    const all = game.state.bodies.concat([ghost]);
    const res = predictor.simulateFuture(all,
                                         { duration: physics.PREDICT_DUR, dt: physics.PREDICT_DT });
    api.pathDt = res.sampleDt;     // 真实采样间隔，供预测线分段渲染
    api.risk = predictor.evaluateRisk(res, all.length - 1, game.state.star);
    api.path = api.risk.path;   // 使用按碰撞点截断后的轨迹，避免画穿天体
  }

  // 统一用 Pointer Events：鼠标 / 触摸 / 笔 同一套逻辑，手机可直接拖拽摆放星体
  function onDown(e) {
    audio.unlock();              // 首次用户交互解锁音频（浏览器自动播放策略）
    if (game.state.gameOver) return;
    if (e.button !== undefined && e.button !== 0) return;   // 仅主键（左键/触摸/笔触）
    const p = toCanvas(e);
    api.dragging = true;
    api.sx = p.x; api.sy = p.y; api.mx = p.x; api.my = p.y;
    api.smx = p.x; api.smy = p.y;   // 平滑坐标与起点一致，避免初始跳变
    api.lastPredict = 0;
    refreshPrediction();
    // 捕获指针：拖出画布范围也能持续收到 move/up，触摸拖拽更顺滑
    if (canvas.setPointerCapture && e.pointerId !== undefined) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (!api.dragging) return;
    const p = toCanvas(e);
    api.mx = p.x; api.my = p.y;
    // 指数滤波去抖：平滑坐标缓慢跟随真实指针，抑制高频微抖引起的线端跳动
    api.smx += (p.x - api.smx) * 0.35;
    api.smy += (p.y - api.smy) * 0.35;
    refreshPrediction();
    e.preventDefault();
  }

  function onUp(e) {
    if (!api.dragging) return;
    api.dragging = false;
    if (canvas.releasePointerCapture && e.pointerId !== undefined) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    }

    const tier = game.TIERS[game.state.currentTier];
    const v = ghostVelocity();

    // 黑洞不可紧贴母星：超大质量会剧烈扰动母星周边轨道，且静止不可移动无法补救
    if (tier.immovable) {
      const ghost = physics.createBody(tier.mass, api.sx, api.sy, 0, 0,
                                       { isCollectable: true, immovable: true,
                                         lifespan: tier.lifespan || 0 });
      const d = Math.hypot(api.sx - game.state.star.x, api.sy - game.state.star.y);
      if (d < physics.STAR_R + ghost.radius + game.NO_HOLE_MARGIN) {
        flash('黑洞不能放在母星附近！');
        api.path = null; api.risk = null;
        return;                         // 不放置、不扣费
      }
    }

    game.state.bodies.push(
      physics.createBody(tier.mass, api.sx, api.sy, v.vx, v.vy,
                         { isCollectable: true, immovable: !!tier.immovable,
                           lifespan: tier.lifespan || 0 })
    );
    game.state.spent += tier.cost;   // 累计已消耗金钱（不限制建造总数）
    audio.play('place');             // 放置音效
    api.path = null; api.risk = null;
  }

  // ---- 面板控件 ----
  function selectTier(t) {
    game.state.currentTier = t;
    document.querySelectorAll('[data-tier]').forEach(b => {
      b.classList.toggle('active', b.dataset.tier === t);
    });
  }

  function togglePause() {
    if (game.state.gameOver) return;
    game.state.paused = !game.state.paused;
    document.getElementById('pauseBtn').textContent = game.state.paused ? '继续' : '暂停';
  }

  function flash(msg) {
    const el = document.getElementById('msg');
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { el.style.opacity = '0'; }, 1200);
  }

  function init() {
    canvas = document.getElementById('game');

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    document.querySelectorAll('[data-tier]').forEach(b => {
      b.addEventListener('click', () => selectTier(b.dataset.tier));
    });
    selectTier('small');

    document.getElementById('pauseBtn').addEventListener('click', togglePause);
    document.getElementById('predChk').addEventListener('change', e => {
      game.state.showPrediction = e.target.checked;
    });
    document.getElementById('hintChk').addEventListener('change', e => {
      game.state.showHint = e.target.checked;
    });
    document.getElementById('restartBtn').addEventListener('click', () => location.reload());
  }

  return Object.assign(api, { init });
})();

input.init();
