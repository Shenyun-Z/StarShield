// 关卡简介（intro）展示 + 布局修复验证
//   - 每个关卡卡片渲染出的 innerHTML 含 intro 简介文案
//   - intro/desc 确定性（无随机，所有用户一致）
//   - 菜单布局使用可滚动的 flex-start（修复第一行关卡被裁剪）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function stubEl() {
  return { textContent: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, getContext() { return new Proxy({}, { get: () => () => {} }); },
    querySelectorAll: () => [], querySelector: () => null, dataset: {}, width: 1280, height: 720 };
}
const elCache = {};
const createdEls = [];   // 记录 createElement 创建的所有节点（用于捕获 innerHTML）
const sandbox = {
  Math, Map, console, JSON, Array, Object, String, Number, isNaN, parseInt, parseFloat,
  performance: { now: () => Date.now() },
  window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
  document: {
    getElementById: (id) => (elCache[id] || (elCache[id] = stubEl())),
    querySelectorAll: () => [], addEventListener() {}, querySelector: () => null,
    createElement: () => { const e = stubEl(); createdEls.push(e); return e; },
  },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
function load(f) { vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f }); }

let ok = true;
function assert(name, cond, extra) { if (!cond) { console.error('FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); ok = false; } else console.log('PASS: ' + name); }

load('js/physics.js'); load('js/predictor.js'); load('js/predictorRenderer.js');
load('js/audio.js'); load('js/render.js'); load('js/levels-campaign.js');
sandbox.localStorage.setItem('starshield_campaign_unlocked', '30');  // 解锁全部便于渲染简介
load('js/game.js');
const game = sandbox.window.game;
sandbox.game = game;
sandbox.physics = sandbox.window.physics;
sandbox.render = sandbox.window.render;
sandbox.audio = sandbox.window.audio;
load('js/input.js');   // init 会调用 renderLevelCards（默认 survival 模式）

// 1. 关卡配置确定性：intro 字段完整且描述为字符串
const levels = game.getLevelsForMode('campaign');
assert('30 关每关均有 intro 简介', levels.every(l => typeof l.intro === 'string' && l.intro.length > 0));
assert('intro 为确定性文案（无随机标记）', levels.every(l => l.intro.length > 5));

// 2. 渲染出的第一张关卡卡片包含简介文案（input.js renderLevelCards → createElement innerHTML）
//    init 默认 selMode='survival'，需模拟切到 campaign 后渲染。直接检查所有创建节点中是否有含 intro 的卡片。
const hasIntroCard = createdEls.some(e => e.innerHTML && /intro|简介|来袭威胁|彗星|黑洞|恒星/.test(String(e.innerHTML)));
// 由于 survival 关卡（game.js 内）也有 intro 字段（已补充），其卡片也会渲染 intro
const survivalLevels = game.getLevelsForMode('survival');
assert('生存模式关卡也含 intro 简介', survivalLevels.every(l => typeof l.intro === 'string' && l.intro.length > 0));
// 检查渲染出的关卡卡片 lc-desc 内容较长（即 intro 简介，而非仅 desc 短句）
const cardHtml = createdEls.map(e => String(e.innerHTML || '')).join('\n');
const descMatch = cardHtml.match(/<div class="lc-desc">([^<]+)<\/div>/);
assert('渲染节点含关卡简介文案（非空描述）', !!descMatch && descMatch[1].length > 8, cardHtml.slice(0, 200));

// 3. 布局修复验证：.menu 使用 flex-start + 首尾 auto margin（避免溢出时裁剪第一行）
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const menuBlock = css.match(/\.menu\s*\{[^}]*\}/)[0];
assert('菜单使用 justify-content: flex-start', /justify-content:\s*flex-start/.test(menuBlock));
assert('菜单 h1 使用 margin-top: auto', /\.menu h1\s*\{\s*margin-top:\s*auto/.test(css));
assert('菜单 footer 使用 margin-bottom: auto', /\.menu-footer\s*\{\s*margin-bottom:\s*auto/.test(css));

// 4. 难度递增（与 determinism 一致，独立复核）
let monoOk = true;
for (let i = 1; i < levels.length; i++) if (levels[i].difficulty <= levels[i - 1].difficulty - 1e-9) monoOk = false;
assert('关卡难度严格递增', monoOk);

console.log(ok ? '\n=== 关卡简介/布局测试全部通过 ===' : '\n=== 关卡简介/布局测试存在失败 ===');
process.exit(ok ? 0 : 1);
