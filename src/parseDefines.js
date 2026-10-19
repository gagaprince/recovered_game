'use strict';
const parser = require('@babel/parser');

const START_RE = /^define\("([^"]+)", function\(require, module, exports\) \{$/;
const END_LINE = '});';

function tryParseFunctionBody(body) {
  try {
    parser.parse('function __m__(){' + body + '\n}', { sourceType: 'script' });
    return true;
  } catch (e) { return false; }
}

// define 从行首开始；结束于第一个能让“函数体”完整通过语法解析的行首 "});"。
// 嵌套 define 的 "});" 会造成未闭合/多余标记，解析必然失败，因此判定可靠。
function splitDefines(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(START_RE);
    if (!m) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] !== END_LINE) continue;
      const body = lines.slice(i + 1, j).join('\n');
      if (tryParseFunctionBody(body)) { end = j; break; }
    }
    if (end !== -1) {
      out.push({ name: m[1], body: lines.slice(i + 1, end).join('\n'), startLine: i, endLine: end });
      i = end;
    }
  }
  return out;
}

function pickTarget(defines, target) {
  if (target) {
    const hit = defines.find(d => d.name === target);
    if (!hit) throw new Error('未找到模块: ' + target);
    return hit;
  }
  let best = null, bestScore = 0;
  for (const d of defines) {
    const hasTable = /String\.prototype\.s\s*=\s*function/.test(d.body) && /new Array\(\d+\)/.test(d.body);
    const hasRegister = d.body.includes('System.register') || /System\[[A-Za-z_$][\w$]*\]/.test(d.body);
    if (!hasTable && !hasRegister) continue;
    const score = (hasTable ? 1e12 : 0) + (hasRegister ? 1e6 : 0) + d.body.length / 1e3;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (!best) throw new Error('没有找到含 System.register 业务代码的 define 模块');
  return best;
}

module.exports = { splitDefines, pickTarget };
