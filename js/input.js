(function () {
  'use strict';
  const UI = window.SSUI || (window.SSUI = {});

  const canvas = document.getElementById('game');
  const stars = [];           // 布防预览
  let placing = false;
  let dragStart = null;
  let previewSeq = 0;         // 预览代次：用于让过期的定时器失效（避免误清新拖拽）
  let hoverPoint = null;      // 最近一次指针位置（道具放置预览用）
  let activePointerId = null; // 当前拖拽所属指针（多点触控下防止串扰，并为指针捕获提供 id）

  // 选择状态
  UI.selMode = 'survival';
  UI.selLevelIndex = 0;
  UI.selStarType = 'large';
  UI.selStarSpec = 'gravity';   // v1.11：当前专精（引力型 = 基准值）

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
  // 母星禁放区（与 game.js 同源）—— 通过 game.canPlaceAt 复用单一权威判定
  function isInsideForbidden(p) {
    // 反向：用于「点击落空」时早返回
    return !game.canPlaceAt(p);
  }

  // ===== 画布布防（拖拽释放方向与速度） =====
  // 拖拽模型：按下为放置中心；指针从按下点拉开产生"投掷向量"；
  // 释放时该向量作为 vx/vy 写入星体初速（沿拖拽反方向射出）。
  // 黑空不可移动（质量巨大），但仍可拖拽设初速——会推动其周围天体。
  // 转换系数：每秒速度 px/s
  const DRAG_SPEED_SCALE = 1.6;          // 拖拽 1px ≈ 1.6 px/s 初速
  const DRAG_MAX_SPEED = 420;            // 封顶初速
  const DRAG_MIN_DISTANCE = 4;           // 小于 4 px 视为点击（零初速放置）

  // 指针归属：无 pointerId 的环境（旧浏览器 / 测试桩）视为唯一指针，保持兼容
  function isActivePointer(e) {
    if (activePointerId === null) return true;
    return !!e && e.pointerId === activePointerId;
  }
  function releaseCapture() {
    if (activePointerId !== null && typeof canvas.releasePointerCapture === 'function') {
      try { canvas.releasePointerCapture(activePointerId); } catch (err) {}
    }
    activePointerId = null;
  }

  function pointerDown(e) {
    if (!game.state.gameStarted || game.state.gameOver) return;
    if (game.isPaused()) return;                               // v1.13：暂停中不允许布防
    if (e.pointerType === 'mouse' && e.button !== 0) return;   // 只响应鼠标左键
    if (placing) return;                                       // 已有拖拽进行中，忽略第二根手指
    const p = canvasPoint(e);
    if (isInsideForbidden(p)) {
      // 在禁区按下：临时显示禁区圈（不进入 placing 状态）
      stars.length = 0;
      stars.push({ x: p.x, y: p.y, radius: 0, forbidden: true });
      // 用代次号让旧定时器失效：否则用户在 700ms 内开始新拖拽时会被误清空
      const seq = ++previewSeq;
      setTimeout(() => { if (seq === previewSeq) stars.length = 0; }, 700);
      return;
    }
    placing = true;
    previewSeq++;                 // 使禁区提示的待触发清理失效
    dragStart = p;
    // 指针捕获（H4）：把后续 move/up 绑定到 canvas，避免指针在窗口外释放时
    // 收不到 pointerup 导致 placing 永久为 true（幽灵预览/持续误拖拽）。
    activePointerId = (e.pointerId != null) ? e.pointerId : null;
    if (activePointerId !== null && typeof canvas.setPointerCapture === 'function') {
      try { canvas.setPointerCapture(activePointerId); } catch (err) {}
    }
    stars.length = 0;
    const pdef = UI.currentDef();
    stars.push({
      x: p.x, y: p.y,
      radius: pdef.radius,
      mass: pdef.mass,
      baseMass: pdef.baseMass || pdef.mass,   // v1.11：预览替身必须带 baseMass（协同才生效）
      spec: pdef.spec || UI.selStarSpec,
      type: UI.selStarType,
      // 拖拽向量（指针 - 起点）
      dragDx: 0, dragDy: 0,
    });
    audio.unlock();
  }
  function pointerMove(e) {
    // 记录指针位置（道具放置预览用；只在能取到坐标时更新，避免 stub 环境缺 getBoundingClientRect 抛错）
    if (e && Number.isFinite(e.clientX) && canvas
        && typeof canvas.getBoundingClientRect === 'function') {
      hoverPoint = canvasPoint(e);
    }
    if (!placing) return;
    if (!isActivePointer(e)) return;
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
    const mdef = UI.currentDef();
    stars[0].radius = mdef.radius;
    stars[0].mass = mdef.mass;
    stars[0].baseMass = mdef.baseMass || mdef.mass;
    stars[0].spec = mdef.spec || UI.selStarSpec;
    stars[0].type = UI.selStarType;
    stars[0].dragDx = dx;
    stars[0].dragDy = dy;
    stars[0].vx = vx;
    stars[0].vy = vy;
    stars[0].forbidden = forbidden;
  }
  function pointerUp(e) {
    if (!placing) return;
    if (!isActivePointer(e)) return;
    placing = false;
    const p = dragStart;
    const last = stars[0];
    stars.length = 0;
    releaseCapture();
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
    // 点击（位移 ≤ 阈值）的三级优先级：释放道具 → 选中场上星体 → 放置新星体。
    // 拖拽（有位移）语义完全不变——H4 的指针归属断言依赖 pointerdown 始终进入拖拽预览。
    const clicked = !last || Math.hypot(last.dragDx || 0, last.dragDy || 0) <= DRAG_MIN_DISTANCE;
    if (clicked && UI.selProp) {
      const r = game.useProp(UI.selProp, p);
      if (r && r.ok) {
        flashMessage(r.reason ? r.reason : ('已释放「' + UI.propNameOf(UI.selProp) + '」'));
        if (((game.state.props || {})[UI.selProp] || 0) <= 0) UI.selProp = null;
      } else {
        flashMessage((r && r.reason) || '无法使用道具');
      }
      UI.syncPropBar();
      return;
    }
    if (clicked) {
      const hit = game.selectBodyAt(p);
      if (hit && hit.ok) {
        audio.play('place');
        UI.syncBodyPanel();
        return;                       // 选中不消耗星能、不放置新星体
      }
    }
    const res = game.placeStar(UI.selStarType, p, { vx, vy, spec: UI.selStarSpec });
    if (!res.ok) flashMessage(res.reason || '无法放置');
    else audio.play('place');
  }
  // 指针被系统取消（手势中断/设备切换/窗口失焦）：放弃本次拖拽，不放置星体。
  // 事件可选：blur 等场景无 pointerId，视为无条件取消。
  function pointerCancel(e) {
    if (!placing) return;
    if (e && !isActivePointer(e)) return;      // 非活动指针的 cancel 忽略
    placing = false;
    dragStart = null;
    previewSeq++;
    stars.length = 0;
    releaseCapture();
  }


  // ===== 暂停 / 设置（v1.13）=====
  // 暂停的唯一真源是 game.state.paused：stepFrame 顶部早退，冻结物理、gameTime、黑洞寿命、
  // 减速额度、波次计时与生存存活分。本层只负责入口、覆盖层显隐与摘要展示。
  // 两条硬约束：
  //   ① 主循环不得因暂停提前 return（robustness 的 H1 要求每帧恰好一次 rAF 调度）；
  //   ② 不改写 state.timeScale（loop-mechanics / result-actions 直读该字段判「开局即常速」）。
  UI.settingsOpen = false;

  // 按钮文案节点：二次确认类按钮内含图标，文案必须写在独立 label 上（写 textContent 会擦掉图标）
  function setLabel(id, txt) { UI.setBpText(UI.ui(id), txt); }

  function openSettings(from) {
    const el = UI.ui('settings');
    if (!el) return;
    UI.settingsOpen = true;
    if (el.dataset) el.dataset.from = (from === 'pause') ? 'pause' : 'menu';
    el.classList.remove('hidden');
    syncSettingsUI();
  }
  function closeSettings() {
    UI.settingsOpen = false;
    const el = UI.ui('settings');
    if (el) el.classList.add('hidden');
  }

  // 「减少动效」→ html[data-motion]（CSS 侧统一降级为接近瞬时；系统偏好由 @media 兜底）。
  // documentElement 在部分测试桩里不存在 → 整段 try/catch 失败静默（纯视觉偏好，绝不影响主循环）。
  function applyMotionPref(reduced) {
    try {
      const root = document && document.documentElement;
      if (root && root.dataset) root.dataset.motion = reduced ? 'reduced' : 'full';
    } catch (e) {}
  }

  // 主音量应用（audio.js 在部分测试沙箱里未加载 → typeof 守卫；失败静默，纯偏好项）
  function applyVolumePref(v) {
    if (typeof audio === 'undefined' || !audio || typeof audio.setVolume !== 'function') return;
    try { audio.setVolume(v); } catch (e) {}
  }

  // 设置行状态同步（主循环每帧调用；签名不变则零 DOM 写入）
  function syncSettingsUI() {
    const st = game.state;
    // 注意：部分测试沙箱不加载 audio.js（audio 未声明）→ 必须用 typeof 守卫，
    // 否则 init 期同步设置行会抛 ReferenceError（audio.isEnabled 的取用方式不安全）。
    const audioOn = (typeof audio !== 'undefined' && audio && typeof audio.isEnabled === 'function')
      ? !!audio.isEnabled() : true;
    const volNum = Number(st.volume);
    const volPct = Math.round(clamp01(Number.isFinite(volNum) ? volNum : 0.8) * 100);
    const sig = (st.showHint ? '1' : '0') + (st.showWarnings ? '1' : '0')
      + (audioOn ? '1' : '0') + (st.reduceMotion ? '1' : '0') + ':' + volPct;
    if (UI.uiCache.settingsSig === sig) return;
    UI.uiCache.settingsSig = sig;
    UI.setBtnClass(UI.ui('warnBtn'), 'on', !!st.showWarnings, 'warnOn');
    UI.setBtnClass(UI.ui('hintBtn'), 'on', !!st.showHint, 'hintOn');
    UI.setBtnClass(UI.ui('audioBtn'), 'on', audioOn, 'audioOn');
    UI.setBtnClass(UI.ui('motionBtn'), 'on', !!st.reduceMotion, 'motionOn');
    UI.setBpText(UI.ui('warnState'), st.showWarnings ? '开' : '关');
    UI.setBpText(UI.ui('hintState'), st.showHint ? '开' : '关');
    UI.setBpText(UI.ui('audioState'), audioOn ? '开' : '关');
    UI.setBpText(UI.ui('motionState'), st.reduceMotion ? '开' : '关');
    applyMotionPref(!!st.reduceMotion);
    // 主音量滑条：值回写只在变化时发生（拖动过程中值已一致，不会抖动）
    const range = UI.ui('volumeRange');
    if (range) {
      const v = String(volPct);
      if (range.value !== v) range.value = v;
    }
    UI.setBpText(UI.ui('volumeState'), volPct + '%');
    applyVolumePref(volPct / 100);
  }

  // 暂停覆盖层：显隐与摘要都走脏检查。暂停期间游戏态不会变化，故摘要只在「进入暂停」那一帧刷新一次
  // （避免每帧调用 getCurrentRunStats 做无谓计算）。
  function syncPauseUI() {
    const el = UI.ui('pause');
    if (!el) return;
    const on = game.isPaused();
    if (UI.uiCache.pauseOn !== on) {
      UI.uiCache.pauseOn = on;
      if (on) el.classList.remove('hidden'); else el.classList.add('hidden');
      if (!on && UI.settingsOpen) closeSettings();     // 继续游戏时收起设置面板，避免遮挡游玩区
      if (on) UI.uiCache.pauseFilled = false;          // 强制刷新一次摘要
    }
    if (!on || UI.uiCache.pauseFilled) return;
    UI.uiCache.pauseFilled = true;
    const st = game.state;
    const sm = game.slowMotionState();
    const s = game.getCurrentRunStats();
    const MODE_TAG = { campaign: '闯关', challenge: '挑战', daily: '每日', endless: '无尽', survival: '生存' };
    UI.setBpText(UI.ui('pauseSub'), (MODE_TAG[st.mode] || '生存') + ' · ' + (st.level ? st.level.name : ''));
    UI.setBpText(UI.ui('pauseWave'), (s.totalWaves > 0) ? (st.wave + '/' + s.totalWaves) : String(st.wave));
    UI.setBpText(UI.ui('pauseScore'), String(s.score));
    UI.setBpText(UI.ui('pauseCleared'), String(s.cleared));
    UI.setBpText(UI.ui('pauseSlow'), sm.disabled ? '本关禁用' : (Math.round(sm.quota * 10) / 10) + 's');
  }

  function bindPause() {
    const pauseBtn = UI.ui('pauseBtn');
    if (pauseBtn) pauseBtn.addEventListener('click', () => {
      const on = game.togglePause();
      syncPauseUI();
      flashMessage(on ? '已暂停（按 P 继续）' : '继续游戏');
    });
    const resumeBtn = UI.ui('pauseResume');
    if (resumeBtn) resumeBtn.addEventListener('click', () => {
      game.setPaused(false);
      syncPauseUI();
    });
    const psBtn = UI.ui('pauseSettingsBtn');
    if (psBtn) psBtn.addEventListener('click', () => openSettings('pause'));
    syncPauseUI();
  }

  function bindSettings() {
    const menuBtn = UI.ui('menuSettingsBtn');
    if (menuBtn) menuBtn.addEventListener('click', () => openSettings('menu'));
    const closeBtn = UI.ui('settingsClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);
    // 「减少动效」：写入设置存档（键白名单已扩展），并立即作用到 html[data-motion]
    const motionBtn = UI.ui('motionBtn');
    if (motionBtn) motionBtn.addEventListener('click', () => {
      const next = !game.state.reduceMotion;
      game.setSetting('reduceMotion', next);
      syncSettingsUI();
      flashMessage(next ? '已减少动效' : '已恢复完整动效');
    });
    // 主音量滑条：拖动即时生效（input 事件）并落盘到设置存档
    const range = UI.ui('volumeRange');
    if (range && range.addEventListener) {
      range.addEventListener('input', () => {
        const pct = Math.max(0, Math.min(100, Math.round(Number(range.value) || 0)));
        const v = pct / 100;
        game.setSetting('volume', v);
        applyVolumePref(v);
        syncSettingsUI();
        flashMessage('主音量：' + pct + '%');
      });
    }
    // 设置面板内的「清除全部进度」（与其它清除入口同一套二次确认模式）
    const sc = UI.ui('settingsClearProg');
    if (sc) sc.addEventListener('click', () => {
      if (sc.dataset.armed === '1') {
        UI.doClearProgress();
        sc.dataset.armed = '0';
        setLabel('settingsClearLabel', '清除全部进度');
        return;
      }
      sc.dataset.armed = '1';
      setLabel('settingsClearLabel', '确认清除全部？');
      clearTimeout(sc._t);
      sc._t = setTimeout(() => {
        sc.dataset.armed = '0';
        setLabel('settingsClearLabel', '清除全部进度');
      }, 3000);
    });
    // 点击遮罩空白处关闭设置面板
    const el = UI.ui('settings');
    if (el && el.addEventListener) {
      el.addEventListener('click', (e) => { if (e && e.target === el) closeSettings(); });
    }
    syncSettingsUI();
  }

  // ===== 主循环 =====
  // 用 rAF 提供的时间戳计算真实帧间隔并交给 game.stepFrame 做固定步累加，
  // 使 60Hz/120Hz/掉帧下的游戏速度一致（旧的“每帧恒推进 1/60 秒”在高刷屏上是 2 倍速）。
  //
  // 异常保护（H1）：循环体任意一环抛异常都不能让主循环死掉——否则画面永久冻结、
  // 只能刷新页面。这里用 try/catch 包裹，异常后仍继续调度下一帧（瞬时异常可自愈）；
  // 连续异常达到阈值则停止空转并给出可读提示，避免控制台刷屏 + 白耗 CPU。
  const MAX_LOOP_ERRORS = 60;      // 连续异常上限（约 1 秒）
  let loopErrorStreak = 0;
  let loopStopped = false;
  let lastFrameTs = 0;

  function showFatal(msg) {
    const el = document.getElementById('message');
    if (el) { el.textContent = msg; el.classList.add('show'); }
  }

  function loop(ts) {
    if (loopStopped) return;
    try {
      const now = (typeof ts === 'number' && Number.isFinite(ts)) ? ts : performance.now();
      const dtReal = lastFrameTs ? (now - lastFrameTs) / 1000 : 1 / 60;
      lastFrameTs = now;
      // 关键：先同步 placingStars，再 render，避免一帧延迟
      window.__placingStars = stars;
      game.stepFrame(dtReal);
      render(canvas, game.state);
      game.updateHud();
      // 控制条状态（减速额度 / 撤销可用性 / 开关态）+ 星体操作面板 + 轻提示
      UI.syncControlButtons();
      syncSettingsUI();     // v1.13：设置行状态（含「减少动效」→ html[data-motion]）
      syncPauseUI();        // v1.13：暂停覆盖层显隐与摘要（脏检查，暂停中零额外计算）
      UI.syncBodyPanel();
      UI.syncPropBar();
      UI.syncBossBar();
      UI.syncWavePreview();
      // 道具放置预览：把"激活道具 + 指针位置"暴露给渲染层（只读，不参与任何判定）
      window.__activeProp = (UI.selProp && hoverPoint)
        ? { id: UI.selProp, x: hoverPoint.x, y: hoverPoint.y }
        : null;
      const notice = game.takeNotice();
      if (notice) flashMessage(notice);
      loopErrorStreak = 0;                 // 本帧正常 → 连续异常计数清零
    } catch (err) {
      loopErrorStreak++;
      if (loopErrorStreak <= 5) {
        console.error('StarShield: 主循环异常（连续第 ' + loopErrorStreak + ' 次）', err);
      }
      if (loopErrorStreak >= MAX_LOOP_ERRORS) {
        loopStopped = true;
        console.error('StarShield: 主循环连续异常，已停止以避免空转');
        showFatal('运行异常，游戏已暂停，请刷新页面重试');
        return;                            // 不再调度，真正停止
      }
    }
    requestAnimationFrame(loop);
  }

  // ===== 初始化 =====
  let initRetried = false;
  function init() {
    // game.js 必须先于本模块执行（index.html 中位于其后）。若因脚本顺序调整
    // 导致 game 尚未就绪，等待 load 事件重试一次，避免整个界面静默失效。
    if (typeof game === 'undefined' || !game) {
      if (!initRetried) { initRetried = true; window.addEventListener('load', init); }
      else console.error('StarShield: game 模块未加载，初始化失败');
      return;
    }
    if (typeof predictorRenderer !== 'undefined' && predictorRenderer.attach) {
      predictorRenderer.attach(canvas);
    }
    UI.bindModeCards();
    UI.renderLevelCards();
    UI.renderCtaHint();
    UI.renderMenuBest();
    UI.bindStartButton();
    UI.bindStarBar();
    UI.bindControls();
    bindPause();          // v1.13：暂停（控制条按钮 + 暂停覆盖层）
    bindSettings();       // v1.13：设置面板（主菜单与暂停层共用同一实例）
    UI.bindResultActions();
    UI.bindMenuClear();
    UI.bindAchievements();
    UI.bindCollection();
    UI.bindBodyPanel();
    UI.bindPropBar();
    // 键盘：P 暂停/继续；Esc 优先级 = 关闭设置 → 取消选中星体/已选道具 → 暂停/继续；
    // Z 撤销（P0-2，暂停期间屏蔽，避免暂停中产生状态分叉）。与按钮同源，避免两套判定逻辑。
    window.addEventListener('keydown', (e) => {
      if (!e) return;
      const k = String(e.key || '').toLowerCase();
      // 设置面板在菜单态也能打开 → 关闭动作必须放在 gameStarted 守卫之前
      if (UI.settingsOpen && (k === 'escape' || k === 'esc')) { closeSettings(); return; }
      if (!game.state.gameStarted || game.state.gameOver) return;
      if (k === 'p') {
        if (UI.settingsOpen) closeSettings();      // P 是全局暂停开关：先收起设置，再切换暂停
        game.togglePause();
        syncPauseUI();
        return;
      }
      if (k === 'escape' || k === 'esc') {
        if (UI.settingsOpen) { closeSettings(); return; }
        if (game.state.selectedBody || UI.selProp) {
          game.clearSelection();
          UI.selProp = null;
          UI.syncBodyPanel();
          UI.syncPropBar();
          return;
        }
        game.setPaused(!game.isPaused());
        syncPauseUI();
        return;
      }
      if (game.isPaused()) return;        // 暂停中屏蔽其余快捷键
      if (k === 'z') UI.doUndo();
    });
    canvas.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('blur', () => pointerCancel());   // 切走窗口 → 无条件放弃本次拖拽
    // 右键菜单会打断拖拽流程，画布上禁用
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // 全局兜底：任何未捕获错误/未处理拒绝都要留下可追溯日志（不阻断主循环）
    window.addEventListener('error', (e) => {
      console.error('StarShield: 未捕获错误', (e && (e.error || e.message)) || e);
    });
    window.addEventListener('unhandledrejection', (e) => {
      console.error('StarShield: 未处理的 Promise 拒绝', e && e.reason);
    });
    // 致命停止后的恢复通道：新开一局时由 game.startGame 调用，
    // 避免"连续异常停帧后点『重新开始』仍然不动"（H1 的副作用）。
    window.__resumeLoop = function () {
      if (!loopStopped) return;
      loopStopped = false;
      loopErrorStreak = 0;
      lastFrameTs = 0;
      const el = document.getElementById('message');
      if (el) { el.textContent = ''; el.classList.remove('show'); }
      console.warn('StarShield: 主循环已恢复');
      loop();
    };
    syncSettingsUI();     // v1.13：首帧前应用「减少动效」偏好（避免进场瞬间的动效闪烁）
    loop();
  }

  // 供 UI.ui/* 模块调用的公共工具（拆分后跨文件）
  UI.flashMessage = flashMessage;
  UI.setLabel = setLabel;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();