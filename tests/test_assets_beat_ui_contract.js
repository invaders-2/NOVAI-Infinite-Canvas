#!/usr/bin/env node
/* 素材库「画布里的 / 本地上传」回归（静态断言，不联网、不依赖 python 环境）：
   B1. 后端把 BEAT（canvas-next）data.gen.hist 的产出当「节点自己的产出」，并给出生成信息与真实像素；
   B2. classic 分类对外叫「智能画布」、smart 叫「旧版智能画布」（与画布列表一致），分类契约保持 3 个；
   B3. assets/output 生成物进「本地素材」只读目录，写操作全部 403 拦下；
   U1. 素材库页面不再把「画布里的」分类写死成 smart，默认落到有资产的分类；
   U2. 没有本地记录时默认来源是「画布里的」，资产库空态有去「画布里的」的引导；
   U3. 分类标签 classic → 智能画布 / smart → 旧版智能画布；只读素材在本地素材里去掉了改名/删除入口。
   跑法：node tests/test_assets_beat_ui_contract.js */
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
const canvasJs = read('web/src/pages/assets/lib/canvas.js');
const stateJs = read('web/src/pages/assets/lib/state.js');
const utilJs = read('web/src/pages/assets/lib/util.js');
const localJs = read('web/src/pages/assets/lib/local.js');
const libraryPane = read('web/src/pages/assets/panes/LibraryPane.vue');
const localDetail = read('web/src/pages/assets/panes/LocalDetail.vue');

console.log('[B1] BEAT 产出与生成信息');
ok(/def canvas_asset_is_beat_output_node\(/.test(mainSrc), '有 BEAT 产出识别函数');
ok(/def canvas_next_generation_meta\(/.test(mainSrc), '有 BEAT 生成信息函数');
ok(/canvas_asset_is_own_output\(field_path, node\)/.test(mainSrc), 'extract 用统一「节点产出」判断（覆盖 images 与 data.gen.hist）');
ok(/def canvas_asset_real_dims\(/.test(mainSrc) && /startswith\("data\.gen\.hist"\)/.test(mainSrc), '素材像素取 data.gen.hist 的 w/h');
ok(/gen_prompt/.test(mainSrc) && /gen_model/.test(mainSrc) && /gen_at/.test(mainSrc), '生成信息字段仍是 gen_prompt/gen_model/gen_at');
ok(/full_model\.partition\("::"\)/.test(mainSrc), 'provider::model 拆成 gen_provider + gen_model');
ok(/canvas_beat_output_generated\(/.test(mainSrc), '上传图不会被误标成生成物');

console.log('[B2] 分类名与契约');
ok(/\{"id": "classic", "name": "智能画布"/.test(mainSrc), 'classic 分类名为「智能画布」');
ok(/\{"id": "smart", "name": "旧版智能画布"/.test(mainSrc), 'smart 分类名为「旧版智能画布」');
ok(/"id": "all", "name": "全部画布"/.test(mainSrc), '全部画布分类保留');

console.log('[B3] 生成物进本地素材（只读）');
ok(/LOCAL_OUTPUT_FOLDER = "画布生成"/.test(mainSrc), '有「画布生成」目录常量');
ok(/def local_output_readonly_name\(/.test(mainSrc), '有只读条目判定');
ok(/"readonly": True/.test(mainSrc) && /"source": "output"/.test(mainSrc), '生成物条目带 readonly/source 标记');
ok(/local_output_readonly_name=local_output_readonly_name/.test(mainSrc), '只读判定已 bind 给路由层');
ok(/deps\.local_output_readonly_name\(name\)/.test(assetsSrc) && /status_code=403/.test(assetsSrc), '删除/移动/改名/上传/导入/反推都有 403 只读拦截');
ok(/def _append_local_output_items\(/.test(mainSrc), '生成物合并进本地素材树');
ok(/root_scope = folder_key in \("", "__root__", "root"\)/.test(assetsSrc), '根视图（folder 为空/__root__）单独判定');
ok(/str\(item\.get\("source"\) or ""\) == "output"/.test(assetsSrc), '根视图排除 source=output 的只读生成物');
ok(/"generated_hidden": generated_hidden/.test(assetsSrc), 'count/total 按作用域口径 + 返回 generated_hidden');
ok(/内置的只读目录/.test(assetsSrc), '新建/重命名同名文件夹同样被只读规则拦下');

console.log('[U1] 画布里的默认分类');
ok(!/cat: 'smart'/.test(canvasJs), "C.cat 不再写死 'smart'");
ok(/cat: ''/.test(canvasJs), "C.cat 初始为空，由 afterLoad 决定");
ok(/function defaultCat\(\)/.test(canvasJs) && /Number\(c\.count \|\| 0\) > 0/.test(canvasJs), 'defaultCat 优先选有资产的分类');
ok(/withAssets\.length/.test(canvasJs) && /withAssets\.find\(c => c\.id === 'classic'\)/.test(canvasJs), '多个分类都有资产时优先智能画布（classic）');
ok(/if \(!C\.cat \|\| !categories\(\)\.some/.test(canvasJs), 'afterLoad 在未选/失效时切到默认分类');

console.log('[U2] 默认来源与空态引导');
ok(/return MEDIA_TABS\.includes\(v\) \? v : 'canvas-assets'/.test(stateJs), "默认来源是 'canvas-assets'（画布里的）");
ok(/localStorage\.getItem\(LAST_MEDIA_TAB_KEY\)/.test(stateJs), '用户已有选择仍然保留（localStorage 优先）');
ok(/canvasAssetCount/.test(libraryPane) && /setTab\('canvas-assets'\)/.test(libraryPane), '资产库空态有「去画布里的」引导');

console.log('[U3] 标签与只读素材交互');
ok(/return kind === 'smart' \? '旧版智能画布' : '智能画布'/.test(utilJs), 'canvasKindLabel: classic → 智能画布 / smart → 旧版智能画布');
ok(/export const GENERATED_FOLDER = '画布生成'/.test(localJs), '前端识别「画布生成」只读目录');
ok(/export async function loadGeneratedAssets/.test(localJs) && /local-assets\?folder=/.test(localJs), '进「画布生成」时按 folder 懒加载生成物');
ok(/function scopedSource\(\)/.test(localJs), '根视图 / 画布生成 各用各的数据源');
ok(/export function isReadonlyAsset/.test(localJs), '本地素材有只读判定');
ok(/isReadonlyAsset\(item\)\) \{ setStatus/.test(localJs), '改名/删除/反推/分类对只读素材给出明确提示');
ok(/readonly/.test(localDetail) && /画布生成（只读）/.test(localDetail), '详情面板标出来源「画布生成（只读）」并禁用改名/删除');

console.log('');
if (fails.length) {
    console.log('[FAIL] ' + fails.length + ' 项不满足：');
    fails.forEach(f => console.log('  - ' + f));
    process.exit(1);
}
console.log('[OK] 素材库 BEAT 契约 ' + pass + ' 项全部通过');
