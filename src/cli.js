#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { splitDefines, pickTarget } = require('./parseDefines');
const { decodeStringTables } = require('./tables');
const { runBody } = require('./vm');
const { makeTransform } = require('./deob');

function parseArgs(argv) {
  const args = { _: [], out: null, target: null, raw: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--no-raw') args.raw = false;
    else args._.push(a);
  }
  return args;
}
function sanitize(name) {
  let s = name;
  try { s = decodeURIComponent(s); } catch (e) { /* 含非法 % 序列时保持原样 */ }
  return s.replace(/^chunks:\/\/\/_virtual\//, '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

function main() {
  const args = parseArgs(process.argv);
  const input = args._[0];
  if (!input) {
    console.log('用法: node src/cli.js <打包后的game.js> [-o 输出目录] [--target 模块名] [--no-raw]');
    process.exit(1);
  }
  const src = fs.readFileSync(input, 'utf8');
  console.log('[1/5] 切分 AMD define 模块...');
  const defines = splitDefines(src);
  console.log('      共 ' + defines.length + ' 个 define');
  const target = pickTarget(defines, args.target);
  console.log('      目标模块: ' + target.name + ' (' + (target.body.length / 1024 / 1024).toFixed(2) + ' MB)');

  const body = target.body;
  const outDir = args.out || path.join(process.cwd(), 'deob-out');
  fs.mkdirSync(path.join(outDir, 'readable'), { recursive: true });
  if (args.raw) fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'tables'), { recursive: true });

  console.log('[2/5] 静态解码字符串表...');
  const staticTables = decodeStringTables(body);
  for (const [name, arr] of Object.entries(staticTables)) {
    console.log('      字符串表 ' + name + ': ' + arr.filter(Boolean).length + ' 行');
    fs.writeFileSync(path.join(outDir, 'tables', name + '.json'), JSON.stringify(arr));
  }
  const tableVarMatch = body.match(/(\w+)\s*=\s*new Array\((\d+)\)/);
  const valueVarMatch = body.match(/var\s+(\w+)\s*=\s*function\(t\)\s*\{\s*for\s*\(var n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  const tableVar = tableVarMatch ? tableVarMatch[1] : Object.keys(staticTables)[0] || 'to';
  const valueVar = valueVarMatch ? valueVarMatch[1] : 'ro';
  console.log('      字符串表变量: ' + tableVar + '，数值表变量: ' + valueVar);

  console.log('[3/5] VM 执行，hook System.register...');
  const ran = runBody(body, { tableVar, valueVar });
  console.log('      捕获 ' + ran.modules.length + ' 个业务模块，外层常量 ' + Object.keys(ran.caps).length + ' 个');
  // 运行时表是权威真值（静态解码仅用于无 VM 时的兜底），覆盖之前的静态产物
  if (Array.isArray(ran.runtimeTable)) {
    fs.writeFileSync(path.join(outDir, 'tables', tableVar + '.json'), JSON.stringify(ran.runtimeTable));
  }
  fs.writeFileSync(path.join(outDir, 'tables', valueVar + '_entries.json'),
    JSON.stringify(Array.isArray(ran.runtimeValues) ? ran.runtimeValues.map((v, i) => [i, v]) : []));
  fs.writeFileSync(path.join(outDir, 'tables', 'outer_constants.json'), JSON.stringify(ran.caps, null, 1));

  const tables = {};
  tables[tableVar] = Array.isArray(ran.runtimeTable) ? ran.runtimeTable : (staticTables[tableVar] || []);
  const transform = makeTransform({
    tables,
    values: Array.isArray(ran.runtimeValues) ? ran.runtimeValues : [],
    caps: ran.caps,
    valueVar,
  });

  console.log('[4/5] Babel 反混淆 ' + ran.modules.length + ' 个模块...');
  const manifest = [];
  let okCount = 0, failCount = 0;
  for (const mod of ran.modules) {
    const fileBase = sanitize(mod.name);
    if (args.raw) fs.writeFileSync(path.join(outDir, 'raw', fileBase + '.js'), mod.factory);
    try {
      const readable = transform(mod.factory, mod.deps || []);
      fs.writeFileSync(path.join(outDir, 'readable', fileBase + '.js'), readable);
      const rf = readable.match(/_RF"\]\["push"\]\(\{\},\s*"([^"]*)",\s*"([^"]*)"/);
      manifest.push({ name: mod.name, file: fileBase + '.js', deps: mod.deps, scriptId: rf ? rf[1] : null, className: rf ? rf[2] : null, bytes: readable.length });
      okCount++;
    } catch (e) {
      failCount++;
      manifest.push({ name: mod.name, file: fileBase + '.js', deps: mod.deps, error: e.message });
      fs.writeFileSync(path.join(outDir, 'readable', fileBase + '.js'), mod.factory);
      console.log('      FAIL ' + mod.name + ': ' + e.message);
    }
  }

  console.log('[5/5] 输出 manifest 与索引...');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const index = [];
  index.push('# 反编译模块索引');
  index.push('');
  index.push('来源: ' + input);
  index.push('目标 define: ' + target.name);
  index.push('模块数: ' + manifest.length + '（成功 ' + okCount + '，失败 ' + failCount + '）');
  index.push('');
  for (const m of [...manifest].sort((a, b) => a.file.localeCompare(b.file))) {
    index.push('- `' + m.file + '` ' + (m.className ? m.className + ' ' : '') + (m.scriptId ? '[' + m.scriptId + '] ' : '') + 'deps: ' + ((m.deps || []).length));
  }
  fs.writeFileSync(path.join(outDir, 'MODULE_INDEX.md'), index.join('\n'));
  console.log('完成: ' + okCount + ' 成功, ' + failCount + ' 失败 → ' + outDir);
}
main();
