#!/usr/bin/env node
/* 本地素材扫描加固契约（静态断言，不联网、不依赖 python 环境）：
   S1. 只扫 NOVAI 管理的 assets/uploads + assets/output，绝不遍历其它系统目录；
   S2. 不跟 symlink / Windows junction（目录级 + 文件级都跳过并计数）；
   S3. 深度 / 条目硬上限，超限截断，tree["scan"] 带 truncated / limits / counts；
   S4. /api/local-assets 回传 truncated + scan + notice，且根视图排除生成物、画布生成仍只读。
   跑法：node tests/test_local_assets_scan_contract.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

const mainSrc = read('main.py');
const assetsSrc = read('server/routes/assets.py');

// 取扫描相关函数体（避免误判其它模块里的 os.walk）
const start = mainSrc.indexOf('def _local_upload_tree_and_items(');
const endMarker = mainSrc.indexOf('_DOUBLE_EXT_RE =', start);
const scanBody = start >= 0 && endMarker > start ? mainSrc.slice(start, endMarker) : '';
const outStart = mainSrc.indexOf('def _local_output_items(');
const outEnd = mainSrc.indexOf('def local_output_readonly_name(', outStart);
const outputBody = outStart >= 0 && outEnd > outStart ? mainSrc.slice(outStart, outEnd) : '';

console.log('[S1] 扫描范围');
ok(/^def _local_upload_tree_and_items\(/m.test(mainSrc), '存在 _local_upload_tree_and_items');
ok(/uploads_root = LOCAL_UPLOAD_DIR/.test(scanBody), '递归只从 LOCAL_UPLOAD_DIR 出发');
ok(/os\.walk\(uploads_root, followlinks=False\)/.test(scanBody), 'os.walk 显式 followlinks=False');
ok(!/os\.walk\(ASSETS_DIR/.test(mainSrc), '不再从 ASSETS_DIR 整盘遍历');
ok(!/os\.walk\(\s*[\"']\/|os\.walk\(\s*os\.path\.expanduser/.test(scanBody), '没有从系统根 / home 出发的遍历');
ok(/OUTPUT_OUTPUT_DIR/.test(outputBody), '生成物只扫 OUTPUT_OUTPUT_DIR');

console.log('[S2] 不跟链接 / junction');
ok(/def _local_scan_is_link\(/.test(mainSrc), '有链接判定函数');
ok(/os\.path\.islink\(/.test(mainSrc) && /isjunction/.test(mainSrc), 'islink + os.path.isjunction');
ok(/FILE_ATTRIBUTE_REPARSE_POINT/.test(mainSrc), 'Windows reparse point（junction）判定');
ok(/_local_scan_is_link\(os\.path\.join\(current, dirname\)\)/.test(scanBody), '目录级跳过链接');
ok(/_local_scan_is_link\(full\)/.test(scanBody), '文件级跳过链接');
ok(/_local_scan_is_link\(full\)/.test(outputBody), '生成物条目跳过链接');
ok(/"skipped_links"/.test(mainSrc), '链接跳过计数写进 scan');

console.log('[S3] 深度 / 条目上限与截断');
ok(/LOCAL_SCAN_MAX_DEPTH = \d+/.test(mainSrc), '有 LOCAL_SCAN_MAX_DEPTH 常量');
ok(/LOCAL_SCAN_MAX_ENTRIES = \d+/.test(mainSrc), '有 LOCAL_SCAN_MAX_ENTRIES 常量');
ok(/LOCAL_SCAN_MAX_ENTRIES = 20000/.test(mainSrc), '条目上限默认 20000');
ok(/depth >= LOCAL_SCAN_MAX_DEPTH/.test(scanBody), '深度上限生效');
ok(/len\(items\) >= LOCAL_SCAN_MAX_ENTRIES/.test(scanBody), '条目上限生效');
ok(/scan\["truncated"\] = True/.test(scanBody) && /scan\["truncated"\] = True/.test(outputBody), '超限置 truncated=true');
ok(/root_node\["scan"\] = scan/.test(scanBody), 'tree 根节点带 scan 信息');
ok(/max_depth/.test(mainSrc) && /max_entries/.test(mainSrc), 'scan 里回传上限值');
ok(/scan\["count"\] = len\(items\)/.test(scanBody) && /scan\["output_count"\]/.test(scanBody), 'scan 里回传条目计数');
ok(/_local_output_items\(limit=budget, scan=scan\)/.test(mainSrc), '生成物扫描与上传共用条目预算');

console.log('[S4] 接口回传与既有行为');
ok(/"truncated": truncated/.test(assetsSrc), '接口回传 truncated');
ok(/"scan": scan/.test(assetsSrc), '接口回传 scan');
ok(/"notice": notice/.test(assetsSrc) && /超过扫描上限/.test(assetsSrc), '超限有人话 notice');
ok(/isinstance\(tree, dict\)/.test(assetsSrc), 'mock 出来的非 dict tree 不炸');
ok(/root_scope = folder_key in/.test(assetsSrc) && /== "output"/.test(assetsSrc), '根视图仍排除生成物');
ok(/"readonly": True/.test(mainSrc) && /LOCAL_OUTPUT_FOLDER = "画布生成"/.test(mainSrc), '「画布生成」仍只读');

console.log('');
if (fails.length) {
    console.log('[FAIL] ' + fails.length + ' 项不满足：');
    fails.forEach(f => console.log('  - ' + f));
    process.exit(1);
}
console.log('[OK] 本地素材扫描加固契约 ' + pass + ' 项全部通过');
