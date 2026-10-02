// 测试沙箱公共加载清单（唯一真源）
// 目的：把「会被拆分 / 新增」的 js 文件清单集中到一处。拆分 js/game.js、js/input.js 时，
//       只需修改本文件即可，无需逐个改 18+ 个测试套件的内联 load() 序列。
//
// 用法（各套件保留自己的桩实现与断言语义不变）：
//   原先： load('js/game.js');  load('js/input.js');
//   现在： loadFiles(load, GAME_FILES);  loadFiles(load, UI_FILES);
//
// 依赖顺序（与 index.html 的 <script> 顺序一致，勿调整）：
//   physics → predictor → predictorRenderer → audio → levels-campaign → render
//   → GAME_FILES（game 层）→ UI_FILES（input 层）
'use strict';

// game 层：拆分为 [core, persist, achievements, challenge, records, daily, progress, waves, world, flow, game]
// （顺序即依赖顺序，勿调整；persist 层内部再按主题拆分，对外仍经 window.SS 暴露同名 API）。
const GAME_FILES = ['js/core.js', 'js/persist.js', 'js/achievements.js', 'js/challenge.js',
  'js/records.js', 'js/daily.js', 'js/progress.js', 'js/waves.js', 'js/world.js', 'js/flow.js', 'js/game.js'];

// input/UI 层：拆分后为 [ui/menu, ui/hud, ui/panels, ui/result, input]；当前已拆出 ui/panels、ui/result。
const UI_FILES = ['js/ui/menu.js', 'js/ui/hud.js', 'js/ui/panels.js', 'js/ui/result.js', 'js/input.js'];

// 参与「纯单机自查」（无网络 API）的全部模块源文件；拆分后自动覆盖新文件。
const SOURCE_FILES = [
  'js/physics.js', 'js/predictor.js', 'js/predictorRenderer.js',
  'js/audio.js', 'js/render.js', 'js/levels-campaign.js',
].concat(GAME_FILES, UI_FILES);

// 依次加载给定文件（load 为各套件自己的 vm 加载函数）
function loadFiles(load, list) {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) load(list[i]);
}

module.exports = { GAME_FILES, UI_FILES, SOURCE_FILES, loadFiles };
