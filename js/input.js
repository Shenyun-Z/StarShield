(function () {
  'use strict';

  const canvas = document.getElementById('game');
  const stars = [];           // 布防预览
  let placing = false;
  let dragStart = null;
  let previewSeq = 0;         // 预览代次：用于让过期的定时器失效（避免误清新拖拽）
  let hoverPoint = null;      // 最近一次指针位置（道具放置预览用）
  let activePointerId = null; // 当前拖拽所属指针（多点触控下防止串扰，并为指针捕获提供 id）

  // 选择状态
  let selMode = 'survival';
  let selLevelIndex = 0;
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

  // 关卡星点（P1-A）：已得星为实心暖金，未得为空心占位
  function starDots(n) {
    let html = '';
    for (let i = 0; i < 3; i++) {
      html += (i < n) ? '<span class="st on">★</span>' : '<span class="st">☆</span>';
    }
    return html;
  }

  // ===== 菜单：关卡卡片渲染 =====
  function renderLevelCards() {
    const wrap = document.getElementById('levelCards');
    const titleEl = document.getElementById('levelTitle');
    if (!wrap) return;
    const levels = game.getLevelsForMode(selMode);
    wrap.innerHTML = '';
    if (selMode === 'campaign') {
      titleEl.textContent = `闯关关卡（${levels.length} 关 · 已通关 ${game.getCampaignUnlocked()} 关`
        + ` · 总星数 ${game.getTotalStars()}/${game.totalStarsMax()}）`;
    } else if (selMode === 'challenge') {
      titleEl.textContent = `挑战关卡（${levels.length} 关 · 已通关 ${game.getChallengeUnlocked()} 关`
        + ` · 挑战星数 ${game.getChallengeStarsTotal()}/${game.totalStarsMax()}）`;
    } else if (selMode === 'daily') {
      const d = game.getDailyState();
      titleEl.textContent = `每日挑战（${d.key} · 每日一变 · 当日最高 ${d.bestScore} 分`
        + (d.cleared ? ' · 今日已通关' : '') + '）';
    } else if (selMode === 'endless') {
      titleEl.textContent = '无尽模式（无限波次 · 比拼最高波数）';
    } else {
      titleEl.textContent = '关卡（生存共用）';
    }
    const chapters = (game.CHAPTERS && game.CHAPTERS.length) ? game.CHAPTERS : [];
    levels.forEach((lv, idx) => {
      // 章节分组标题（P2）：在该章第一关之前插入一行（含该章星数完成度）
      if (selMode === 'campaign' || selMode === 'challenge') {
        const ch = chapters.filter(c => c.from === idx)[0];
        if (ch) {
          let stars = 0;
          for (let k = ch.from; k <= ch.to; k++) stars += game.starsForLevel(k);
          const maxStars = (ch.to - ch.from + 1) * 3;
          const head = document.createElement('div');
          head.className = 'chapter-head';
          head.innerHTML = `<span class="ch-title">${ch.title}</span>`
            + `<span class="ch-sub">${ch.subtitle}</span>`
            + `<span class="ch-stars">★ ${stars}/${maxStars}</span>`;
          wrap.appendChild(head);
        }
      }
      const locked = (selMode === 'campaign' && !game.isLevelUnlocked(idx))
        || (selMode === 'challenge' && !game.isChallengeUnlocked(idx));
      const el = document.createElement('button');
      el.className = 'level-card'
        + (idx === selLevelIndex && !locked ? ' selected' : '')
        + (locked ? ' locked' : '');
      el.dataset.idx = idx;
      const totalWaves = Array.isArray(lv.waves) ? lv.waves.length : null;
      // 徽标展示本关规模：闯关=波数，生存=限时秒数
      // （曾显示 scene 的黑洞/恒星数量，但那些天体并不生成，属误导，已移除）
      const badge = totalWaves != null ? (totalWaves + ' 波') : (Math.round(lv.duration || 0) + 's');
      // 星级行（P1-A / v1.10 挑战星）：仅闯关与挑战且已解锁时显示；必须独立成 div，
      // 不能塞进 lc-desc（其内容被测试正则要求为"不含标签的纯文本"）。
      const starRow = (selMode === 'campaign' || selMode === 'challenge')
        ? `<div class="lc-stars">${starDots(selMode === 'challenge' ? game.challengeStarsForLevel(idx) : game.starsForLevel(idx))}</div>`
        : '';
      // 挑战修饰符标签（v1.10）：逐条列出，玩家一眼看到本关的额外限制
      let modsRow = '';
      const modIds = (selMode === 'challenge' && typeof game.challengeModifiersFor === 'function')
        ? game.challengeModifiersFor(idx) : [];
      if (modIds.length) {
        const names = modIds.map(id => {
          const d = (game.MODIFIERS || []).filter(m => m.id === id)[0];
          return d ? d.name : id;
        });
        modsRow = `<div class="lc-mods">${names.map(n => '<span class="mod-chip">' + n + '</span>').join('')}</div>`;
      }
      // 显示实际生效的初始星能（挑战的「星能减半」会让卡片数字与实战一致，避免文案误导）
      const halfBudget = modIds.indexOf('halfBudget') >= 0;
      const shownBudget = halfBudget ? Math.round(lv.budget * 0.5) : lv.budget;
      const budgetNote = halfBudget ? '（减半）' : '';
      // 额外任务徽章（v1.10）：只判不罚的附加目标；已达成点亮
      let taskRow = '';
      if (lv.task && (selMode === 'campaign' || selMode === 'challenge' || selMode === 'daily')) {
        const done = (typeof game.isTaskDone === 'function') ? game.isTaskDone(selMode, idx) : false;
        taskRow = `<div class="lc-task${done ? ' done' : ''}">${done ? '✦ 任务已完成' : '✦ 任务'}：${lv.task.text}</div>`;
      }
      // 本关最佳记录（v1.10）：有记录才显示，避免空态噪声
      let recRow = '';
      const rec = (typeof game.getRecord === 'function') ? game.getRecord(selMode, idx) : null;
      if (rec) {
        recRow = `<div class="lc-record">最佳 ${rec.bestScore} 分 · 最少受击 ${rec.leastHits}`
          + (rec.fastestWin > 0 ? ' · 最快 ' + rec.fastestWin + 's' : '') + '</div>';
      }
      // 未解锁原因：挑战模式看挑战进度；第四章另需累计星星达标
      let lockMsg = '通关前一关后开启';
      if (selMode === 'challenge') lockMsg = '通关挑战模式前一关后开启';
      else if (idx >= 30 && game.getTotalStars() < game.getCh4StarGate()) {
        lockMsg = `累计星星需达 ${game.getCh4StarGate()}（当前 ${game.getTotalStars()}）`;
      }
      el.innerHTML = locked
        ? `
          <div class="lc-name">${idx + 1} 关 · 未解锁<span class="badge">🔒</span></div>
          <div class="lc-desc">${lockMsg}</div>
        `
        : `
          <div class="lc-name">${lv.name}<span class="badge">${badge}</span></div>
          ${starRow}
          ${modsRow}
          <div class="lc-desc">${lv.intro || lv.desc || ''}</div>
          <div class="lc-meta">血 ${lv.health} · 星能 ${shownBudget}${budgetNote}${lv.difficulty != null ? ' · 难度 ' + Number(lv.difficulty).toFixed(2) : ''}</div>
          ${taskRow}
          ${recRow}
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
    } else if (selMode === 'challenge') {
      btn.textContent = '开始 · 挑战模式';
      const mods = (typeof game.challengeModifiersFor === 'function') ? game.challengeModifiersFor(selLevelIndex) : [];
      hint.textContent = `${lv.name} · ${mods.length} 项修饰符 · ${lv.health} 血 · ${lv.budget} 星能`;
    } else if (selMode === 'daily') {
      btn.textContent = '开始 · 每日挑战';
      const d = game.getDailyState();
      hint.textContent = `${lv.name} · 今日${d.cleared ? '已通关' : '未通关'}`
        + ` · 当日最高 ${d.bestScore} 分 / ${d.bestWave} 波`;
    } else if (selMode === 'endless') {
      btn.textContent = '开始 · 无尽模式';
      hint.textContent = `${lv.name} · 无限波次 · 比拼最高波数`;
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
    const e = (typeof game.getBestWaves === 'function') ? game.getBestWaves() : 0;
    const ch = (typeof game.getChallengeUnlocked === 'function') ? game.getChallengeUnlocked() : 0;
    const tdone = (typeof game.getTasksDoneCount === 'function') ? game.getTasksDoneCount() : 0;
    el.innerHTML = `本机记录：生存最佳 ${s > 0 ? s + ' 分' : '—'}　|　闯关已通关 ${c > 0 ? c + ' 关' : '0 关'}`
      + `　|　无尽最高 ${e > 0 ? e + ' 波' : '—'}`
      + `　|　总星数 ${game.getTotalStars()}/${game.totalStarsMax()}`
      + `　|　挑战已通关 ${ch} 关　|　额外任务 ${tdone} 项`;
    // 每日挑战卡片的当日状态（跨日自动刷新，读的是本机日期派生的进度）
    const dailyBest = document.getElementById('dailyBest');
    if (dailyBest && typeof game.getDailyState === 'function') {
      const d = game.getDailyState();
      const txt = d.cleared ? ('今日已通关 · 最高 ' + d.bestScore + ' 分')
        : (d.bestScore > 0 ? ('今日最高 ' + d.bestScore + ' 分') : '今日未挑战');
      if (dailyBest.textContent !== txt) dailyBest.textContent = txt;
    }
    // 存档异常提示（M7）：菜单遮罩层级高于 .message 轻提示，故直接渲染进菜单区域
    if (typeof game.takeWarning === 'function') {
      const w = game.takeWarning();
      if (w) {
        const tip = document.createElement('div');
        tip.className = 'menu-warn';
        tip.textContent = '⚠ ' + w;
        el.appendChild(tip);
      }
    }
    renderAchievements();
  }

  // ===== 成就面板（P1-C）=====
  // 用 innerHTML 一次性渲染（避免 createElement 顺序影响既有测试对"首个创建节点"的检查）
  function renderAchievements() {
    const list = document.getElementById('achieveList');
    const title = document.getElementById('achieveTitle');
    const btn = document.getElementById('achieveToggle');
    if (!list || typeof game.getAchievementList !== 'function') return;
    const items = game.getAchievementList();
    const done = items.filter(i => i.unlocked).length;
    if (title) title.textContent = `成就（${done}/${items.length}）`;
    list.innerHTML = items.map(i =>
      `<div class="achieve-item${i.unlocked ? ' unlocked' : ''}">`
      + `<span class="ai-name">${i.unlocked ? '★ ' : '☆ '}${i.name}</span>`
      + `<span class="ai-desc">${i.desc}</span>`
      + `</div>`
    ).join('');
    if (btn) btn.textContent = (list.style.display === 'none') ? '展开成就' : '收起成就';
  }
  // 展开/收起：只用 class 与 style，避免 classList.toggle（测试 stub 无该方法）
  function bindAchievements() {
    const btn = document.getElementById('achieveToggle');
    const list = document.getElementById('achieveList');
    if (!btn || !list) return;
    btn.addEventListener('click', () => {
      const showing = list.style.display !== 'none';
      list.style.display = showing ? 'none' : '';
      btn.textContent = showing ? '展开成就' : '收起成就';
    });
  }

  // ===== 菜单：唯一开始按钮 =====
  function bindStartButton() {
    const btn = document.getElementById('startBtn');
    btn.addEventListener('click', () => {
      audio.unlock();
      game.startGame({ mode: selMode, levelIndex: selLevelIndex });
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

  // ===== 控制条状态同步（P0-1 / P0-2 / P0-3）=====
  // 主循环每帧调用：全部带脏检查（textContent / classList 写入都会触发样式重算）。
  const uiCache = Object.create(null);
  const uiEls = Object.create(null);
  function ui(id) {
    if (!uiEls[id]) uiEls[id] = document.getElementById(id);
    return uiEls[id];
  }
  function setBtnText(btn, txt) {
    if (!btn) return;
    if (btn.textContent === txt) return;
    btn.textContent = txt;
  }
  function setBtnClass(btn, name, on, cacheKey) {
    if (!btn || !btn.classList) return;
    if (uiCache[cacheKey] === on) return;
    uiCache[cacheKey] = on;
    if (on) btn.classList.add(name); else btn.classList.remove(name);
  }
  function syncControlButtons() {
    const st = game.state;
    // 减速额度（P0-1）：正常态显示剩余秒数、减速中显示小数、低额度转琥珀、耗尽提示
    const slowBtn = ui('slowBtn');
    if (slowBtn && typeof game.slowMotionState === 'function') {
      const sm = game.slowMotionState();
      const slowed = st.timeScale < 1;
      const txt = sm.disabled
        ? '时间：禁用（本关无减速）'
        : (sm.exhausted
            ? '时间：正常 · 已耗尽'
            : (slowed ? '时间：减速 · ' + sm.quota.toFixed(1) + 's'
                      : '时间：正常 · ' + Math.ceil(sm.quota) + 's'));
      setBtnText(slowBtn, txt);
      setBtnClass(slowBtn, 'low', sm.low && !sm.exhausted, 'slowLow');
      setBtnClass(slowBtn, 'exhausted', sm.exhausted, 'slowExhausted');
    }
    // 撤销（P0-2）：无可用历史时置灰
    const undoBtn = ui('undoBtn');
    if (undoBtn && typeof game.canUndo === 'function') {
      const can = game.canUndo();
      const dis = !can.ok;
      if (uiCache.undoDisabled !== dis) {
        uiCache.undoDisabled = dis;
        undoBtn.disabled = dis;
      }
    }
    // 预警（P0-3）/ 预测线（P0-4 持久化）：开关态写回按钮
    const warnBtn = ui('warnBtn');
    setBtnText(warnBtn, '预警：' + (st.showWarnings ? '开' : '关'));
    setBtnClass(warnBtn, 'on', !!st.showWarnings, 'warnOn');
    setBtnText(ui('hintBtn'), '预测：' + (st.showHint ? '开' : '关'));
  }
  // 撤销最近放置：成功/失败都给轻提示（P0-2）
  function doUndo() {
    const st = game.state;
    if (!st.gameStarted || st.gameOver) return;
    const r = game.undoLastPlacement();
    if (r && r.ok) flashMessage('已撤销放置，返还 ' + r.refund + ' 星能');
    else flashMessage((r && r.reason) || '无法撤销');
    syncControlButtons();
  }

  // ===== 下一波来袭预告（v1.10）=====
  // 只在"模式/关卡/波次变化的那一帧"重算并重绘（脏检查键含三者），
  // 避免主循环每帧遍历波次数组与写 DOM。
  function syncWavePreview() {
    const st = game.state;
    const key = (st.gameStarted && !st.gameOver && typeof game.getWavePreview === 'function')
      ? (st.mode + ':' + st.levelIndex + ':' + st.wave)
      : 'off';
    if (uiCache.wpKey === key) return;
    uiCache.wpKey = key;
    const box = ui('wavePreview');
    const body = ui('wavePreviewBody');
    if (!box || !body) return;
    const pv = (typeof game.getWavePreview === 'function') ? game.getWavePreview() : null;
    if (!pv || !pv.available) {
      if (box.style.display !== 'none') box.style.display = 'none';
      return;
    }
    const cls = 'hud-group preview-group' + (pv.boss ? ' boss' : '');
    if (box.className !== cls) box.className = cls;
    if (box.style.display !== '') box.style.display = '';
    let html = '';
    if (pv.boss) html += '<span class="wp-item"><span class="wp-dot boss"></span>BOSS</span>';
    for (let i = 0; i < pv.counts.length; i++) {
      const c = pv.counts[i];
      if (c.kind === 'boss') continue;             // BOSS 已前置展示，避免重复
      html += '<span class="wp-item"><span class="wp-dot ' + c.kind + '"></span>' + c.name + ' ×' + c.count + '</span>';
    }
    if (pv.sides.length) html += '<span class="wp-side">' + pv.sides.join('/') + '</span>';
    html += '<span class="wp-total">' + pv.waveNo + '/' + pv.total + '</span>';
    if (body.innerHTML !== html) body.innerHTML = html;
  }

  // ===== 星体操作面板（P1-B）=====
  // 逐帧同步选中态与升级/回收数值：全部脏检查，避免主循环内的无谓 DOM 写入。
  function setBpText(el, txt) {
    if (el && el.textContent !== txt) el.textContent = txt;
  }
  function syncBodyPanel() {
    const panel = ui('bodyPanel');
    const sel = game.state.selectedBody;
    // 选中目标可能已被吸收/吞噬/回收 → 立即失效，避免面板指向离场天体
    const alive = !!(sel && game.state.gameStarted && !game.state.gameOver
      && game.state.bodies.indexOf(sel) >= 0);
    if (!alive && sel) game.clearSelection();
    if (panel) {
      const show = alive ? '' : 'none';
      if (panel.style.display !== show) panel.style.display = show;
    }
    if (!alive) return;
    const info = game.getBodyActionInfo(sel);
    if (!info) {
      if (panel) panel.style.display = 'none';
      return;
    }
    setBpText(ui('bpName'), '已选：' + info.name);
    setBpText(ui('bpUpgrade'), info.upgradeName
      ? ('升级 → ' + info.upgradeName + '（-' + info.upgradeDelta + '）')
      : ('升级（' + info.upgradeReason + '）'));
    setBpText(ui('bpRecycle'), '回收（+' + info.refund + '）');
    const up = ui('bpUpgrade');
    if (up && up.disabled !== !info.canUpgrade) up.disabled = !info.canUpgrade;
  }
  // ===== 一次性道具（P2）=====
  // 激活流程：点击道具槽选中 → 在画布上点击释放（与放置星体、点选星体互斥）→ Esc 取消
  let selProp = null;
  function propNameOf(id) {
    const list = (typeof game.getProps === 'function') ? game.getProps() : [];
    const hit = list.filter(p => p.id === id)[0];
    return hit ? hit.name : id;
  }
  function syncPropBar() {
    const bar = ui('propBar');
    if (!bar || typeof game.getProps !== 'function') return;
    const list = game.getProps();
    for (const p of list) {
      const cnt = ui('propCount-' + p.id);
      if (cnt) {
        const txt = String(p.count);
        if (cnt.textContent !== txt) cnt.textContent = txt;
      }
      const el = document.getElementById('prop-' + p.id);
      if (el) {
        if (el.disabled !== (p.count <= 0)) el.disabled = (p.count <= 0);
        const on = (selProp === p.id);
        if (uiCache['propOn-' + p.id] !== on) {
          uiCache['propOn-' + p.id] = on;
          if (on) el.classList.add('active'); else el.classList.remove('active');
        }
      }
    }
  }
  function bindPropBar() {
    const bar = document.getElementById('propBar');
    if (!bar) return;
    const opts = (bar.querySelectorAll ? bar.querySelectorAll('.prop-opt') : []);
    if (!opts || !opts.forEach) return;
    opts.forEach(o => o.addEventListener('click', () => {
      const id = o.dataset ? o.dataset.prop : null;
      if (!id) return;
      const count = (game.state.props && game.state.props[id]) || 0;
      if (count <= 0) { flashMessage('「' + propNameOf(id) + '」已用完'); return; }
      selProp = (selProp === id) ? null : id;
      game.clearSelection();                 // 道具与星体选中互斥
      flashMessage(selProp ? ('已选中「' + propNameOf(id) + '」：点击画布释放') : '已取消道具');
      syncPropBar();
    }));
  }

  // ===== Boss 分段血条（P2）=====
  function syncBossBar() {
    const bar = ui('bossBar');
    const segs = ui('bbSegs');
    if (!bar || !segs) return;
    const st = game.state;
    let boss = null;
    if (st.gameStarted && !st.gameOver) {
      for (let i = 0; i < st.bodies.length; i++) {
        if (st.bodies[i].type === 'boss') { boss = st.bodies[i]; break; }
      }
    }
    const total = boss ? Math.max(1, Math.min(6, boss.hpMax || 1)) : 0;
    const left = boss ? Math.max(0, Math.min(total, boss.hp || 0)) : 0;
    const key = total + ':' + left;
    if (uiCache.bossKey === key) return;     // 脏检查：段数不变则不写 DOM
    uiCache.bossKey = key;
    if (!boss) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    let html = '';
    for (let i = 0; i < total; i++) {
      html += '<span class="bb-seg' + (i < left ? ' on' : '') + '"></span>';
    }
    segs.innerHTML = html;
  }

  // 操作面板按钮：升级 / 回收 / 关闭（P1-B）
  function bindBodyPanel() {
    const up = document.getElementById('bpUpgrade');
    const rc = document.getElementById('bpRecycle');
    const cl = document.getElementById('bpClose');
    if (up) up.addEventListener('click', () => {
      const sel = game.state.selectedBody;
      if (!sel) return;
      const r = game.upgradeBody(sel);
      if (r && r.ok) { flashMessage('已升级，消耗 ' + r.delta + ' 星能'); audio.play('place'); }
      else flashMessage((r && r.reason) || '无法升级');
      syncBodyPanel();
    });
    if (rc) rc.addEventListener('click', () => {
      const sel = game.state.selectedBody;
      if (!sel) return;
      const r = game.recycleBody(sel);
      if (r && r.ok) flashMessage('已回收，返还 ' + r.refund + ' 星能');
      else flashMessage((r && r.reason) || '无法回收');
      syncBodyPanel();
    });
    if (cl) cl.addEventListener('click', () => { game.clearSelection(); syncBodyPanel(); });
  }

  // ===== 控制按钮 =====
  function bindControls() {
    const slowBtn = document.getElementById('slowBtn');
    const undoBtn = document.getElementById('undoBtn');
    const warnBtn = document.getElementById('warnBtn');
    const audioBtn = document.getElementById('audioBtn');
    const hintBtn = document.getElementById('hintBtn');
    const restartBtn = document.getElementById('restartBtn');
    const menuBtn = document.getElementById('menuBtn');
    const clearBtn = document.getElementById('clearBtn');

    // 时间减速（P0-1）：唯一入口是 game.toggleSlowMotion()，由 game 判定额度；
    // input 不再直接写 state.timeScale（避免出现"额度未扣、倍率已变"的分叉）。
    slowBtn.addEventListener('click', () => {
      const r = game.toggleSlowMotion();
      if (r && !r.ok && r.reason) flashMessage(r.reason);
      syncControlButtons();
    });
    // 撤销最近放置（P0-2）
    if (undoBtn) undoBtn.addEventListener('click', doUndo);
    // 撞母星预警开关（P0-3）：与提示线独立，状态持久化（P0-4）
    if (warnBtn) {
      warnBtn.addEventListener('click', () => {
        const next = !game.state.showWarnings;
        game.setSetting('showWarnings', next);
        syncControlButtons();
        flashMessage(next ? '撞母星预警：开' : '撞母星预警：关');
      });
    }
    audioBtn.addEventListener('click', () => {
      const on = !audio.isEnabled();
      audio.setEnabled(on);
      audioBtn.textContent = '音效：' + (on ? '开' : '关');
    });
    // 预测线开关：状态持久化（P0-4）
    hintBtn.addEventListener('click', () => {
      game.setSetting('showHint', !game.state.showHint);
      syncControlButtons();
    });
    restartBtn.addEventListener('click', () => {
      if (restartBtn.dataset.armed === '1') {
        // 再来一局：同一关卡重启（从零布防）
        game.startGame({
          mode: game.state.mode,
          levelIndex: game.state.levelIndex,
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
    // 重置选择状态：回到生存模式第 0 关
    selMode = 'survival';
    selLevelIndex = 0;
    document.querySelectorAll('.mode-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.mode === selMode);
    });
    renderLevelCards();
    renderCtaHint();
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
    if (clicked && selProp) {
      const r = game.useProp(selProp, p);
      if (r && r.ok) {
        flashMessage(r.reason ? r.reason : ('已释放「' + propNameOf(selProp) + '」'));
        if (((game.state.props || {})[selProp] || 0) <= 0) selProp = null;
      } else {
        flashMessage((r && r.reason) || '无法使用道具');
      }
      syncPropBar();
      return;
    }
    if (clicked && typeof game.selectBodyAt === 'function') {
      const hit = game.selectBodyAt(p);
      if (hit && hit.ok) {
        audio.play('place');
        syncBodyPanel();
        return;                       // 选中不消耗星能、不放置新星体
      }
    }
    const res = game.placeStar(selStarType, p, { vx, vy });
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

  // ===== 结算面板 =====
  function showResult(reason) {
    const s = game.getCurrentRunStats();
    // 固定波次模式（闯关/挑战/每日）在标题、文案、波次行上口径一致
    const fixedWave = (s.mode === 'campaign' || s.mode === 'challenge' || s.mode === 'daily');
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
      } else if (fixedWave) {
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
        sub.textContent = fixedWave
          ? `${s.levelName} · 已击退全部 ${s.totalWaves || 0} 波，本关目标达成！`
          : `${s.levelName} · 成功撑过全部 ${s.totalWaves || 0} 波`;
      } else if (reason === 'timeup') {
        sub.textContent = `${s.levelName} · 存活 ${s.duration || 0}s，时间到达成目标`;
      } else {
        sub.textContent = fixedWave
          ? `${s.levelName} · 母星被摧毁，止步于第 ${s.wave || 0} 波（共 ${s.totalWaves || 0} 波）`
          : `${s.levelName} · 母星生命归零，共撑过 ${s.wave || 0} 波`;
      }
    }
    // 星级评价（P1-A）：仅闯关模式展示；通关给星（只增不减已在 game 侧落盘）
    const starsBox = document.getElementById('resultStars');
    if (starsBox) {
      if (s.mode === 'campaign' || s.mode === 'challenge') {
        const idx = Number.isFinite(s.levelIndex) ? s.levelIndex : 0;
        const crit = game.getStarCriteria(idx);
        const earned = game.computeStars({
          mode: s.mode, endReason: s.endReason,
          hitCount: s.hits, totalWaves: s.totalWaves || crit.totalWaves,
        });
        // 挑战星与闯关星各自独立（挑战星不并入闯关总星数）
        const best = (s.mode === 'challenge')
          ? game.challengeStarsForLevel(idx)
          : game.starsForLevel(idx);
        starsBox.style.display = '';
        const starRow = document.getElementById('rsStarRow');
        if (starRow) {
          let html = '';
          for (let i = 0; i < 3; i++) {
            // .pop 触发射入动画（CSS 动画，非 classList.toggle）
            html += (i < earned) ? '<span class="rs-star on pop">★</span>' : '<span class="rs-star">☆</span>';
          }
          starRow.innerHTML = html;
        }
        const starNote = document.getElementById('rsStarNote');
        if (starNote) {
          starNote.textContent = earned > 0
            ? `本次受击 ${s.hits || 0} 次 · ★★ 门槛 ≤ ${crit.star2HitLimit} 次 · ★★★ 需零受击　|　本关最佳 ${best}/3`
            : `未通关本关，本次未获星（★1 需击退全部 ${crit.totalWaves} 波）　|　本关最佳 ${best}/3`;
        }
      } else {
        starsBox.style.display = 'none';
      }
    }

    // 本次新解锁的成就（P1-C）：队列一次性取走，避免重复提示
    const achBox = document.getElementById('resultAchieve');
    if (achBox) {
      const news = (typeof game.takeNewAchievements === 'function') ? game.takeNewAchievements() : [];
      if (news && news.length) {
        achBox.style.display = '';
        achBox.innerHTML = news.map(a => `<div class="ra-item">🏆 成就解锁 · ${a.name} —— ${a.desc}</div>`).join('');
        audio.play('place');
      } else {
        achBox.style.display = 'none';
        achBox.innerHTML = '';
      }
    }

    // 结算面板「下一关」按钮：仅闯关模式通关时显示（解锁下一关后直接可玩）
    // 额外任务结果（v1.10，只判不罚）：达成显示暖金，未达成显示灰色文案
    const taskBox = document.getElementById('resultTask');
    if (taskBox) {
      const t = game.state.lastTask;
      if (t && t.id) {
        taskBox.className = 'result-task' + (t.done ? ' done' : '');
        taskBox.textContent = t.done
          ? ('✦ 额外任务达成：' + t.text + (t.already ? '（此前已完成）' : ''))
          : ('✦ 额外任务未达成：' + t.text);
        taskBox.style.display = '';
      } else {
        taskBox.style.display = 'none';
        taskBox.textContent = '';
      }
    }
    // 本关最佳记录对比（v1.10）：新纪录高亮提示
    const recBox = document.getElementById('resultRecord');
    if (recBox) {
      const lr = game.state.lastRecord;
      if (lr && lr.record) {
        const r = lr.record;
        const tags = [];
        if (lr.newBest.first) tags.push('首次记录');
        else {
          if (lr.newBest.score) tags.push('最高分');
          if (lr.newBest.leastHits) tags.push('最少受击');
          if (lr.newBest.fastestWin) tags.push('最快通关');
        }
        recBox.className = 'result-record' + (tags.length ? ' new' : '');
        recBox.textContent = '纪录：最佳 ' + r.bestScore + ' 分 · 最少受击 ' + r.leastHits
          + (r.fastestWin > 0 ? ' · 最快 ' + r.fastestWin + 's' : '')
          + (tags.length ? '　★ ' + tags.join(' / ') : '')
          // 每日挑战额外展示"当日"口径（跨日会重置，与关卡最佳记录不是同一件事）
          + ((game.state.lastDaily && game.state.lastDaily.state)
              ? ('　|　今日最佳 ' + game.state.lastDaily.state.bestScore + ' 分 / '
                 + game.state.lastDaily.state.bestWave + ' 波')
              : '');
        recBox.style.display = '';
      } else {
        recBox.style.display = 'none';
        recBox.textContent = '';
      }
    }
    // 结算面板「下一关」按钮：闯关/挑战通关且下一关已解锁时可继续
    const nextBtn = document.getElementById('resultNext');
    if (nextBtn) {
      const canNext = reason === 'win' && (s.mode === 'campaign' || s.mode === 'challenge');
      nextBtn.style.display = canNext ? '' : 'none';
    }
    // 固定波次模式与无尽显示"撑过波次"（无尽模式下它是核心成绩），生存模式隐藏
    if (rsWavesItem) {
      rsWavesItem.style.display = (fixedWave || s.mode === 'endless') ? '' : 'none';
    }
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
  // （关卡卡片也要一起刷新：本局可能产生了新纪录、完成了额外任务、推进了挑战进度）
  window.__refreshMenuBest = function () {
    renderMenuBest();
    renderLevelCards();
  };
  function bindResultActions() {
    document.getElementById('resultRetry').addEventListener('click', () => {
      game.startGame({
        mode: game.state.mode,
        levelIndex: game.state.levelIndex,
      });
    });
    document.getElementById('resultMenu').addEventListener('click', () => {
      game.backToMenu();
    });
    // 结算面板「下一关」：闯关模式通关后直接进入下一关（已解锁）
    const nextBtn = document.getElementById('resultNext');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        const mode = game.state.mode;
        const nextIdx = game.state.levelIndex + 1;
        if (mode === 'challenge') {
          if (game.isChallengeUnlocked(nextIdx)) {
            game.startGame({ mode: 'challenge', levelIndex: nextIdx });
          } else {
            flashMessage('请先通关挑战模式当前关以解锁下一关');
          }
          return;
        }
        if (mode !== 'campaign') return;
        if (game.isLevelUnlocked(nextIdx)) {
          game.startGame({ mode: 'campaign', levelIndex: nextIdx });
        } else if (nextIdx >= 30) {
          flashMessage('第四章还需累计星星达 ' + game.getCh4StarGate() + '（当前 ' + game.getTotalStars() + '）');
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
      syncControlButtons();
      syncBodyPanel();
      syncPropBar();
      syncBossBar();
      syncWavePreview();
      // 道具放置预览：把"激活道具 + 指针位置"暴露给渲染层（只读，不参与任何判定）
      window.__activeProp = (selProp && hoverPoint)
        ? { id: selProp, x: hoverPoint.x, y: hoverPoint.y }
        : null;
      if (typeof game.takeNotice === 'function') {
        const notice = game.takeNotice();
        if (notice) flashMessage(notice);
      }
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
    bindModeCards();
    renderLevelCards();
    renderCtaHint();
    renderMenuBest();
    bindStartButton();
    bindStarBar();
    bindControls();
    bindResultActions();
    bindMenuClear();
    bindAchievements();
    bindBodyPanel();
    bindPropBar();
    // Z 键撤销（P0-2）、Esc 取消选中与道具激活（P1-B / P2）：与按钮同源，避免两套判定逻辑
    window.addEventListener('keydown', (e) => {
      if (!e || !game.state.gameStarted || game.state.gameOver) return;
      const k = String(e.key || '').toLowerCase();
      if (k === 'z') doUndo();
      else if (k === 'escape' || k === 'esc') {
        game.clearSelection();
        selProp = null;
        syncBodyPanel();
        syncPropBar();
      }
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
    loop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();