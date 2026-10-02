// 样式契约测试公共读取器：按层叠顺序拼接 css/ 下全部样式文件。
// 背景：style.css 已按 ①~⑬ 区块拆分为 css/ 6 文件，因此凡是需要「整份样式文本」的断言
// （class 定义 / 设计 token / 断点数量 / 花括号配平 / @import 与外部 URL 检查）都改为读取合并结果。
// FILES 顺序 = index.html 中 <link> 的层叠顺序，勿随意调整。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = ['tokens.css', 'components.css', 'screens.css', 'overlays.css', 'menu.css', 'panels.css', 'motion.css', 'responsive.css'];

function readAllCss() {
  return FILES.map(f => fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')).join('\n');
}
readAllCss.FILES = FILES;

module.exports = readAllCss;
