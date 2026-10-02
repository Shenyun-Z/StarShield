// js/records.js —— 每关最佳记录 / 累计统计（v1.13 从 persist.js 拆出）
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    RECORDS_KEY, STATS_KEY, state, bestScore, bestWaves,
  } = SS;

  function loadRecords() {
    let raw = null;
    try { raw = localStorage.getItem(RECORDS_KEY); } catch (e) { SS.setWarning('最佳记录读取失败：本地存储不可用'); }
    SS.recordsByKey = Object.create(null);
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        SS.setWarning('最佳记录已损坏，已回退为空进度');
      } else {
        for (const k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          const v = obj[k];
          if (!v || typeof v !== 'object') continue;
          SS.recordsByKey[k] = {
            bestScore: Math.max(0, Math.round(Number(v.bestScore) || 0)),
            leastHits: Math.max(0, Math.round(Number(v.leastHits) || 0)),
            fastestWin: Math.max(0, Math.round(Number(v.fastestWin) || 0)),
            won: !!v.won,
            plays: Math.max(0, Math.round(Number(v.plays) || 0)),
          };
        }
      }
    }
    return Object.keys(SS.recordsByKey).length;
  }
  function saveRecords() {
    try { localStorage.setItem(RECORDS_KEY, JSON.stringify(SS.recordsByKey)); return true; }
    catch (e) { SS.setWarning('最佳记录保存失败：本地存储不可用或已满'); return false; }
  }
  function getRecord(mode, levelIndex) {
    return SS.recordsByKey[SS.taskKey(mode, levelIndex)] || null;
  }
  // 结算时择优写入；返回 { record, newBest } 供结算面板展示"新纪录"
  function recordRun() {
    if (!state.level) return null;
    const key = SS.taskKey();
    const cur = SS.recordsByKey[key] || null;
    const score = SS.integerScore();
    const hits = Math.max(0, state.hitCount);
    const won = state.endReason === 'win';
    const duration = Math.max(0, Math.round(state.gameTime));
    const next = cur ? Object.assign({}, cur) : { bestScore: 0, leastHits: 0, fastestWin: 0, won: false, plays: 0 };
    const newBest = { score: false, leastHits: false, fastestWin: false, first: !cur };
    if (!cur || score > next.bestScore) { if (cur) newBest.score = true; next.bestScore = score; }
    if (!cur || hits < next.leastHits) { if (cur) newBest.leastHits = true; next.leastHits = hits; }
    if (won && (!next.won || !next.fastestWin || duration < next.fastestWin)) {
      if (next.won && next.fastestWin > 0) newBest.fastestWin = true;
      next.fastestWin = duration;
    }
    next.won = next.won || won;
    next.plays += 1;
    SS.recordsByKey[key] = next;
    saveRecords();
    return { record: Object.assign({}, next), newBest: newBest };
  }

  // ===== 累计统计（v1.11；v1.13 移除本机榜单，仅保留累计统计）=====
  // 单一存档键 STATS_KEY，结构：
  //   { v: 1,
  //     totals: { plays:{mode:n}, wins:{mode:n}, timeSec, intercepted, hits, SS.bestScore, bestWaves: SS.bestWaves } }
  // 设计取舍：累计统计是"只增"的展示型数据。旧存档中的 boards 字段会被自然忽略（向后兼容）。
  // 写入时机：仅结算期（SS.endGame），主循环零开销。
  const STATS_MODES = ['survival', 'campaign', 'challenge', 'endless', 'daily'];
  const MODE_NAMES = { survival: '生存', campaign: '闯关', challenge: '挑战', endless: '无尽', daily: '每日' };
  function emptyStats() {
    const plays = Object.create(null), wins = Object.create(null);
    for (let i = 0; i < STATS_MODES.length; i++) {
      plays[STATS_MODES[i]] = 0;
      wins[STATS_MODES[i]] = 0;
    }
    return {
      v: 1,
      totals: {
        plays: plays, wins: wins, timeSec: 0, intercepted: 0, hits: 0,
        bestScore: 0, bestWaves: 0,
      },
    };
  }
  SS.stats = emptyStats();
  function statsInt(v) { return Math.max(0, Math.round(Number(v) || 0)); }
  function loadStats() {
    let raw = null;
    try { raw = localStorage.getItem(STATS_KEY); } catch (e) { SS.setWarning('统计读取失败：本地存储不可用'); }
    SS.stats = emptyStats();
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        SS.setWarning('统计存档已损坏，已回退为空进度');
      } else {
        const t = (obj.totals && typeof obj.totals === 'object') ? obj.totals : {};
        const tp = (t.plays && typeof t.plays === 'object') ? t.plays : {};
        const tw = (t.wins && typeof t.wins === 'object') ? t.wins : {};
        for (let i = 0; i < STATS_MODES.length; i++) {
          const m = STATS_MODES[i];
          SS.stats.totals.plays[m] = statsInt(tp[m]);
          SS.stats.totals.wins[m] = statsInt(tw[m]);
        }
        SS.stats.totals.timeSec = statsInt(t.timeSec);
        SS.stats.totals.intercepted = statsInt(t.intercepted);
        SS.stats.totals.hits = statsInt(t.hits);
        SS.stats.totals.bestScore = statsInt(t.bestScore);
        SS.stats.totals.bestWaves = statsInt(t.bestWaves);
      }
    }
    return getStatsTotals();
  }
  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(SS.stats)); return true; }
    catch (e) { SS.setWarning('统计保存失败：本地存储不可用或已满'); return false; }
  }
  function getStatsTotals() {
    const t = SS.stats.totals;
    const plays = {}, wins = {};
    for (let i = 0; i < STATS_MODES.length; i++) {
      const m = STATS_MODES[i];
      plays[m] = t.plays[m] || 0;
      wins[m] = t.wins[m] || 0;
    }
    return {
      plays: plays, wins: wins,
      timeSec: t.timeSec || 0, intercepted: t.intercepted || 0, hits: t.hits || 0,
      bestScore: t.bestScore || 0, bestWaves: t.bestWaves || 0,
    };
  }
  // 累计统计累加（每局一次）。调用点：SS.endGame() 末尾 —— 该函数顶部有 gameOver 幂等护栏，
  // 因此这里无需再判重；整段 try/catch 包裹，失败只提示、绝不影响结算面板。
  function accumulateStats() {
    const mode = state.mode;
    if (STATS_MODES.indexOf(mode) < 0) return null;
    try {
      SS.stats.totals.plays[mode] = (SS.stats.totals.plays[mode] || 0) + 1;
      if (state.endReason === 'win') SS.stats.totals.wins[mode] = (SS.stats.totals.wins[mode] || 0) + 1;
      SS.stats.totals.timeSec = statsInt(SS.stats.totals.timeSec + Math.max(0, state.gameTime));
      SS.stats.totals.intercepted = statsInt(SS.stats.totals.intercepted + Math.max(0, state.asteroidsCleared));
      SS.stats.totals.hits = statsInt(SS.stats.totals.hits + Math.max(0, state.hitCount));
      const sc = SS.integerScore();
      if (sc > SS.stats.totals.bestScore) SS.stats.totals.bestScore = sc;
      if (mode === 'endless' && state.wave > SS.stats.totals.bestWaves) SS.stats.totals.bestWaves = statsInt(state.wave);
      saveStats();
      return getStatsTotals();
    } catch (e) {
      SS.setWarning('统计累加失败：本地存储不可用');
      return null;
    }
  }
  function getModeNames() { return Object.assign({}, MODE_NAMES); }

  // ===== 挑战模式进度存档（v1.10）=====
  // { unlocked, stars: {"<idx>":1|2|3}, best: {"<idx>":{SS.bestScore,leastHits,fastestWin,won,plays}} }
  // 挑战星**不并入** SS.getTotalStars()：闯关星级同时驱动成就与第四章门槛，混入会污染两处语义。
  SS.challenge = { unlocked: 0, stars: Object.create(null), best: Object.create(null) };

  // ===== 导出到共享命名空间 =====
  SS.loadRecords = loadRecords;
  SS.saveRecords = saveRecords;
  SS.getRecord = getRecord;
  SS.recordRun = recordRun;
  SS.STATS_MODES = STATS_MODES;
  SS.MODE_NAMES = MODE_NAMES;
  SS.emptyStats = emptyStats;
  SS.statsInt = statsInt;
  SS.loadStats = loadStats;
  SS.saveStats = saveStats;
  SS.getStatsTotals = getStatsTotals;
  SS.accumulateStats = accumulateStats;
  SS.getModeNames = getModeNames;
})();
