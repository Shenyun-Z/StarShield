# 修改日志 (Changelog)

> 相对 GitHub 上一版本（origin/main）的全部改动记录。
> 更新日志仅记录于此文件与 git commit message，不写入 README.md。

## [本次累计改动] 2026-08-21

### -３、关卡布局修复 + 关卡简介 + 难度/确定性强化（追加）
- **第一行关卡无法显示（布局 bug）**：根因是菜单 `.menu` 为 `flex-direction: column; justify-content: center; overflow-y: auto`——当 30 个关卡卡片铺开后内容超高时，flex 居中会把**顶部溢出内容裁掉且无法向上滚动**（flexbox 经典溢出裁剪）。修复：改为 `justify-content: flex-start` + 首尾 `auto margin`（`.menu h1 { margin-top:auto }`、`.menu .menu-footer { margin-bottom:auto }`），内容少时垂直居中、内容超高时可从顶部完整滚动，第一行关卡不再被裁切。
- **关卡简介（intro）**：`levels-campaign.js` 每关新增确定性 `intro` 字段（`buildIntro` 基于主题/阶段/黑洞/恒星/彗星比/波次生成，如「双星轨道。挑战升级，场内有 2 个黑洞形成引力漩涡…」）；game.js 生存 3 关也补齐 `intro`。关卡卡片 `lc-desc` 改显简介，技术指标（难度/波次/彗星比）移入小字 `lc-meta`。
- **难度严格递增 + 确定性强化**：`determinism.test.js` 增加 `intro` 字段断言、难度改为**严格递增**（`<=` 判失败）、波次数非递减断言。全部关卡由固定种子 mulberry32 确定性生成，三次加载内容完全一致、无 `Math.random`——保证不同用户看到的关卡内容完全一致、无随机/差异。
- 验证：新增 `test/intro.test.js`（8 项：30 关 intro、生存 intro、卡片渲染含简介、菜单 flex-start 布局、难度严格递增）。全部 10 套测试通过、lint 0 错误。

### -２、分数整数化 + 显示/稳定性全面审查（追加）
- **分数浮点 bug 根因修复**（用户报告：生存最佳分数显示 `274.03333333`）：
  - 根因：生存模式存活分每帧 `+1/30`（`sv = dtFrame*2`）令 `state.score` 累积为浮点；`updateBest` 直接把浮点存入 `bestScore` 并写入 localStorage。
  - 修复：新增 `integerScore()`（由四类计分明细各自取整后代数求和推导整数总分），`updateBest` 比较/存储前取整，`bestForMode` 返回取整值，`getCurrentRunStats().score` 与 HUD `scoreVal` 均改用 `integerScore()`——保证**总分恒为整数、且与结算面板明细之和严格一致**（消除浮点 ±1 显示漂移）。
  - 旧浮点存档由 `loadBest` 的 `parseInt` 自动归一化。
- **清除进度后「开局方式」显示不一致**：`doClearProgress` 删除存档后，"沿用上次布防"按钮仍显示。提取 `refreshSetupOptions()`，清空进度后同步隐藏该按钮并回"从零开始"。
- **空关卡列表兜底**：`renderCtaHint` 在关卡加载异常时禁用开始按钮并提示，避免读取 `undefined` 崩溃。
- **结算副标题边界防御**：`totalWaves/duration/wave` 为空时 `|| 0`，避免拼接 "null 波"。
- **血条除零防御**：`health / (state.level.health || 1)`。
- 验证：新增 `test/score-type.test.js`（旧浮点存档归一、bestForMode 整数、存活分累积后结算总分整数且与明细一致）；`test/score.test.js` 追加 `integerScore` 一致性断言。全部 9 套测试通过、lint 0 错误。

