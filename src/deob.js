'use strict';
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generate = require('@babel/generator').default;

function numKey(node) {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node) && /^\d+$/.test(node.value)) return +node.value;
  return null;
}

// 形态1：(X = obj)["setters"] = [fn,...]
// 形态2：{ "setters": [fn,...] }
// 必须在“赋值所在路径”上用 scope.getBinding 向外查到真正的外层导入绑定，
// 否则方法内部的同名局部变量（混淆器高频复用单字母名）会抢先被错误改名。
function renameImports(ast, deps) {
  const usedNames = new Set();
  const renamedBindings = new Set();
  const renameOne = (assignPath, want) => {
    const oldName = assignPath.node.left.name;
    const binding = assignPath.scope.getBinding(oldName);
    if (!binding || renamedBindings.has(binding)) return;
    let wantName = want;
    if (!/^[A-Za-z_$][\w$]*$/.test(wantName)) wantName = '_' + wantName.replace(/\W/g, '_');
    if (binding.identifier.name === wantName) { renamedBindings.add(binding); return; }
    const owner = binding.scope;
    if (owner.hasBinding(wantName) || usedNames.has(wantName)) {
      let i = 2;
      while (owner.hasBinding(wantName + '_' + i) || usedNames.has(wantName + '_' + i)) i++;
      wantName = wantName + '_' + i;
    }
    usedNames.add(wantName);
    try { owner.rename(oldName, wantName); renamedBindings.add(binding); } catch (e) { /* 保留原名 */ }
  };
  const handleSetter = (fnPath, idx) => {
    const node = fnPath.node;
    if (!(t.isFunctionExpression(node) || t.isArrowFunctionExpression(node))) return;
    const paramNames = new Set(node.params.filter(t.isIdentifier).map(pa => pa.name));
    const dep = (deps && deps[idx]) || '';
    const base = dep.replace(/^\.\//, '').replace(/\.(js|ts|mjs)$/, '').split('/').pop() || 'mod';
    const stmts = (node.body && node.body.body) || [];
    const assignPaths = [];
    fnPath.traverse({
      AssignmentExpression(ap) {
        const a = ap.node;
        if (a.operator !== '=' || !t.isIdentifier(a.left) || !t.isMemberExpression(a.right) ||
            !t.isIdentifier(a.right.object) || !paramNames.has(a.right.object.name)) return;
        const propNode = a.right.property;
        const prop = a.right.computed
          ? (t.isStringLiteral(propNode) ? propNode.value : null)
          : (t.isIdentifier(propNode) ? propNode.name : null);
        if (prop == null) return;
        if (!stmts.includes(ap.getStatementParent().node)) return;
        assignPaths.push({ ap, prop });
      }
    });
    for (const { ap, prop } of assignPaths) {
      if (prop === '__esModule') continue;
      renameOne(ap, prop === 'default' ? base : prop);
    }
  };
  traverse(ast, {
    AssignmentExpression(p) {
      const a = p.node;
      const isSettersMember = t.isMemberExpression(a.left) &&
        ((a.left.computed && t.isStringLiteral(a.left.property, { value: 'setters' })) ||
         (!a.left.computed && t.isIdentifier(a.left.property, { name: 'setters' })));
      if (a.operator === '=' && t.isArrayExpression(a.right) && isSettersMember) {
        a.right.elements.forEach((el, idx) => {
          if (!el) return;
          const fp = p.get('right.elements.' + idx);
          if (fp.node) handleSetter(fp, idx);
        });
      }
    },
    ObjectExpression(p) {
      const propIdx = p.node.properties.findIndex(pr => t.isObjectProperty(pr) && t.isArrayExpression(pr.value) &&
        ((t.isIdentifier(pr.key) && pr.key.name === 'setters') ||
         (t.isStringLiteral(pr.key) && pr.key.value === 'setters')));
      if (propIdx < 0) return;
      p.node.properties[propIdx].value.elements.forEach((el, idx) => {
        if (!el) return;
        const fp = p.get('properties.' + propIdx + '.value.elements.' + idx);
        if (fp.node) handleSetter(fp, idx);
      });
    }
  });
}

function makeTransform({ tables = {}, values = [], caps = {}, valueVar = 'ro' } = {}) {
  const tableVar = Object.keys(tables)[0] || 'to';
  const table = tables[tableVar] || [];
  const valueArr = Array.isArray(values) ? values : [];

  function resolve(expr, scope, depth = 0) {
    if (depth > 10) return null;
    if (t.isStringLiteral(expr)) return { kind: 'str', value: expr.value };
    if (t.isNumericLiteral(expr)) return { kind: 'num', value: expr.value };
    if (t.isMemberExpression(expr) && expr.computed) {
      const k = numKey(expr.property);
      if (k == null) return null;
      const b = resolve(expr.object, scope, depth + 1);
      if (!b) return null;
      if (b.kind === 'tableRef') { const row = table[k]; return Array.isArray(row) ? { kind: 'tableRow', value: row } : null; }
      if (b.kind === 'tableRow') { const v = b.value[k]; return typeof v === 'string' ? { kind: 'str', value: v } : null; }
      if (b.kind === 'valuesRef') {
        const v = valueArr[k];
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? { kind: 'num', value: n } : { kind: 'str', value: String(v) };
      }
      return null;
    }
    if (t.isIdentifier(expr)) {
      const binding = scope.getBinding(expr.name);
      if (!binding) {
        if (expr.name === tableVar) return { kind: 'tableRef' };
        if (expr.name === valueVar) return { kind: 'valuesRef' };
        if (Object.prototype.hasOwnProperty.call(caps, expr.name)) {
          const v = caps[expr.name];
          return typeof v === 'string' ? { kind: 'str', value: v } : { kind: 'num', value: v };
        }
        return null;
      }
      if (binding.path.isVariableDeclarator() && binding.constant) return resolve(binding.path.node.init, binding.scope, depth + 1);
      return null;
    }
    return null;
  }

  return function transform(code, deps = []) {
    const ast = parser.parse('(' + code + ')', { sourceType: 'script' });
    const crawlScopes = () => traverse(ast, { Program(p) { p.scope.crawl(); } });
    const literalOf = r => r.kind === 'str' ? t.stringLiteral(r.value) : t.numericLiteral(r.value);
    // 计算属性本身是 to/ro/外层常量 标识符时（如 obj[St]），先把键还原成字面量
    const resolveComputedKey = (p, mark) => {
      const node = p.node;
      if (!node.computed || !t.isIdentifier(node.property)) return;
      const r = resolve(node.property, p.scope);
      if (!r || (r.kind !== 'str' && r.kind !== 'num')) return;
      if (r.kind === 'str' && /^[A-Za-z_$][\w$]*$/.test(r.value)) {
        node.property = t.identifier(r.value);
        node.computed = false;
      } else {
        node.property = literalOf(r);
      }
      mark();
    };
    for (let iter = 0; iter < 12; iter++) {
      let changed = false;
      traverse(ast, {
        MemberExpression(p) {
          resolveComputedKey(p, () => { changed = true; });
          if (!p.node.computed) return;
          const r = resolve(p.node, p.scope);
          if (r && (r.kind === 'str' || r.kind === 'num')) {
            p.replaceWith(literalOf(r));
            changed = true;
          }
        },
        Identifier(p) {
          const binding = p.scope.getBinding(p.node.name);
          if (!binding || !binding.constant || !binding.path.isVariableDeclarator()) return;
          const init = binding.path.node.init;
          if (!init || binding.path.node.id === p.node) return;
          if (t.isMemberExpression(p.parent) && p.parent.property === p.node && !p.parent.computed) return;
          const r = resolve(init, binding.scope);
          if (r && (r.kind === 'str' || r.kind === 'num')) {
            p.replaceWith(r.kind === 'str' ? t.stringLiteral(r.value) : t.numericLiteral(r.value));
            changed = true;
          }
        }
      });
      crawlScopes();
      traverse(ast, {
        VariableDeclaration(p) {
          const keep = [];
          for (const d of p.node.declarations) {
            if (t.isIdentifier(d.id) && d.init) {
              const b = p.scope.getBinding(d.id.name);
              if (b && b.constant && b.references === 0 &&
                  (t.isMemberExpression(d.init) || t.isIdentifier(d.init) || t.isStringLiteral(d.init) || t.isNumericLiteral(d.init))) {
                changed = true;
                continue;
              }
            }
            keep.push(d);
          }
          if (keep.length === 0) p.remove();
          else if (keep.length !== p.node.declarations.length) p.node.declarations = keep;
        }
      });
      if (!changed) break;
    }
    // 字符串表还原后，setter 形如 X = t["cclegacy"]，此时再把外层导入变量改成语义名
    try { renameImports(ast, deps); } catch (e) { /* 改名失败不影响字面量还原 */ }
    crawlScopes();
    for (let iter = 0; iter < 4; iter++) {
      let changed = false;
      traverse(ast, {
        MemberExpression(p) {
          resolveComputedKey(p, () => { changed = true; });
          if (!p.node.computed) return;
          const r = resolve(p.node, p.scope);
          if (r && (r.kind === 'str' || r.kind === 'num')) {
            p.replaceWith(literalOf(r));
            changed = true;
          }
        }
      });
      crawlScopes();
      traverse(ast, {
        VariableDeclaration(p) {
          const keep = [];
          for (const d of p.node.declarations) {
            if (t.isIdentifier(d.id) && d.init) {
              const b = p.scope.getBinding(d.id.name);
              if (b && b.constant && b.references === 0 &&
                  (t.isMemberExpression(d.init) || t.isIdentifier(d.init) || t.isStringLiteral(d.init) || t.isNumericLiteral(d.init))) {
                changed = true;
                continue;
              }
            }
            keep.push(d);
          }
          if (keep.length === 0) p.remove();
          else if (keep.length !== p.node.declarations.length) p.node.declarations = keep;
        }
      });
      if (!changed) break;
    }
    return generate(ast, { compact: false, comments: false, jsescOption: { minimal: true } }).code;
  };
}

module.exports = { makeTransform };
