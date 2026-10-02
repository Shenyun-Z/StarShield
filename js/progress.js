// js/progress.js —— 最佳成绩 / 解锁 / 计分 / 隐藏关（v1.13 从 game.js 拆出）
// 依赖 core.js 的常量与全局状态（解构别名）与同层其它文件经 window.SS 暴露的函数。
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    DEFAULT_SETTINGS, CH4_START, CH4_STAR_GATE, HIDDEN_STAR_GATE, HIDDEN_TASK_NEED,
    CAMPAIGN_LEVELS, state, clampInt,
  } = SS;

  function loadBest() {
    try {
      SS.bestScore = Math.max(0, parseInt(localStorage.getItem('starshield_best_score') || '0', 10) || 0);
      SS.bestWaves = Math.max(0, parseInt(localStorage.getItem('starshield_best_waves') || '0', 10) || 0);
      // 解锁进度做区间收敛：存档可被手工篡改，越界值会让关卡列表/开局判定异常
      const unlocked = parseInt(localStorage.getItem('starshield_campaign_unlocked') || '0', 10) || 0;
      SS.campaignUnlocked = clampInt(unlocked, 0, Math.max(0, CAMPAIGN_LEVELS.length));
    } catch (e) { SS.bestScore = 0; SS.bestWaves = 0; SS.campaignUnlocked = 0; }
  }
  function saveBest() {
    try {
      localStorage.setItem('starshield_best_score', String(SS.bestScore));
      localStorage.setItem('starshield_best_waves', String(SS.bestWaves));
      localStorage.setItem('starshield_campaign_unlocked', String(SS.campaignUnlocked));
    } catch (e) {
      SS.setWarning('战绩保存失败：本地存储不可用或已满');
    }
  }
  // 一键清除进度：删除本游戏写入的全部 localStorage 键（各层级通用）
  function clearAllProgress() {
    try {
      for (const k of SS.LS_KEYS) localStorage.removeItem(k);
    } catch (e) {}
    SS.bestScore = 0; SS.bestWaves = 0; SS.campaignUnlocked = 0;
    // 设置同步复位为默认值（P0-4）：存档已删除，若内存不复位会出现"界面与存档不一致"
    SS.settings = Object.assign({}, DEFAULT_SETTINGS);
    state.showHint = SS.settings.showHint;
    state.showWarnings = SS.settings.showWarnings;
    state.reduceMotion = SS.settings.reduceMotion;   // v1.13：动效偏好随设置一并复位
    state.volume = SS.settings.volume;               // v1.13：主音量同样复位为默认
    state.paused = false;                         // v1.13：清进度后不得停在暂停态
    SS.pendingNotice = '';
    // 星级 / 成就同样复位（P1）：存档已删除，内存若不复位会出现"界面与存档不一致"
    SS.stars = Object.create(null);
    SS.achievements = Object.create(null);
    SS.pendingAchievements = [];
    state.lastStars = 0;
    state.selectedBody = null;
    // v1.10：挑战 / 每日挑战 / 额外任务 / 最佳记录 一并复位（存档已删除，内存不复位会与存档不一致）
    SS.challenge = { unlocked: 0, stars: Object.create(null), best: Object.create(null) };
    SS.daily = SS.emptyDaily();
    SS.tasksDone = Object.create(null);
    SS.recordsByKey = Object.create(null);
    SS.stats = SS.emptyStats();        // v1.11：累计统计（存档已删除，内存必须同步复位）
    state.lastTask = null;
    state.lastRecord = null;
    state.lastDaily = null;
    state.lastEnding = null;
    state.modifiers = [];
    // 重新加载菜单时由调用方负责刷新显示
  }
  // 整数化总分：由四类计分明细（各自取整）代数求和推导，保证与结算面板明细严格一致、
  // 始终为整数（消除生存存活分浮点累加导致的显示漂移）。
  // 这是全游戏唯一的总分口径——不再维护一个浮点的 state.score 影子字段（M2）。
  function integerScore() {
    const n = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
    return Math.max(0,
      n(state.scoreIntercept)
      + n(state.scoreWaveBonus)
      + n(state.scoreSurvive)
      - n(state.scorePenalty));
  }
  function updateBest() {
    if (state.mode === 'campaign') {
      // 闯关模式的「成就」= 已通关到第几关（最高解锁索引 + 1），不记录波次
      // 仅在通关时由 unlockNextLevel() 推进 SS.campaignUnlocked
    } else if (SS.isFixedWaveMode()) {
      // 挑战 / 每日挑战：成绩记录在各自的存档里（SS.recordChallengeRun / SS.recordDaily），
      // 不得写入 survival/endless 共用的 SS.bestScore / SS.bestWaves，否则记录会互相污染
      return;
    } else {
      const rounded = integerScore();
      if (rounded > SS.bestScore) SS.bestScore = rounded;
      // 无尽模式额外记录「最高波数」（SS.bestWaves 字段此前未被真正使用）
      if (state.mode === 'endless' && state.wave > SS.bestWaves) SS.bestWaves = state.wave;
    }
    saveBest();
  }
  // 通关当前关：解锁下一关（仅闯关模式）
  function unlockNextLevel() {
    if (state.mode !== 'campaign') return;
    if (isHiddenLevel()) return;        // 隐藏关不推进常规解锁进度
    const next = state.levelIndex + 1;
    if (next > SS.campaignUnlocked) {
      SS.campaignUnlocked = next;
      saveBest();
    }
  }
  function bestDisplay() {
    if (state.mode === 'campaign') return SS.campaignUnlocked > 0 ? ('通关第 ' + SS.campaignUnlocked + ' 关') : '未通关';
    if (state.mode === 'challenge') {
      return SS.challenge.unlocked > 0 ? ('挑战已通关 ' + SS.challenge.unlocked + ' 关') : '未通关';
    }
    if (state.mode === 'daily') {
      const d = SS.getDailyState();
      if (d.cleared) return '今日已通关';
      return d.bestScore > 0 ? ('今日 ' + d.bestScore + ' 分') : '今日未挑战';
    }
    if (state.mode === 'endless') return SS.bestWaves > 0 ? ('最高 ' + SS.bestWaves + ' 波') : '—';
    return SS.bestScore > 0 ? String(Math.round(SS.bestScore)) : '—';
  }
  function bestForMode(mode) {
    if (mode === 'campaign') return SS.campaignUnlocked;
    if (mode === 'challenge') return SS.challenge.unlocked;
    if (mode === 'daily') return SS.getDailyState().bestScore;   // 本机记录：当日最高分
    if (mode === 'endless') return SS.bestWaves;
    return Math.round(SS.bestScore);
  }
  // 关卡是否解锁（闯关模式：索引 <= 已解锁上限）
  // 第四章（idx >= 30，新增内容）额外要求累计星星达标——用于承接"满星解锁新内容"的目标感。
  // 前 30 关只按通关进度判定，逐位不变（不做进度倒退）。
  function isLevelUnlocked(idx) {
    const i = parseInt(idx, 10) || 0;
    if (isHiddenLevel(i)) return isHiddenUnlocked(i);   // 隐藏关：独立解锁条件（星数 / 任务全清）
    if (i > SS.campaignUnlocked) return false;
    if (i < CH4_START) return true;
    return SS.getTotalStars() >= CH4_STAR_GATE;
  }
  function getCh4StarGate() { return CH4_STAR_GATE; }

  // ===== 隐藏关（v1.11）=====
  // 定位：不属任何章节、不计星、不推进 SS.campaignUnlocked 的"纯挑战关"；
  // 解锁条件写在关卡数据里（level.unlock），由内容层声明、此处只做判定与进度展示。
  function isHiddenLevel(idx) {
    const i = Number.isFinite(idx) ? idx : state.levelIndex;
    const lv = CAMPAIGN_LEVELS[i];
    return !!(lv && lv.hidden);
  }
  function countRegularTasksDone() {
    let n = 0;
    for (let i = 0; i < CAMPAIGN_LEVELS.length; i++) {
      if (CAMPAIGN_LEVELS[i].hidden) continue;
      if (SS.isTaskDone('campaign', i)) n++;
    }
    return n;
  }
  // 隐藏关解锁进度（供菜单展示："累计星数 96/100" 之类）
  function getHiddenUnlockInfo(idx) {
    const i = parseInt(idx, 10) || 0;
    const lv = CAMPAIGN_LEVELS[i];
    if (!lv || !lv.hidden || !lv.unlock) return null;
    if (lv.unlock.type === 'stars') {
      const cur = SS.getTotalStars();
      const need = lv.unlock.value || HIDDEN_STAR_GATE;
      return { type: 'stars', need: need, current: cur, ok: cur >= need,
               label: '累计星数 ' + Math.min(cur, need) + '/' + need };
    }
    const done = countRegularTasksDone();
    const need = lv.unlock.value || HIDDEN_TASK_NEED;
    return { type: 'tasks', need: need, current: done, ok: done >= need,
             label: '常规关额外任务 ' + done + '/' + need };
  }
  function isHiddenUnlocked(idx) {
    const info = getHiddenUnlockInfo(idx);
    return !!(info && info.ok);
  }
  function getHiddenLevels() {
    const out = [];
    for (let i = 0; i < CAMPAIGN_LEVELS.length; i++) {
      if (CAMPAIGN_LEVELS[i].hidden) out.push({ index: i, level: CAMPAIGN_LEVELS[i] });
    }
    return out;
  }


  // ===== 导出到共享命名空间 =====
  SS.loadBest = loadBest;
  SS.saveBest = saveBest;
  SS.clearAllProgress = clearAllProgress;
  SS.integerScore = integerScore;
  SS.updateBest = updateBest;
  SS.unlockNextLevel = unlockNextLevel;
  SS.bestDisplay = bestDisplay;
  SS.bestForMode = bestForMode;
  SS.isLevelUnlocked = isLevelUnlocked;
  SS.getCh4StarGate = getCh4StarGate;
  SS.isHiddenLevel = isHiddenLevel;
  SS.countRegularTasksDone = countRegularTasksDone;
  SS.getHiddenUnlockInfo = getHiddenUnlockInfo;
  SS.isHiddenUnlocked = isHiddenUnlocked;
  SS.getHiddenLevels = getHiddenLevels;
})();
