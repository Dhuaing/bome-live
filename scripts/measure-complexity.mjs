/**
 * 代码质量度量：函数长度 + 分支点数量。
 * 只做启发式统计（按缩进花括号配对），够用来定位坏味道。
 *
 * 用法：node scripts/measure-complexity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'scripts', 'cloudfunctions', 'config'];
const EXTS = ['.ts', '.tsx', '.js'];
const IGNORE = ['node_modules', 'dist', 'dist-h5', 'dist-weapp', '.swc'];

/** 递归收集源文件 */
function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (EXTS.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** 统计一段文本里的分支点（if / else if / case / && / || / ?: / catch） */
function countBranches(text) {
  const patterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bcase\s+/g,
    /&&/g,
    /\|\|/g,
    /\?[^:?]*:/g,
    /\bcatch\s*\(/g
  ];
  let n = 0;
  for (const p of patterns) n += (text.match(p) || []).length;
  return n;
}

/**
 * 用「花括号配对 + 缩进」粗略切出函数体。
 * 识别 function xxx(...) { / const xxx = (...) => { / exports.main = async (...) => {
 */
function extractFunctions(src) {
  const lines = src.split('\n');
  const results = [];

  const fnStart = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(?[^)]*\)?\s*=>\s*\{/,
    /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/,
    /^\s*(\w+)\s*\([^)]*\)\s*\{/,
    /^\s*(?:async\s+)?(\w+)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name = null;
    for (const re of fnStart) {
      const m = line.match(re);
      if (m) { name = m[1]; break; }
    }
    if (!name) continue;
    if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;

    // 从这一行开始做花括号配对
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') depth--;
      }
      if (started && depth <= 0) { end = j; break; }
    }
    const body = lines.slice(i, end + 1).join('\n');
    results.push({
      name,
      line: i + 1,
      length: end - i + 1,
      branches: countBranches(body)
    });
    i = end;
  }
  return results;
}

const files = ROOTS.flatMap((r) => collect(r));
const all = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const fn of extractFunctions(src)) all.push({ file: f, ...fn });
}

// 阈值：函数 > 40 行 或 分支 > 10 视为超标
const LONG = 40;
const BRANCHY = 10;

const long = all.filter((x) => x.length > LONG).sort((a, b) => b.length - a.length);
const branchy = all.filter((x) => x.branches > BRANCHY).sort((a, b) => b.branches - a.branches);

console.log(`共统计 ${all.length} 个函数，${files.length} 个文件\n`);

console.log(`=== 超长函数（> ${LONG} 行）: ${long.length} 个 ===`);
for (const x of long.slice(0, 12)) {
  console.log(`  ${String(x.length).padStart(4)} 行  ${String(x.branches).padStart(3)} 分支  ${x.file}:${x.line}  ${x.name}()`);
}

console.log(`\n=== 高分支函数（> ${BRANCHY}）: ${branchy.length} 个 ===`);
for (const x of branchy.slice(0, 12)) {
  console.log(`  ${String(x.branches).padStart(3)} 分支  ${String(x.length).padStart(4)} 行  ${x.file}:${x.line}  ${x.name}()`);
}

const totalLines = files.reduce((s, f) => s + fs.readFileSync(f, 'utf8').split('\n').length, 0);
console.log(`\n=== 代码库规模 ===`);
console.log(`  源文件 ${files.length} 个，共 ${totalLines} 行`);
