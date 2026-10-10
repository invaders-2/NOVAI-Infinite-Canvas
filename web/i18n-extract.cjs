// 从 web/src 抽取所有含中文的文案：模板文本、静态属性、脚本里的字符串与模板字符串（${} 变成 {0}{1}…）
const fs = require('fs'), path = require('path');
const NM = path.join(__dirname, 'node_modules') + '/';
const { parse: parseSfc } = require(NM + '@vue/compiler-sfc');
const babel = require(NM + '@babel/parser');
const ROOT = path.join(__dirname, 'src');
const ZH = /[一-龥]/;
const out = new Map();   // text -> {files:Set, kind}
function add(t, file, kind) {
  t = t.replace(/\s+/g, ' ').trim();
  if (!t || !ZH.test(t)) return;
  if (!out.has(t)) out.set(t, { files: new Set(), kind });
  out.get(t).files.add(path.relative(ROOT, file));
}
function walkJs(code, file) {
  let ast;
  try { ast = babel.parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }); }
  catch (e) { try { ast = babel.parseExpression(code, { errorRecovery: true }); } catch (e2) { return; } }
  (function visit(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n.type === 'StringLiteral') add(n.value, file, 'str');
    else if (n.type === 'TemplateLiteral') {
      let s = ''; n.quasis.forEach((q, i) => { s += q.value.cooked; if (i < n.expressions.length) s += '{' + i + '}'; });
      if (ZH.test(n.quasis.map(q => q.value.cooked).join(''))) add(s, file, 'tpl');
    }
    for (const k in n) if (k !== 'loc' && k !== 'start' && k !== 'end' && k !== 'leadingComments' && k !== 'trailingComments') visit(n[k]);
  })(ast);
}
function walkTpl(node, file) {
  if (!node) return;
  if (node.type === 2) add(node.content, file, 'text');                     // TEXT
  if (node.type === 5 && node.content) walkJs(node.content.content || '', file);   // {{ }}
  if (node.type === 8) (node.children || []).forEach(c => typeof c === 'object' && walkTpl(c, file));
  if (node.type === 1) {                                                     // ELEMENT
    for (const p of node.props || []) {
      if (p.type === 6 && p.value) add(p.value.content, file, 'attr');      // static attr
      if (p.type === 7 && p.exp) walkJs(p.exp.content || '', file);        // directive
    }
  }
  // 文本与 {{ }} 相邻时，运行时是一个文本节点：按「文本{0}文本」整体收一条
  const kids = node.children || [];
  let run = [];
  const flush = () => {
    if (run.some(c => c.type === 5) && run.some(c => c.type === 2 && ZH.test(c.content))) {
      let s = '', i = 0; run.forEach(c => { s += c.type === 2 ? c.content : '{' + (i++) + '}'; });
      add(s, file, 'tpl');
    }
    run = [];
  };
  kids.forEach(c => { if (c.type === 2 || c.type === 5) run.push(c); else flush(); });
  flush();
  kids.forEach(c => walkTpl(c, file));
}
function files(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]); }
for (const f of files(ROOT)) {
  if (path.basename(f).startsWith('._')) continue;
  const src = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.vue')) {
    const { descriptor } = parseSfc(src, { filename: f });
    if (descriptor.template && descriptor.template.ast) walkTpl(descriptor.template.ast, f);
    for (const s of [descriptor.script, descriptor.scriptSetup]) if (s) walkJs(s.content, f);
  } else if (f.endsWith('.js')) walkJs(src, f);
}
const arr = [...out.entries()].map(([zh, v]) => ({ zh, kind: v.kind, files: [...v.files].slice(0, 3) }));
fs.writeFileSync(process.argv[2], JSON.stringify(arr, null, 1));
console.log(arr.length, arr.filter(a => a.kind === 'tpl').length);
