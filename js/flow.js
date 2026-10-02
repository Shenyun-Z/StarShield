// js/flow.js —— 主循环步进 / HUD 更新 / 关卡选择 API / 开始游戏（v1.13 从 game.js 拆出）
// 依赖 core.js 的常量与全局状态（解构别名）与同层其它文件经 window.SS 暴露的函数。
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    DT, MAX_SUBSTEPS, MAX_FRAME_DT, STASIS_FACTOR, WAVE_TIMEOUT,
    BLACKHOLE_FADE, SLOW_REFUND_PER_WAVE, SURVIVAL_LEVELS, CAMPAIGN_LEVELS, CHAPTERS,
    ENDLESS_LEVEL, state, clamp,
  } = SS;

  // ===== 主循环步进 =====
  // dtReal：本帧真实经过的秒数（由 input.js 的 rAF 循环传入）。
  // 内部按固定步长 DT 累加推进，返回时 state 已前进 0~MAX_SUBSTEPS 步。
  function stepFrame(dtReal) {
    if (state.gameOver || !state.gameStarted) { SS.stepAccumulator = 0; return; }
    // v1.13 暂停早退：必须放在**减速额度扣减（下面的 real 分支）之前**，
    // 否则暂停期间 slowQuota / slowUsedSeconds / stasisTime 仍会按真实时间递减。
    // SS.stepAccumulator 归零，恢复时不会把暂停时长一次性补步（无跳帧）。
    if (state.paused) { SS.stepAccumulator = 0; return; }

    // 帧率无关的固定步长推进：按真实时间累加，攒够一个 DT 才走一步。
    // 这样 60Hz / 120Hz / 掉帧下的游戏速度一致，且物理步长恒为 DT
    // （若缩放步长本身，慢动作会让物理与预测积分不一致、预测线失真）。
    // dtReal 缺省时按一帧（DT）处理，便于脚本/测试直接调用 stepFrame()。
    const real = (typeof dtReal === 'number' && Number.isFinite(dtReal) && dtReal > 0)
      ? Math.min(dtReal, MAX_FRAME_DT)
      : DT;
    // 减速额度扣减（P0-1）：按真实帧时间，且必须放在下面 `steps === 0` 提前返回之前——
    // 否则 120Hz 高刷屏上偶数帧会漏扣，额度消耗速率减半。
    // 这里只做「额度耗尽 → 降级回常速」的单向处理，不改写正常的 timeScale，
    // 保持 stepFrame 对 state.timeScale 的既有直读语义（旧调用与测试兼容）。
    if (state.timeScale < 1) {
      state.slowUsedSeconds += real;          // 成就统计（P1-C）：本局实际减速时长（真实秒）
      state.slowQuota = Math.max(0, state.slowQuota - real);
      if (state.slowQuota <= 0) {
        state.timeScale = 1;
        SS.pushNotice('减速额度已用尽，已恢复常速（每清空一波返还 ' + SLOW_REFUND_PER_WAVE + ' 秒）');
      }
    }
    // 凝滞道具（P2）：短时全局减速走独立因子，而非改写 state.timeScale——
    // 既不消耗减速额度，也不污染 slowUsedSeconds（成就判定）与玩家的减速偏好。
    const stasisFactor = state.stasisTime > 0 ? STASIS_FACTOR : 1;
    if (state.stasisTime > 0) state.stasisTime = Math.max(0, state.stasisTime - real);
    SS.stepAccumulator += real * state.timeScale * stasisFactor;
    let steps = 0;
    while (SS.stepAccumulator >= DT && steps < MAX_SUBSTEPS) {
      SS.stepAccumulator -= DT;
      steps++;
    }
    if (steps === 0) return;                       // 还没攒够一步（高刷屏上常见）
    if (SS.stepAccumulator >= DT) SS.stepAccumulator = 0; // 积压过多 → 丢弃，避免追帧雪崩
    const dtFrame = DT * steps;
    // 本局游戏时钟（P0-2）：撤销时间窗与其它"游戏内时长"统一以此为准（慢动作下按比例延长）
    state.gameTime += dtFrame;

    if (!state.waveActive) {
      state.waveTimer += dtFrame;
      if (state.waveTimer >= 0.5) SS.startWave();
    } else {
      state.spawnAccumulator += dtFrame;
      while (state.spawnAccumulator >= state.waveInterval && state.waveQueue.length > 0) {
        state.spawnAccumulator -= state.waveInterval;
        SS.spawnFromQueue();
      }
    }

    for (let k = 0; k < steps; k++) physics.stepSystem(state.bodies, DT);

    // 尾迹（彗星 / 分裂彗星 / 分裂子体）
    for (const b of state.bodies) {
      if (b.type === 'comet' || b.type === 'splitter' || b.type === 'splitChild') {
        const maxLen = b.type === 'splitChild' ? 6 : 12;
        b.trail = b.trail || [];
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > maxLen) b.trail.shift();
      }
    }

    // 碰撞 / 出界
    const planet = state.bodies[0];
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (b.anchored) continue;
      if (b.type === 'planet') continue;
      if (b.dead) continue;                   // 已被 physics 标记死亡（黑洞吞噬等）的跳过

      const dx = b.x - planet.x, dy = b.y - planet.y;
      const dist = Math.hypot(dx, dy);
      if (dist < planet.radius + b.radius) {
        // 撞上母星：仅来袭威胁扣血，玩家星体被吸收但不造成伤害（M6）
        if (physics.isThreat(b)) SS.damagePlanet(b);
        else SS.absorbByPlanet(b);
        state.bodies.splice(i, 1);
        continue;
      }

      const m = 120;
      if (b.x < -m || b.x > window.innerWidth + m || b.y < -m || b.y > window.innerHeight + m) {
        // 出界：仅「来袭威胁」计入拦截清除。
        // 玩家星体飞出边界不得分，否则可反复投掷小行星出界刷分。
        if (physics.isThreat(b)) SS.registerClear(b, 'flee');
        state.bodies.splice(i, 1);
      }
    }

    // 波次超时保护（H3）：队列已吐空、但场上仍有威胁长时间无法清场
    // （被引力拘禁在稳定轨道，既不出界也不撞母星）→ 强制收编，避免永久软锁。
    if (state.waveActive) {
      state.waveElapsed += dtFrame;
      if (state.waveQueue.length === 0 && state.waveElapsed >= WAVE_TIMEOUT) {
        SS.sweepRemainingThreats();
      }
    }

    // 波次结束判定
    if (state.waveActive && state.waveQueue.length === 0) {
      const remaining = state.bodies.filter(
        b => physics.isThreat(b)
      ).length;
      if (remaining === 0) {
        SS.clearWave();
        // 固定波次模式（闯关/挑战/每日）：最后一波清空即通关胜利
        if (SS.isFixedWaveMode() && state.isLastWave) {
          SS.endGame('win');
        }
      }
    }

    // 玩家放置的黑洞吞噬陨石（额外奖励）
    // 注：这里只计分 + 标记 dead，不播动画（统一由下方 dead 清理块调用 SS.consumeByBlackhole）
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (!physics.isThreat(b)) continue;
      if (b.anchored) continue;
      if (b.dead) continue;                   // physics.resolveCollisions 已处理过的跳过
      // 玩家黑洞（非 anchored）也走此路径
      for (let j = 0; j < state.bodies.length; j++) {
        const h = state.bodies[j];
        if (h.type !== 'blackhole') continue;
        const dxh = b.x - h.x, dyh = b.y - h.y;
        if (Math.hypot(dxh, dyh) < h.radius + b.radius) {
          SS.registerClear(b, 'blackhole');
          b.dead = true;
          b.captured = true;
          b.capturedBy = h;                   // 记录哪个黑洞
          break;
        }
      }
    }

    // 清理被 physics 标记为 dead 的天体（黑洞吞噬、互撞、撞母星等）
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (!b.dead) continue;
      // 补动画：
      if (b.hitStar) {
        // 撞上母星（physics 先标记了 dead，这里补发表现与结算）：
        // 仅来袭威胁扣血，玩家星体被吸收（M6）
        if (physics.isThreat(b)) SS.damagePlanet(b);
        else SS.absorbByPlanet(b);
      } else if (b.hitSolid) {
        // 撞上实心场景天体（伴星/引力井/障碍/脉冲源）：被撞毁。
        // 单独分支：不可走 captured（否则播紫黑洞吞噬特效并计入黑洞统计）。
        SS.starStarCollision(b, b);
      } else if (b.exploded && !b.captured) {
        // 被玩家星体/场景机关撞毁的来袭威胁：计入拦截清除并给分（method='clash'），
        // 否则撞毁 Boss 这类"必须多段摧毁"的目标将完全没有收益，与计分规则不符。
        if (physics.isThreat(b)) {
          SS.registerClear(b, 'clash');
          SS.maybeSplitThreat(b);     // 分裂彗星：被撞毁后裂成两个子体（撞母星不分裂）
        }
        // 玩家星体互撞 → 蓝色火花。一次碰撞涉及两个天体，
        // 只触发一次（physics 通过 explodedWith 记录了对手）
        if (!b._clashHandled) {
          const other = b.explodedWith;
          if (other) other._clashHandled = true;
          SS.starStarCollision(b, other || b);
        }
      } else if (b.captured) {
        // 被黑洞吞噬的分裂彗星同样分裂（黑洞吞噬属于"被拦截"）
        if (physics.isThreat(b)) SS.maybeSplitThreat(b);
        // 被黑洞吞：优先使用 capturedBy，找不到则最近黑洞
        let bh = b.capturedBy;
        if (!bh || bh.dead) {
          let nd = Infinity;
          for (let k = 0; k < state.bodies.length; k++) {
            const h = state.bodies[k];
            if (h.type !== 'blackhole') continue;
            const d = Math.hypot(b.x - h.x, b.y - h.y);
            if (d < nd) { nd = d; bh = h; }
          }
        }
        if (bh) SS.consumeByBlackhole(b, bh);
      }
      state.bodies.splice(i, 1);
    }

    // Boss 受击表现：physics 在扣段时写入 hpDrop，这里消费后清零（不重复播放）
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (!b.hpDrop) continue;
      b.hpDrop = 0;
      SS.spawnShockwave(b.x, b.y, (b.radius || 20) + 90, 'rgba(240,200,255,0.85)', 0.35);
      SS.spawnExplosion(b.x, b.y, '#e0b0ff', 16);
      state.shake = Math.max(state.shake, 8);
      state.planetPunch = Math.max(state.planetPunch, 0);
      audio.play('bossHit');
    }

    // 脉冲源开火反馈：physics 每发一次脉冲累加 pulseFired，这里消费并播放一次音效
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (!b.pulseFired) continue;
      b.pulseFired = 0;
      SS.spawnShockwave(b.x, b.y, (b.radius || 16) + 120, 'rgba(200,155,255,0.5)', 0.35);
      audio.play('pulse');
    }

    // 粒子
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.x += p.vx * dtFrame;
      p.y += p.vy * dtFrame;
      p.life -= dtFrame;
      if (p.life <= 0) state.particles.splice(i, 1);
    }

    // 冲击波环扩散 + 渐隐
    for (let i = state.shockwaves.length - 1; i >= 0; i--) {
      const s = state.shockwaves[i];
      const t = 1 - (s.life / s.maxLife);
      s.radius = s.radius + (s.maxRadius - s.radius) * 0.12 + 4;   // 平滑扩张
      s.life -= dtFrame;
      if (s.life <= 0) state.shockwaves.splice(i, 1);
    }
    // 屏闪渐弱
    for (let i = state.flashes.length - 1; i >= 0; i--) {
      state.flashes[i].life -= dtFrame;
      if (state.flashes[i].life <= 0) state.flashes.splice(i, 1);
    }

    // 玩家黑洞生命周期 + 消失动画（M1：统一用游戏时钟 dtFrame，而非墙钟 performance.now()）
    // 用游戏时钟后：慢动作下寿命按游戏时间消耗（不再被放大 4 倍），
    // 切后台时主循环暂停 → 寿命也暂停，不会回到页面就整批过期。
    for (let i = state.bodies.length - 1; i >= 0; i--) {
      const b = state.bodies[i];
      if (b.type !== 'blackhole') continue;
      if (!b.anchored || !Number.isFinite(b.lifeRemaining)) continue;   // 仅玩家黑洞
      b.lifeRemaining = Math.max(0, b.lifeRemaining - dtFrame);
      // 剩余 BLACKHOLE_FADE 时进入收缩动画
      if (!b.fading && b.lifeRemaining <= BLACKHOLE_FADE) {
        b.fading = true;
        b.fadeLife = BLACKHOLE_FADE;
      }
      // fading 阶段递减 fadeLife
      if (b.fading) {
        b.fadeLife = Math.max(0, b.fadeLife - dtFrame);
      }
      // 到期 → 触发消失动画 + 移除
      if (b.lifeRemaining <= 0) {
        // 紫色冲击波 + 粒子
        SS.spawnShockwave(b.x, b.y, b.radius + 160,
                       'rgba(200,155,255,0.85)', 0.50);
        SS.spawnExplosion(b.x, b.y, '#c89bff', 22);
        SS.addFlash('rgba(170,120,255,0.25)', 0.8);
        audio.play('suck');
        state.bodies.splice(i, 1);
      }
    }
    // 母星震缩渐弱
    if (state.planetPunch > 0) state.planetPunch = Math.max(0, state.planetPunch - dtFrame * 4);

    if (state.shake > 0) state.shake = Math.max(0, state.shake - dtFrame * 40);
    if (state.healthFlash > 0) state.healthFlash = Math.max(0, state.healthFlash - dtFrame * 2);

    if (state.mode === 'survival' && !state.gameOver) {
      const sv = dtFrame * 2;
      state.scoreSurvive += sv;
      // 限时倒计时
      if (state.duration > 0) {
        state.remainingTime = Math.max(0, state.remainingTime - dtFrame);
        if (state.remainingTime <= 0) {
          SS.endGame('timeup');   // 时间到，未陨落
        }
      }
    }
  }

  // ===== HUD 更新 =====
  // HUD 每帧刷新，但绝大多数帧数值不变；用一层脏检查避免无谓的 DOM 写入
  // （textContent 写入会触发样式重算，60fps × 8 个节点是实打实的开销）。
  const hudCache = Object.create(null);
  function setText(id, txt) {
    if (hudCache[id] === txt) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = txt;
    hudCache[id] = txt;
  }
  function clearHudCache() {
    for (const k in hudCache) delete hudCache[k];
  }

  function updateHud() {
    // 游戏中才更新 HUD；菜单状态下不写 DOM，避免覆盖默认显示
    if (!state.gameStarted) return;
    if (!state.level) return;
    const set = setText;
    set('budgetVal', Math.round(state.budget));
    const waveGroup = document.getElementById('waveGroup');
    if (waveGroup) waveGroup.style.display = SS.isFixedWaveMode() ? '' : 'none';
    // 固定波次模式常驻显示「当前波/总波」，便于了解剩余波数
    if (SS.isFixedWaveMode() && state.level && Array.isArray(state.level.waves)) {
      set('waveVal', state.wave + '/' + state.level.waves.length);
    } else {
      set('waveVal', state.wave);
    }
    // 生存模式限时
    const timeGroup = document.getElementById('timeGroup');
    const timeVal = document.getElementById('timeVal');
    if (timeGroup && timeVal) {
      if (state.duration > 0) {
        timeGroup.style.display = '';
        const sec = Math.ceil(state.remainingTime);
        set('timeVal', sec + 's');
        // v1.13：告急色改用类驱动（不再写内联色值，视觉统一由 CSS token 决定）
        const timeLow = sec <= 10;
        if (hudCache.__timeLow !== timeLow) {
          hudCache.__timeLow = timeLow;
          if (timeLow) timeVal.classList.add('low'); else timeVal.classList.remove('low');
        }
      } else {
        timeGroup.style.display = 'none';
      }
    }
    // 无尽阶段胶囊（v1.11）：仅无尽模式显示「阶段 N · 距风暴 X 波」；风暴波整条转红。
    // 走 hudCache 脏检查：每帧比较 key，只有阶段/倒计时变化时才写 DOM 与 class。
    const stageGroup = document.getElementById('endlessStage');
    if (stageGroup) {
      if (state.mode === 'endless') {
        const info = SS.getEndlessStageInfo();
        if (stageGroup.style.display !== '') stageGroup.style.display = '';
        const key = info.stormNow
          ? ('storm:' + state.wave)
          : ('wave:' + state.wave + ':' + info.stageNo);
        if (hudCache.__stageKey !== key) {
          hudCache.__stageKey = key;
          if (info.stormNow) {
            stageGroup.classList.add('storm');
            set('endlessStageVal', '风暴波 · 第 ' + state.wave + ' 波');
          } else {
            stageGroup.classList.remove('storm');
            // 无尽模式的波次只在此显示（waveGroup 只在固定波次模式展开），故这里必须带上当前波数
            set('endlessStageVal', '第 ' + state.wave + ' 波 · 阶段 ' + info.stageNo
              + ' · 距风暴 ' + info.sinceStorm + ' 波');
          }
        }
      } else if (stageGroup.style.display !== 'none') {
        stageGroup.style.display = 'none';
        hudCache.__stageKey = '';
      }
    }
    // 模式标签：新增挑战/每日/无尽分支（此前只有闯关/其它两支，新模式会显示成"生存·…"）
    // v1.13：标签内含图标，故写独立文本节点 modeTagText（写 #modeTag 的 textContent 会擦掉图标）
    const MODE_TAG = { campaign: '闯关', challenge: '挑战', daily: '每日', endless: '无尽', survival: '生存' };
    set('modeTagText', (MODE_TAG[state.mode] || '生存') + '·' + state.level.name);
    // 血量：宽度与颜色都做脏检查。v1.13 起颜色状态一律走 CSS 类（设计 token 为唯一真源，
    // 不再写内联渐变/色值），低血量与受击闪烁共用 .low。
    const healthFill = document.getElementById('healthFill');
    const healthVal = document.getElementById('healthVal');
    const hpPct = clamp(state.health / (state.level.health || 1), 0, 1) * 100;
    const pctStr = hpPct.toFixed(1) + '%';
    if (hudCache.__healthPct !== pctStr) {
      hudCache.__healthPct = pctStr;
      if (healthFill) healthFill.style.width = pctStr;
    }
    const hpLow = hpPct < 30;
    const hpAlarm = hpLow || state.healthFlash > 0;
    if (hudCache.__healthAlarm !== hpAlarm) {
      hudCache.__healthAlarm = hpAlarm;
      if (healthFill) { if (hpLow) healthFill.classList.add('low'); else healthFill.classList.remove('low'); }
      if (healthVal) { if (hpAlarm) healthVal.classList.add('low'); else healthVal.classList.remove('low'); }
    }
    set('healthVal', String(state.health));
    set('scoreVal', SS.integerScore());
    set('bestVal', SS.bestDisplay());
  }

  // ===== 关卡选择 API =====
  function getLevelsForMode(mode) {
    if (mode === 'campaign') return CAMPAIGN_LEVELS;
    // 挑战模式只含 40 个常规关：隐藏关自带特殊规则（level.modifiers），
    // 与挑战模式的递增修饰符叠加会出现"卡片显示的规则 ≠ 实际生效的规则"，故不纳入挑战模式。
    if (mode === 'challenge') return SS.REGULAR_LEVELS;
    if (mode === 'daily') {
      const lvl = SS.getDailyLevel();
      return lvl ? [lvl] : [];
    }
    if (mode === 'endless') return [ENDLESS_LEVEL];
    return SURVIVAL_LEVELS;
  }

  // ===== 下一波来袭预告（v1.10，只读信息）=====
  // 索引口径与 HUD 的「当前波/总波」完全一致：state.wave 表示"已开始的波数"，
  // 因此 waves[state.wave] 就是下一波（波已清、下一波未开始的间隙里 state.wave 不变，预告不跳变）。
  // 生存/无尽没有预定义波次 → available=false（UI 隐藏该项）。
  function getWavePreview() {
    const lvl = state.level;
    const empty = { available: false, waveNo: 0, total: 0, boss: false, counts: [], sides: [], label: '' };
    if (!SS.isFixedWaveMode() || !lvl || !Array.isArray(lvl.waves)) return empty;
    const total = lvl.waves.length;
    const idx = state.wave;
    if (idx >= total) {
      return { available: false, waveNo: total, total: total, boss: false, counts: [], sides: [], label: '最终波进行中' };
    }
    const wv = lvl.waves[idx] || { spawns: [] };
    const spawns = Array.isArray(wv.spawns) ? wv.spawns : [];
    const counts = Object.create(null);
    let left = 0, right = 0, other = 0;
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[i];
      const kind = s.kind || 'asteroid';
      counts[kind] = (counts[kind] || 0) + 1;
      const e = SS.normalizeEdge(s.edge);
      if (e === 1) right++;
      else if (e === 3) left++;
      else if (e !== null) other++;
    }
    const NAMES = { asteroid: '陨石', comet: '彗星', splitter: '分裂彗星', disturber: '干扰体', boss: 'BOSS' };
    const ORDER = ['asteroid', 'comet', 'splitter', 'disturber', 'boss'];
    const list = [];
    for (let i = 0; i < ORDER.length; i++) {
      const k = ORDER[i];
      if (counts[k]) list.push({ kind: k, name: NAMES[k] || k, count: counts[k] });
    }
    const sides = [];
    if (left) sides.push('左');
    if (right) sides.push('右');
    if (!left && !right && other) sides.push('上下');
    return {
      available: true,
      waveNo: idx + 1,
      total: total,
      boss: !!wv.boss || list.some(c => c.kind === 'boss'),
      counts: list,
      sides: sides,
      label: list.map(c => c.name + ' ×' + c.count).join(' · '),
    };
  }

  // ===== 开始游戏 =====
  function startGame(opts) {
    // 允许不传或误传非对象（历史调用曾有 startGame('survival', 0) 这种顺序错误）→ 退回默认开头
    const o = (opts && typeof opts === 'object') ? opts : {};
    clearHudCache();
    SS.stepAccumulator = 0;        // 丢弃上一局残留的时间片
    // 校验一律前置：**先在局部量上判定，全部通过后才提交 state**。
    // 否则被拒绝的开局会把 state.mode / state.levelIndex 写成脏值，
    // 而后续「再来一局」等入口都从 state 读取索引 → 一局失败会连带后续开局一起失效。
    const mode = o.mode || 'survival';
    const idx = o.levelIndex || 0;
    // 解锁校验：闯关按通关进度（第四章另加累计星星门槛）；挑战模式有独立的挑战进度
    if (mode === 'campaign' && !SS.isLevelUnlocked(idx)) {
      return false;
    }
    if (mode === 'challenge' && !SS.isChallengeUnlocked(idx)) {
      return false;
    }
    const levels = getLevelsForMode(mode);
    const lvl = levels[idx];
    if (!lvl) return false;               // 关卡不存在（含越界索引）→ 拒绝开局且不留副作用
    state.mode = mode;
    state.levelIndex = idx;
    state.level = lvl;
    state.gameStarted = true;
    state.paused = false;       // v1.13：新一局必从"运行中"开始（否则上一局的暂停态会残留）
    // 每局都从零开始：场上只有母星，所有星体由玩家自行摆放（不存在预设布防）
    SS.setupLevel();

    // 同步菜单高亮（用户用「再来一局」/「重新开始」时 input 内的选择状态需对齐）
    if (typeof window.__syncMenuSelection === 'function') {
      window.__syncMenuSelection(state.mode, state.levelIndex);
    }

    // 显隐 UI
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('starBar').classList.remove('hidden');
    document.getElementById('controls').classList.remove('hidden');
    const propBarEl = document.getElementById('propBar');
    if (propBarEl) propBarEl.classList.remove('hidden');
    // 兜底：万一结算面板/message 还残留
    const msg = document.getElementById('message');
    if (msg) { msg.classList.remove('show'); msg.textContent = ''; }
    const res = document.getElementById('result');
    if (res) res.classList.add('hidden');

    // 关卡横幅：展示本关目标与结束条件，停留更久、置顶居中且不遮挡核心区域
    const banner = document.getElementById('levelBanner');
    if (banner) {
      const lvl = state.level;
      const goal = lvl.objective || lvl.desc || '';
      const fail = lvl.failCondition || '';
      // 章首关叠加一句剧情文案（极简叙事，纯文本；每日挑战不套用闯关章节的剧情）
      let story = '';
      if (state.mode === 'campaign' || state.mode === 'challenge') {
        const ch = (CHAPTERS || []).filter(c => c.from === state.levelIndex && c.story)[0];
        if (ch) story = ch.story;
      }
      // 额外任务提示（只判不罚的附加目标）
      const task = lvl.task ? lvl.task.text : '';
      // 图标统一为内联 SVG（v1.13）：与 HUD / 按钮同一套图标体系，不再混用 emoji
      banner.innerHTML =
        `<div class="lb-name">${lvl.name}</div>` +
        (story ? `<div class="lb-story">${story}</div>` : '') +
        `<div class="lb-goal"><svg class="ic ic-sm"><use href="#ic-target"/></svg>目标：${goal}</div>` +
        (task ? `<div class="lb-task"><svg class="ic ic-sm"><use href="#ic-star"/></svg>额外任务：${task}</div>` : '') +
        (fail ? `<div class="lb-fail"><svg class="ic ic-sm"><use href="#ic-alert"/></svg>失败：${fail}</div>` : '');
      banner.classList.add('show');
      clearTimeout(banner._t);
      banner._t = setTimeout(() => banner.classList.remove('show'), 3600);
    }

    // 若主循环曾因连续异常被停止，开新局时恢复（否则画面会一直不动）
    if (typeof window.__resumeLoop === 'function') {
      window.__resumeLoop();
    }
  }

  // 返回菜单
  function backToMenu() {
    state.gameStarted = false;
    state.gameOver = false;
    state.paused = false;       // v1.13：回菜单必须解除暂停（否则下次开局的暂停覆盖层会残留）
    clearHudCache();
    SS.stepAccumulator = 0;
    // 重置 controls 按钮状态（避免重开二次确认武装残留）
    // v1.13：按钮内含图标，文案写在独立 label 节点上（写按钮 textContent 会擦掉图标）
    const restartBtn = document.getElementById('restartBtn');
    if (restartBtn) {
      restartBtn.dataset.armed = '0';
      restartBtn.classList.remove('armed');
      const rl = document.getElementById('restartLabel');
      if (rl) rl.textContent = '重新开始';
    }
    const menuBtn = document.getElementById('menuBtn');
    if (menuBtn) {
      menuBtn.dataset.armed = '0';
      const ml = document.getElementById('menuLabel');
      if (ml) ml.textContent = '返回菜单';
    }
    // 清理所有动态状态
    state.shake = 0;
    state.healthFlash = 0;
    state.selectedBody = null;      // 回菜单时清空选中态，避免残留光环
    document.getElementById('menu').classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('starBar').classList.add('hidden');
    document.getElementById('controls').classList.add('hidden');
    const propBarBack = document.getElementById('propBar');
    if (propBarBack) propBarBack.classList.add('hidden');
    const res = document.getElementById('result');
    if (res) res.classList.add('hidden');
    // 通知 input 刷新最佳战绩（可能在本局中更新过）
    if (typeof window.__refreshMenuBest === 'function') {
      window.__refreshMenuBest();
    }
  }

  // 当前关卡与最佳战绩快照
  function getCurrentRunStats() {
    return {
      mode: state.mode,
      levelName: state.level ? state.level.name : '',
      wave: state.wave,
      totalWaves: (SS.isFixedWaveMode() && state.level && Array.isArray(state.level.waves)) ? state.level.waves.length : null,
      score: SS.integerScore(),
      cleared: state.asteroidsCleared,
      spent: state.totalSpent,
      hits: state.hitCount,
      difficulty: Number.isFinite(state.difficulty) ? Number(state.difficulty.toFixed(2)) : 0.3,
      waveBonus: state.lastWaveBonus,
      duration: state.duration,                    // 限时秒数（生存模式）
      endReason: state.endReason,                  // 'defeat' | 'timeup' | 'win' | null
      // 分数明细（分账展示）
      scoreIntercept: Math.round(state.scoreIntercept),
      interceptCount: state.asteroidsCleared,    // 拦截清除的威胁总数（用于结算明细）
      scoreWaveBonus: Math.round(state.scoreWaveBonus),
      scoreSurvive: Math.round(state.scoreSurvive),
      scorePenalty: Math.round(state.scorePenalty),
      // 计分权重说明参数
      diffMul: Number((1 + Math.max(0, state.difficulty - 0.3) * 1.4).toFixed(2)),
      modeMul: state.mode === 'campaign' ? Number((1 + state.levelIndex * 0.15).toFixed(2)) : 1,
      // P1 扩展字段（只增不改：既有字段名与口径保持原样，成就判定与结算展示共用）
      levelIndex: state.levelIndex,
      slowUsedSeconds: Math.round(state.slowUsedSeconds * 100) / 100,
      upgrades: state.upgrades,
      recycles: state.recycles,
      blackholeSwallowed: state.blackholeSwallowed,
      propsUsed: state.propsUsed,
      stasisTime: Math.round(state.stasisTime * 100) / 100,
      budgetLeft: Math.round(state.budget),
      stars: state.lastStars,
      totalStars: SS.getTotalStars(),
      // v1.10 扩展字段（同样只增不改）：模式扩展、额外任务判定与结算展示共用
      // levelBudget = 本局**生效后**的初始星能（已计入「星能减半」等修饰符）
      levelBudget: (Number.isFinite(state.initialBudget) && state.initialBudget > 0)
        ? state.initialBudget
        : ((state.level && Number.isFinite(state.level.budget)) ? state.level.budget : 0),
      blackholesPlaced: state.blackholesPlaced,
      gameTime: Math.round(state.gameTime),          // 本局游戏时钟（秒），结算"用时"口径
      modifiers: Array.isArray(state.modifiers) ? state.modifiers.slice() : [],
      taskId: (state.level && state.level.task) ? state.level.task.id : '',
      taskText: (state.level && state.level.task) ? state.level.task.text : '',
      challengeStars: SS.getChallengeStarsTotal(),
      tasksDone: SS.getTasksDoneCount(),
      // v1.11 扩展字段：隐藏关与专精/协同（结算面板与成就判定共用）
      hidden: SS.isHiddenLevel(),
      hiddenInfo: SS.isHiddenLevel() ? SS.getHiddenUnlockInfo(state.levelIndex) : null,
      specSwitches: state.specSwitches || 0,
      synergyMaxBonus: maxSynergyBonus(),
      // v1.11 扩展字段（只增不改）：专精 / 无尽阶段 / 结局 / 每日连胜 / 完美收集
      specGiantPlaced: state.specGiantPlaced || 0,
      endlessStage: state.endlessStage || 0,
      ending: state.lastEnding ? state.lastEnding.id : '',
      dailyStreak: SS.getDailyStreak(),
      hiddenCleared: SS.getHiddenClearedCount(),
      perfect: SS.isPerfectCollected(),
    };
  }
  // 本局场上最高的协同加成（结算/展示用；无玩家星体时为 0）
  function maxSynergyBonus() {
    let best = 0;
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (b && b.type === 'star' && Number.isFinite(b.synergyBonus) && b.synergyBonus > best) {
        best = b.synergyBonus;
      }
    }
    return Math.round(best * 1000) / 1000;
  }


  // ===== 导出到共享命名空间 =====
  SS.stepFrame = stepFrame;
  SS.hudCache = hudCache;
  SS.setText = setText;
  SS.clearHudCache = clearHudCache;
  SS.updateHud = updateHud;
  SS.getLevelsForMode = getLevelsForMode;
  SS.getWavePreview = getWavePreview;
  SS.startGame = startGame;
  SS.backToMenu = backToMenu;
  SS.getCurrentRunStats = getCurrentRunStats;
  SS.maxSynergyBonus = maxSynergyBonus;
})();
