// 闯关模式确定性关卡配置（层层递进）
// 设计目标：
//   1) 公平性：全部用户加载同一份数据，波次序列完全一致（确定性生成，无随机）。
//   2) 层层递进：30 关，难度随关卡序号平滑上升（母星血量减少、星能收紧、
//      波次增多、来袭速度/质量提升、彗星占比上升、黑洞/恒星场景逐步加入）。
//   3) 解锁制：仅通关当前关才能开启下一关（解锁进度存于 localStorage）。
//   4) 成就记录：仅记录「已通关到第 N 关」。
(function (global) {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return (v < a) ? a : (v > b ? b : v); }

  // 6 种星域主题：名称 + **真实场景机关**（v1.9 起生效）。
  // 坐标用「相对屏幕中心的比例」dx/dy ∈ [-0.5, 0.5]，由 game.js 的 setupLevel 按当前
  // 窗口尺寸换算成像素，保证不同分辨率下布局一致、且所有玩家看到同一套场景。
  // 场景天体只参与引力与碰撞（可撞毁来袭天体，也会挡住玩家星体）：不计威胁、不可回收/升级。
  // 注：历史版本曾定义 scene.holes/stars 但从不生成，导致"文案与实战不符"；
  // 现在改为**真正生成**，因此 buildIntro 必须如实描述这些机关。
  const THEMES = [
    { key: 'calm',   name: '宁静星域',
      scene: { key: 'none',
        intro: '开局星域空无一物，所有引力都要由你亲手布下。',
        bodies: [] } },
    { key: 'dual',   name: '双星轨道',
      scene: { key: 'companion',
        intro: '场中有一颗伴星持续牵引，来袭轨道会被它改写——善用它的引力。',
        bodies: [{ type: 'companion', mass: 3000, radius: 26, dx: -0.30, dy: 0, rotation: 0 }] } },
    { key: 'well',   name: '深井引力',
      scene: { key: 'well',
        intro: '场中存在一处强引力井，靠近它的天体会被明显加速或拽偏。',
        bodies: [{ type: 'well', mass: 4500, radius: 15, dx: 0, dy: -0.28, rotation: 0 }] } },
    { key: 'binary', name: '双子恒星',
      scene: { key: 'companion',
        intro: '两颗恒星分列母星两侧，引力场被持续扭曲，布防需兼顾双向牵引。',
        bodies: [
          { type: 'companion', mass: 1800, radius: 21, dx: -0.32, dy: -0.10, rotation: 0 },
          { type: 'companion', mass: 1800, radius: 21, dx: 0.32, dy: 0.10, rotation: 0 },
        ] } },
    { key: 'maze',   name: '乱流迷宫',
      scene: { key: 'obstacle',
        intro: '场内散布固定岩体障碍：它们会拦下撞上来的天体，也会挡住你的星体。',
        bodies: [
          { type: 'obstacle', mass: 320, radius: 22, dx: -0.22, dy: -0.20, rotation: 0.4,
            vertices: [1, 0.86, 1.08, 0.92, 1.12, 0.9, 1.05, 0.94, 1.1] },
          { type: 'obstacle', mass: 320, radius: 20, dx: 0.24, dy: -0.14, rotation: 1.1,
            vertices: [0.94, 1.1, 0.9, 1.06, 0.92, 1.12, 0.88, 1.04, 1.06] },
          { type: 'obstacle', mass: 320, radius: 24, dx: 0.02, dy: 0.28, rotation: 2.0,
            vertices: [1.06, 0.92, 1.1, 0.95, 1.02, 1.08, 0.9, 1.04, 0.96] },
        ] } },
    { key: 'storm',  name: '风暴核心',
      scene: { key: 'pulsar',
        intro: '场中的脉冲源会周期性向外推挤附近天体，稳定轨道随时可能被打乱。',
        bodies: [{ type: 'pulsar', mass: 900, radius: 17, dx: 0.30, dy: -0.05,
                   pulseStrength: 170, pulsePeriod: 3.2, rotation: 0 }] } },
    // ===== 第四章主题（v1.10 追加，只能追加在尾部）=====
    // 前 30 关的主题索引是 Math.floor(i / 5) % THEMES.length，i/5 的取值只有 0..5，
    // 因此把新主题追加到数组尾部（索引 6、7）不会改变前 30 关的取模结果。
    // 若插到前面或中间，前 30 关的场景与文案会整体错位（有基线 fixture 断言兜底）。
    { key: 'trench', name: '坠星海沟',
      scene: { key: 'well',
        intro: '两道引力井分列星域两侧，来袭天体被来回牵引，布防会被反复改写。',
        bodies: [
          { type: 'well', mass: 3600, radius: 14, dx: -0.28, dy: -0.16, rotation: 0 },
          { type: 'well', mass: 3200, radius: 13, dx: 0.28, dy: 0.18, rotation: 0 },
        ] } },
    { key: 'terminus', name: '终焉双源',
      scene: { key: 'pulsar',
        intro: '两个脉冲源交替向外推挤天体，稳定轨道几乎不存在，只有精准布防才能撑到最后。',
        bodies: [
          { type: 'pulsar', mass: 900, radius: 16, dx: -0.30, dy: 0.12,
            pulseStrength: 175, pulsePeriod: 3.0, rotation: 0 },
          { type: 'pulsar', mass: 850, radius: 15, dx: 0.30, dy: -0.12,
            pulseStrength: 195, pulsePeriod: 2.6, rotation: 1.2 },
        ] } },
  ];

  // 前 30 关（v1.9 已发布内容）的难度分母。**必须冻结**：难度进度 t = i / (LEGACY_N - 1)，
  // 若改成 i / (N - 1)，前 30 关的 t 会整体变小，血量/星能/波数/波次构成与 rng 抽取序列
  // 全部漂移（见 test/fixtures/campaign-v1.11.json 的基线断言）。
  const LEGACY_N = 30;
  const N = 40; // 总关卡数（前 30 关 + 第四章 10 关）

  // ===== 每关「额外任务」（v1.10）=====
  // 内容层只负责**声明**（id + 文案），判定逻辑在 game.js 的 TASK_CHECKS（与成就同构）。
  // 语义约束：只判不罚——达成不改变星级、不返还星能，因此不影响任何一关的既有平衡。
  // 必须是纯确定性推导，禁止消费下面的 rng（否则会移动后续关卡的抽取序列）。
  const EXTRA_TASKS = [
    { id: 'noProp',      text: '不使用任何道具通关' },
    { id: 'noSlow',      text: '不使用时间减速通关' },
    { id: 'noBlackhole', text: '不放置黑洞通关' },
    { id: 'noRecycle',   text: '不回收、不升级任何星体' },
    { id: 'thrifty',     text: '通关时星能结余不少于初始预算的一半' },
    { id: 'noHit',       text: '母星零受击通关' },
  ];
  // 按 7 步长轮转（与任务数 6 互质）：连续 6 关覆盖全部任务，且所有玩家完全一致
  function taskFor(i) { return EXTRA_TASKS[(i * 7) % EXTRA_TASKS.length]; }
  const LEVELS = [];
  const rng = mulberry32(0x5CA1AB1E); // 固定种子 → 可复现

  // 基于关卡特征生成确定性简介（无随机，所有用户一致）。
  // theme 提供星域名称与**真实场景描述**（scene.intro 与实战生成的天体一致）；
  // stage 描述整体难度阶段；cometPct 描述威胁构成。
  function buildIntro(theme, idx, waveCount, cometRatio) {
    const stage =
      idx < 6 ? '入门关，适合熟悉引力布防的基本操作。'
        : idx < 12 ? '挑战升级，来袭更密、更快，考验你的布防节奏。'
        : idx < 18 ? '关卡核心期，多目标同屏，需兼顾拦截与防守。'
        : idx < 24 ? '高手关卡，高速彗星与密集波次轮番轰炸。'
        : '终局挑战，极限速度与强度的终极考验。';
    const env = (theme.scene && theme.scene.intro) ? theme.scene.intro : '';
    const comet = Math.round(cometRatio * 100);
    return `${theme.name}。${stage}${env}来袭威胁中约 ${comet}% 为高速彗星，共 ${waveCount} 波。`;
  }

  let prevTotalWaves = 0;   // 上一关的总波数（含 Boss 波），用于保证波数非递减
  for (let i = 0; i < N; i++) {
    // 第四章（i >= LEGACY_N）：沿用同一套确定性公式，但使用**独立难度曲线** t2 ∈ [0,1]，
    // 并把喂给波次生成的 t 提升到 1.45 → 1.90（高于第一至三章的上限 1.45）。
    const isCh4 = i >= LEGACY_N;
    const t2 = isCh4 ? (i - LEGACY_N) / (N - LEGACY_N - 1) : 0;   // 章内进度 0..1
    const t = isCh4 ? (1.45 + t2 * 0.45) : (i / (LEGACY_N - 1));  // 0..1 或 1.45..1.90
    const theme = THEMES[Math.floor(i / 5) % THEMES.length];

    // ===== v1.9 强度重校准（P2，前 30 关，公式逐字冻结）=====
    // 上一版加入「回收 70% 返还 + 就地升级」后，玩家有效星能与布防灵活度显著提升，
    // 因此这里逐关上调来袭规模与强度，并同步微调血量/星能，使难度回到"需要认真布防"。
    // 旧值 → 新值（逐关线性插值，全部为确定性公式，无随机）：
    //   波次数     8 → 22   ⇒  9 → 26
    //   每波个数   3 → 12   ⇒  4 → 14
    //   基准速度  70 → 190  ⇒ 80 → 225
    //   质量      28 → 150  ⇒ 32 → 180
    //   母星血量  28 → 16   ⇒ 30 → 20（容错略增：威胁更多更强，避免一失误即崩盘）
    //   星能预算 650 → 380  ⇒ 620 → 370（收紧：配合回收/升级带来的资源效率提升）
    // 硬约束：难度系数仍严格递增（测试断言）、关卡数与内容完全确定性（deepEqual）均不变。
    // ===== v1.10 第四章（i >= 30，追加内容）=====
    // 承接第 30 关的强度继续上升：血量 20→16、星能 370→300、波数 26→30、
    // 难度 1.48→1.90（严格递增、两位小数不并列）、彗星 0.50→0.60、
    // 分裂彗星 0.16→0.22、干扰体 0.12→0.18。
    // ===== v1.11 强度重校准（因新增专精与布局协同）=====
    // 玩家的新增实力主要来自**布局协同**（邻近星体叠加、靠近机关借力，最多 +40% 引力），
    // 而默认专精「引力型」在数值上与历史完全一致（见 physics.SPECS）。因此这里的上调幅度
    // 按"协同的典型收益"校准：越靠后的关卡（玩家星体越多、越容易形成协同）上调越明显。
    // intensity：前 30 关 1.00 → 1.12；第四章 1.18 → 1.26（作用于来袭速度与质量）
    const intensity = isCh4 ? (1.18 + t2 * 0.08) : (1 + t * 0.12);
    // 母星血量：前 30 关 30 → 18 渐降；第四章 18 → 16 渐降
    const health = isCh4
      ? Math.round(clamp(18 - t2 * 2, 16, 18))
      : Math.round(clamp(30 - t * 12, 18, 30));
    // 星能预算：前 30 关 620 → 360；第四章 360 → 300（下界仍不低于一颗大行星 300）
    const budget = isCh4
      ? Math.round(clamp(360 - t2 * 60, 300, 360))
      : Math.round(clamp(620 - t * 260, 360, 620));
    // 波次数：前 30 关 9 → 27；第四章 27 → 30
    let waveCount = isCh4
      ? Math.round(clamp(27 + t2 * 3, 27, 30))
      : Math.round(clamp(9 + t * 18, 9, 27));
    const isBossLevel = ((i + 1) % 5 === 0);
    // 波数单调性保护（硬约束，作用于全部关卡）：本关总波数（含可能的 Boss 收尾波）
    // 不得少于上一关。Boss 波会给第 5/10/15… 关额外 +1 波，若不保护，
    // 紧随其后的关卡会出现"波数倒退"（测试断言波数非递减）。
    waveCount = Math.max(waveCount, prevTotalWaves - (isBossLevel ? 1 : 0));
    // 全局难度系数（喂给 spawnThreat 计算速度与质量）
    const difficulty = isCh4
      ? Number((1.58 + t2 * 0.45).toFixed(2))     // 1.58 → 2.03
      : Number((0.5 + t * 1.05).toFixed(2));      // 0.50 → 1.55
    // 彗星占比：0.15 → 0.50（第四章 0.46 → 0.52）
    const cometRatio = isCh4
      ? clamp(0.46 + t2 * 0.06, 0.46, 0.52)
      : clamp(0.15 + t * 0.35, 0.15, 0.5);
    // v1.9 新威胁的占比：分裂彗星（全程少量，后期增多）、引力干扰体（仅中后期）。
    // 两者都是确定性抽取（同一 rng 序列），所有玩家看到完全一致的构成。
    // 硬约束：三者之和必须 < 1，否则陨石（else 分支）永远不会被抽到。
    const splitterRatio = isCh4
      ? clamp(0.18 + t2 * 0.02, 0.18, 0.2)
      : clamp(0.03 + t * 0.15, 0.03, 0.18);
    const disturberRatio = isCh4
      ? clamp(0.14 + t2 * 0.04, 0.14, 0.18)
      : clamp(t * 0.14, 0, 0.14);

    // 确定性生成波次：每波若干来袭，spread/edge/speed/mass 随难度递增
    const waves = [];
    for (let w = 0; w < waveCount; w++) {
      const wt = (w + 1) / waveCount;             // 波次内进度 0..1
      const count = Math.round(clamp(4 + (t * 5) + wt * 3, 4, 14));
      const spreadArc = clamp(0.5 + t * 1.2 + wt * 0.4, 0.5, 2.4); // 覆盖角范围（弧度）
      // v1.11 重校准：来袭速度与质量按 intensity 整体上调（越靠后越明显）
      const baseSpeed = Number(((80 + t * 145 + wt * 45) * intensity).toFixed(1));
      const mass = Math.round(clamp((32 + t * 85 + wt * 36) * intensity, 26, 230));
      const spawns = [];
      for (let s = 0; s < count; s++) {
        // 类型抽取：单次 rng() 决定，区间依次为 分裂彗星 / 干扰体 / 彗星 / 陨石
        const roll = rng();
        let kind;
        if (roll < splitterRatio) kind = 'splitter';
        else if (roll < splitterRatio + disturberRatio) kind = 'disturber';
        else if (roll < splitterRatio + disturberRatio + cometRatio) kind = 'comet';
        else kind = 'asteroid';
        const edge = rng() < 0.5 ? 'left' : 'right';
        const spread = (rng() - 0.5) * spreadArc;   // 相对本波中心角的偏移
        // 速度/质量/半径按类型微调：彗星类更快更轻，干扰体更慢更重更“实体”
        const speedScale = kind === 'splitter' ? 1.18
          : kind === 'comet' ? 1.25
          : kind === 'disturber' ? 0.85 : 1;
        const massScale = kind === 'disturber' ? 0.95
          : (kind === 'comet' || kind === 'splitter') ? 0.7 : 1;
        const radius = kind === 'comet' ? 7
          : kind === 'splitter' ? 9
          : kind === 'disturber' ? 15
          : Math.round(clamp(14 + mass / 9, 14, 26));
        spawns.push({
          kind,
          edge,
          spread: Number(spread.toFixed(3)),
          speed: Number((baseSpeed * speedScale).toFixed(1)),
          mass: Math.round(mass * massScale),
          radius,
        });
      }
      waves.push({
        interval: Number(clamp(0.7 - t * 0.25, 0.35, 0.7).toFixed(2)), // 来袭间隔随难度变快
        spawns,
      });
    }

    // Boss 波（每 5 关一次，作为该关的收尾波）：一个需要多段摧毁的巨型天体 + 少量护卫。
    // 必须计入波次总数（objective/intro/HUD/"当前波/总波"都以 waves.length 为准）。
    if (isBossLevel) {
      const bossHp = Math.min(5, 3 + Math.floor(i / 10));       // 3 → 5 段
      const bossMass = Math.round(clamp(260 + t * 160, 260, 420));
      const bossSpeed = Number((60 + t * 70).toFixed(1));       // 比普通来袭慢，给玩家反应时间
      waves.push({
        interval: 0.7,
        boss: true,
        spawns: [
          { kind: 'boss', edge: (i % 2 === 0) ? 'right' : 'left', spread: 0,
            speed: bossSpeed, mass: bossMass, radius: 34, hp: bossHp },
          { kind: 'asteroid', edge: 'left', spread: 0.25,
            speed: Number((bossSpeed * 1.15).toFixed(1)), mass: 45, radius: 16 },
          { kind: 'asteroid', edge: 'right', spread: -0.25,
            speed: Number((bossSpeed * 1.15).toFixed(1)), mass: 45, radius: 16 },
        ],
      });
    }
    const totalWaves = waves.length;              // 含 Boss 波的真实波数
    prevTotalWaves = totalWaves;                  // 供下一关的单调性保护使用

    const roman = ['一','二','三','四','五','六','七','八','九','十',
      '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
      '二十一','二十二','二十三','二十四','二十五','二十六','二十七','二十八','二十九','三十',
      '三十一','三十二','三十三','三十四','三十五','三十六','三十七','三十八','三十九','四十'];

    LEVELS.push(Object.freeze({
      id: 'camp-' + (i + 1),
      name: '第' + roman[i] + '关 · ' + theme.name,
      desc: '难度 ' + difficulty.toFixed(2) + ' · ' + totalWaves + ' 波 · 彗星 '
        + Math.round(cometRatio * 100) + '%' + (isBossLevel ? ' · BOSS' : ''),
      // 关卡简介：介绍本关场景特色与挑战（确定性生成，所有用户一致）
      intro: buildIntro(theme, i, totalWaves, cometRatio) + (isBossLevel ? '本关收尾将出现一个需要多段摧毁的巨型天体。' : ''),
      // 关卡目标（塔防式清晰文案）与结束条件，供开局横幅与结算展示
      objective: '守住母星，击退全部 ' + totalWaves + ' 波来袭威胁',
      failCondition: '母星生命值（' + health + ' 点）归零',
      // 每关「额外任务」（v1.10）：只判不罚——不影响星级、不返还星能，故不改变既有平衡
      task: Object.freeze(taskFor(i)),
      health, budget, difficulty,
      waves: Object.freeze(waves),
      // 场景机关（真实生成，见 THEMES.scene）：冻结以防运行时被意外改写
      scene: theme.scene
        ? Object.freeze({
            key: theme.scene.key,
            intro: theme.scene.intro,
            bodies: Object.freeze(theme.scene.bodies.map(b => Object.freeze(Object.assign({}, b)))),
          })
        : Object.freeze({ key: 'none', intro: '', bodies: Object.freeze([]) }),
    }));
  }

  // ===== 隐藏关（v1.11）=====
  // 定位：**纯挑战关**——不属任何章节、不计星（满星上限恒为 120）、不推进常规解锁进度。
  // 解锁条件写在 unlock 字段（累计星数 / 40 个常规关的额外任务全清），由 game.js 判定与展示进度。
  // 波次使用**独立种子**生成，不触碰常规关卡的 rng 抽取序列（确定性红线）。
  function buildHiddenLevel(cfg) {
    const hrng = mulberry32(cfg.seed);
    const theme = THEMES[cfg.themeIndex % THEMES.length];
    const waves = [];
    for (let w = 0; w < cfg.waveCount; w++) {
      const wt = (w + 1) / cfg.waveCount;
      const count = Math.round(clamp(6 + cfg.difficulty * 4 + wt * 3, 6, 15));
      const spreadArc = clamp(0.9 + cfg.difficulty * 0.8 + wt * 0.3, 0.9, 2.2);
      const baseSpeed = Number((120 + cfg.difficulty * 110 + wt * 45).toFixed(1));
      const mass = Math.round(clamp(45 + cfg.difficulty * 75 + wt * 34, 34, 230));
      const spawns = [];
      for (let s = 0; s < count; s++) {
        const roll = hrng();
        let kind;
        if (roll < cfg.splitterRatio) kind = 'splitter';
        else if (roll < cfg.splitterRatio + cfg.disturberRatio) kind = 'disturber';
        else if (roll < cfg.splitterRatio + cfg.disturberRatio + cfg.cometRatio) kind = 'comet';
        else kind = 'asteroid';
        const speedScale = kind === 'splitter' ? 1.18
          : kind === 'comet' ? 1.25
          : kind === 'disturber' ? 0.85 : 1;
        const massScale = kind === 'disturber' ? 0.95
          : (kind === 'comet' || kind === 'splitter') ? 0.7 : 1;
        const radius = kind === 'comet' ? 7
          : kind === 'splitter' ? 9
          : kind === 'disturber' ? 15
          : Math.round(clamp(14 + mass / 9, 14, 26));
        spawns.push({
          kind,
          edge: hrng() < 0.5 ? 'left' : 'right',
          spread: Number(((hrng() - 0.5) * spreadArc).toFixed(3)),
          speed: Number((baseSpeed * speedScale).toFixed(1)),
          mass: Math.round(mass * massScale),
          radius,
        });
      }
      waves.push({
        interval: Number(clamp(0.7 - cfg.difficulty * 0.12, 0.35, 0.7).toFixed(2)),
        spawns,
      });
    }
    // Boss 收尾波（与常规关同结构，保证 p2-systems 的 Boss 语义一致）
    const bossSpeed = Number((70 + cfg.difficulty * 40).toFixed(1));
    waves.push({
      interval: 0.7,
      boss: true,
      spawns: [
        { kind: 'boss', edge: 'right', spread: 0, speed: bossSpeed, mass: 320, radius: 34,
          hp: Math.min(5, 3 + (cfg.bossHpBonus || 0)) },
        { kind: 'asteroid', edge: 'left', spread: 0.25,
          speed: Number((bossSpeed * 1.15).toFixed(1)), mass: 45, radius: 16 },
        { kind: 'asteroid', edge: 'right', spread: -0.25,
          speed: Number((bossSpeed * 1.15).toFixed(1)), mass: 45, radius: 16 },
      ],
    });
    const totalWaves = waves.length;
    return Object.freeze({
      id: cfg.id,
      name: cfg.name,
      hidden: true,
      desc: '隐藏关 · ' + totalWaves + ' 波 · 难度 ' + cfg.difficulty.toFixed(2),
      intro: cfg.intro,
      objective: '守住母星，击退全部 ' + totalWaves + ' 波来袭威胁',
      failCondition: '母星生命值（' + cfg.health + ' 点）归零',
      task: Object.freeze({ id: cfg.task.id, text: cfg.task.text }),
      unlock: Object.freeze({ type: cfg.unlock.type, value: cfg.unlock.value }),
      health: cfg.health, budget: cfg.budget, difficulty: cfg.difficulty, duration: 0,
      waves: Object.freeze(waves),
      scene: Object.freeze({
        key: theme.scene.key,
        intro: theme.scene.intro,
        bodies: Object.freeze(theme.scene.bodies.map(b => Object.freeze(Object.assign({}, b)))),
      }),
      modifiers: Object.freeze(cfg.modifiers.slice()),
    });
  }
  // 隐藏关 1：星能减半 + 禁道具（考验纯布防与协同）；隐藏关 2：来袭加速 + 禁黑洞 + 禁回收升级
  LEVELS.push(buildHiddenLevel({
    id: 'hidden-1', name: '隐藏关 · 无声围城', seed: 0x11DDE1, themeIndex: 6,
    waveCount: 20, health: 12, budget: 320, difficulty: 1.9,
    cometRatio: 0.34, splitterRatio: 0.14, disturberRatio: 0.16, bossHpBonus: 1,
    modifiers: ['noProps', 'halfBudget'],
    unlock: { type: 'stars', value: 100 },
    task: { id: 'noHit', text: '母星零受击通关' },
    intro: '隐藏关：初始星能减半且不发放任何道具，两道引力井会把来袭来回牵引。只能靠纯粹的布防与协同守住母星。',
  }));
  LEVELS.push(buildHiddenLevel({
    id: 'hidden-2', name: '隐藏关 · 双倍绝境', seed: 0x22EE52, themeIndex: 7,
    waveCount: 24, health: 10, budget: 360, difficulty: 2.1,
    cometRatio: 0.36, splitterRatio: 0.16, disturberRatio: 0.18, bossHpBonus: 2,
    modifiers: ['fastThreats', 'noBlackhole', 'noRecycle'],
    unlock: { type: 'tasks', value: 40 },
    task: { id: 'noSlow', text: '不使用时间减速通关' },
    intro: '隐藏关：所有来袭速度 ×1.5，禁止放置黑洞，也禁止回收与升级。双脉冲源持续打乱轨道——这是星域尽头的最终考验。',
  }));

  // 章节划分（4 章 × 10 关）：供菜单分组展示与该章星数完成度统计。
  // 仅是最上层展示结构，不影响关卡解锁与难度曲线。
  // story：章首关开局横幅的一句剧情文案（极简叙事，纯文本，不引入新界面）。
  const CHAPTERS = [
    { id: 'ch1', title: '第一章 · 星域初探', subtitle: '宁静星域 → 双星轨道', from: 0, to: 9,
      story: '母星孤悬于宁静星域。远方第一批陨石已经起航——用引力筑起你的第一道防线。' },
    { id: 'ch2', title: '第二章 · 引力深井', subtitle: '深井引力 → 双子恒星', from: 10, to: 19,
      story: '越过深井与双子恒星，引力不再只属于你：它会牵引敌人，也会打乱你的布防。' },
    { id: 'ch3', title: '第三章 · 风暴核心', subtitle: '乱流迷宫 → 风暴核心', from: 20, to: 29,
      story: '风暴核心的脉冲不断撕扯轨道，巨型天体已在集结——最后的防线必须由你亲手稳住。' },
    { id: 'ch4', title: '第四章 · 星海终局', subtitle: '坠星海沟 → 终焉双源', from: 30, to: 39,
      story: '穿过坠星海沟，星域尽头是终焉双源。这里是已知星图的边界，也是母星最后的战场。',
      // 章节结局（v1.12）：通关本章最后一关（第 40 关）时在结算面板展示。
      // 放在 CHAPTERS 而非关卡对象上：关卡对象有 fixture 逐字段精确比对，新增字段会击穿它。
      ending: { title: '结局 · 星海终局',
        text: '终焉双源的最后一次脉冲散入虚空，两颗崩解的恒星重归黑暗。母星在残骸间穿行，轨道重新亮起灯火——星图边界之内，再无来敌。' } },
  ];

  // ===== 结局文案（v1.12）=====
  // 隐藏关结语与「完美星图」收束文案。**独立导出，不挂到关卡对象上**：
  //   test/content-ext.test.js 对 42 个关卡对象与 test/fixtures/campaign-v1.11.json 做逐字段 deepEqual，
  //   任何写入关卡对象的新字段都会击穿该断言。此表由 game.js 的 getRunEnding()/总览面板读取。
  const STORY = {
    hidden: {
      'hidden-1': { title: '结局 · 无声围城',
        text: '没有任何道具、只有一半星能——你仍然让母星在二十波围城中纹丝不动。星图中最沉默的一座城，被你守成了标本。' },
      'hidden-2': { title: '真结局 · 双倍绝境',
        text: '双击脉冲源在最后一道轨迹上同时熄灭。你带着被撕扯过的防线穿过双倍绝境，看见了星图之外的第一缕光——那里没有敌人，只有更远的星海。' },
    },
    perfect: { title: '完美星图',
      text: '120 颗星、40 项额外任务、两处隐藏关尽数收录。这片星域的每一道轨迹都被你亲手量过——星图至此完整。' },
  };

  // ===== 每日挑战（单机）=====
  // 由本机日期键（'YYYYMMDD' 字符串，由 game.js 读取系统时间后传入）派生一个确定性关卡：
  // 同一天进入即同一套配置（波次/强度/修饰符/任务固定），跨日自动刷新。
  // 两个硬约束：
  //   1) 不得依赖 Date —— 关卡模块的加载沙箱不注入 Date，日期键一律由调用方传入；
  //   2) 使用**独立种子**（不消费闯关用的 rng），因此不会影响闯关关卡的抽取序列。
  const DAILY_MODIFIERS = ['noProps', 'halfBudget', 'fastThreats', 'noBlackhole', 'noRecycle', 'noSlow'];
  function makeDailyChallenge(dateKey) {
    const digits = String(dateKey == null ? '' : dateKey).replace(/[^0-9]/g, '');
    const num = digits ? Number(digits) : 0;
    const seed = Number.isFinite(num) ? (num % 2147483647) : 0;
    const drng = mulberry32((seed ^ 0x9E3779B9) >>> 0);

    const waveCount = 12 + Math.floor(drng() * 5);                  // 普通波 12 ~ 16（另有 Boss 收尾波）
    const budget = 380 + Math.floor(drng() * 81);                   // 380 ~ 460
    const difficulty = Number((1.00 + drng() * 0.45).toFixed(2));   // 1.00 ~ 1.45
    const cometRatio = Number((0.25 + drng() * 0.20).toFixed(3));
    const splitterRatio = Number((0.05 + drng() * 0.08).toFixed(3));
    const disturberRatio = Number((drng() * 0.10).toFixed(3));
    const theme = THEMES[Math.floor(drng() * THEMES.length)];

    // 修饰符：1 条必选 + 约半数情况下追加 1 条不重复的
    const mods = [DAILY_MODIFIERS[Math.floor(drng() * DAILY_MODIFIERS.length)]];
    if (drng() < 0.5) {
      let extra = DAILY_MODIFIERS[Math.floor(drng() * DAILY_MODIFIERS.length)];
      if (extra === mods[0]) {
        extra = DAILY_MODIFIERS[(DAILY_MODIFIERS.indexOf(extra) + 1) % DAILY_MODIFIERS.length];
      }
      mods.push(extra);
    }
    // 任务：每日一条（与闯关的任务池同源，判定逻辑共用）
    const taskDef = EXTRA_TASKS[Math.floor(drng() * EXTRA_TASKS.length)];

    const t = difficulty;
    const waves = [];
    for (let w = 0; w < waveCount; w++) {
      const wt = (w + 1) / waveCount;
      const count = Math.round(clamp(5 + t * 4 + wt * 3, 5, 13));
      const spreadArc = clamp(0.8 + t * 0.9 + wt * 0.3, 0.8, 2.2);
      const baseSpeed = Number((110 + t * 110 + wt * 40).toFixed(1));
      const mass = Math.round(clamp(40 + t * 70 + wt * 30, 30, 160));
      const spawns = [];
      for (let s = 0; s < count; s++) {
        const roll = drng();
        let kind;
        if (roll < splitterRatio) kind = 'splitter';
        else if (roll < splitterRatio + disturberRatio) kind = 'disturber';
        else if (roll < splitterRatio + disturberRatio + cometRatio) kind = 'comet';
        else kind = 'asteroid';
        const speedScale = kind === 'splitter' ? 1.18
          : kind === 'comet' ? 1.25
          : kind === 'disturber' ? 0.85 : 1;
        const massScale = kind === 'disturber' ? 0.95
          : (kind === 'comet' || kind === 'splitter') ? 0.7 : 1;
        const radius = kind === 'comet' ? 7
          : kind === 'splitter' ? 9
          : kind === 'disturber' ? 15
          : Math.round(clamp(14 + mass / 9, 14, 26));
        spawns.push({
          kind,
          edge: drng() < 0.5 ? 'left' : 'right',
          spread: Number(((drng() - 0.5) * spreadArc).toFixed(3)),
          speed: Number((baseSpeed * speedScale).toFixed(1)),
          mass: Math.round(mass * massScale),
          radius,
        });
      }
      waves.push({
        interval: Number(clamp(0.75 - t * 0.20, 0.4, 0.75).toFixed(2)),
        spawns,
      });
    }
    // Boss 收尾波：给每日挑战一个明确的高潮（结构与闯关 Boss 波一致）
    const bossSpeed = Number((70 + t * 60).toFixed(1));
    waves.push({
      interval: 0.7,
      boss: true,
      spawns: [
        { kind: 'boss', edge: 'right', spread: 0, speed: bossSpeed, mass: 300, radius: 34, hp: 4 },
        { kind: 'asteroid', edge: 'left', spread: 0.25,
          speed: Number((bossSpeed * 1.15).toFixed(1)), mass: 45, radius: 16 },
        { kind: 'asteroid', edge: 'right', spread: -0.25,
          speed: Number((bossSpeed * 1.15).toFixed(1)), mass: 45, radius: 16 },
      ],
    });
    const totalWaves = waves.length;

    return Object.freeze({
      id: 'daily',
      name: '每日挑战 · ' + theme.name,
      desc: '每日一变 · ' + totalWaves + ' 波 · 难度 ' + difficulty.toFixed(2)
        + (mods.length ? ' · ' + mods.length + ' 项修饰' : ''),
      intro: '每日挑战由本机日期生成：' + theme.name + '，共 ' + totalWaves
        + ' 波，难度 ' + difficulty.toFixed(2) + '。' + (theme.scene.intro || ''),
      objective: '守住母星，击退全部 ' + totalWaves + ' 波来袭威胁',
      failCondition: '母星生命值（20 点）归零',
      task: Object.freeze({ id: taskDef.id, text: taskDef.text }),
      health: 20, budget: budget, difficulty: difficulty, duration: 0,
      waves: Object.freeze(waves),
      scene: Object.freeze({
        key: theme.scene.key,
        intro: theme.scene.intro,
        bodies: Object.freeze(theme.scene.bodies.map(b => Object.freeze(Object.assign({}, b)))),
      }),
      modifiers: Object.freeze(mods.slice()),
      daily: true,
    });
  }

  global.CAMPAIGN_LEVELS = Object.freeze(LEVELS);
  global.CHAPTERS = Object.freeze(CHAPTERS.map(c => Object.freeze(c)));
  global.EXTRA_TASKS = Object.freeze(EXTRA_TASKS.map(t => Object.freeze(Object.assign({}, t))));
  // 结局文案（v1.12）：深冻结，避免运行时被误改。
  // hidden：按隐藏关 id 索引的结语；perfect：100% 收集（120 星 + 40 任务 + 2 隐藏关）收束文案。
  const FROZEN_STORY = {
    hidden: Object.freeze(Object.keys(STORY.hidden).reduce((acc, k) => {
      acc[k] = Object.freeze(Object.assign({}, STORY.hidden[k]));
      return acc;
    }, {})),
    perfect: Object.freeze(Object.assign({}, STORY.perfect)),
  };
  global.STORY = Object.freeze(FROZEN_STORY);
  global.makeDailyChallenge = makeDailyChallenge;
})(typeof window !== 'undefined' ? window : globalThis);
