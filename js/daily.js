// js/daily.js —— 每日挑战（v1.13 从 persist.js 拆出）
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    DAILY_KEY, state, bestScore,
  } = SS;

  const DAILY_EMPTY = {
    date: '', cleared: false, bestScore: 0, bestWave: 0,
    streak: 0, lastCleared: '', clearedTotal: 0,
  };
  function emptyDaily() { return Object.assign({}, DAILY_EMPTY); }
  SS.daily = emptyDaily();
  SS.dailyCache = null;                     // { key, level }：同一日期内复用同一关卡对象
  function dailyKeyOf(now) {
    const d = (now instanceof Date) ? now : new Date();
    const m = d.getMonth() + 1, day = d.getDate();
    return String(d.getFullYear()) + (m < 10 ? '0' + m : m) + (day < 10 ? '0' + day : day);
  }
  function getDailyKey() {
    try { return dailyKeyOf(new Date()); } catch (e) { return '00000000'; }
  }
  // 日期键算术：返回 dateKey 的前一天键（连胜判定用）。非法输入返回 ''。
  // 用 Date 完成进位（自动处理月末/闰年），避免手写日历规则出错。
  function prevDailyKey(dateKey) {
    const s = String(dateKey == null ? '' : dateKey).replace(/[^0-9]/g, '');
    if (s.length !== 8) return '';
    const y = parseInt(s.slice(0, 4), 10), m = parseInt(s.slice(4, 6), 10), d = parseInt(s.slice(6, 8), 10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
    try {
      const dt = new Date(y, m - 1, d);
      dt.setDate(dt.getDate() - 1);
      const mm = dt.getMonth() + 1, dd = dt.getDate();
      return String(dt.getFullYear()) + (mm < 10 ? '0' + mm : mm) + (dd < 10 ? '0' + dd : dd);
    } catch (e) { return ''; }
  }
  function getDailyStreak() { return Math.max(0, Math.round(Number(SS.daily.streak) || 0)); }
  function loadDaily() {
    let raw = null;
    try { raw = localStorage.getItem(DAILY_KEY); } catch (e) { SS.setWarning('每日挑战存档读取失败：本地存储不可用'); }
    SS.daily = emptyDaily();
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        SS.setWarning('每日挑战存档已损坏，已回退为空进度');
      } else {
        // 连胜元数据跨日保留（旧版存档缺这三个字段时按默认值回退，不视为损坏）
        SS.daily.streak = Math.max(0, Math.round(Number(obj.streak) || 0));
        SS.daily.lastCleared = String(obj.lastCleared || '');
        SS.daily.clearedTotal = Math.max(0, Math.round(Number(obj.clearedTotal) || 0));
        // 当日成绩只在日期键匹配时恢复（跨日即视为新的一天）
        if (String(obj.date || '') === getDailyKey()) {
          SS.daily.date = String(obj.date);
          SS.daily.cleared = !!obj.cleared;
          SS.daily.bestScore = Math.max(0, Math.round(Number(obj.bestScore) || 0));
          SS.daily.bestWave = Math.max(0, Math.round(Number(obj.bestWave) || 0));
        }
      }
    }
    return getDailyState();
  }
  function saveDaily() {
    try { localStorage.setItem(DAILY_KEY, JSON.stringify(SS.daily)); return true; }
    catch (e) { SS.setWarning('每日挑战保存失败：本地存储不可用或已满'); return false; }
  }
  function getDailyState() {
    const key = getDailyKey();
    const fresh = (SS.daily.date !== key);
    return {
      key: key,
      date: fresh ? key : SS.daily.date,
      cleared: fresh ? false : SS.daily.cleared,
      bestScore: fresh ? 0 : SS.daily.bestScore,
      bestWave: fresh ? 0 : SS.daily.bestWave,
      // v1.11：连胜元数据不受"跨日重置当日成绩"的影响
      streak: getDailyStreak(),
      lastCleared: SS.daily.lastCleared || '',
      clearedTotal: Math.max(0, Math.round(Number(SS.daily.clearedTotal) || 0)),
      level: getDailyLevel(),
    };
  }
  // 当天的确定性关卡（由 levels-campaign.js 的 makeDailyChallenge 生成；同一天复用同一对象）
  function getDailyLevel() {
    const key = getDailyKey();
    if (SS.dailyCache && SS.dailyCache.key === key) return SS.dailyCache.level;
    let level = null;
    // levels-campaign.js 恒定导出 makeDailyChallenge；try/catch 保留（生成器异常时回退空关卡并提示）
    try { level = window.makeDailyChallenge(key); } catch (e) { level = null; }
    if (!level) SS.setWarning('每日挑战关卡生成失败');
    SS.dailyCache = { key: key, level: level };
    return level;
  }
  function recordDaily() {
    const key = getDailyKey();
    // 跨日：只重置"当日成绩"，连胜元数据必须保留（否则连胜永远只能是 1）
    if (SS.daily.date !== key) {
      const keep = { streak: getDailyStreak(), lastCleared: SS.daily.lastCleared, clearedTotal: SS.daily.clearedTotal };
      SS.daily = Object.assign(emptyDaily(), keep);
      SS.daily.date = key;
    }
    const score = SS.integerScore();
    const won = state.endReason === 'win';
    const newBest = { score: score > SS.daily.bestScore, wave: state.wave > SS.daily.bestWave };
    SS.daily.bestScore = Math.max(SS.daily.bestScore, score);
    SS.daily.bestWave = Math.max(SS.daily.bestWave, state.wave);
    SS.daily.cleared = SS.daily.cleared || won;
    // 连胜推进（幂等）：同一天重复通关只记一次，避免"刷连胜"
    let streakUp = false;
    if (won && SS.daily.lastCleared !== key) {
      SS.daily.streak = (SS.daily.lastCleared === prevDailyKey(key)) ? getDailyStreak() + 1 : 1;
      SS.daily.lastCleared = key;
      SS.daily.clearedTotal = Math.max(0, Math.round(Number(SS.daily.clearedTotal) || 0)) + 1;
      streakUp = true;
    }
    saveDaily();
    return { state: getDailyState(), newBest: newBest, streakUp: streakUp };
  }

  // ===== 星体回收与就地升级（P1-B）=====
  // 与「撤销」的语义边界：撤销＝放置后 5 游戏秒内、全额返还、自动失效（纠错）；
  // 回收＝任意时刻、返还 70%、有代价（战术腾挪）。两者互不改写对方的数组与存档。

  // ===== 导出到共享命名空间 =====
  SS.DAILY_EMPTY = DAILY_EMPTY;
  SS.emptyDaily = emptyDaily;
  SS.dailyKeyOf = dailyKeyOf;
  SS.getDailyKey = getDailyKey;
  SS.prevDailyKey = prevDailyKey;
  SS.getDailyStreak = getDailyStreak;
  SS.loadDaily = loadDaily;
  SS.saveDaily = saveDaily;
  SS.getDailyState = getDailyState;
  SS.getDailyLevel = getDailyLevel;
  SS.recordDaily = recordDaily;
})();
