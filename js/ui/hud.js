// js/ui/hud.js —— HUD：星体档位栏 / 控制条 / 预告 / 操作面板 / 道具槽 / Boss 血条 / 控制按钮
// （v1.13 从 input.js 拆出）依赖 game 数据层 / document / audio，以及 input.js 暴露的
// UI.flashMessage、UI.setLabel、UI.syncSettingsUI；本文件还内部实现 doClearProgress 并对外导出。
(function () {
  'use strict';
  const UI = window.SSUI || (window.SSUI = {});

  // 当前档位 + 专精的派生参数（唯一口径来自 game.getStarDef，与物理/记账同源）
  function currentDef() {
    return game.getStarDef(UI.selStarType, UI.selStarSpec);
  }
  function currentRadius() { return currentDef().radius; }
  // 星体栏各档位的价格标签（v1.12）：随当前专精刷新。
  // 修复前：按钮恒显示基准价（中行星 150），而实扣按专精价（巨型 180），同屏与 #specPreview 自相矛盾。
  // 黑洞不参与专精（game.getStarDef 对 blackhole 恒返回基准成本），故同一循环即可覆盖全部档位。
  const STAR_TIER_KEYS = ['small', 'mid', 'large', 'star', 'blackhole'];
  function syncStarBarPrices() {
    for (let i = 0; i < STAR_TIER_KEYS.length; i++) {
      const key = STAR_TIER_KEYS[i];
      const el = document.getElementById('starCost-' + key);
      if (!el) continue;
      const txt = String(game.getStarDef(key, UI.selStarSpec).cost);
      if (el.textContent !== txt) el.textContent = txt;   // 先比较再赋值（与既有脏检查风格一致）
    }
  }
  // 专精选择器状态（按钮高亮 + 参数预览 + 星体栏价格）：全部用 add/remove（测试 stub 无 classList.toggle）
  function syncSpecUI() {
    const def = currentDef();
    ['gravity', 'giant'].forEach(id => {
      const btn = document.getElementById('spec-' + id);
      if (!btn) return;
      const on = (UI.selStarSpec === id);
      if (on) btn.classList.add('selected'); else btn.classList.remove('selected');
    });
    const pv = document.getElementById('specPreview');
    if (pv) {
      const txt = def.name + ' · 质量 ' + def.mass + ' · 半径 ' + def.radius + ' · ' + def.cost + ' 星能';
      if (pv.textContent !== txt) pv.textContent = txt;
    }
    syncStarBarPrices();
  }


  // ===== 星体档位栏 =====
  function bindStarBar() {
    const bar = document.getElementById('starBar');
    if (!bar) return;
    const opts = bar.querySelectorAll('.star-opt');
    opts.forEach(o => o.addEventListener('click', () => {
      opts.forEach(x => x.classList.remove('selected'));
      o.classList.add('selected');
      UI.selStarType = o.dataset.star;
      syncSpecUI();                      // 档位变化 → 刷新专精参数预览（质量/半径/价格）
    }));
    // 专精选择（v1.11）：作用于此后放置与升级的星体；黑洞不参与。
    // v1.12：改用 id 直取（与 syncSpecUI 的定位方式一致），不再依赖 querySelectorAll —
    // 后者在测试桩里恒返回空集合，会让专精按钮实际不可交互、也无法被点击链路测试覆盖。
    ['gravity', 'giant'].forEach(id => {
      const btn = document.getElementById('spec-' + id);
      if (!btn) return;
      btn.addEventListener('click', () => {
        UI.selStarSpec = id;
        syncSpecUI();
        UI.flashMessage('专精：' + currentDef().specName + '（' + currentDef().cost + ' 星能）');
      });
    });
    syncSpecUI();
  }

  // ===== 控制条状态同步（P0-1 / P0-2 / P0-3）=====
  // 主循环每帧调用：全部带脏检查（textContent / classList 写入都会触发样式重算）。
  UI.uiCache = Object.create(null);
  UI.uiEls = Object.create(null);
  function ui(id) {
    if (!UI.uiEls[id]) UI.uiEls[id] = document.getElementById(id);
    return UI.uiEls[id];
  }
  function setBtnText(btn, txt) {
    if (!btn) return;
    if (btn.textContent === txt) return;
    btn.textContent = txt;
  }
  function setBtnClass(btn, name, on, cacheKey) {
    if (!btn) return;
    if (UI.uiCache[cacheKey] === on) return;
    UI.uiCache[cacheKey] = on;
    if (on) btn.classList.add(name); else btn.classList.remove(name);
  }
  function syncControlButtons() {
    const st = game.state;
    // 减速额度（P0-1）：正常态显示剩余秒数、减速中显示小数、低额度转琥珀、耗尽提示
    const slowBtn = ui('slowBtn');
    if (slowBtn) {
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
    if (undoBtn) {
      const can = game.canUndo();
      const dis = !can.ok;
      if (UI.uiCache.undoDisabled !== dis) {
        UI.uiCache.undoDisabled = dis;
        undoBtn.disabled = dis;
      }
    }
    // 预警（P0-3）/ 预测线（P0-4 持久化）：v1.13 起这两个开关迁入设置面板。
    // 设置行内含图标与说明子节点，故不再写按钮自身 textContent（会擦掉子节点）：
    // 改为 `.on` 类驱动胶囊开关 + 独立状态节点显示「开 / 关」。
    const warnBtn = ui('warnBtn');
    setBtnClass(warnBtn, 'on', !!st.showWarnings, 'warnOn');
    setBtnClass(ui('hintBtn'), 'on', !!st.showHint, 'hintOn');
    setBpText(ui('warnState'), st.showWarnings ? '开' : '关');
    setBpText(ui('hintState'), st.showHint ? '开' : '关');
  }
  // 撤销最近放置：成功/失败都给轻提示（P0-2）
  function doUndo() {
    const st = game.state;
    if (!st.gameStarted || st.gameOver) return;
    const r = game.undoLastPlacement();
    if (r && r.ok) UI.flashMessage('已撤销放置，返还 ' + r.refund + ' 星能');
    else UI.flashMessage((r && r.reason) || '无法撤销');
    syncControlButtons();
  }

  // ===== 下一波来袭预告（v1.10）=====
  // 只在"模式/关卡/波次变化的那一帧"重算并重绘（脏检查键含三者），
  // 避免主循环每帧遍历波次数组与写 DOM。
  function syncWavePreview() {
    const st = game.state;
    const key = (st.gameStarted && !st.gameOver)
      ? (st.mode + ':' + st.levelIndex + ':' + st.wave)
      : 'off';
    if (UI.uiCache.wpKey === key) return;
    UI.uiCache.wpKey = key;
    const box = ui('wavePreview');
    const body = ui('wavePreviewBody');
    if (!box || !body) return;
    const pv = game.getWavePreview();
    if (!pv.available) {
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
    setBpText(ui('bpName'), '已选：' + info.name + (info.specName ? '（' + info.specName + '）' : ''));
    // 切换专精（v1.11）：同档互转，按差价补/退星能；黑洞无专精
    const swBtn = ui('bpSwitchSpec');
    if (swBtn) {
      setBpText(swBtn, info.switchName
        ? ('切为' + info.switchName + '（' + (info.switchDelta >= 0 ? '-' : '+') + Math.abs(info.switchDelta) + '）')
        : '切换专精');
      if (swBtn.disabled !== !info.canSwitch) swBtn.disabled = !info.canSwitch;
    }
    setBpText(ui('bpUpgrade'), info.upgradeName
      ? ('升级 → ' + info.upgradeName + '（-' + info.upgradeDelta + '）')
      : ('升级（' + info.upgradeReason + '）'));
    setBpText(ui('bpRecycle'), '回收（+' + info.refund + '）');
    const up = ui('bpUpgrade');
    if (up && up.disabled !== !info.canUpgrade) up.disabled = !info.canUpgrade;
  }
  // ===== 一次性道具（P2）=====
  // 激活流程：点击道具槽选中 → 在画布上点击释放（与放置星体、点选星体互斥）→ Esc 取消
  UI.selProp = null;
  function propNameOf(id) {
    const list = game.getProps();
    const hit = list.filter(p => p.id === id)[0];
    return hit ? hit.name : id;
  }
  function syncPropBar() {
    const bar = ui('propBar');
    if (!bar) return;
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
        const on = (UI.selProp === p.id);
        if (UI.uiCache['propOn-' + p.id] !== on) {
          UI.uiCache['propOn-' + p.id] = on;
          if (on) el.classList.add('active'); else el.classList.remove('active');
        }
      }
    }
  }
  function bindPropBar() {
    const bar = document.getElementById('propBar');
    if (!bar) return;
    const opts = bar.querySelectorAll('.prop-opt');
    opts.forEach(o => o.addEventListener('click', () => {
      const id = o.dataset.prop;
      if (!id) return;
      const count = (game.state.props && game.state.props[id]) || 0;
      if (count <= 0) { UI.flashMessage('「' + propNameOf(id) + '」已用完'); return; }
      UI.selProp = (UI.selProp === id) ? null : id;
      game.clearSelection();                 // 道具与星体选中互斥
      UI.flashMessage(UI.selProp ? ('已选中「' + propNameOf(id) + '」：点击画布释放') : '已取消道具');
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
    if (UI.uiCache.bossKey === key) return;     // 脏检查：段数不变则不写 DOM
    UI.uiCache.bossKey = key;
    if (!boss) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    let html = '';
    for (let i = 0; i < total; i++) {
      html += '<span class="bb-seg' + (i < left ? ' on' : '') + '"></span>';
    }
    segs.innerHTML = html;
  }

  // 操作面板按钮：升级 / 切换专精 / 回收 / 关闭（P1-B + v1.11）
  function bindBodyPanel() {
    const up = document.getElementById('bpUpgrade');
    const rc = document.getElementById('bpRecycle');
    const sw = document.getElementById('bpSwitchSpec');
    const cl = document.getElementById('bpClose');
    if (sw) sw.addEventListener('click', () => {
      const sel = game.state.selectedBody;
      if (!sel) return;
      const info = game.getBodyActionInfo(sel);
      const r = game.switchSpec(sel, info && info.switchName === '巨型' ? 'giant' : 'gravity');
      if (r && r.ok) {
        const sign = r.delta >= 0 ? '消耗 ' + r.delta : '退还 ' + (-r.delta);
        UI.flashMessage('已切换为「' + r.specName + '」，' + sign + ' 星能');
        audio.play('place');
      } else {
        UI.flashMessage((r && r.reason) || '无法切换专精');
      }
      syncBodyPanel();
    });
    if (up) up.addEventListener('click', () => {
      const sel = game.state.selectedBody;
      if (!sel) return;
      const r = game.upgradeBody(sel);
      if (r && r.ok) { UI.flashMessage('已升级，消耗 ' + r.delta + ' 星能'); audio.play('place'); }
      else UI.flashMessage((r && r.reason) || '无法升级');
      syncBodyPanel();
    });
    if (rc) rc.addEventListener('click', () => {
      const sel = game.state.selectedBody;
      if (!sel) return;
      const r = game.recycleBody(sel);
      if (r && r.ok) UI.flashMessage('已回收，返还 ' + r.refund + ' 星能');
      else UI.flashMessage((r && r.reason) || '无法回收');
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
      if (r && !r.ok && r.reason) UI.flashMessage(r.reason);
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
        UI.syncSettingsUI();
        UI.flashMessage(next ? '撞母星预警：开' : '撞母星预警：关');
      });
    }
    // 音效开关（持久化由 audio.js 自管；本层只同步设置行视觉状态）
    audioBtn.addEventListener('click', () => {
      const on = !audio.isEnabled();
      audio.setEnabled(on);
      UI.syncSettingsUI();
      UI.flashMessage(on ? '音效：开' : '音效：关');
    });
    // 预测线开关：状态持久化（P0-4）
    hintBtn.addEventListener('click', () => {
      game.setSetting('showHint', !game.state.showHint);
      syncControlButtons();
      UI.syncSettingsUI();
      UI.flashMessage(game.state.showHint ? '预测线：开' : '预测线：关');
    });
    restartBtn.addEventListener('click', () => {
      if (restartBtn.dataset.armed === '1') {
        // 再来一局：同一关卡重启（从零布防）
        game.startGame({
          mode: game.state.mode,
          levelIndex: game.state.levelIndex,
        });
        restartBtn.dataset.armed = '0';
        UI.setLabel('restartLabel', '重新开始');
        restartBtn.classList.remove('armed');
        return;
      }
      restartBtn.dataset.armed = '1';
      UI.setLabel('restartLabel', '确认重开？');
      restartBtn.classList.add('armed');
      clearTimeout(restartBtn._t);
      restartBtn._t = setTimeout(() => {
        restartBtn.dataset.armed = '0';
        UI.setLabel('restartLabel', '重新开始');
        restartBtn.classList.remove('armed');
      }, 3000);
    });
    menuBtn.addEventListener('click', () => {
      // 返回菜单（二次确认避免误触）
      if (menuBtn.dataset.armed === '1') {
        game.backToMenu();
        menuBtn.dataset.armed = '0';
        UI.setLabel('menuLabel', '返回菜单');
        return;
      }
      menuBtn.dataset.armed = '1';
      UI.setLabel('menuLabel', '确认返回？');
      clearTimeout(menuBtn._t);
      menuBtn._t = setTimeout(() => {
        menuBtn.dataset.armed = '0';
        UI.setLabel('menuLabel', '返回菜单');
      }, 3000);
    });
    // 游戏内「清除进度」（二次确认）：v1.13 起位于暂停覆盖层的危险区
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (clearBtn.dataset.armed === '1') {
          doClearProgress();
          clearBtn.dataset.armed = '0';
          UI.setLabel('clearLabel', '清除进度');
          return;
        }
        clearBtn.dataset.armed = '1';
        UI.setLabel('clearLabel', '确认清除？');
        clearTimeout(clearBtn._t);
        clearBtn._t = setTimeout(() => {
          clearBtn.dataset.armed = '0';
          UI.setLabel('clearLabel', '清除进度');
        }, 3000);
      });
    }
  }

  // 一键清除全部进度：清 localStorage → 回菜单 → 刷新关卡与成就显示
  function doClearProgress() {
    game.clearAllProgress();
    game.backToMenu();
    // 重置选择状态：回到生存模式第 0 关
    UI.selMode = 'survival';
    UI.selLevelIndex = 0;
    document.querySelectorAll('.mode-card').forEach(c => {
      if (c.dataset.mode === UI.selMode) c.classList.add('selected'); else c.classList.remove('selected');
    });
    UI.renderLevelCards();
    UI.renderCtaHint();
    if (typeof window.__refreshMenuBest === 'function') window.__refreshMenuBest();
    UI.flashMessage('进度已清除');
  }


  // 挂载到共享命名空间（供 input.js 装配与主循环调用；通用 DOM 工具也在此复用）
  UI.currentDef = currentDef;
  UI.currentRadius = currentRadius;
  UI.syncStarBarPrices = syncStarBarPrices;
  UI.syncSpecUI = syncSpecUI;
  UI.ui = ui;
  UI.setBtnText = setBtnText;
  UI.setBtnClass = setBtnClass;
  UI.setBpText = setBpText;
  UI.propNameOf = propNameOf;
  UI.doUndo = doUndo;
  UI.syncControlButtons = syncControlButtons;
  UI.syncWavePreview = syncWavePreview;
  UI.syncBodyPanel = syncBodyPanel;
  UI.syncPropBar = syncPropBar;
  UI.syncBossBar = syncBossBar;
  UI.bindStarBar = bindStarBar;
  UI.bindPropBar = bindPropBar;
  UI.bindBodyPanel = bindBodyPanel;
  UI.bindControls = bindControls;
  UI.doClearProgress = doClearProgress;
})();
