(function () {
  'use strict';

  const canvas = document.getElementById('game');
  const stars = [];           // 布防预览
  let placing = false;
  let dragStart = null;

  // 选择状态
  let selMode = 'survival';
  let selLevelIndex = 0;
  let keepSetup = false;
  let selStarType = 'large';

  // ===== 工具 =====
  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left), y: (e.clientY - r.top) };
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function flashMessage(txt) {
    const banner = document.getElementById('message');
    if (!banner) return;
    banner.textContent = txt;
    banner.classList.add('show');
    clearTimeout(flashMessage._t);
    flashMessage._t = setTimeout(() => banner.classList.remove('show'), 900);
  }
  function currentRadius() {
    const def = (game.STAR_TYPES && game.STAR_TYPES[selStarType]) || { radius: 17 };
    return def.radius;
  }

  // 母星禁放区（与 game.js 同源）—— 通过 game.canPlaceAt 复用单一权威判定
  function isInsideForbidden(p) {
    // 反向：用于「点击落空」时早返回
    return !game.canPlaceAt(p);
  }

  // ===== 菜单：模式选择 =====
  function bindModeCards() {
    const cards = document.querySelectorAll('.mode-card');
    cards.forEach(c => c.addEventListener('click', () => {
      cards.forEach(x => x.classList.remove('selected'));
      c.classList.add('selected');
      selMode = c.dataset.mode;
      // 切换关卡池时默认选中第 0 关
      selLevelIndex = 0;
      renderLevelCards();
      renderCtaHint();
    }));
  }

  // ===== 菜单：关卡卡片渲染 =====
  function renderLevelCards() {
    const wrap = document.getElementById('levelCards');
    const titleEl = document.getElementById('levelTitle');
    if (!wrap) return;
    const levels = game.getLevelsForMode(selMode);
    wrap.innerHTML = '';
    if (selMode === 'campaign') {
      titleEl.textContent = `闯关关卡（${levels.length} 关 · 已通关 ${game.getCampaignUnlocked()} 关）`;
    } else {
      titleEl.textContent = '关卡（生存共用）';
    }
    levels.forEach((lv, idx) => {
      const locked = selMode === 'campaign' && !game.isLevelUnlocked(idx);
      const el = document.createElement('button');
      el.className = 'level-card'
        + (idx === selLevelIndex && !locked ? ' selected' : '')
        + (locked ? ' locked' : '');
      el.dataset.idx = idx;
      const bh = (lv.scene.blackholes || []).length;
      const st = (lv.scene.stars || []).length;
      el.innerHTML = locked
        ? `
          <div class="lc-name">${idx + 1} 关 · 未解锁<span class="badge">🔒</span></div>
          <div class="lc-desc">通关前一关后开启</div>
        `
        : `
          <div class="lc-name">${lv.name}<span class="badge">${bh}BH ${st}★</span></div>
          <div class="lc-desc">${lv.intro || lv.desc || ''}</div>
          <div class="lc-meta">血 ${lv.health} · 星能 ${lv.budget} · ${lv.desc || ''}</div>
        `;
      el.addEventListener('click', () => {
        if (locked) {
          flashMessage('请先通关前一关');
          return;
        }
        selLevelIndex = idx;
        renderLevelCards();
        renderCtaHint();
      });
      wrap.appendChild(el);
    });
  }

  function renderCtaHint() {
    const hint = document.getElementById('ctaHint');
    const btn = document.getElementById('startBtn');
    const lv = game.getLevelsForMode(selMode)[selLevelIndex];
    if (!lv) {
      // 关卡列表为空（异常兜底）：禁用开始，避免读取 undefined 崩溃
      if (btn) { btn.disabled = true; btn.textContent = '暂无可玩关卡'; }
      if (hint) hint.textContent = '关卡配置加载失败，请刷新页面重试';
      return;
    }
    if (btn) btn.disabled = false;
    if (selMode === 'campaign') {
      btn.textContent = '开始 · 闯关模式';
      hint.textContent = `${lv.name} · ${lv.health} 血 · ${lv.budget} 星能`;
    } else {
      btn.textContent = '开始 · 生存模式';
      hint.textContent = `${lv.name} · 无限星能 · 比拼分数`;
    }
  }

  function renderMenuBest() {
    const el = document.getElementById('menuBest');
    if (!el) return;
    const s = game.bestForMode('survival');
    const c = game.getCampaignUnlocked();
    el.innerHTML = `本机成就：生存最佳 ${s > 0 ? s + ' 分' : '—'}　|　闯关已通关 ${c > 0 ? c + ' 关' : '0 关'}`;
  }

  // ===== 菜单：开局方式 =====
  // 刷新「开局方式」显示：无存档则隐藏"沿用上次布防"并强制从零开始（供 bindSetupOptions 与 doClearProgress 共用）
  function refreshSetupOptions() {
    const fresh = document.getElementById('startFresh');
    const withS = document.getElementById('startWithSetup');
    const hint = document.getElementById('setupHint');
    if (!withS) return;
    let has = false;
    try { has = !!localStorage.getItem('starshield_setup'); } catch (e) {}
    withS.style.display = has ? '' : 'none';
    if (!has) { keepSetup = false; if (fresh) fresh.classList.add('selected'); if (withS) withS.classList.remove('selected'); }
    if (hint) hint.textContent = keepSetup
      ? '将沿用上次布防的星体位置'
      : '本次从空场开始布防';
  }
  function bindSetupOptions() {
    const fresh = document.getElementById('startFresh');
    const withS = document.getElementById('startWithSetup');
    if (!fresh || !withS) return;
    fresh.addEventListener('click', () => {
      fresh.classList.add('selected'); withS.classList.remove('selected');
      keepSetup = false; refreshSetupOptions();
    });
    withS.addEventListener('click', () => {
      withS.classList.add('selected'); fresh.classList.remove('selected');
      keepSetup = true; refreshSetupOptions();
    });
    fresh.classList.add('selected');
    refreshSetupOptions();
  }

  // ===== 菜单：唯一开始按钮 =====
  function bindStartButton() {
    const btn = document.getElementById('startBtn');
    btn.addEventListener('click', () => {
      audio.unlock();
      game.startGame({ mode: selMode, levelIndex: selLevelIndex, keepSetup });
    });
  }

  // 暴露给 game 模块：用于「再来一局」/「重新开始」时同步菜单高亮与关卡卡片
  window.__syncMenuSelection = function (mode, levelIndex) {
    if (mode === selMode && levelIndex === selLevelIndex) return;
    selMode = mode;
    selLevelIndex = levelIndex || 0;
    // 同步模式卡片高亮
    document.querySelectorAll('.mode-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.mode === selMode);
    });
    renderLevelCards();
    renderCtaHint();
  };

  // ===== 星体档位栏 =====
  function bindStarBar() {
    const bar = document.getElementById('starBar');
    if (!bar) return;
    const opts = bar.querySelectorAll('.star-opt');
    opts.forEach(o => o.addEventListener('click', () => {
      opts.forEach(x => x.classList.remove('selected'));
      o.classList.add('selected');
      selStarType = o.dataset.star;
    }));
  }

  // ===== 控制按钮 =====
  function bindControls() {
    const slowBtn = document.getElementById('slowBtn');
    const audioBtn = document.getElementById('audioBtn');
    const hintBtn = document.getElementById('hintBtn');
    const restartBtn = document.getElementById('restartBtn');
    const menuBtn = document.getElementById('menuBtn');
    const clearBtn = document.getElementById('clearBtn');

    slowBtn.addEventListener('click', () => {
      const s = game.state;
      s.timeScale = (s.timeScale === 1) ? 0.25 : 1;
      slowBtn.textContent = '时间：' + (s.timeScale === 1 ? '正常' : '减速');
    });
    audioBtn.addEventListener('click', () => {
      const on = !audio.isEnabled();
      audio.setEnabled(on);
      audioBtn.textContent = '音效：' + (on ? '开' : '关');
    });
    hintBtn.addEventListener('click', () => {
      const s = game.state;
      s.showHint = !s.showHint;
      hintBtn.textContent = '预测：' + (s.showHint ? '开' : '关');
    });
    restartBtn.addEventListener('click', () => {
      if (restartBtn.dataset.armed === '1') {
        // 再来一局：同一关卡重启
        game.startGame({
          mode: game.state.mode,
          levelIndex: game.state.levelIndex,
          keepSetup: false,
        });
        restartBtn.dataset.armed = '0';
        restartBtn.textContent = '重新开始';
        restartBtn.classList.remove('armed');
        return;
      }
      restartBtn.dataset.armed = '1';
      restartBtn.textContent = '确认重开？';
      restartBtn.classList.add('armed');
      clearTimeout(restartBtn._t);
      restartBtn._t = setTimeout(() => {
        restartBtn.dataset.armed = '0';
        restartBtn.textContent = '重新开始';
        restartBtn.classList.remove('armed');
      }, 3000);
    });
    menuBtn.addEventListener('click', () => {
      // 返回菜单（二次确认避免误触）
      if (menuBtn.dataset.armed === '1') {
        game.backToMenu();
        menuBtn.dataset.armed = '0';
        menuBtn.textContent = '返回菜单';
        return;
      }
      menuBtn.dataset.armed = '1';
      menuBtn.textContent = '确认返回？';
      clearTimeout(menuBtn._t);
      menuBtn._t = setTimeout(() => {
        menuBtn.dataset.armed = '0';
        menuBtn.textContent = '返回菜单';
      }, 3000);
    });
    // 游戏内「清除进度」（二次确认）
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (clearBtn.dataset.armed === '1') {
          doClearProgress();
          clearBtn.dataset.armed = '0';
          clearBtn.textContent = '清除进度';
          return;
        }
        clearBtn.dataset.armed = '1';
        clearBtn.textContent = '确认清除？';
        clearTimeout(clearBtn._t);
        clearBtn._t = setTimeout(() => {
          clearBtn.dataset.armed = '0';
          clearBtn.textContent = '清除进度';
        }, 3000);
      });
    }
  }

  // 一键清除全部进度：清 localStorage → 回菜单 → 刷新关卡与成就显示
  function doClearProgress() {
    game.clearAllProgress();
    game.backToMenu();
    // 重置选择状态：回到生存模式第 0 关 + 从零开始布防
    selMode = 'survival';
    selLevelIndex = 0;
    keepSetup = false;
    document.querySelectorAll('.mode-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.mode === selMode);
    });
    renderLevelCards();
    renderCtaHint();
    // 刷新「开局方式」显示（存档已清空 → 隐藏"沿用上次布防"、回"从零开始"）
    refreshSetupOptions();
    if (typeof window.__refreshMenuBest === 'function') window.__refreshMenuBest();
    flashMessage('进度已清除');
  }

  // ===== 画布布防（拖拽释放方向与速度） =====
  // 拖拽模型：按下为放置中心；指针从按下点拉开产生"投掷向量"；
  // 释放时该向量作为 vx/vy 写入星体初速（沿拖拽反方向射出）。
  // 黑空不可移动（质量巨大），但仍可拖拽设初速——会推动其周围天体。
  // 转换系数：每秒速度 px/s
  const DRAG_SPEED_SCALE = 1.6;          // 拖拽 1px ≈ 1.6 px/s 初速
  const DRAG_MAX_SPEED = 420;            // 封顶初速
  const DRAG_MIN_DISTANCE = 4;           // 小于 4 px 视为点击（零初速放置）

  function pointerDown(e) {
    if (!game.state.gameStarted || game.state.gameOver) return;
    const p = canvasPoint(e);
    if (isInsideForbidden(p)) {
      // 在禁区按下：临时显示禁区圈（不进入 placing 状态）
      stars.length = 0;
      stars.push({ x: p.x, y: p.y, radius: 0, forbidden: true });
      setTimeout(() => { stars.length = 0; }, 700);
      return;
    }
    placing = true;
    dragStart = p;
    stars.length = 0;
    stars.push({
      x: p.x, y: p.y,
      radius: currentRadius(),
      type: selStarType,
      // 拖拽向量（指针 - 起点）
      dragDx: 0, dragDy: 0,
    });
    audio.unlock();
  }
  function pointerMove(e) {
    if (!placing) return;
    const p = canvasPoint(e);
    // 预览中心 = 拖拽起点；指针只是"投掷方向指示器"
    const dx = p.x - dragStart.x;
    const dy = p.y - dragStart.y;
    const len = Math.hypot(dx, dy);
    const forbidden = isInsideForbidden(dragStart);
    // 实时计算假定初速（与 pointerUp 一致，便于预测线读取）
    let vx = 0, vy = 0;
    if (len > DRAG_MIN_DISTANCE) {
      const speed = Math.min(len * DRAG_SPEED_SCALE, DRAG_MAX_SPEED);
      const n = speed / len;
      vx = dx * n;
      vy = dy * n;
    }
    stars[0].x = dragStart.x;
    stars[0].y = dragStart.y;
    stars[0].radius = currentRadius();
    stars[0].mass = (game.STAR_TYPES && game.STAR_TYPES[selStarType] || { mass: 300 }).mass;
    stars[0].type = selStarType;
    stars[0].dragDx = dx;
    stars[0].dragDy = dy;
    stars[0].vx = vx;
    stars[0].vy = vy;
    stars[0].forbidden = forbidden;
  }
  function pointerUp(e) {
    if (!placing) return;
    placing = false;
    const p = dragStart;
    const last = stars[0];
    stars.length = 0;
    if (!p) return;
    // 计算初速（沿指针方向）
    let vx = 0, vy = 0;
    if (last) {
      const dist = Math.hypot(last.dragDx || 0, last.dragDy || 0);
      if (dist > DRAG_MIN_DISTANCE) {
        const speed = Math.min(dist * DRAG_SPEED_SCALE, DRAG_MAX_SPEED);
        const n = speed / dist;
        vx = (last.dragDx || 0) * n;
        vy = (last.dragDy || 0) * n;
      }
    }
    const res = game.placeStar(selStarType, p, { vx, vy });
    if (!res.ok) flashMessage(res.reason || '无法放置');
    else audio.play('place');
  }

  // ===== 结算面板 =====
  function showResult(reason) {
    const s = game.getCurrentRunStats();
    const title = document.getElementById('resultTitle');
    const sub = document.getElementById('resultSubtitle');
    const rsWavesItem = document.getElementById('rsWavesItem');
    // 标题随结束原因 / 模式区分
    if (title) {
      if (reason === 'win') {
        title.textContent = '通关！';
        title.style.background = '';
        title.style.webkitBackgroundClip = '';
        title.style.backgroundClip = '';
        title.style.color = '';
      } else if (reason === 'timeup') {
        title.textContent = '时间到';
        title.style.background = 'linear-gradient(90deg,#ffe28a,#ffd17a,#c89bff)';
        title.style.webkitBackgroundClip = 'text';
        title.style.backgroundClip = 'text';
        title.style.color = 'transparent';
      } else if (s.mode === 'campaign') {
        title.textContent = '防线失守';
        title.style.background = '';
        title.style.webkitBackgroundClip = '';
        title.style.backgroundClip = '';
        title.style.color = '';
      } else {
        title.textContent = '母星陨落';
        title.style.background = '';
        title.style.webkitBackgroundClip = '';
        title.style.backgroundClip = '';
        title.style.color = '';
      }
    }
    if (sub) {
      if (reason === 'win') {
        sub.textContent = s.mode === 'campaign'
          ? `${s.levelName} · 已击退全部 ${s.totalWaves || 0} 波，本关目标达成！`
          : `${s.levelName} · 成功撑过全部 ${s.totalWaves || 0} 波`;
      } else if (reason === 'timeup') {
        sub.textContent = `${s.levelName} · 存活 ${s.duration || 0}s，时间到达成目标`;
      } else {
        sub.textContent = s.mode === 'campaign'
          ? `${s.levelName} · 母星被摧毁，止步于第 ${s.wave || 0} 波（共 ${s.totalWaves || 0} 波）`
          : `${s.levelName} · 母星生命归零，共撑过 ${s.wave || 0} 波`;
      }
    }
    // 结算面板「下一关」按钮：仅闯关模式通关时显示（解锁下一关后直接可玩）
    const nextBtn = document.getElementById('resultNext');
    if (nextBtn) {
      const canNext = reason === 'win' && s.mode === 'campaign';
      nextBtn.style.display = canNext ? '' : 'none';
    }
    // 闯关/生存模式不同的统计：生存模式隐藏"撑过波次"
    if (rsWavesItem) rsWavesItem.style.display = s.mode === 'campaign' ? '' : 'none';
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('rsWaves', s.wave);
    set('rsScore', s.score);
    set('rsCleared', s.cleared);
    set('rsSpent', s.spent);
    set('rsHits', s.hits);
    // 计分明细填充
    set('rsIntercept', s.scoreIntercept);
    set('rsWaveBonus', s.scoreWaveBonus);
    set('rsSurvive', s.scoreSurvive);
    set('rsPenalty', s.scorePenalty);
    set('sdDiffMul', '×' + (s.diffMul || 1).toFixed(2));
    set('sdModeMul', '×' + (s.modeMul || 1).toFixed(2));
    // 拦截项明细：展示清除数量 + 平均 base，使"明细"可见
    const note = document.getElementById('rsInterceptNote');
    if (note) {
      const n = s.interceptCount || 0;
      note.textContent = `清除 ${n} 个 · 陨石 6+质量/8 · 彗星 12`;
    }
    // 生存模式显示"生存时长奖励"行；闯关模式隐藏该行
    const surviveRow = document.getElementById('sdSurviveRow');
    if (surviveRow) surviveRow.style.display = s.mode === 'survival' ? '' : 'none';
    document.getElementById('result').classList.remove('hidden');
  }

  // 暴露给 game 模块：用于返回菜单时刷新最佳战绩显示
  window.__refreshMenuBest = function () {
    renderMenuBest();
  };
  function bindResultActions() {
    document.getElementById('resultRetry').addEventListener('click', () => {
      game.startGame({
        mode: game.state.mode,
        levelIndex: game.state.levelIndex,
        keepSetup: false,
      });
    });
    document.getElementById('resultMenu').addEventListener('click', () => {
      game.backToMenu();
    });
    // 结算面板「下一关」：闯关模式通关后直接进入下一关（已解锁）
    const nextBtn = document.getElementById('resultNext');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        const nextIdx = game.state.levelIndex + 1;
        if (game.isLevelUnlocked(nextIdx)) {
          game.startGame({ mode: 'campaign', levelIndex: nextIdx, keepSetup: false });
        } else {
          flashMessage('请先通关当前关以解锁下一关');
        }
      });
    }
    // 结算面板「清除进度」（二次确认）
    const clearBtn = document.getElementById('resultClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (clearBtn.dataset.armed === '1') {
          doClearProgress();
          clearBtn.dataset.armed = '0';
          clearBtn.textContent = '清除进度';
          return;
        }
        clearBtn.dataset.armed = '1';
        clearBtn.textContent = '确认清除？';
        clearTimeout(clearBtn._t);
        clearBtn._t = setTimeout(() => {
          clearBtn.dataset.armed = '0';
          clearBtn.textContent = '清除进度';
        }, 3000);
      });
    }
  }

  // 菜单「一键清除进度」（二次确认）
  function bindMenuClear() {
    const btn = document.getElementById('menuClearProg');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (btn.dataset.armed === '1') {
        doClearProgress();
        btn.dataset.armed = '0';
        btn.textContent = '一键清除进度';
        return;
      }
      btn.dataset.armed = '1';
      btn.textContent = '确认清除全部？';
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.dataset.armed = '0';
        btn.textContent = '一键清除进度';
      }, 3000);
    });
  }
  window.__showResult = showResult;

  // ===== 主循环 =====
  function loop() {
    // 关键：先同步 placingStars，再 render，避免一帧延迟
    window.__placingStars = stars;
    game.stepFrame();
    render(canvas, game.state);
    game.updateHud();
    requestAnimationFrame(loop);
  }

  // ===== 初始化 =====
  function init() {
    if (typeof predictorRenderer !== 'undefined' && predictorRenderer.attach) {
      predictorRenderer.attach(canvas);
    }
    bindModeCards();
    renderLevelCards();
    renderCtaHint();
    renderMenuBest();
    bindSetupOptions();
    bindStartButton();
    bindStarBar();
    bindControls();
    bindResultActions();
    bindMenuClear();
    canvas.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    loop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();