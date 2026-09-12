#!/usr/bin/env node
/**
 * 统一测试入口（零依赖，M4）
 *   1) 对仓库内全部 .js 做语法检查（node --check）
 *   2) 依次执行 test/*.test.js 全部测试套件
 *   3) 任一失败 → 退出码 1（供 npm test / CI 作为质量门使用）
 *
 * 用法：
 *   node test/run-all.js              # 语法检查 + 全部测试
 *   node test/run-all.js --syntax-only
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IGNORE_DIRS = new Set(['node_modules', '.git', '.codebuddy']);
const syntaxOnly = process.argv.includes('--syntax-only');

function collectJs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      collectJs(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function run(cmd, args, stdio) {
  return execFileSync(cmd, args, { stdio: stdio || 'pipe', cwd: ROOT });
}

let failed = 0;

// ---- 1) 语法检查 ----
const jsFiles = collectJs(ROOT, []).sort();
console.log('== 语法检查：' + jsFiles.length + ' 个文件 ==');
for (const f of jsFiles) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  try {
    run(process.execPath, ['--check', f]);
  } catch (e) {
    failed++;
    console.error('FAIL 语法错误: ' + rel);
    if (e.stderr) console.error(String(e.stderr).trim());
  }
}
if (failed === 0) console.log('OK   ' + jsFiles.length + ' 个文件语法正常');
if (syntaxOnly) {
  console.log(failed === 0 ? '\n== 仅语法检查：全部通过 ==' : '\n== 仅语法检查：存在失败 ==');
  process.exit(failed === 0 ? 0 : 1);
}

// ---- 2) 测试套件 ----
const suites = fs.readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .sort();
console.log('\n== 测试套件：' + suites.length + ' 套 ==');
const results = [];
for (const s of suites) {
  const file = path.join(ROOT, 'test', s);
  try {
    run(process.execPath, [file], 'inherit');
    results.push('PASS ' + s);
  } catch (e) {
    failed++;
    results.push('FAIL ' + s);
  }
}

console.log('\n== 汇总 ==');
for (const r of results) console.log(r);
console.log('语法: ' + jsFiles.length + ' 文件 | 测试: ' + suites.length + ' 套 | 失败: ' + failed);
process.exit(failed === 0 ? 0 : 1);
