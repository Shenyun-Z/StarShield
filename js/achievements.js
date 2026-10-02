// js/achievements.js —— 成就定义与判定（v1.13 从 persist.js 拆出）
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    STAR_MAX_PER_LEVEL, ACHIEVEMENTS_KEY,
  } = SS;

  const ACHIEVEMENTS = [
    { id: 'first_win',    group: 'combat',  name: '初次告捷', desc: '首次通关任意闯关关卡',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' },
    { id: 'no_hit_win',   group: 'combat',  name: '铜墙铁壁', desc: '零受击通关（三星）',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.hits === 0 },
    { id: 'hit_survive',  group: 'combat',  name: '浴火重生', desc: '母星受击 5 次以上仍通关',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.hits >= 5 },
    { id: 'wave_15',      group: 'combat',  name: '波次机器', desc: '单局击退 15 波以上并通关',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.wave >= 15 },
    { id: 'star_30',      group: 'combat',  name: '群星闪耀', desc: '累计获得 30 颗星',
      need: () => SS.getTotalStars() >= 30 },
    { id: 'star_60',      group: 'combat',  name: '星河为证', desc: '累计获得 60 颗星',
      need: () => SS.getTotalStars() >= 60 },
    // 文案修正（v1.11）：判定一直用 SS.totalStarsMax()（现为 40 常规关 × 3 = 120），
    // 旧文案写的 90 是加入第四章前的数字，属"文案与实战不符"，此处改为动态口径。
    { id: 'star_all',     group: 'combat',  name: '完美星域', desc: '集齐全部 ' + (SS.regularLevelCount() * STAR_MAX_PER_LEVEL) + ' 颗星',
      need: () => SS.getTotalStars() >= SS.totalStarsMax() },
    { id: 'clear_50',     group: 'economy', name: '拦截专家', desc: '单局拦截 50 个来袭威胁',
      need: (s) => s.cleared >= 50 },
    { id: 'bh_10',        group: 'economy', name: '黑洞胃王', desc: '单局用黑洞吞噬 10 个威胁',
      need: (s) => s.blackholeSwallowed >= 10 },
    { id: 'no_slow_win',  group: 'economy', name: '从容不迫', desc: '不使用慢动作通关',
      need: (s) => s.endReason === 'win' && s.slowUsedSeconds <= 0 },
    { id: 'thrifty',      group: 'economy', name: '一次成型', desc: '通关过程中不回收、不升级',
      need: (s) => s.endReason === 'win' && s.mode === 'campaign' && s.recycles === 0 && s.upgrades === 0 },
    { id: 'tinkerer',     group: 'economy', name: '机械师', desc: '单局完成 5 次星体升级',
      need: (s) => s.upgrades >= 5 },
    { id: 'eco_win',      group: 'economy', name: '零浪费', desc: '闯关通关且星能结余 ≥ 200',
      need: (s) => s.mode === 'campaign' && s.endReason === 'win' && s.budgetLeft >= 200 },
    { id: 'survive_500',  group: 'economy', name: '长明者', desc: '生存模式单局得分 ≥ 500',
      need: (s) => s.mode === 'survival' && s.score >= 500 },
    // ===== v1.11 扩展（+12 项）：覆盖专精 / 协同 / 每日挑战 / 隐藏关 / 任务全清 / 无尽风暴 / 挑战进度 / 完美收集 =====
    // 口径说明：
    //   · 判定只读 SS.getCurrentRunStats() 的字段或本文件内的 getter，与既有成就同构（可独立测试）；
    //   · 无尽成就用 s.wave 而非 SS.bestWaves —— SS.updateBest() 在 evaluateAchievements() **之后**执行，
    //     结算时 SS.bestWaves 还是上一局的值，用它会漏判；
    //   · 协同是小数比率（physics.SYNERGY_TOTAL_MAX = 0.40），故阈值写作 0.30 / 0.40。
    { id: 'spec_giant_5',  group: 'spec',    name: '巨石匠',   desc: '单局放置 5 颗「巨型」专精星体',
      need: (s) => s.specGiantPlaced >= 5 },
    { id: 'spec_switch_3', group: 'spec',    name: '变形者',   desc: '单局完成 3 次专精互转',
      need: (s) => s.specSwitches >= 3 },
    { id: 'synergy_30',    group: 'spec',    name: '引力共振', desc: '单局某颗星体的协同加成达 30%',
      need: (s) => s.synergyMaxBonus >= 0.30 },
    { id: 'synergy_40',    group: 'spec',    name: '满格共振', desc: '单局协同加成打满 40% 上限',
      need: (s) => s.synergyMaxBonus >= 0.40 },
    { id: 'daily_first',   group: 'daily',   name: '今日之星', desc: '首次通关每日挑战',
      need: (s) => s.mode === 'daily' && s.endReason === 'win' },
    { id: 'daily_streak_3', group: 'daily',  name: '三日不辍', desc: '每日挑战连续通关 3 天',
      need: () => SS.getDailyStreak() >= 3 },
    { id: 'hidden_clear',  group: 'daily',   name: '密道探索者', desc: '通关任意隐藏关',
      need: (s) => !!s.hidden && s.endReason === 'win' },
    { id: 'hidden_all',    group: 'daily',   name: '星图尽头', desc: '通关全部隐藏关',
      need: () => SS.countHiddenLevels() > 0 && SS.getHiddenClearedCount() >= SS.countHiddenLevels() },
    { id: 'task_all',      group: 'meta',    name: '使命必达', desc: '完成全部 ' + SS.regularLevelCount() + ' 个常规关的额外任务',
      need: () => SS.regularLevelCount() > 0 && SS.countRegularTasksDone() >= SS.regularLevelCount() },
    { id: 'endless_30',    group: 'meta',    name: '风暴幸存者', desc: '无尽模式坚守 30 波（历经三次风暴）',
      need: (s) => s.mode === 'endless' && s.wave >= 30 },
    { id: 'challenge_10',  group: 'meta',    name: '挑战者',   desc: '挑战模式通关 10 关',
      need: () => SS.getChallengeUnlocked() >= 10 },
    { id: 'perfect',       group: 'meta',    name: '完美星图', desc: '集齐 ' + (SS.regularLevelCount() * STAR_MAX_PER_LEVEL)
        + ' 星、清空全部额外任务与隐藏关',
      need: () => SS.getTotalStars() >= SS.totalStarsMax()
        && SS.regularLevelCount() > 0 && SS.countRegularTasksDone() >= SS.regularLevelCount()
        && SS.countHiddenLevels() > 0 && SS.getHiddenClearedCount() >= SS.countHiddenLevels() },
  ];
  // 成就分组表（v1.13）：数组顺序即 UI 展示顺序；icon 为内联 SVG sprite 的 symbol id。
  const ACHIEVEMENT_GROUPS = [
    { id: 'combat',  label: '通关与星级', icon: 'ic-star' },
    { id: 'economy', label: '操作与经营', icon: 'ic-budget' },
    { id: 'spec',    label: '专精与协同', icon: 'ic-orbit' },
    { id: 'daily',   label: '每日与隐藏关', icon: 'ic-clock' },
    { id: 'meta',    label: '模式与收集', icon: 'ic-trophy' },
  ];
  SS.achievements = Object.create(null);
  SS.pendingAchievements = [];
  function loadAchievements() {
    let raw = null;
    try { raw = localStorage.getItem(ACHIEVEMENTS_KEY); } catch (e) { SS.setWarning('成就存档读取失败：本地存储不可用'); }
    SS.achievements = Object.create(null);
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        SS.setWarning('成就存档已损坏，已回退为空进度');
      } else {
        for (const k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          // 只接受当前版本仍存在的成就 id（旧版本残留键直接忽略）
          if (ACHIEVEMENTS.some(a => a.id === k)) SS.achievements[k] = obj[k] || Date.now();
        }
      }
    }
    SS.pendingAchievements = [];
    return getAchievementList();
  }
  function saveAchievements() {
    try { localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(SS.achievements)); return true; }
    catch (e) { SS.setWarning('成就保存失败：本地存储不可用或已满'); return false; }
  }
  function getAchievementList() {
    return ACHIEVEMENTS.map(a => ({
      id: a.id, group: a.group, name: a.name, desc: a.desc,
      unlocked: !!SS.achievements[a.id],
      time: SS.achievements[a.id] || 0,
    }));
  }
  // 幂等解锁：已解锁项直接跳过；判定抛异常按"未达成"处理，绝不打断结算流程。
  function evaluateAchievements(stats) {
    const s = stats || SS.getCurrentRunStats();
    const unlocked = [];
    for (const a of ACHIEVEMENTS) {
      if (SS.achievements[a.id]) continue;
      let hit = false;
      try { hit = !!a.need(s); } catch (e) { hit = false; }
      if (hit) {
        SS.achievements[a.id] = Date.now();
        unlocked.push({ id: a.id, name: a.name, desc: a.desc });
      }
    }
    if (unlocked.length) {
      SS.pendingAchievements = SS.pendingAchievements.concat(unlocked);
      saveAchievements();
    }
    return { unlocked: unlocked, total: ACHIEVEMENTS.length, count: Object.keys(SS.achievements).length };
  }
  // 供 UI 一次性取走"本次新解锁"（与 SS.takeWarning / SS.takeNotice 同构）
  function takeNewAchievements() {
    const list = SS.pendingAchievements;
    SS.pendingAchievements = [];
    return list;
  }

  // ===== 模式单一真源（v1.10）=====
  // 固定波次模式：关卡自带 waves 数组、有明确终局（击退全部波次即通关）。
  // 胜利判定 / HUD 波次显示 / 道具配额 / 波次道具补给 / 统计口径都读它，
  // 避免"新增模式后某处仍按 campaign 判断"造成隐形缺陷（本批次最大的风险来源）。

  // ===== 导出到共享命名空间 =====
  SS.ACHIEVEMENTS = ACHIEVEMENTS;
  SS.ACHIEVEMENT_GROUPS = ACHIEVEMENT_GROUPS;
  SS.loadAchievements = loadAchievements;
  SS.saveAchievements = saveAchievements;
  SS.getAchievementList = getAchievementList;
  SS.evaluateAchievements = evaluateAchievements;
  SS.takeNewAchievements = takeNewAchievements;
})();
