#!/usr/bin/env node
// 视频分镜链路的真实联调：LLM 规划 → 生成 → 解析 → 逐行提示词。
// 需要：本机已启动 main.py（默认 3211）且配好了可用的 chat provider。
// 用法：LIVE_PROVIDER=modelscope LIVE_MODEL=Qwen/Qwen3.8-Flash-Next node tests/test_video_storyboard_live.js
// 不调用视频生成接口，不花钱。
'use strict';
const M = require('../static/js/shared/table-model.js');
const BASE = process.env.LIVE_BASE || 'http://127.0.0.1:3211';
const PROVIDER = process.env.LIVE_PROVIDER || 'modelscope';
const MODEL = process.env.LIVE_MODEL || 'Qwen/Qwen3.8-Flash-Next';

async function ask(message, maxTokens){
    const res = await fetch(BASE + '/api/canvas-llm', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
            message, model: MODEL, ms_model: PROVIDER === 'modelscope' ? MODEL : '',
            provider: PROVIDER, system_prompt:'You are a helpful assistant.', messages:[],
            images:[], videos:[], reverse:false, target_type:'video', target_model:'veo3-fast',
            ...(maxTokens ? {max_tokens:maxTokens} : {})
        })
    });
    if(!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 400));
    const data = await res.json();
    return String(data.text || '');
}

const say = (...a) => console.log(...a);
let bad = 0;
const check = (c, m) => { say((c ? '  OK  ' : '  BAD ') + m); if(!c) bad++; };

async function runCase(title, requirement, groups){
    say('');
    say('════ ' + title + ' ════');
    const inputs = groups.flatMap(g => g.entries);
    const planText = await ask(M.buildListPlanPrompt(requirement, inputs, groups, {targetKind:'video'}));
    const plan = M.extractJsonObject(planText);
    check(Boolean(plan), '规划遍返回了 JSON');
    if(plan){
        say('  plan.inputGroups = ' + JSON.stringify(plan.inputGroups));
        say('  plan.rowCount    = ' + JSON.stringify(plan.rowCount));
        say('  plan.columns     = ' + JSON.stringify(plan.columns));
    }
    const modes = M.planGroupModes(plan, groups.length);
    say('  planGroupModes   = ' + JSON.stringify(modes));

    let answer = await ask(M.buildListGeneratePrompt(requirement, inputs, groups, plan, {targetKind:'video'}));
    let table = null;
    try { table = M.parseTableOutput(answer); }
    catch(e){
        say('  首轮解析失败：' + e.message + ' → 走修复遍');
        answer = await ask(M.buildRepairPrompt(answer), M.LLM_REPAIR_MAX_TOKENS);
        table = M.parseTableOutput(answer);
    }
    check(Boolean(table), '生成遍产出合法多维表格');
    say('  表格：' + table.columns.length + ' 列 × ' + table.rows.length + ' 行');
    say('  列名：' + JSON.stringify(table.columns));
    table.rows.forEach((row, i) => say('  行 ' + (i + 1) + '：' + JSON.stringify(row)));

    // 逐行组装提示词（等价于 canvas.js 的 tableRowInputs）：每行拿自己那份素材
    const channels = groups.map((g, i) => ({id: M.channelIdAt(i), mode: M.CHANNEL_MODES.includes(modes[i]) ? modes[i] : M.channelModeFor(g.entries), items: g.entries.map(e => ({type:'media', nodeId:e.nodeId}))}));
    const ordinalBase = []; let running = 0;
    channels.forEach(ch => { ordinalBase.push(running); running += ch.items.length; });
    let dangling = 0;
    table.rows.forEach((row, rowIndex) => {
        const ordinalMap = new Map();
        const media = [];
        channels.forEach((ch, ci) => {
            M.inputItemsForRow(ch, rowIndex).forEach(item => {
                const pos = ch.items.findIndex(c => c.nodeId === item.nodeId);
                const ordinal = ordinalBase[ci] + Math.max(0, pos) + 1;
                const kind = (inputs[ordinal - 1] || {}).kind || 'image';
                ordinalMap.set(ordinal, {position: media.length + 1, kind});
                media.push({nodeId:item.nodeId, kind});
            });
        });
        const raw = M.buildRowPrompt([], '', row.filter(v => String(v).trim()).join('\n'));
        const out = M.rewriteMentions(raw, ordinalMap);
        dangling += out.dangling.length;
        say('  [行 ' + (rowIndex + 1) + ' 提示词] 素材 ' + media.length + ' 个 · 悬空 ' + out.dangling.length + ' → ' + out.text.slice(0, 180).replace(/\n/g, ' | '));
    });
    check(dangling === 0, '行提示词没有悬空引用');
    return table;
}

(async () => {
    try {
        // 场景 1：没有任何参考素材（纯提示词 → 分镜）
        await runCase('场景 1：无参考素材', '帮我做一支 8 秒的产品广告视频：一只白色运动鞋在雨后的城市街头，镜头从鞋底特写拉开到人物奔跑', []);
        // 场景 2：两组素材（参考角色图逐行 + 白底产品图每行都用）
        const g1 = {sourceId:'grp-ref', entries:[{nodeId:'r1', kind:'image', label:'角色1'}, {nodeId:'r2', kind:'image', label:'角色2'}, {nodeId:'r3', kind:'image', label:'角色3'}]};
        const g2 = {sourceId:'grp-prod', entries:[{nodeId:'p1', kind:'image', label:'白底1'}, {nodeId:'p2', kind:'image', label:'白底2'}]};
        await runCase('场景 2：参考角色图 ×3 + 白底产品图 ×2', '用参考角色分别拍 3 段产品短视频，每段都要出现白底产品图里的产品', [g1, g2]);
    } catch(error){
        say('脚本异常：' + (error && error.stack || error));
        process.exit(1);
    }
    say('');
    say(bad ? ('❌ 失败 ' + bad + ' 项') : '✅ 全部通过');
    process.exit(bad ? 1 : 0);
})();