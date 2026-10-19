'use strict';
// 静态还原字符串表：$s = Qs("乱序串", n), table[k] = $s.s(chunkSize)
// 原始字符串 = 整体反转后按 chunkSize 切分，再逐块反转、按原顺序拼接。
function reverseString(s) {
  const a = Array.from(s);
  for (let l = 0, r = a.length - 1; l < r; l++, r--) { const t = a[l]; a[l] = a[r]; a[r] = t; }
  return a.join('');
}
function chunk(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
function decodeStringTables(body) {
  const re = /([\w$]+)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*\d+\s*\)\s*,\s*(\w+)\s*\[\s*(\d+)\s*\]\s*=\s*[\w$]+\.s\((\d+)\)/g;
  const tables = {}; // tableVar -> {size, rows: Map(k->chunks)}
  let m;
  while ((m = re.exec(body))) {
    const literal = Function('return ' + m[2])();
    const tableVar = m[3], key = +m[4], size = +m[5];
    const reversed = reverseString(literal);
    if (reversed.length % size !== 0) continue; // 非目标形态
    const chunksOut = chunk(reversed, size).map(reverseString);
    if (!tables[tableVar]) tables[tableVar] = { rows: new Map() };
    tables[tableVar].rows.set(key, chunksOut);
  }
  // 输出为稀疏数组
  const result = {};
  for (const [name, t] of Object.entries(tables)) {
    let max = -1;
    for (const k of t.rows.keys()) max = Math.max(max, k);
    const arr = new Array(max + 1);
    for (const [k, v] of t.rows) arr[k] = v;
    result[name] = arr;
  }
  return result;
}
module.exports = { decodeStringTables, reverseString };