### -１、关卡目标与结束条件清晰化展示（追加）
- **关卡目标字段**：`levels-campaign.js` 每关新增 `objective`（如「守住母星，击退全部 12 波来袭威胁」）与 `failCondition`（如「母星生命值（20 点）归零」）；game.js 生存模式 3 关同样补充。
- **开局横幅增强**（参考《保卫萝卜》式目标提示）：`#levelBanner` 由"关卡名+描述"改为置顶居中的三行横幅——关卡名 / 🎯 目标 / ⚠️ 失败条件，停留 3.6 秒自动淡出，`pointer-events:none` 不遮挡核心游玩区，移动端 `min(560px, 86vw)` 自适应。
- **常驻进度**：HUD 波次在闯关模式常驻显示「当前波/总波」（如 3/10），实时可见剩余波数；生存模式显示剩余时间（已有）。
- **结算面板**：
  - 标题明确结果（通关！/ 防线失守 / 母星陨落 / 时间到），副标题说明成功或失败原因（"已击退全部 N 波，目标达成" / "母星被摧毁，止步于第 N 波"）。
  - **胜利时显示「下一关」按钮**：闯关模式通关后直接解锁并进入下一关；失败则隐藏。
- 验证：新增 `test/objective.test.js`（13 项：目标字段、横幅渲染、波次进度、下一关显隐、成败文案）；`determinism.test.js` 增加每关 objective/failCondition 断言。全部 8 套测试通过、lint 0 错误。

### 〇、模式重构 + 清除进度（需求1/2，追加）
- **极限模式 → 闯关模式**：模式标识 `extreme` 全链路改为 `campaign`（index.html / input.js / game.js），UI 文案、HUD、结算面板全部对齐。
- **关卡扩至 30 关、层层递进**：新增 `js/levels-campaign.js`（替换并删除 `levels-extreme.js`），用 mulberry32 固定种子确定性生成 30 关，母星血量随关卡递减、星能收紧、波次增多、来袭速度/质量提升、彗星占比上升、难度系数单调递增；每关 `Object.freeze`，运行时零随机、所有用户一致（公平）。
- **解锁制**：只有通关当前关才能开启下一关。`localStorage['starshield_campaign_unlocked']` 记录最高解锁索引，`startGame` 对未解锁关卡返回 `false` 拒绝开局，菜单关卡卡片渲染锁定态（🔒）。
- **成就记录 = 通关到第 N 关**：菜单 `本机成就` 显示「闯关已通关 N 关」，替代旧的"撑过波次"。
- **一键清除进度（三个层级入口）**：
  - 菜单底部 `#menuClearProg`「一键清除进度」
  - 结算面板 `#resultClear`「清除进度」
  - 游戏内控制条 `#clearBtn`「清除进度」
  - 均带二次确认；`game.clearAllProgress()` 清空全部 `starshield_*` 键（best_score/best_waves/setup/campaign_unlocked/audio），清除后回菜单、重选第 1 关、刷新成就显示。
- 验证：新增 `test/unlock.test.js`（解锁制 + 清除进度全链路），`test/determinism.test.js` 改为验证 30 关确定性/递进，`setup/score/result-ui` 全部迁移到 `campaign`。全部 7 套测试通过、lint 0 错误。

### 一、致命加载问题修复（导致游戏无法运行）
- **render.js IIFE 参数缺失**：IIFE 被误改为 `(function () {`，但其内部使用 `global.render` / `global.addEventListener`，`global` 未定义导致模块加载即崩溃，`render` 永不挂载，`loop()` 每帧抛异常、画面空白。
  - 修复：`(function () {` → `(function (global) {`，结尾 `})();` → `})(typeof window !== 'undefined' ? window : globalThis);`
- **game.js / render.js 括号不匹配**：stepFrame 多出闭合 `}`；render.js 重复 `if (ps && ps.length) {` 嵌套，级联语法错误。已修正。

### 二、碰撞与母星受击（核心玩法）
- **母星受击不扣分/无动画（根因修复）**：`physics.resolveCollisions` 中母星作为 `immovable` 天体被错误走"黑洞吞噬"分支（`captured=true`），永不产生 `hitStar`，导致 game.js 的 `damagePlanet` 从未被触发。
  - 修复：区分不可动方是否为母星（`anchor.isStar`）——母星走 `hitStar` 分支，其它走 `captured`；并新增 `registerClear()` 统一清除计分，dead 清理块对 `hitStar` 调用 `damagePlanet`（扣血 + 红震 + 冲击波 + 碎片 + 屏闪 + hit 音效）。
  - 验证：单元测试 `test/collision.test.js`、集成测试 `test/integration.test.js` 全绿。

