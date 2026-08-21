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

  // 4 种重力场景主题，按关卡分组循环（每章 6 关），保证多样性与递进
  // theme 决定场景中额外放置的黑洞/恒星，以及默认来袭边角偏好
  const THEMES = [
    { key: 'calm',   name: '宁静星域', holes: 0, stars: 0 },
    { key: 'dual',   name: '双星轨道', holes: 2, stars: 0 },
    { key: 'well',   name: '深井引力', holes: 1, stars: 0 },
    { key: 'binary', name: '双子恒星', holes: 0, stars: 2 },
    { key: 'maze',   name: '乱流迷宫', holes: 3, stars: 1 },
    { key: 'storm',  name: '风暴核心', holes: 4, stars: 2 },
  ];

  const N = 30; // 总关卡数
  const LEVELS = [];
  const rng = mulberry32(0x5CA1AB1E); // 固定种子 → 可复现

  // 基于关卡特征生成确定性简介（无随机，所有用户一致）。
  // themeName 描述场景引力环境；stage 描述整体难度阶段；cometPct 描述威胁构成。
  function buildIntro(theme, idx, waveCount, holeN, starN, cometRatio) {
    const stage =
      idx < 6 ? '入门关，适合熟悉引力布防的基本操作。'
        : idx < 12 ? '挑战升级，来袭更密、更快，考验你的布防节奏。'
        : idx < 18 ? '关卡核心期，多目标同屏，需兼顾拦截与防守。'
        : idx < 24 ? '高手关卡，高速彗星与密集波次轮番轰炸。'
        : '终局挑战，极限速度与强度的终极考验。';
    const env =
      holeN > 0 && starN > 0 ? `场内有 ${holeN} 个黑洞与 ${starN} 颗恒星交织引力场。`
        : holeN > 0 ? `场内有 ${holeN} 个黑洞形成引力漩涡。`
        : starN > 0 ? `场内有 ${starN} 颗恒星提供强大引力。`
        : '场内无额外引力天体，母星孤悬星海。';
    const comet = Math.round(cometRatio * 100);
    return `${theme.name}。${stage}${env}来袭威胁中约 ${comet}% 为高速彗星，共 ${waveCount} 波。`;
  }

  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);              // 0..1 难度进度
    const theme = THEMES[Math.floor(i / 5) % THEMES.length];

    // 母星血量：28 → 16 渐降
    const health = Math.round(clamp(28 - t * 12, 16, 28));
    // 星能预算：650 → 380 渐降（越后面越考验布防效率）
    const budget = Math.round(clamp(650 - t * 270, 380, 650));
    // 波次数：8 → 22 渐增
    const waveCount = Math.round(clamp(8 + t * 14, 8, 22));
    // 全局难度系数（喂给 spawnThreat 计算速度与质量）
    const difficulty = Number((0.5 + t * 0.95).toFixed(2)); // 0.50 → 1.45
    // 彗星占比：0.15 → 0.5 渐增（更难拦截）
    const cometRatio = clamp(0.15 + t * 0.35, 0.15, 0.5);

    // 场景额外天体（黑洞/恒星），按主题 + 难度逐步增多
    const blackholes = [];
    const stars = [];
    let holeMass = 2600 + Math.round(t * 2600);
    for (let h = 0; h < theme.holes; h++) {
      const ang = (Math.PI * 2 / theme.holes) * h + 0.4;
      const dist = 200 + Math.round(t * 90);
      blackholes.push({
        dx: Math.round(Math.cos(ang) * dist),
        dy: Math.round(Math.sin(ang) * dist),
        mass: holeMass, radius: 11 + Math.round(t * 5),
      });
    }
    let starMass = 4200 + Math.round(t * 3200);
    for (let s = 0; s < theme.stars; s++) {
      const ang = (Math.PI * 2 / theme.stars) * s + 1.1;
      const dist = 240 + Math.round(t * 70);
      stars.push({
        dx: Math.round(Math.cos(ang) * dist),
        dy: Math.round(Math.sin(ang) * dist),
        mass: starMass, radius: 14 + Math.round(t * 6),
      });
    }

    // 确定性生成波次：每波若干来袭，spread/edge/speed/mass 随难度递增
    const waves = [];
    for (let w = 0; w < waveCount; w++) {
      const wt = (w + 1) / waveCount;             // 波次内进度 0..1
      const count = Math.round(clamp(3 + (t * 4) + wt * 3, 3, 12));
      const spreadArc = clamp(0.5 + t * 1.2 + wt * 0.4, 0.5, 2.4); // 覆盖角范围（弧度）
      const baseSpeed = Number((70 + t * 120 + wt * 40).toFixed(1));
      const mass = Math.round(clamp(28 + t * 70 + wt * 30, 24, 150));
      const spawns = [];
      for (let s = 0; s < count; s++) {
        const isComet = rng() < cometRatio;
        const edge = rng() < 0.5 ? 'left' : 'right';
        const spread = (rng() - 0.5) * spreadArc;   // 相对本波中心角的偏移
        spawns.push({
          kind: isComet ? 'comet' : 'asteroid',
          edge,
          spread: Number(spread.toFixed(3)),
          speed: Number((baseSpeed * (isComet ? 1.25 : 1)).toFixed(1)),
          mass: Math.round(mass * (isComet ? 0.7 : 1)),
          radius: isComet ? 7 : Math.round(clamp(14 + mass / 9, 14, 26)),
        });
      }
      waves.push({
        interval: Number(clamp(0.7 - t * 0.25, 0.35, 0.7).toFixed(2)), // 来袭间隔随难度变快
        spawns,
      });
    }

    const roman = ['一','二','三','四','五','六','七','八','九','十',
      '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
      '二十一','二十二','二十三','二十四','二十五','二十六','二十七','二十八','二十九','三十'];

    LEVELS.push(Object.freeze({
      id: 'camp-' + (i + 1),
      name: '第' + roman[i] + '关 · ' + theme.name,
      desc: '难度 ' + difficulty.toFixed(2) + ' · ' + waveCount + ' 波 · 彗星 ' + Math.round(cometRatio * 100) + '%',
      // 关卡简介：介绍本关场景特色与挑战（确定性生成，所有用户一致）
      intro: buildIntro(theme, i, waveCount, blackholes.length, stars.length, cometRatio),
      // 关卡目标（塔防式清晰文案）与结束条件，供开局横幅与结算展示
      objective: '守住母星，击退全部 ' + waveCount + ' 波来袭威胁',
      failCondition: '母星生命值（' + health + ' 点）归零',
      health, budget, difficulty,
      scene: { blackholes: Object.freeze(blackholes), stars: Object.freeze(stars) },
      waves: Object.freeze(waves),
    }));
  }

  global.CAMPAIGN_LEVELS = Object.freeze(LEVELS);
})(typeof window !== 'undefined' ? window : globalThis);
