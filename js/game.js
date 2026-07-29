/* =========================================================================
 * game.js  —— 成员3（交互/游戏系统 · 协调者）核心文件
 * 职责：主循环 + 游戏规则（波次/得分/血量/收集环/关卡状态机）
 * 严格对接 PLAN.md 第8节接口契约，调用 physics / predictor / render。
 * ========================================================================= */
const game = (function () {
  const W = 960, H = 600;
  const STEPS = 2;                 // 每帧物理子步数（DT*STEPS ≈ 帧时长）
  const DT = physics.DT;

  // 星体档位（半径 ∝ ∛质量，档位越高星体越大）
  // 成本经过重估：小天体便宜且撞击效率高（薄拦截）；大/恒星贵但覆盖大、引力强（区域控制）；
  // 黑洞最贵且限时，是“战略 AoE”，需捕获≥2 颗陨石才回本（详见 SCORE）。
  const TIERS = {
    small:     { mass: 50,   cost: 3 },                           // 撞击为主：便宜，可成排拦截
    medium:    { mass: 200,  cost: 6 },                           // 撞击为主，略带引力
    large:     { mass: 600,  cost: 12 },                          // 撞击 + 引力（可撕裂陨石）
    star:      { mass: 1500, cost: 20 },                          // 撞击 + 强引力 + 撕裂（大范围控制）
    blackhole: { mass: 6000, cost: 30, immovable: true, lifespan: 12 }  // 纯引力·静止·限时12s：明显弯曲所有非母星轨道
  };
  const METEOR_MASS = 1;

  // —— 得分规则（固定分，不叠加连击）——
  // 重估后：撞毁 > 吸入 > 安全飞出；最终得分 = 得分 − 已花费，逼玩家权衡“建造投入 vs 防守收益”。
  //   destroy: 25 每颗陨石撞毁（越小越便宜的星体边际收益越高，鼓励薄拦截）
  //   capture: 20 黑洞每吞噬 1 颗（黑洞 cost=30，需吞 ≥2 颗才回本，限制铺满黑洞刷分）
  //   escape:   8 陨石被引力弹弓甩出边界（被动防守，少量分）
  const SCORE = {
    destroy: 25,
    capture: 20,
    escape:  8
  };

  // 黑洞不可放置在母星周围的禁放半径（含母星半径 + 黑洞半径 + 安全余量）
  const NO_HOLE_MARGIN = 60;

  let canvas, ctx, star;

  const state = {
    bodies: [], star: null,
    score: 0, health: 100, spent: 0, finalScore: 0,   // spent=已消耗金钱（不限制建造总数）
    best: 0, newRecord: false,                // 本地最高分 / 本局是否破纪录
    destroyed: 0, captured: 0,                // 撞毁(撞击/撕裂) / 吸入(黑洞吞噬) 的陨石计数
    fx: [],                                   // 爆炸特效（粒子/冲击波/闪光）
    floaters: [],                             // 飘字（+分数 / -血量）浮动文字
    wave: 0, paused: false, mode: 'simple',   // 'simple' | 'pro'
    shake: 0, showPrediction: true, showHint: true,
    hintCache: null, hintNext: 0, hintSampleDt: 0,
    currentTier: 'small',
    waveActive: false, spawnList: [], spawnTimer: 0, nextWaveTimer: 0,
    gameOver: false
  };

  // ---- 关卡/波次 ----
  function startWave(n) {
    state.wave = n;
    state.spawnList = [];
    state.waveActive = true;
    state.spawnTimer = 0;
    const count = (n === 1) ? 1 : (2 + n);     // 教程关1颗，之后递增
    const gap = (n === 1) ? 2 : 1.5;
    for (let i = 0; i < count; i++) {
      state.spawnList.push({ t: gap * i + 0.5, done: false });
    }
    // 预算不再随波次白送，改为靠击毁/吞噬陨石赚回
  }

  function spawnMeteor(n) {
    const edge = Math.floor(Math.random() * 4);
    let x, y;
    if (edge === 0)      { x = Math.random() * W; y = -20; }
    else if (edge === 1) { x = W + 20;          y = Math.random() * H; }
    else if (edge === 2) { x = Math.random() * W; y = H + 20; }
    else                 { x = -20;             y = Math.random() * H; }

    const cx = W / 2, cy = H / 2;
    let tx = cx, ty = cy;
    if (n === 1) { tx = cx + 140; ty = cy - 40; }   // 教程：偏移，缓慢飘来
    else { tx = cx + (Math.random() * 100 - 50); ty = cy + (Math.random() * 100 - 50); }

    const dx = tx - x, dy = ty - y;
    const d = Math.hypot(dx, dy);
    const speed = (n === 1) ? 55 : (70 + n * 12);
    const vx = dx / d * speed, vy = dy / d * speed;

    const m = physics.createBody(METEOR_MASS, x, y, vx, vy, { isMeteorite: true });
    state.bodies.push(m);
  }

  // ---- 爆炸特效（三种死亡各一套独立动画）----
  //   explode（撞毁）：橙红中心闪光 + 扩散冲击波 + 碎片四溅
  //   capture（吸入）：紫色漩涡向内收缩，粒子螺旋被吸入
  //   escape （离开）：青蓝柔和环扩散 + 轻盈漂浮的雾点
  function spawnExplosion(b) {
    const power = Math.max(1, Math.cbrt(b.mass));         // 大星体炸得更大
    const n = Math.min(40, Math.round(14 + power * 8));   // 粒子数
    const parts = [];
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = (40 + Math.random() * 160) * power * 0.6;
      parts.push({
        x: b.x, y: b.y,
        vx: b.vx * 0.3 + Math.cos(ang) * sp,
        vy: b.vy * 0.3 + Math.sin(ang) * sp,
        r: 1 + Math.random() * 2.2 * power,
        hue: 20 + Math.random() * 40                       // 橙红-金黄
      });
    }
    state.fx.push({
      type: 'explode',
      x: b.x, y: b.y,
      age: 0, life: 0.9,                                   // 秒
      ringMax: 26 + b.radius * 4,                          // 冲击波最大半径
      parts: parts
    });
    state.shake = Math.max(state.shake, 6 + power * 3);    // 撞击屏震
  }

  // 吸入（黑洞吞噬 / 黑洞坍缩）：紫色漩涡，粒子螺旋向中心收拢
  function spawnCapture(b) {
    const power = Math.max(1, Math.cbrt(b.mass));
    const baseR = (b.radius || 12) + 14;
    const n = Math.min(30, Math.round(12 + power * 6));
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push({
        ang: Math.random() * Math.PI * 2,
        r: baseR * (0.4 + Math.random() * 0.8),
        vr: -(30 + Math.random() * 70),                    // 向内收
        spin: (3 + Math.random() * 4) * (Math.random() < 0.5 ? 1 : -1),
        hue: 265 + Math.random() * 35                       // 紫
      });
    }
    state.fx.push({
      type: 'capture',
      x: b.x, y: b.y, baseR: baseR,
      age: 0, life: 0.8,
      parts: parts
    });
  }

  // 离开画面边界（安全化解）：青蓝柔和环扩散 + 轻盈漂浮雾点
  function spawnEscape(b) {
    const power = Math.max(1, Math.cbrt(b.mass));
    const n = Math.min(22, Math.round(8 + power * 4));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 15 + Math.random() * 45;
      parts.push({
        x: b.x, y: b.y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        r: 1 + Math.random() * 2,
        hue: 180 + Math.random() * 30                       // 青蓝
      });
    }
    state.fx.push({
      type: 'escape',
      x: b.x, y: b.y,
      age: 0, life: 0.8,
      parts: parts
    });
  }

  function updateFx(dt) {
    for (const e of state.fx) {
      e.age += dt;
      if (e.type === 'capture') {
        // 吸入：粒子半径向内收、角度旋转（螺旋）
        for (const p of e.parts) { p.r += p.vr * dt; p.ang += p.spin * dt; }
      } else {
        // 撞毁 / 离开：粒子按速度惯性漂移 + 阻尼
        for (const p of e.parts) {
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.vx *= 0.96; p.vy *= 0.96;
        }
      }
    }
    state.fx = state.fx.filter(e => e.age < e.life);
    // 飘字：向上飘并淡出
    for (const f of state.floaters) f.age += dt;
    state.floaters = state.floaters.filter(f => f.age < f.life);
  }

  // 飘字得分：在 (x,y) 弹出一行文字（如 "+25" / "-12"），向上飘并淡出
  function addFloater(x, y, text, color) {
    state.floaters.push({ x: x, y: y, text: text, color: color, age: 0, life: 1.0 });
  }

  // ---- 每帧逻辑 ----
  function stepFrame() {
    const dtFrame = DT * STEPS;
    if (state.paused || state.gameOver) return;

    // 波次生成
    state.spawnTimer += dtFrame;
    for (const s of state.spawnList) {
      if (!s.done && s.t <= state.spawnTimer) { s.done = true; spawnMeteor(state.wave); }
    }

    // 物理推进
    for (let k = 0; k < STEPS; k++) physics.stepSystem(state.bodies, DT);

    // 触界即消失：任何非母星/非黑洞天体（含玩家放置的）一旦越过画布边缘并正向外飞出，
    // 立即消失（escape）。用"向外飞出"判定，避免刚在边缘外生成、向场内飞来的陨石被误删。
    for (const b of state.bodies) {
      if (b.isStar || b.immovable || b.dead) continue;
      const outX = b.x < 0 || b.x > W;
      const outY = b.y < 0 || b.y > H;
      if (outX || outY) {
        const movingOut = (b.x < 0 && b.vx < 0) || (b.x > W && b.vx > 0) ||
                          (b.y < 0 && b.vy < 0) || (b.y > H && b.vy > 0);
        if (movingOut) { b.escaped = true; b.dead = true; }
      }
    }

    // 黑洞存活时限：到期自动坍缩消失（限制单次放置收益，防止铺满黑洞刷分）
    for (const b of state.bodies) {
      if (b.dead || !b.immovable || b.isStar || b.lifespan <= 0) continue;
      b.age += dtFrame;
      if (b.age >= b.lifespan) {
        b.dead = true; b.expired = true;
        // 坍缩特效（吸入式漩涡，用较小质量生成，避免巨型爆炸）
        spawnCapture({ x: b.x, y: b.y, radius: b.radius, mass: 500 });
      }
    }

    // 计分 + 清理
    const survivors = [];
    let meteorsLeft = 0;
    for (const b of state.bodies) {
      if (b.dead) {
        if (b.exploded) {
          spawnExplosion(b);                                // 撞毁：橙红爆炸
          audio.play('boom');
          if (b.isMeteorite) {
            state.destroyed++; state.score += SCORE.destroy;
            addFloater(b.x, b.y, '+' + SCORE.destroy, '#ff9e5e');
          }
        }
        else if (b.captured) {
          spawnCapture(b);                                  // 吸入：紫色漩涡
          audio.play('suck');
          if (b.isMeteorite) {
            state.captured++; state.score += SCORE.capture;
            addFloater(b.x, b.y, '+' + SCORE.capture, '#b06bff');
          }
        }
        else if (b.escaped) {
          spawnEscape(b);                                   // 离开边界：青蓝淡出
          if (b.isMeteorite) {
            state.score += SCORE.escape; audio.play('flee');
            addFloater(b.x, b.y, '+' + SCORE.escape, '#7adcff');
          }
        }
        else if (b.hitStar) {
          spawnExplosion(b);                                // 撞毁：撞母星爆炸（含扣血）
          state.health -= 12; state.shake = 16;
          audio.play('hit');
          addFloater(b.x, b.y, '-12', '#ff3b3b');
          if (b.isMeteorite) state.destroyed++;             // 撞毁计数（含撞母星）
        }
        else if (b.expired) {
          spawnCapture({ x: b.x, y: b.y, radius: b.radius, mass: 500 });  // 黑洞坍缩：吸入式
        }
        continue;
      }
      if (b.isMeteorite) meteorsLeft++;
      if (!b.trail) b.trail = [];
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 30) b.trail.shift();
      survivors.push(b);
    }
    state.bodies = survivors;

    if (state.shake > 0) state.shake = Math.max(0, state.shake - dtFrame * 40);
    updateFx(dtFrame);

    // 波次完成 -> 进入下一波
    if (state.waveActive && state.spawnList.every(s => s.done) && meteorsLeft === 0) {
      state.waveActive = false;
      if (state.health > 0) state.nextWaveTimer = 2.0;
    }
    if (!state.waveActive && state.nextWaveTimer > 0) {
      state.nextWaveTimer -= dtFrame;
      if (state.nextWaveTimer <= 0) startWave(state.wave + 1);
    }

    if (state.health <= 0) {
      state.health = 0; state.gameOver = true; state.paused = true;
      // 结算：最终得分 = 得分 − 已消耗金钱（建得越多扣得越多，按实际花费比例扣除）
      state.finalScore = Math.max(0, Math.round(state.score - state.spent));
      // 战绩本地存：刷新最高分并标记新纪录
      if (state.finalScore > state.best) {
        state.best = state.finalScore;
        state.newRecord = true;
        try { localStorage.setItem('starshield_best', String(state.best)); } catch (e) {}
      }
    }
  }

  function renderFrame() {
    render.drawFrame(state.bodies, state);
    // 提示线：用"后台整系统前向 N 体模拟"预测每个星体未来轨迹（与真实积分一致，不飘忽）
    if (input && state.showHint) {
      const now = performance.now();
      if (!state.hintCache || now >= state.hintNext) {
        const res = predictor.simulateFuture(state.bodies,
          { duration: physics.PREDICT_DUR, dt: physics.PREDICT_DT });
        state.hintCache = res;                 // 整段模拟结果（paths/bodies/sampleDt）
        state.hintSampleDt = res.sampleDt;     // 预测线相邻点真实时间间隔
        state.hintNext = now + 150;   // 节流：约 150ms 重算一次（降低运算负担）
        state.hintSmooth = true;      // 标记：本帧有新预测，下一帧做插值平滑
      }
      if (!state.hintDisp) state.hintDisp = new Map();
      for (let bi = 0; bi < state.bodies.length; bi++) {
        const b = state.bodies[bi];
        if (b.dead || b.isStar || b.immovable) continue;
        const path = state.hintCache.paths[bi];
        if (!path || path.length < 2) continue;
        // 用"与预测线同一时刻同步演化"的其它天体未来位置做碰撞评估（修#1 判色失真）
        const risk = predictor.evaluateRisk(state.hintCache, bi, state.star);
        // 平滑缓冲：显示路径逐帧指数插值向新预测靠拢，消除 150ms 重算时的硬跳/闪烁
        let disp = state.hintDisp.get(b);
        if (!disp || disp.length !== risk.path.length) {
          disp = risk.path.map(p => ({ x: p.x, y: p.y }));   // 长度变化则重置（换轨迹）
        } else {
          const k = state.hintSmooth ? 0.25 : 1;             // 新预测时缓冲过渡，否则保持
          for (let i = 0; i < disp.length; i++) {
            disp[i].x += (risk.path[i].x - disp[i].x) * k;
            disp[i].y += (risk.path[i].y - disp[i].y) * k;
          }
        }
        state.hintDisp.set(b, disp);
        // dt 传真实采样间隔（= sampleDt），使"每 2 秒一段、共三段"正确（修#4）
        predictorRenderer.drawPredictionLine(disp, risk, true, state.hintSampleDt);
      }
      // 清理已不存在（死亡/移除）星体的提示缓冲，避免 hintDisp 内存只增不减（修#5）
      for (const key of Array.from(state.hintDisp.keys())) {
        if (!state.bodies.includes(key)) state.hintDisp.delete(key);
      }
      state.hintSmooth = false;
    } else if (state.hintDisp) {
      state.hintDisp = null;   // 关闭提示时清空缓冲
    }
    // 拖拽中：由 input 提供预测数据并绘制
    if (input && input.dragging && state.showPrediction) {
      const tier = TIERS[state.currentTier];
      // 黑洞：先画母星禁放圈，提示不可放置区域
      if (tier.immovable) {
        const gr = physics.RADIUS_K * Math.cbrt(tier.mass);
        const r = physics.STAR_R + gr + NO_HOLE_MARGIN;
        predictorRenderer.drawNoHoleZone(state.star.x, state.star.y, r);
      }
      const gm = tier.mass;
      predictorRenderer.drawGhost(input.sx, input.sy, gm);
      predictorRenderer.drawPredictionLine(input.path, input.risk, false, input.pathDt || physics.PREDICT_DT);
      predictorRenderer.drawDragArrow(input.sx, input.sy, input.smx, input.smy);
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    stepFrame();
    renderFrame();
  }

  function init() {
    canvas = document.getElementById('game');
    canvas.width = W; canvas.height = H;
    ctx = render.initRender(canvas);
    predictorRenderer.attach(canvas);

    // 读取本地最高分（file:// 下个别浏览器可能限制，try 兜底）
    try { state.best = parseInt(localStorage.getItem('starshield_best') || '0', 10) || 0; }
    catch (e) { state.best = 0; }

    // 母星仅用 isStar 锚定（stepSystem 会跳过母星的位置/速度更新）；
    // 不可加 immovable，否则碰撞会被当成"黑洞吞噬"而只给分、不扣血。
    star = physics.createBody(physics.STAR_MASS, W / 2, H / 2, 0, 0,
                              { isStar: true });
    star.radius = physics.STAR_R;
    state.star = star;
    state.bodies.push(star);

    startWave(1);
    requestAnimationFrame(loop);
  }

  return { init, state, TIERS, W, H, NO_HOLE_MARGIN, SCORE };
})();

// 入口（脚本置于 body 末尾，DOM 已就绪）
game.init();