### 三、黑洞行为
- 放置后**固定位置**（`anchored`/`immovable`，不受引力推动）。
- 放置后 **10 秒自动消失**（紫吸动画 + 冲击波 + 粒子 + 屏闪）。
- **移除关卡初始黑洞**：`setupLevel` 不再按 `scene.blackholes` 放置开局黑洞，开局画布纯空白（仅母星）。黑洞仅由玩家放置。

### 四、得分系统重构（统一、合理、含模式差异）
- 新增 `registerClear(body, method)` 统一拦截计分：
  - `base = 彗星 ? 12 : (6 + round(mass/8))`（质量反映威胁度）
  - `diffMul = 1 + max(0, difficulty-0.3)*1.4`（难度加权）
  - `modeMul = 极端 ? (1 + levelIndex*0.15) : 1`（极端后关加成）
  - `gain = round(base * diffMul * modeMul)`，至少 1 分；极端模式每清除返还 2 星能（资源循环）
- 波次清空奖励：`score += 15 + 5*wave`
- 失守惩罚：`score = max(0, score-8)`
- 生存模式存活分：每秒 `+2`
- 删除旧 `rewards` 死代码（分数与星能不再紊乱绑定）
- 结算快照新增明细字段 `scoreIntercept/scoreWaveBonus/scoreSurvive/scorePenalty/diffMul/modeMul`
- 验证：`test/score.test.js` 全绿

### 五、极限模式确定性配置（公平性）
- 新增 `js/levels-extreme.js`：用 mulberry32 固定种子 PRNG 生成 **4 个关卡 × 14~20 波 × 每波 3~16 威胁 ≈ 数百个确定性威胁单位**，写入文件供查阅/审计，运行时零随机、所有用户完全一致。
- game.js 极端模式改为读取 `state.level.waves` 数组（不再运行时随机），`spawnThreat` 消费 `{kind,edge,spread,speed,mass,radius}` 描述。
- 极限模式新增**通关胜利**：最后一波清空触发 `endGame('win')`，结算显示"通关！"。
- 验证：`test/determinism.test.js` 全绿（三次加载内容完全一致、无 Math.random、难度非递减）。

### 六、结算分数界面（任务1）
- 重做 `#result` 面板：展示「计分项 / 权重倍率 / 得分」三列表格 + 总分，含拦截清除、波次奖励、生存时长、失守惩罚四项明细及公式说明。
- 生存模式显示"生存时长奖励"行，极端模式隐藏该行。
- 新增对应 CSS（`.score-breakdown` 等）。

### 七、从零开始 / 沿用上次布防（任务3）
- **根因修复**：`startGame(opts)` 此前忽略 `opts.keepSetup`，无条件 `applySavedSetup()`，且开局 `if (!ok) saveSetup()` 会把空场覆盖真实存档。
  - 修复：仅当 `opts.keepSetup===true` 才应用存档；开局不再调用 `saveSetup`（存档在 `endGame` 时记录）。
- 验证：`test/setup.test.js` 全绿（从零不扣星能、沿用出现存档星体并扣减）。

### 八、测试套件（工程化）
- 新增 `test/` 目录：
  - `collision.test.js`（物理标记 hitStar、无初始黑洞）
  - `integration.test.js`（端到端撞击母星扣血+动画、耗尽 gameOver）
  - `score.test.js`（得分公式、模式差异、失守惩罚）
  - `determinism.test.js`（极限配置确定性）
  - `setup.test.js`（keepSetup 行为）
- 全部测试通过，所有改动文件 lint 0 错误。

### 九、已知待改进（任务4 分析，未在本次实现）
- 缺暂停 / 加速-减速时间控制
- 缺首次游玩引导动画与关卡地图选择
- 缺连击/连杀奖励、成就系统
- 缺多语言、音效开关 UI
- 玩法深度对比《保卫萝卜》：缺炮塔/陷阱多样性、怪物路径可视化、塔升级树、关卡剧情
