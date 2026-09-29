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
  ];

  const N = 30; // 总关卡数
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

  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);              // 0..1 难度进度
    const theme = THEMES[Math.floor(i / 5) % THEMES.length];

    // ===== v1.9 强度重校准（P2）=====
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
    // 母星血量：30 → 20 渐降
    const health = Math.round(clamp(30 - t * 10, 20, 30));
    // 星能预算：620 → 370 渐降（越后面越考验布防效率与回收/升级的取舍）
    const budget = Math.round(clamp(620 - t * 250, 370, 620));
    // 波次数：9 → 26 渐增
    const waveCount = Math.round(clamp(9 + t * 17, 9, 26));
    // 全局难度系数（喂给 spawnThreat 计算速度与质量）
    const difficulty = Number((0.5 + t * 0.95).toFixed(2)); // 0.50 → 1.45
    // 彗星占比：0.15 → 0.5 渐增（更难拦截）
    const cometRatio = clamp(0.15 + t * 0.35, 0.15, 0.5);
    // v1.9 新威胁的占比：分裂彗星（全程少量，后期增多）、引力干扰体（仅中后期）。
    // 两者都是确定性抽取（同一 rng 序列），所有玩家看到完全一致的构成。
    const splitterRatio = clamp(0.03 + t * 0.13, 0.03, 0.16);
    const disturberRatio = clamp(t * 0.12, 0, 0.12);

    // 确定性生成波次：每波若干来袭，spread/edge/speed/mass 随难度递增
    const waves = [];
    for (let w = 0; w < waveCount; w++) {
      const wt = (w + 1) / waveCount;             // 波次内进度 0..1
      const count = Math.round(clamp(4 + (t * 5) + wt * 3, 4, 14));
      const spreadArc = clamp(0.5 + t * 1.2 + wt * 0.4, 0.5, 2.4); // 覆盖角范围（弧度）
      const baseSpeed = Number((80 + t * 145 + wt * 45).toFixed(1));
      const mass = Math.round(clamp(32 + t * 85 + wt * 36, 26, 180));
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
    const isBossLevel = ((i + 1) % 5 === 0);
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

    const roman = ['一','二','三','四','五','六','七','八','九','十',
      '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
      '二十一','二十二','二十三','二十四','二十五','二十六','二十七','二十八','二十九','三十'];

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

  // 章节划分（3 章 × 10 关）：供菜单分组展示与该章星数完成度统计。
  // 仅是最上层展示结构，不影响关卡解锁与难度曲线。
  const CHAPTERS = [
    { id: 'ch1', title: '第一章 · 星域初探', subtitle: '宁静星域 → 双星轨道', from: 0, to: 9 },
    { id: 'ch2', title: '第二章 · 引力深井', subtitle: '深井引力 → 双子恒星', from: 10, to: 19 },
    { id: 'ch3', title: '第三章 · 风暴核心', subtitle: '乱流迷宫 → 风暴核心', from: 20, to: 29 },
  ];

  global.CAMPAIGN_LEVELS = Object.freeze(LEVELS);
  global.CHAPTERS = Object.freeze(CHAPTERS.map(c => Object.freeze(c)));
})(typeof window !== 'undefined' ? window : globalThis);
