// js/ui/menu.js —— 菜单：模式卡 / 关卡卡 / 开始按钮 / 清除进度（v1.13 从 input.js 拆出）
// 依赖 game 数据层 / document / audio，以及 input.js 暴露的 UI.flashMessage、UI.setLabel、UI.doClearProgress。
(function () {
  'use strict';
  const UI = window.SSUI || (window.SSUI = {});

  // ===== 菜单：模式选择 =====
  function bindModeCards() {
    const cards = document.querySelectorAll('.mode-card');
    cards.forEach(c => c.addEventListener('click', () => {
      cards.forEach(x => x.classList.remove('selected'));
      c.classList.add('selected');
      UI.selMode = c.dataset.mode;
      // 切换关卡池时默认选中第 0 关
      UI.selLevelIndex = 0;
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
    const levels = game.getLevelsForMode(UI.selMode);
    wrap.innerHTML = '';
    if (UI.selMode === 'campaign') {
      titleEl.textContent = `闯关关卡（${levels.length} 关 · 已通关 ${game.getCampaignUnlocked()} 关`
        + ` · 总星数 ${game.getTotalStars()}/${game.totalStarsMax()}）`;
    } else if (UI.selMode === 'challenge') {
      titleEl.textContent = `挑战关卡（${levels.length} 关 · 已通关 ${game.getChallengeUnlocked()} 关`
        + ` · 挑战星数 ${game.getChallengeStarsTotal()}/${game.totalStarsMax()}）`;
    } else if (UI.selMode === 'daily') {
      const d = game.getDailyState();
      titleEl.textContent = `每日挑战（${d.key} · 每日一变 · 当日最高 ${d.bestScore} 分`
        + (d.cleared ? ' · 今日已通关' : '') + '）';
    } else if (UI.selMode === 'endless') {
      titleEl.textContent = '无尽模式（无限波次 · 比拼最高波数）';
    } else {
      titleEl.textContent = '关卡（生存共用）';
    }
    const chapters = (game.CHAPTERS && game.CHAPTERS.length) ? game.CHAPTERS : [];
    levels.forEach((lv, idx) => {
      // 章节分组标题（P2）：在该章第一关之前插入一行（含该章星数完成度）
      if (UI.selMode === 'campaign' || UI.selMode === 'challenge') {
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
      // 隐藏关分组（v1.11）：自成一组、不计星，显示解锁进度
      if (UI.selMode === 'campaign' && lv.hidden && (idx === 0 || !levels[idx - 1].hidden)) {
        const hiddenLevels = levels.filter(l => l.hidden);
        let done = 0;
        for (let k = 0; k < hiddenLevels.length; k++) {
          const realIdx = levels.indexOf(hiddenLevels[k]);
          if (game.isHiddenUnlocked(realIdx)) done++;
        }
        const head = document.createElement('div');
        head.className = 'chapter-head hidden-head';
        head.innerHTML = `<span class="ch-title">隐藏关</span>`
          + `<span class="ch-sub">特殊规则挑战关 · 不计星</span>`
          + `<span class="ch-stars">已解锁 ${done}/${hiddenLevels.length}</span>`;
        wrap.appendChild(head);
      }
      const locked = (UI.selMode === 'campaign' && !game.isLevelUnlocked(idx))
        || (UI.selMode === 'challenge' && !game.isChallengeUnlocked(idx));
      const el = document.createElement('button');
      el.className = 'level-card'
        + (idx === UI.selLevelIndex && !locked ? ' selected' : '')
        + (locked ? ' locked' : '')
        + (UI.selMode === 'campaign' && lv.hidden ? ' hidden-level' : '');
      el.dataset.idx = idx;
      const totalWaves = Array.isArray(lv.waves) ? lv.waves.length : null;
      // 徽标展示本关规模：闯关=波数，生存=限时秒数
      // （曾显示 scene 的黑洞/恒星数量，但那些天体并不生成，属误导，已移除）
      const badge = totalWaves != null ? (totalWaves + ' 波') : (Math.round(lv.duration || 0) + 's');
      // 星级行（P1-A / v1.10 挑战星）：仅闯关与挑战且已解锁时显示；必须独立成 div，
      // 不能塞进 lc-desc（其内容被测试正则要求为"不含标签的纯文本"）。
      const starRow = (UI.selMode === 'campaign' || UI.selMode === 'challenge')
        ? `<div class="lc-stars">${starDots(UI.selMode === 'challenge' ? game.challengeStarsForLevel(idx) : game.starsForLevel(idx))}</div>`
        : '';
      // 挑战修饰符标签（v1.10）：逐条列出，玩家一眼看到本关的额外限制
      let modsRow = '';
      let modIds = (UI.selMode === 'challenge') ? game.challengeModifiersFor(idx) : [];
      // 隐藏关自带特殊规则（与挑战模式的修饰符同源机制）
      if (UI.selMode === 'campaign' && lv.hidden && Array.isArray(lv.modifiers)) modIds = lv.modifiers.slice();
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
      if (lv.task && (UI.selMode === 'campaign' || UI.selMode === 'challenge' || UI.selMode === 'daily')) {
        const done = game.isTaskDone(UI.selMode, idx);
        taskRow = `<div class="lc-task${done ? ' done' : ''}">`
          + `<svg class="ic ic-xs"><use href="#${done ? 'ic-check' : 'ic-target'}"/></svg>`
          + `${done ? '任务已完成' : '任务'}：${lv.task.text}</div>`;
      }
      // 本关最佳记录（v1.10）：有记录才显示，避免空态噪声
      let recRow = '';
      const rec = game.getRecord(UI.selMode, idx);
      if (rec) {
        recRow = `<div class="lc-record">最佳 ${rec.bestScore} 分 · 最少受击 ${rec.leastHits}`
          + (rec.fastestWin > 0 ? ' · 最快 ' + rec.fastestWin + 's' : '') + '</div>';
      }
      // 未解锁原因：挑战模式看挑战进度；第四章另需累计星星达标
      let lockMsg = '通关前一关后开启';
      let unlockRow = '';
      if (UI.selMode === 'campaign' && lv.hidden) {
        const hu = game.getHiddenUnlockInfo(idx);
        lockMsg = hu ? ('未解锁 · ' + hu.label) : '未解锁 · 需满足解锁条件';
        unlockRow = hu ? `<div class="lc-unlock">${hu.ok ? '已解锁' : '解锁条件：' + hu.label}</div>` : '';
      } else if (UI.selMode === 'challenge') lockMsg = '通关挑战模式前一关后开启';
      else if (idx >= 30 && game.getTotalStars() < game.getCh4StarGate()) {
        lockMsg = `累计星星需达 ${game.getCh4StarGate()}（当前 ${game.getTotalStars()}）`;
      }
      el.innerHTML = locked
        ? `
          <div class="lc-name">${idx + 1} 关 · 未解锁<span class="badge"><svg class="ic ic-xs"><use href="#ic-lock"/></svg></span></div>
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
          ${unlockRow}
        `;
      el.addEventListener('click', () => {
        if (locked) {
          UI.flashMessage('请先通关前一关');
          return;
        }
        UI.selLevelIndex = idx;
        renderLevelCards();
        renderCtaHint();
      });
      wrap.appendChild(el);
    });
  }

  function renderCtaHint() {
    const hint = document.getElementById('ctaHint');
    const btn = document.getElementById('startBtn');
    const lv = game.getLevelsForMode(UI.selMode)[UI.selLevelIndex];
    if (!lv) {
      // 关卡列表为空（异常兜底）：禁用开始，避免读取 undefined 崩溃
      if (btn) { btn.disabled = true; btn.textContent = '暂无可玩关卡'; }
      if (hint) hint.textContent = '关卡配置加载失败，请刷新页面重试';
      return;
    }
    if (btn) btn.disabled = false;
    if (UI.selMode === 'campaign') {
      btn.textContent = '开始 · 闯关模式';
      hint.textContent = `${lv.name} · ${lv.health} 血 · ${lv.budget} 星能`;
    } else if (UI.selMode === 'challenge') {
      btn.textContent = '开始 · 挑战模式';
      const mods = game.challengeModifiersFor(UI.selLevelIndex);
      hint.textContent = `${lv.name} · ${mods.length} 项修饰符 · ${lv.health} 血 · ${lv.budget} 星能`;
    } else if (UI.selMode === 'daily') {
      btn.textContent = '开始 · 每日挑战';
      const d = game.getDailyState();
      hint.textContent = `${lv.name} · 今日${d.cleared ? '已通关' : '未通关'}`
        + ` · 当日最高 ${d.bestScore} 分 / ${d.bestWave} 波`;
    } else if (UI.selMode === 'endless') {
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
    const e = game.getBestWaves();
    const ch = game.getChallengeUnlocked();
    const tdone = game.getTasksDoneCount();
    el.innerHTML = `本机记录：生存最佳 ${s > 0 ? s + ' 分' : '—'}　|　闯关已通关 ${c > 0 ? c + ' 关' : '0 关'}`
      + `　|　无尽最高 ${e > 0 ? e + ' 波' : '—'}`
      + `　|　总星数 ${game.getTotalStars()}/${game.totalStarsMax()}`
      + `　|　挑战已通关 ${ch} 关　|　额外任务 ${tdone} 项`;
    // 每日挑战卡片的当日状态（跨日自动刷新，读的是本机日期派生的进度）
    const dailyBest = document.getElementById('dailyBest');
    if (dailyBest) {
      const d = game.getDailyState();
      const txt = d.cleared ? ('今日已通关 · 最高 ' + d.bestScore + ' 分')
        : (d.bestScore > 0 ? ('今日最高 ' + d.bestScore + ' 分') : '今日未挑战');
      if (dailyBest.textContent !== txt) dailyBest.textContent = txt;
    }
    // 存档异常提示（M7）：菜单遮罩层级高于 .message 轻提示，故直接渲染进菜单区域
    const w = game.takeWarning();
    if (w) {
      const tip = document.createElement('div');
      tip.className = 'menu-warn';
      tip.textContent = '⚠ ' + w;
      el.appendChild(tip);
    }
    UI.renderAchievements();
    UI.renderCollection();
  }


  // ===== 菜单：唯一开始按钮 =====
  function bindStartButton() {
    const btn = document.getElementById('startBtn');
    btn.addEventListener('click', () => {
      audio.unlock();
      game.startGame({ mode: UI.selMode, levelIndex: UI.selLevelIndex });
    });
  }

  // 暴露给 game 模块：用于「再来一局」/「重新开始」时同步菜单高亮与关卡卡片
  window.__syncMenuSelection = function (mode, levelIndex) {
    if (mode === UI.selMode && levelIndex === UI.selLevelIndex) return;
    UI.selMode = mode;
    UI.selLevelIndex = levelIndex || 0;
    // 同步模式卡片高亮（只用 add/remove：测试 stub 的 classList 没有 toggle）
    document.querySelectorAll('.mode-card').forEach(c => {
      if (c.dataset.mode === UI.selMode) c.classList.add('selected'); else c.classList.remove('selected');
    });
    renderLevelCards();
    renderCtaHint();
  };



  // 暴露给 game 模块：用于返回菜单时刷新最佳战绩显示
  // （关卡卡片也要一起刷新：本局可能产生了新纪录、完成了额外任务、推进了挑战进度）
  window.__refreshMenuBest = function () {
    renderMenuBest();
    renderLevelCards();
  };

  // 菜单「一键清除进度」（二次确认）
  function bindMenuClear() {
    const btn = document.getElementById('menuClearProg');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (btn.dataset.armed === '1') {
        UI.doClearProgress();
        btn.dataset.armed = '0';
        UI.setLabel('menuClearLabel', '一键清除进度');
        return;
      }
      btn.dataset.armed = '1';
      UI.setLabel('menuClearLabel', '确认清除全部？');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.dataset.armed = '0';
        UI.setLabel('menuClearLabel', '一键清除进度');
      }, 3000);
    });
  }

  // 挂载到共享命名空间，供 input.js 装配
  UI.bindModeCards = bindModeCards;
  UI.renderLevelCards = renderLevelCards;
  UI.renderCtaHint = renderCtaHint;
  UI.renderMenuBest = renderMenuBest;
  UI.bindStartButton = bindStartButton;
  UI.bindMenuClear = bindMenuClear;
})();
