/* 群组成员关系成环时，smartArrangeAtomicIds 绝不能挂住主线程。
   这里把函数源码抽出来在沙箱里跑：
     · nodes / isSmartGroupNode / console 由调用方注入；
     · Set 也注入（一个带操作计数的子类）—— 一旦出现「删了又放回」的无限循环，计数会瞬间爆掉并抛错，
       测试立刻失败；这正是老实现（见 LEGACY 常量）会触发的那条路径。
   跑法：node tests/test_smart_canvas_group_cycle.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

const fnSrc = (js.match(/function smartArrangeAtomicIds\(ids\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(fnSrc.length > 200, '抽到 smartArrangeAtomicIds 源码');

/* 老实现（修复前），只用来证明「测试确实能抓住死循环」 */
const LEGACY = [
    'function smartArrangeAtomicIds(ids){',
    '    const out = new Set((ids || []).filter(id => nodes.some(n => n.id === id)));',
    '    let changed = true;',
    '    while(changed){',
    '        changed = false;',
    '        nodes.filter(isSmartGroupNode).forEach(group => {',
    '            (group.items || []).forEach(itemId => {',
    '                if(!out.has(itemId)) return;',
    '                out.delete(itemId);',
    '                out.add(group.id);',
    '                changed = true;',
    '            });',
    '        });',
    '    }',
    '    return [...out];',
    '}'
].join('\n');

function makeRunner(src, budget){
    const CountingSet = class extends Set {
        constructor(...args){ super(...args); this.ops = 0; }
        add(v){ this.ops += 1; if(this.ops > budget) throw new Error('LOOP_BUDGET_EXCEEDED'); return super.add(v); }
        delete(v){ this.ops += 1; if(this.ops > budget) throw new Error('LOOP_BUDGET_EXCEEDED'); return super.delete(v); }
    };
    const warnings = [];
    const consoleStub = { warn: (...args) => warnings.push(args.join(' ')) };
    const factory = new Function('nodes', 'isSmartGroupNode', 'Set', 'console',
        src + '\nreturn smartArrangeAtomicIds;');
    const isGroup = n => n && n.type === 'smart-group';
    return (nodes, ids) => {
        const run = factory(nodes, isGroup, CountingSet, consoleStub);
        return {out: run(ids), warnings: warnings};
    };
}

const runFixed = makeRunner(fnSrc, 5000);
const runLegacy = makeRunner(LEGACY, 5000);

const node = (id, type) => ({id, type: type || 'image', items: undefined});
const group = (id, items) => ({id, type: 'smart-group', items});

console.log('[1] 无环数据：结果与旧实现一致（嵌套分组层层上提）');
const nested = [node('a'), group('B', ['a']), group('C', ['B']), node('z')];
const fixedNested = runFixed(nested, ['a', 'z']).out.slice().sort();
const legacyNested = runLegacy(nested, ['a', 'z']).out.slice().sort();
ok(JSON.stringify(fixedNested) === JSON.stringify(['C', 'z']), '嵌套：a ∈ B ∈ C → 只留最外层 C（实际 ' + JSON.stringify(fixedNested) + '）');
ok(JSON.stringify(fixedNested) === JSON.stringify(legacyNested), '与旧实现结果一致');
ok(runFixed([node('a'), group('B', ['a'])], ['a']).out.join() === 'B', '一层：a ∈ B → B');
ok(runFixed([node('a')], ['a']).out.join() === 'a', '不在任何组里的节点原样保留');
ok(runFixed([node('a'), group('B', ['b'])], ['a']).out.join() === 'a', '组里没有命中成员 → 不上提');

console.log('[2] 组互相包含（环）：修复版必须收敛');
const mutual = [group('A', ['b', 'B']), group('B', ['a', 'A']), node('a'), node('b')];
let fixedMutual = null;
try {
    fixedMutual = runFixed(mutual, ['a', 'b']);
    ok(true, '互相包含：跑完没抛（收敛）');
} catch (error) {
    ok(false, '互相包含：修复版仍然爆掉 —— ' + error.message);
}
if (fixedMutual){
    ok(fixedMutual.out.length > 0, '互相包含：返回非空结果 ' + JSON.stringify(fixedMutual.out));
    ok(fixedMutual.warnings.some(w => w.indexOf('存在环') >= 0), '互相包含：console.warn 报了环');
}

console.log('[3] 组把自己列进 items：同样必须收敛');
let selfRef = null;
try {
    selfRef = runFixed([group('A', ['A', 'a']), node('a')], ['a']);
    ok(true, '自引用：跑完没抛（收敛）');
} catch (error) {
    ok(false, '自引用：修复版仍然爆掉 —— ' + error.message);
}
if (selfRef) ok(selfRef.out.join() === 'A', '自引用：结果 ' + JSON.stringify(selfRef.out));

console.log('[4] 老实现确实会被这套守卫抓住（证明测试不是空壳）');
['互相包含', '自引用'].forEach((label, i) => {
    const fixture = i === 0 ? mutual : [group('A', ['A', 'a']), node('a')];
    const ids = ['a', 'b'];
    let tripped = false;
    try { runLegacy(fixture, ids); } catch (error) { tripped = error.message === 'LOOP_BUDGET_EXCEEDED'; }
    ok(tripped, label + '：旧实现触发 LOOP_BUDGET_EXCEEDED（说明这个测试能抓住死循环）');
});

console.log('[5] 源码层面：不再有 while(changed) 的无界定点循环');
/* 只看代码形态（注释里提到了老写法，别把它算进来） */
ok(!/while\(changed\)\s*\{/.test(js), '全文件已无 while(changed){ 的无界定点循环');
ok(/const maxRounds = groups\.length \+ 1;/.test(js), '有「组数 + 1」的硬轮次上限');
ok(/const promoted = new Set\(\);/.test(js), '有每组只上提一次的记账');
ok(/for\(let round = 0; round < maxRounds; round \+= 1\)\{/.test(js), '定点迭代写成了有上限的 for');

console.log('');
if (fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
