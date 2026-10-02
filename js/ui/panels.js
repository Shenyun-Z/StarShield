// js/ui/panels.js —— 成就面板 / 星图总览（v1.13 从 input.js 拆出）
// 只依赖 game 数据层与 document；不含任何与输入/主循环共享的闭包状态。
(function () {
  'use strict';
  const UI = window.SSUI || (window.SSUI = {});

  // ===== 通用进度条（v1.13，成就 / 星图总览共用）=====
  // 纯 innerHTML 字符串，不新增 createElement（避免影响 createdEls 类名计数断言）。
  // label 左对齐、value 右对齐（等宽数字），轨道内填充宽度 = pct%（钳制 0~100）。
  function panelProgress(label, value, pct) {
    const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    return '<div class="panel-progress">'
      + '<div class="pp-head"><span class="pp-label">' + label + '</span>'
      + '<span class="pp-value">' + value + '</span></div>'
      + '<div class="pp-track"><span class="pp-fill" style="width:' + v + '%"></span></div>'
      + '</div>';
  }

  // ===== 成就面板（P1-C）=====
  // 用 innerHTML 一次性渲染（避免 createElement 顺序影响既有测试对"首个创建节点"的检查）
  // v1.13：顶部总进度条 + 按 ACHIEVEMENT_GROUPS 分区 + 组内进度 + 两列网格 + 图标徽标。
  function renderAchievements() {
    const list = document.getElementById('achieveList');
    const title = document.getElementById('achieveTitle');
    const btn = document.getElementById('achieveToggle');
    if (!list) return;
    const items = game.getAchievementList();
    const done = items.filter(i => i.unlocked).length;
    if (title) title.textContent = `成就（${done}/${items.length}）`;
    const pct = items.length ? (done / items.length) * 100 : 0;
    // 分组表：优先取数据层单一真源；缺失时退化为单组，保证任何情况下都不漏渲染。
    const groups = (game.ACHIEVEMENT_GROUPS && game.ACHIEVEMENT_GROUPS.length)
      ? game.ACHIEVEMENT_GROUPS
      : [{ id: 'meta', label: '成就', icon: 'ic-trophy' }];
    const fallback = groups[groups.length - 1].id;
    let html = panelProgress('总进度', '已解锁 ' + done + '/' + items.length + ' · '
      + Math.round(pct) + '%', pct);
    groups.forEach(g => {
      // 防御式归并：未知/缺失 group 的条目并入最后一组，避免"加了成就却看不到"。
      const bucket = items.filter(i => (i.group || fallback) === g.id);
      if (!bucket.length) return;
      const gDone = bucket.filter(i => i.unlocked).length;
      html += '<div class="achieve-group">'
        + '<div class="ag-head"><svg class="ic ic-sm"><use href="#' + g.icon + '"/></svg>'
        + '<span class="ag-title">' + g.label + '</span>'
        + '<span class="ag-count">' + gDone + '/' + bucket.length + '</span></div>'
        + '<div class="ag-grid">'
        + bucket.map(i =>
            '<div class="achieve-item' + (i.unlocked ? ' unlocked' : '') + '">'
            + '<span class="ai-badge"><svg class="ic ic-xs"><use href="#'
            + (i.unlocked ? 'ic-check' : 'ic-lock') + '"/></svg></span>'
            + '<span class="ai-name">' + i.name + '</span>'
            + '<span class="ai-desc">' + i.desc + '</span>'
            + '</div>'
          ).join('')
        + '</div>'
        + '</div>';
    });
    list.innerHTML = html;
    // v1.13：折叠按钮内含图标与箭头，文案必须写在独立 label 节点上
    // （对按钮整体写 textContent 会把图标与箭头一并擦掉）。
    setFoldState(btn, document.getElementById('achieveToggleLabel'),
      list.style.display !== 'none', '展开成就', '收起成就');
  }
  // 展开/收起：只用 class 与 style，避免 classList.toggle（测试 stub 无该方法）
  function bindAchievements() {
    const btn = document.getElementById('achieveToggle');
    const list = document.getElementById('achieveList');
    if (!btn || !list) return;
    btn.addEventListener('click', () => {
      const showing = list.style.display !== 'none';
      list.style.display = showing ? 'none' : '';
      setFoldState(btn, document.getElementById('achieveToggleLabel'),
        !showing, '展开成就', '收起成就');
    });
  }

  // ===== 星图总览面板（v1.11）=====
  // 两块：收集进度 / 统计摘要（v1.13 移除各模式历史榜单）。整体用 innerHTML 一次性拼装，
  // 与成就面板同构（避免 createElement 顺序影响既有测试，且测试 stub 的 appendChild 是 no-op）。
  function fmtDuration(sec) {
    const total = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分 ' + (total % 60) + ' 秒';
    return total + ' 秒';
  }
  // 内容块（v1.13）：标题前置内联图标（iconId 为 sprite symbol id，可为空）。
  // rows 支持数组 [label, value] 或对象 { label, value, stack }；stack=true 时取值落到第二行并弱化。
  function collectBlock(iconId, title, rows) {
    const head = '<div class="cb-title">'
      + (iconId ? '<svg class="ic ic-sm"><use href="#' + iconId + '"/></svg>' : '')
      + '<span class="cb-text">' + title + '</span></div>';
    const body = (rows || []).map(r => {
      const row = r || {};
      const label = Array.isArray(row) ? row[0] : row.label;
      const value = Array.isArray(row) ? row[1] : row.value;
      const stack = !Array.isArray(row) && row.stack;
      return '<div class="collect-row' + (stack ? ' stack' : '') + '">'
        + '<span class="cr-label">' + (label == null ? '' : label) + '</span>'
        + '<span class="cr-value">' + (value == null ? '' : value) + '</span></div>';
    }).join('');
    return '<div class="collect-block">' + head + body + '</div>';
  }
  function renderCollection() {
    const list = document.getElementById('collectList');
    const title = document.getElementById('collectTitle');
    const btn = document.getElementById('collectToggle');
    if (!list) return;
    const html = [];
    const perfect = game.isPerfectCollected();
    if (perfect) {
      const ps = game.getPerfectStory();
      if (ps) {
        html.push('<div class="collect-perfect"><div class="cp-title">★ ' + ps.title
          + '</div><div class="cp-text">' + ps.text + '</div></div>');
      }
    }

    /* --- 1) 收集进度 --- */
    const starMax = game.totalStarsMax();
    const dist = game.getStarDistribution();
    const regular = game.regularLevelCount();
    const hiddenTotal = game.countHiddenLevels();
    const hiddenCleared = game.getHiddenClearedCount();
    let hiddenUnlocked = 0;
    game.getHiddenLevels().forEach(h => { if (game.isHiddenUnlocked(h.index)) hiddenUnlocked++; });
    const ach = game.getAchievementList();
    const achDone = ach.filter(i => i.unlocked).length;
    const chStars = game.getChallengeStarsTotal();
    const chUnlocked = game.getChallengeUnlocked();
    const d = game.getDailyState();
    // 收集度（三面等权，v1.13）：星数 / 额外任务 / 隐藏关通关各自归一后取平均。
    // 与 game.isPerfectCollected()「完美星图」判定同口径 —— 仅三者全满才为 100%。
    const stars = game.getTotalStars();
    const tasksDone = game.getTasksDoneCount();
    const rStars = starMax > 0 ? stars / starMax : 0;
    const rTasks = regular > 0 ? tasksDone / regular : 0;
    const rHidden = hiddenTotal > 0 ? hiddenCleared / hiddenTotal : 1;
    const collectPct = Math.round((rStars + rTasks + rHidden) / 3 * 100);
    html.push(panelProgress('收集度', collectPct + '%', collectPct));

    const progress = [
      { label: '闯关星数', value: stars + '/' + starMax
        + (dist ? '（3★ ' + dist.three + ' · 2★ ' + dist.two + ' · 1★ ' + dist.one
          + ' · 未通关 ' + dist.none + '）' : ''), stack: true },
      { label: '额外任务', value: tasksDone + '/' + regular },
      { label: '隐藏关', value: '解锁 ' + hiddenUnlocked + '/' + hiddenTotal
        + ' · 通关 ' + hiddenCleared + '/' + hiddenTotal, stack: true },
      { label: '挑战进度', value: chUnlocked + '/' + regular + ' 关 · 挑战星 ' + chStars + '/' + starMax, stack: true },
      { label: '每日挑战', value: d ? ((d.cleared ? '今日已通关' : '今日未通关') + ' · 连胜 ' + d.streak
        + ' 天 · 累计通关 ' + d.clearedTotal + ' 天') : '—', stack: true },
      { label: '成就', value: achDone + '/' + ach.length },
    ];
    html.push(collectBlock('ic-target', '收集进度', progress));

    /* --- 2) 统计摘要 --- */
    const t = game.getStatsTotals();
    const modeNames = game.getModeNames();
    const modes = (game.STATS_MODES || []).slice();
    let totalPlays = 0, totalWins = 0;
    modes.forEach(m => { totalPlays += (t.plays[m] || 0); totalWins += (t.wins[m] || 0); });
    const summary = [
      { label: '累计游戏时长', value: fmtDuration(t.timeSec) },
      { label: '累计拦截威胁', value: String(t.intercepted) },
      { label: '累计母星受击', value: String(t.hits) },
      { label: '累计场次 / 胜场', value: totalPlays + ' / ' + totalWins
        + (totalPlays > 0 ? '（胜率 ' + Math.round(totalWins / totalPlays * 100) + '%）' : '') },
      { label: '历史最高分', value: t.bestScore > 0 ? String(t.bestScore) : '—' },
      { label: '历史最高波数', value: t.bestWaves > 0 ? t.bestWaves + ' 波' : '—' },
    ];
    modes.forEach(m => {
      const p = t.plays[m] || 0, w = t.wins[m] || 0;
      summary.push({ label: modeNames[m] || m, value: p + ' 场 · ' + w + ' 胜'
        + (p > 0 ? '（' + Math.round(w / p * 100) + '%）' : '') });
    });
    html.push(collectBlock('ic-budget', '统计摘要', summary));

    list.innerHTML = html.join('');
    if (title) title.textContent = '星图总览' + (perfect ? '（100% 已达成）' : '');
    setFoldState(btn, document.getElementById('collectToggleLabel'),
      list.style.display !== 'none', '展开总览', '收起总览');
  }
  function bindCollection() {
    const btn = document.getElementById('collectToggle');
    const list = document.getElementById('collectList');
    if (!btn || !list) return;
    btn.addEventListener('click', () => {
      const showing = list.style.display !== 'none';
      list.style.display = showing ? 'none' : '';
      setFoldState(btn, document.getElementById('collectToggleLabel'),
        !showing, '展开总览', '收起总览');
    });
  }

  // 折叠面板状态：文案写 label，展开态用 .open 驱动箭头旋转（stub 无 classList.toggle，只用 add/remove）
  function setFoldState(btn, labelEl, open, openText, closeText) {
    if (labelEl) {
      const txt = open ? closeText : openText;
      if (labelEl.textContent !== txt) labelEl.textContent = txt;
    }
    if (btn) {
      if (open) btn.classList.add('open'); else btn.classList.remove('open');
    }
  }

  // 挂载到共享命名空间，供 input.js 装配与调用
  UI.renderAchievements = renderAchievements;
  UI.renderCollection = renderCollection;
  UI.bindAchievements = bindAchievements;
  UI.bindCollection = bindCollection;
})();
