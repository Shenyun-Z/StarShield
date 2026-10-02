(function () {
  'use strict';

  // ===== 共享常量 / 关卡定义 / 全局状态 / 工具：由 js/core.js 提供（window.SS）=====
  // 对象/数组与不可变常量可直接解构别名（零改动复用）；可变标量在下方本地声明。
  const SS = window.SS || (window.SS = {});
  const {
    SLOW_QUOTA_MAX, SLOW_REFUND_PER_WAVE, UNDO_WINDOW, STAR_MAX_PER_LEVEL, RECYCLE_REFUND_RATIO,
    UPGRADE_CHAIN, CH4_START, DEFAULT_SPEC, HIDDEN_STAR_GATE, HIDDEN_TASK_NEED,
    PLANET_FORBIDDEN_PAD, SURVIVAL_LEVELS, CAMPAIGN_LEVELS, CHAPTERS, ENDLESS_LEVEL,
    state,
  } = SS;


  // ===== 导出给同层其它文件（js/waves.js 等）共享：仍居本文件的函数 / 常量 =====

  // 对外
  window.game = {
    state: SS.state,
    startGame: SS.startGame,
    backToMenu: SS.backToMenu,
    stepFrame: SS.stepFrame,
    // v1.13 暂停
    setPaused: SS.setPaused,
    togglePause: SS.togglePause,
    isPaused: SS.isPaused,
    updateHud: SS.updateHud,
    placeStar: SS.placeStar,
    canPlaceAt: SS.canPlaceAt,
    loadBest: SS.loadBest,
    saveBest: SS.saveBest,
    clearAllProgress: SS.clearAllProgress,
    bestDisplay: SS.bestDisplay,
    bestForMode: SS.bestForMode,
    getCurrentRunStats: SS.getCurrentRunStats,
    getLevelsForMode: SS.getLevelsForMode,
    isLevelUnlocked: SS.isLevelUnlocked,
    getCampaignUnlocked: function () { return SS.campaignUnlocked; },
    takeWarning: SS.takeWarning,
    takeNotice: SS.takeNotice,
    // P0-1 减速额度
    toggleSlowMotion: SS.toggleSlowMotion,
    slowMotionState: SS.slowMotionState,
    // P0-2 撤销最近放置
    canUndo: SS.canUndo,
    undoLastPlacement: SS.undoLastPlacement,
    // P0-4 设置持久化
    loadSettings: SS.loadSettings,
    saveSettings: SS.saveSettings,
    getSettings: SS.getSettings,
    setSetting: SS.setSetting,
    // P1-A 星级评价
    loadStars: SS.loadStars,
    saveStars: SS.saveStars,
    getStars: SS.getStars,
    starsForLevel: SS.starsForLevel,
    getTotalStars: SS.getTotalStars,
    totalStarsMax: SS.totalStarsMax,
    getStarCriteria: SS.getStarCriteria,
    computeStars: SS.computeStars,
    // P1-B 回收 / 升级 / 选中
    recycleBody: SS.recycleBody,
    upgradeBody: SS.upgradeBody,
    selectBodyAt: SS.selectBodyAt,
    clearSelection: SS.clearSelection,
    getBodyActionInfo: SS.getBodyActionInfo,
    // P2 一次性道具
    getProps: SS.getProps,
    useProp: SS.useProp,
    // v1.11 星体专精与隐藏关
    getStarDef: SS.getStarDef,
    costOf: SS.costOf,
    getSpecs: SS.specList,
    switchSpec: SS.switchSpec,
    isHiddenLevel: SS.isHiddenLevel,
    isHiddenUnlocked: SS.isHiddenUnlocked,
    getHiddenUnlockInfo: SS.getHiddenUnlockInfo,
    getHiddenLevels: SS.getHiddenLevels,
    regularLevelCount: SS.regularLevelCount,
    DEFAULT_SPEC: SS.DEFAULT_SPEC,
    HIDDEN_STAR_GATE: SS.HIDDEN_STAR_GATE,
    HIDDEN_TASK_NEED: SS.HIDDEN_TASK_NEED,
    countHiddenLevels: SS.countHiddenLevels,
    getHiddenClearedCount: SS.getHiddenClearedCount,
    getStarDistribution: SS.getStarDistribution,
    // v1.11 结局文案 / 完美收集 / 无尽阶段 / 累计统计
    getRunEnding: SS.getRunEnding,
    getPerfectStory: SS.getPerfectStory,
    isPerfectCollected: SS.isPerfectCollected,
    getEndlessStageInfo: SS.getEndlessStageInfo,
    ENDLESS_STAGES: SS.ENDLESS_STAGES,
    ENDLESS_STAGE_SIZE: SS.ENDLESS_STAGE_SIZE,
    // 只读：按当前 SS.state.wave / SS.state.mode 推导本波参数（无副作用，供节奏校验与外部展示）
    getWaveParams: SS.waveParams,
    STATS_MODES: SS.STATS_MODES,
    loadStats: SS.loadStats,
    getStatsTotals: SS.getStatsTotals,
    getModeNames: SS.getModeNames,
    getDailyStreak: SS.getDailyStreak,
    prevDailyKey: SS.prevDailyKey,
    // v1.10 模式 / 修饰符 / 任务 / 记录 / 挑战 / 每日挑战
    isFixedWaveMode: SS.isFixedWaveMode,
    MODIFIERS: SS.MODIFIERS,
    challengeModifiersFor: SS.challengeModifiersFor,
    getActiveModifiers: SS.getActiveModifiers,
    hasModifier: SS.hasModifier,
    isTaskDone: SS.isTaskDone,
    getTasksDoneCount: SS.getTasksDoneCount,
    TASK_CHECKS: SS.TASK_CHECKS,
    getRecord: SS.getRecord,
    loadRecords: SS.loadRecords,
    loadChallenge: SS.loadChallenge,
    getChallengeUnlocked: SS.getChallengeUnlocked,
    isChallengeUnlocked: SS.isChallengeUnlocked,
    challengeStarsForLevel: SS.challengeStarsForLevel,
    getChallengeStarsTotal: SS.getChallengeStarsTotal,
    getChallengeBest: SS.getChallengeBest,
    loadDaily: SS.loadDaily,
    getDailyState: SS.getDailyState,
    getDailyLevel: SS.getDailyLevel,
    getWavePreview: SS.getWavePreview,
    getCh4StarGate: SS.getCh4StarGate,
    CH4_START: SS.CH4_START,
    // P1-C 成就
    loadAchievements: SS.loadAchievements,
    saveAchievements: SS.saveAchievements,
    getAchievementList: SS.getAchievementList,
    evaluateAchievements: SS.evaluateAchievements,
    takeNewAchievements: SS.takeNewAchievements,
    ACHIEVEMENTS: SS.ACHIEVEMENTS,
    ACHIEVEMENT_GROUPS: SS.ACHIEVEMENT_GROUPS,
    STAR_TYPES: SS.STAR_TYPES,
    SURVIVAL_LEVELS: SS.SURVIVAL_LEVELS,
    CAMPAIGN_LEVELS: SS.CAMPAIGN_LEVELS,
    ENDLESS_LEVEL: SS.ENDLESS_LEVEL,
    CHAPTERS: SS.CHAPTERS,
    getBestWaves: function () { return SS.bestWaves; },
    PLANET_FORBIDDEN_PAD: SS.PLANET_FORBIDDEN_PAD,
    SLOW_QUOTA_MAX: SS.SLOW_QUOTA_MAX,
    SLOW_REFUND_PER_WAVE: SS.SLOW_REFUND_PER_WAVE,
    UNDO_WINDOW: SS.UNDO_WINDOW,
    RECYCLE_REFUND_RATIO: SS.RECYCLE_REFUND_RATIO,
    UPGRADE_CHAIN: SS.UPGRADE_CHAIN,
    STAR_MAX_PER_LEVEL: SS.STAR_MAX_PER_LEVEL,
  };

  SS.loadSettings();
  SS.loadBest();
  // 星级迁移依赖 SS.campaignUnlocked，必须放在 SS.loadBest() 之后
  SS.loadStars();
  SS.loadAchievements();
  // v1.10：挑战进度 / 额外任务 / 最佳记录 / 每日挑战（每日按日期自动判定是否跨日）
  SS.loadChallenge();
  SS.loadTasks();
  SS.loadRecords();
  SS.loadDaily();
  // v1.11：累计统计（只读展示数据，损坏时回退默认并给出提示）

  SS.loadStats();
})();