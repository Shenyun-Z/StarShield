// 文本转义回归（v1.16 / M12）
//   背景：界面层用 innerHTML 拼接 DOM，全部插值目前都来自本地静态表（章节标题、成就名、
//   结局文案），属于"现在安全、以后接输入就会破"的模式。本轮给 core.js 加了 SS.escHtml，
//   并把 6 处字符串插值改为过转义。本套件守住两件事：
//     A. 转义函数本身正确（5 个 HTML 元字符 + null/数字边界）
//     B. 6 处字符串插值没有被后续改动"抄回"成裸拼接（静态源码断言）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const sandbox = {
  Math, Object, Array, String, Number, Boolean, JSON, console,
  parseInt, parseFloat, isNaN, Infinity, NaN,
  window: { addEventListener() {} },
  document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/core.js'), 'utf8'), sandbox, { filename: 'core.js' });

const esc = sandbox.window.SS.escHtml;

let ok = true;
function assert(name, cond, extra) {
  if (!cond) { console.error('FAIL: ' + name + (extra != null ? ' (' + extra + ')' : '')); ok = false; }
  else console.log('PASS: ' + name);
}

/* ---- A. 转义函数 ---- */
{
  assert('A1. 导出存在且为函数', typeof esc === 'function');
  assert('A2. 尖括号被实体化', esc('<img src=x onerror=alert(1)>').indexOf('<') < 0
    && esc('<b>').indexOf('&lt;b&gt;') === 0, esc('<b>'));
  assert('A3. 双引号与单引号被实体化', esc('a"b\'c') === 'a&quot;b&#39;c', esc('a"b\'c'));
  assert('A4. & 先行转义（不会被二次解释为实体）', esc('a&b') === 'a&amp;b', esc('a&b'));
  assert('A5. 连续特殊字符不被重复转义',
    esc('&lt;') === '&amp;lt;', esc('&lt;'));
  assert('A6. null / undefined 转为空串', esc(null) === '' && esc(undefined) === '', esc(null));
  assert('A7. 数字与中文原样保留', esc(120) === '120' && esc('第三十关 · 宁静星域') === '第三十关 · 宁静星域');
  assert('A8. 典型 XSS payload 输出中不含可执行标签',
    esc('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;', esc('<script>alert(1)</script>'));
}

/* ---- B. 插值点静态守卫 ---- */
{
  const menu = fs.readFileSync(path.join(root, 'js/ui/menu.js'), 'utf8');
  const result = fs.readFileSync(path.join(root, 'js/ui/result.js'), 'utf8');
  const raw = [
    { file: 'js/ui/menu.js', src: menu, field: 'ch.title', bare: '${ch.title}' },
    { file: 'js/ui/menu.js', src: menu, field: 'ch.subtitle', bare: '${ch.subtitle}' },
    { file: 'js/ui/result.js', src: result, field: 'a.name', bare: '${a.name}' },
    { file: 'js/ui/result.js', src: result, field: 'a.desc', bare: '${a.desc}' },
    { file: 'js/ui/result.js', src: result, field: 'ending.title', bare: "' + ending.title + '" },
    { file: 'js/ui/result.js', src: result, field: 'ending.text', bare: "' + ending.text + '" },
  ];
  for (const r of raw) {
    assert('B. ' + r.file + ' 的 ' + r.field + ' 已过 escHtml（无裸拼接）',
      r.src.indexOf(r.bare) < 0 && r.src.indexOf('window.SS.escHtml(' + r.field + ')') >= 0);
  }
}

console.log(ok ? '\n=== 文本转义回归全部通过 ===' : '\n=== 文本转义回归存在失败 ===');
process.exit(ok ? 0 : 1);
