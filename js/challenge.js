// js/challenge.js —— 挑战修饰符 / 额外任务 / 挑战进度（v1.13 从 persist.js 拆出）
(function () {
  'use strict';
  const SS = window.SS || (window.SS = {});
  const {
    STAR_MAX_PER_LEVEL, CHALLENGE_KEY, TASKS_KEY, CAMPAIGN_LEVELS, state, clamp, clampInt, bestScore,
  } = SS;

  function isFixedWaveMode(mode) {
    const m = mode || state.mode;
    return m === 'campaign' || m === 'challenge' || m === 'daily';
  }

  // ===== 挑战修饰符（v1.10）=====
  // 声明式定义；各个拦截点只读 hasModifier()，不在别处自行推导规则。
  const MODIFIERS = [
    { id: 'noProps',     name: '禁道具',     desc: '本局不发放任何道具' },
    { id: 'fastThreats', name: '来袭加速',   desc: '所有来袭威胁速度 ×1.5' },
    { id: 'halfBudget',  name: '星能减半',   desc: '初始星能只有一半' },
    { id: 'noBlackhole', name: '禁黑洞',     desc: '不能放置黑洞' },
    { id: 'noRecycle',   name: '禁回收升级', desc: '不能回收或升级星体' },
    { id: 'noSlow',      name: '禁减速',     desc: '本局没有减速额度' },
  ];
  const MODIFIER_ORDER = MODIFIERS.map(m => m.id);
  // 挑战模式：按关卡序号确定性挂载递增修饰符（每 6 关加一条，上限 5 条）。
  // 确定性是硬要求——"挑战模式第 N 关"对所有玩家必须是同一套规则。
  function challengeModifiersFor(levelIndex) {
    const idx = Math.max(0, parseInt(levelIndex, 10) || 0);
    const n = Math.min(5, 1 + Math.floor(idx / 6));
    return MODIFIER_ORDER.slice(0, n);
  }
  function modifierDefs(ids) {
    const list = Array.isArray(ids) ? ids : [];
    return list.map(id => {
      const d = MODIFIERS.filter(m => m.id === id)[0];
      return d ? { id: d.id, name: d.name, desc: d.desc } : { id: String(id), name: String(id), desc: '' };
    });
  }
  function hasModifier(id) {
    return Array.isArray(state.modifiers) && state.modifiers.indexOf(id) >= 0;
  }
  function getActiveModifiers() { return modifierDefs(state.modifiers); }

  // ===== 每关额外任务（v1.10）=====
  // 与成就同构：声明式判定、只读结算统计、幂等存档（只增不减）。
  // 语义：**只判不罚**——达成不给星、不返还星能，因此不改变任何一关的既有平衡与可达性。
  const TASK_CHECKS = {
    noProp:      (s) => s.propsUsed === 0,
    noSlow:      (s) => s.slowUsedSeconds <= 0,
    noBlackhole: (s) => s.blackholesPlaced === 0,
    noRecycle:   (s) => s.recycles === 0 && s.upgrades === 0,
    thrifty:     (s) => s.budgetLeft >= Math.round((s.levelBudget || 0) * 0.5),
    noHit:       (s) => s.hits === 0,
  };
  SS.tasksDone = Object.create(null);        // { "<mode>:<idx>": true }
  function taskKey(mode, levelIndex) {
    const m = mode || state.mode;
    const idx = parseInt(levelIndex, 10);
    return String(m) + ':' + (Number.isFinite(idx) ? idx : state.levelIndex);
  }
  function loadTasks() {
    let raw = null;
    try { raw = localStorage.getItem(TASKS_KEY); } catch (e) { SS.setWarning('任务存档读取失败：本地存储不可用'); }
    SS.tasksDone = Object.create(null);
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') {
        SS.setWarning('任务存档已损坏，已回退为空进度');
      } else {
        for (const k in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k]) SS.tasksDone[k] = true;
        }
      }
    }
    return getTasksDoneCount();
  }
  function saveTasks() {
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(SS.tasksDone)); return true; }
    catch (e) { SS.setWarning('任务保存失败：本地存储不可用或已满'); return false; }
  }
  function isTaskDone(mode, levelIndex) { return !!SS.tasksDone[taskKey(mode, levelIndex)]; }
  function getTasksDoneCount() { return Object.keys(SS.tasksDone).length; }
  // 本局任务判定（仅固定波次模式；未通关不判定、不记录）
  function recordRunTask() {
    const lvl = state.level;
    if (!isFixedWaveMode() || !lvl || !lvl.task) {
      return { done: false, already: false, id: '', text: '' };
    }
    const key = taskKey();
    const already = !!SS.tasksDone[key];
    if (state.endReason !== 'win') return { done: false, already: already, id: lvl.task.id, text: lvl.task.text };
    const check = TASK_CHECKS[lvl.task.id];
    let hit = false;
    try { hit = !!check(SS.getCurrentRunStats()); } catch (e) { hit = false; }
    if (!hit) return { done: false, already: already, id: lvl.task.id, text: lvl.task.text };
    if (!already) { SS.tasksDone[key] = true; saveTasks(); }
    return { done: true, already: already, id: lvl.task.id, text: lvl.task.text };
  }

  // ===== 每关最佳记录（v1.10）=====
  // 键为 "<mode>:<idx>"：闯关 / 挑战 / 每日 / 生存 / 无尽 各自独立，互不干扰。
  SS.recordsByKey = Object.create(null);

  function parseChallenge(raw) {
    const out = { unlocked: 0, stars: Object.create(null), best: Object.create(null) };
    if (!raw) return out;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    if (!obj || typeof obj !== 'object') {
      SS.setWarning('挑战存档已损坏，已回退为空进度');   // 损坏不静默（M7 口径）
      return out;
    }
    // 挑战模式的关卡池是 40 个常规关（SS.REGULAR_LEVELS，**不含隐藏关**）：
    // unlocked 允许等于池长度（表示"40 关已全部通关"），但索引必须 < 池长度才可进入。
    // 旧实现误用 CAMPAIGN_LEVELS.length（42），会让篡改后的存档解锁不存在的索引 40/41。
    out.unlocked = clampInt(obj.unlocked, 0, SS.REGULAR_LEVELS.length);
    if (obj.stars && typeof obj.stars === 'object') {
      for (const k in obj.stars) {
        if (!Object.prototype.hasOwnProperty.call(obj.stars, k)) continue;
        const idx = parseInt(k, 10);
        const v = parseInt(obj.stars[k], 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= SS.REGULAR_LEVELS.length) continue;
        if (!Number.isFinite(v) || v <= 0) continue;
        out.stars[String(idx)] = clamp(v, 1, STAR_MAX_PER_LEVEL);
      }
    }
    if (obj.best && typeof obj.best === 'object') {
      for (const k in obj.best) {
        if (!Object.prototype.hasOwnProperty.call(obj.best, k)) continue;
        const idx = parseInt(k, 10);
        const v = obj.best[k];
        if (!Number.isFinite(idx) || idx < 0 || idx >= SS.REGULAR_LEVELS.length) continue;
        if (!v || typeof v !== 'object') continue;
        out.best[String(idx)] = {
          bestScore: Math.max(0, Math.round(Number(v.bestScore) || 0)),
          leastHits: Math.max(0, Math.round(Number(v.leastHits) || 0)),
          fastestWin: Math.max(0, Math.round(Number(v.fastestWin) || 0)),
          won: !!v.won,
          plays: Math.max(0, Math.round(Number(v.plays) || 0)),
        };
      }
    }
    return out;
  }
  function loadChallenge() {
    let raw = null;
    try { raw = localStorage.getItem(CHALLENGE_KEY); } catch (e) { SS.setWarning('挑战存档读取失败：本地存储不可用'); }
    SS.challenge = parseChallenge(raw);
    return getChallengeUnlocked();
  }
  function saveChallenge() {
    try { localStorage.setItem(CHALLENGE_KEY, JSON.stringify(SS.challenge)); return true; }
    catch (e) { SS.setWarning('挑战存档保存失败：本地存储不可用或已满'); return false; }
  }
  function getChallengeUnlocked() { return SS.challenge.unlocked; }
  // 挑战可进入的索引必须**同时**满足：在已解锁进度内，且落在挑战关卡池内（0..39）。
  // 实测缺陷（v1.12 修复）：旧实现只判 `i <= challenge.unlocked`，而 unlockNextChallenge 用
  // CAMPAIGN_LEVELS.length(42) 作上界 → 通关第 40 关后 unlocked=40，isChallengeUnlocked(40) 为 true，
  // 结算面板「下一关」据此调用 SS.startGame(40) → 关卡池只有 0..39 → 静默失败（点了没反应）。
  function isChallengeUnlocked(idx) {
    const i = parseInt(idx, 10);
    return Number.isFinite(i) && i >= 0 && i < SS.REGULAR_LEVELS.length && i <= SS.challenge.unlocked;
  }
  function unlockNextChallenge() {
    if (state.mode !== 'challenge') return;
    const next = state.levelIndex + 1;
    // 允许 unlocked 推进到池长度（= 40，表示"挑战 40 关已全部通关"，SS.bestDisplay 文案据此显示），
    // 但不得超过池长度（索引 40/41 在挑战池里并不存在，属越界进度）。
    if (next > SS.challenge.unlocked && next <= SS.REGULAR_LEVELS.length) {
      SS.challenge.unlocked = next;
      saveChallenge();
    }
  }
  function challengeStarsForLevel(idx) {
    const v = parseInt(SS.challenge.stars[String(idx)] || '0', 10);
    return Number.isFinite(v) ? clamp(v, 0, STAR_MAX_PER_LEVEL) : 0;
  }
  function getChallengeStarsTotal() {
    let sum = 0;
    for (const k of Object.keys(SS.challenge.stars)) sum += SS.challenge.stars[k];
    return sum;
  }
  // 挑战成绩与闯关共用同一套择优逻辑，但落在独立的 best 表里
  function recordChallengeRun() {
    if (state.mode !== 'challenge') return null;
    const key = String(state.levelIndex);
    const cur = SS.challenge.best[key] || null;
    const score = SS.integerScore();
    const hits = Math.max(0, state.hitCount);
    const won = state.endReason === 'win';
    const duration = Math.max(0, Math.round(state.gameTime));
    const next = cur ? Object.assign({}, cur) : { bestScore: 0, leastHits: 0, fastestWin: 0, won: false, plays: 0 };
    if (!cur || score > next.bestScore) next.bestScore = score;
    if (!cur || hits < next.leastHits) next.leastHits = hits;
    if (won && (!next.won || !next.fastestWin || duration < next.fastestWin)) next.fastestWin = duration;
    next.won = next.won || won;
    next.plays += 1;
    SS.challenge.best[key] = next;
    saveChallenge();
    return Object.assign({}, next);
  }
  function getChallengeBest(idx) { return SS.challenge.best[String(idx)] || null; }

  // ===== 每日挑战存档（v1.10；v1.11 增加连胜）=====
  // 只保存"当天"的成绩；读取时若日期已变（跨日）会自动重置，无需定时器。
  // v1.11 扩展三个**跨日保留**的元数据（不随当日成绩重置）：
  //   streak       连续通关天数（同一日期重复通关只记一次，保证幂等）
  //   lastCleared  最近一次通关的日期键
  //   clearedTotal 累计通关天数

  // ===== 导出到共享命名空间 =====
  SS.isFixedWaveMode = isFixedWaveMode;
  SS.MODIFIERS = MODIFIERS;
  SS.MODIFIER_ORDER = MODIFIER_ORDER;
  SS.challengeModifiersFor = challengeModifiersFor;
  SS.modifierDefs = modifierDefs;
  SS.hasModifier = hasModifier;
  SS.getActiveModifiers = getActiveModifiers;
  SS.TASK_CHECKS = TASK_CHECKS;
  SS.taskKey = taskKey;
  SS.loadTasks = loadTasks;
  SS.saveTasks = saveTasks;
  SS.isTaskDone = isTaskDone;
  SS.getTasksDoneCount = getTasksDoneCount;
  SS.recordRunTask = recordRunTask;
  SS.parseChallenge = parseChallenge;
  SS.loadChallenge = loadChallenge;
  SS.saveChallenge = saveChallenge;
  SS.getChallengeUnlocked = getChallengeUnlocked;
  SS.isChallengeUnlocked = isChallengeUnlocked;
  SS.unlockNextChallenge = unlockNextChallenge;
  SS.challengeStarsForLevel = challengeStarsForLevel;
  SS.getChallengeStarsTotal = getChallengeStarsTotal;
  SS.recordChallengeRun = recordChallengeRun;
  SS.getChallengeBest = getChallengeBest;
})();
