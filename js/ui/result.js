// js/ui/result.js —— 结算面板（v1.13 从 input.js 拆出）
// 依赖 game 数据层 / document / audio，以及 input.js 暴露的 UI.flashMessage、UI.setLabel、UI.doClearProgress。
(function () {
  'use strict';
  const UI = window.SSUI || (window.SSUI = {});

  // ===== 结算面板 =====
  function showResult(reason) {
    const s = game.getCurrentRunStats();
    // 固定波次模式（闯关/挑战/每日）在标题、文案、波次行上口径一致 —— 判定复用规则层单一真源
    const fixedWave = game.isFixedWaveMode(s.mode);
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
      if (s.hidden) {
        // 隐藏关不计星：改为展示本关的特殊规则（避免出现"未记录的星级"）
        const modNames = (Array.isArray(s.modifiers) ? s.modifiers : []).map(id => {
          const d = (game.MODIFIERS || []).filter(m => m.id === id)[0];
          return d ? d.name : id;
        }).join(' · ');
        starsBox.style.display = '';
        const hRow = document.getElementById('rsStarRow');
        if (hRow) hRow.innerHTML = '';
        const hNote = document.getElementById('rsStarNote');
        if (hNote) {
          hNote.className = 'result-hidden-rule';
          hNote.textContent = '隐藏关特殊规则：' + (modNames || '无')
            + '　——　本关不计星，只记录通关与最佳成绩';
        }
      } else if (s.mode === 'campaign' || s.mode === 'challenge') {
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
          starNote.className = 'rs-star-note';   // 从隐藏关的"特殊规则"样式复位
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
      const news = game.takeNewAchievements();
      if (news.length) {
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
    // 结局文案（v1.11）：仅闯关第 40 关与两个隐藏关通关时展示（判定在 game.getRunEnding）
    const endBox = document.getElementById('resultEnding');
    if (endBox) {
      const ending = game.state.lastEnding;
      if (ending && ending.title && ending.text) {
        endBox.className = 'result-ending';
        endBox.innerHTML = '<div class="re-title">' + ending.title + '</div>'
          + '<div class="re-text">' + ending.text + '</div>';
        endBox.style.display = '';
      } else {
        endBox.style.display = 'none';
        endBox.innerHTML = '';
      }
    }
    // 结算面板「下一关」按钮（v1.12）：只依据"下一关**确实存在于本模式的关卡池里**"。
    //   · 闯关：非隐藏关（隐藏关是独立挑战关，没有"下一关"语义）且 索引+1 < 闯关池长度（42）
    //   · 挑战：索引+1 < 挑战池长度（40）→ 通关第 40 关后按钮自动消失
    // 旧实现只判模式（campaign/challenge 一律显示），于是挑战末关留下死链、隐藏关还会弹出
    // 与之无关的"第四章还需累计星星"提示。
    // 刻意**不判解锁状态**：解锁由点击分支给出提示；若在此判解锁，会在"通关但解锁进度尚未推进"
    // 的场景下误隐藏按钮（既有断言依赖该场景可见）。
    const nextBtn = document.getElementById('resultNext');
    if (nextBtn) {
      const pool = (s.mode === 'campaign' || s.mode === 'challenge') ? game.getLevelsForMode(s.mode) : [];
      const canNext = reason === 'win' && !game.isHiddenLevel(s.levelIndex)
        && (s.levelIndex + 1) < pool.length;
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
            UI.flashMessage('请先通关挑战模式当前关以解锁下一关');
          }
          return;
        }
        if (mode !== 'campaign') return;
        if (game.isLevelUnlocked(nextIdx)) {
          game.startGame({ mode: 'campaign', levelIndex: nextIdx });
        } else if (nextIdx >= game.CH4_START) {
          UI.flashMessage('第四章还需累计星星达 ' + game.getCh4StarGate() + '（当前 ' + game.getTotalStars() + '）');
        } else {
          UI.flashMessage('请先通关当前关以解锁下一关');
        }
      });
    }
    // 结算面板「清除进度」（二次确认）
    const clearBtn = document.getElementById('resultClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (clearBtn.dataset.armed === '1') {
          UI.doClearProgress();
          clearBtn.dataset.armed = '0';
          UI.setLabel('resultClearLabel', '清除进度');
          return;
        }
        clearBtn.dataset.armed = '1';
        UI.setLabel('resultClearLabel', '确认清除？');
        clearTimeout(clearBtn._t);
        clearBtn._t = setTimeout(() => {
          clearBtn.dataset.armed = '0';
          UI.setLabel('resultClearLabel', '清除进度');
        }, 3000);
      });
    }
  }

  // 暴露给 game 模块的结算入口（endGame 通过 window.__showResult 调用）
  window.__showResult = showResult;
  UI.bindResultActions = bindResultActions;
})();
