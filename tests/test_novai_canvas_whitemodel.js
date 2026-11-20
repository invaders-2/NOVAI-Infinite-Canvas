#!/usr/bin/env node
'use strict';
/**
 * 图片节点「白膜处理」入口：「更多」菜单 → 就地编辑条（档位 / 模型）→ whitemodel 编辑 → 新版本写回。
 * 三档：产品（商品未上色石膏粗模，默认）、人物（白色人台）、清空商品（商品移除，只留干净场景）。
 * 只读源码与构建产物断言，不花模型额度。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ui = 'novai-canvas-ui/src/canvas/canvas-next/ui/';
const genPanel = read(ui + 'GenPanel.tsx');
const registry = read(ui + 'editors/registry.tsx');
const css = read(ui + 'canvas-next.css');
const types = read('novai-canvas-ui/src/canvas/canvas-next/backend/types.ts');
const novai = read('novai-canvas-ui/src/novaiBackend.ts');
const bridge = read('novai-canvas-ui/src/canvas/canvas-next/backend/bridge.ts');
const mock = read('novai-canvas-ui/src/canvas/canvas-next/backend/mockEdit.ts');
const built = read('static/novai-canvas/canvas.js');

/* ---------- 入口：工具条按钮 / 就地编辑层 ---------- */
assert(types.includes('"cutout" | "whitemodel"'), 'EditOp 增加 whitemodel');
assert(!genPanel.includes('B("whitemodel"'), '白膜不在工具条上（低频 AI 特效收进「更多」菜单）');
assert(registry.includes('data-k="whitemodel"') && registry.includes('<Icon name="user" size="s" />白膜处理'), '「更多」菜单里有「白膜处理」行');
assert(registry.includes('openEditor(ctl, "whitemodel", id)'), '菜单行复用 openEditor 的 whitemodel 路由');
assert(registry.includes('kind === "whitemodel"'), 'openEditor 分发 whitemodel');
assert(registry.includes('function WhiteModelEditor'), '白膜是就地编辑层（和涂鸦同一套）');
assert(registry.includes('data-ed="whitemodel"'), '编辑层叠在图片节点上');
assert(registry.includes('runEdit(store, n.id, "whitemodel", "白膜"'), '工具条开始后按 whitemodel 跑编辑');
assert(registry.includes('data-k="whitemodel-model"'), '编辑条里可以选处理模型');
assert(registry.includes('ComboMenu') && registry.includes('选择供应商'), '模型菜单先选供应商（编辑器同款两级）');
assert(registry.includes('返回供应商列表'), '模型列表可返回供应商');
assert(registry.includes('data-model'), '再选这家供应商的具体模型');

/* ---------- 档位：产品 / 人物 / 清空商品 ---------- */
assert(/export type WhiteTier = "mannequin" \| "blockout" \| "clear"/.test(registry), '白膜分三档（内部 id：mannequin / blockout / clear）');
assert(registry.includes('data-k="whitemodel-tier"'), '编辑条上有档位切换');
assert(/data-tier=\{t\.id\}/.test(registry), '档位控件按 id 渲染');
assert(/id: "blockout", label: "产品"/.test(registry), '档位里有「产品」');
assert(/id: "mannequin", label: "人物"/.test(registry), '档位里有「人物」');
assert(/id: "clear", label: "清空商品"/.test(registry), '档位里有「清空商品」');
assert(registry.indexOf('id: "blockout", label: "产品"') < registry.indexOf('id: "mannequin", label: "人物"')
  && registry.indexOf('id: "mannequin", label: "人物"') < registry.indexOf('id: "clear", label: "清空商品"'), '展示顺序：产品 → 人物 → 清空商品');
assert(/tip: "把商品做成白色模型：保留外形、机位和投影，抹掉 logo、缝线、装饰和反光，纯白底"/.test(registry), '产品档说明');
assert(/tip: "把人物变成白色人台：脱掉衣服，保留姿态和构图，纯白底"/.test(registry), '人物档说明');
assert(/tip: "把商品连它的影子一起拿掉，只留干净场景"/.test(registry), '清空商品档说明');
assert(!/tip: "[^"]*白模/.test(registry), '「白模」只出现在按钮上，tip 不再重复解释');
assert(registry.includes('useState<WhiteTier>("blockout")'), '默认档位是「产品」（blockout）');
assert(registry.includes('tier === "clear" ? "开始清空" : "开始白模"'), '运行按钮文案：开始白模 / 开始清空');
assert(!/开始白膜|开始清场/.test(registry), '旧的「开始白膜 / 开始清场」文案已清掉');
assert(registry.includes('t === "blockout" ? "cube"'), '产品档用线性图标');
assert(registry.includes('const pickTier = (t: WhiteTier)'), '切换档位会更新状态');
assert(/params: \{ tier \}/.test(registry), '选中的档位通过 params 传给后端');
// 清场档默认模型也跟人台档走：清场 / 换品过不过关主要看模型强弱（真图实测）
assert(/const bestFor = \(\) => mannequinBest/.test(registry), '两档默认模型都是人台档那条强模型链');
assert(/const model = all\.find\(\(m\) => m\.id === modelId\) \|\| bestFor\(\) \|\| nodeModel/.test(registry), '用户在模型 pill 里手动选过的优先（modelId）');
assert(registry.includes('gemini-3-pro-image-preview'), '人台档默认优先 APIMART 的 Gemini 图片模型');
assert(registry.includes('nano[._-]?banana'), '人台档其次 nano banana');
// 档位 = 跟「模型」同一颗 pill（.pill + 线性图标 + 右侧 chevron），点开复用两级菜单的浮层容器
assert(/<button className="pill" data-k="whitemodel-tier"[^>]*aria-haspopup="menu"/.test(registry), '档位是和模型同款的一颗 pill + 点开浮层');
assert(/className=\{"mi" \+ \(tier === t\.id \? " on" : ""\)\} data-tier=\{t\.id\}/.test(registry), '浮层里列人台 / 清场两项，当前项带选中态');
assert(/pick\.tier \? WHITE_TIERS\.map/.test(registry), '档位浮层复用 .wm-pick-menu 容器');
assert(!/const anchor = \(bar\.ref\.current as Element\) \|\| fallback/.test(registry), '浮层不再以整条编辑条为唯一锚点');
assert(/const r = fallback\.getBoundingClientRect\(\)/.test(registry), '浮层位置按被点击的 pill 算');
assert(/r\.left \+ r\.width \/ 2 - 150/.test(registry), '浮层在被点 pill 上方水平居中');
assert(/innerWidth - 308/.test(registry), '浮层夹在屏幕内，不出界');
assert(/\.wm-pick-menu\{[^}]*backdrop-filter[^}]*box-shadow/.test(css), '档位浮层是磨砂玻璃（底 + backdrop-filter + 柔和投影）');
assert(/\.wm-pick-menu \.mi\.on\{[^}]*background:[^}]*font-weight:600/.test(css), '选中的档位用软底 + 字重变化（不描边）');
assert(!/\.wm-pick-menu\{[^}]*border:/.test(css), '档位浮层与选中态不画线框');
assert(!/wm-seg/.test(css) && !/wm-seg/.test(registry), '旧的灰底两段胶囊样式已删除（不留死代码）');

/* ---------- 自检：档位各一套 ---------- */
assert(registry.includes('whiteModelIssue'), '结果有自动审查');
assert(/async function whiteModelIssue\(src: string, tier: WhiteTier = "mannequin", from = ""\): Promise<\{ block\?: string; warn\?: string \}>/.test(registry), '自检按档位区分，返回 block / warn 两种结论');
assert(registry.includes('if (tier === "clear")') && registry.includes('商品没被移除'), '清场档查「商品没被移除」而不是彩色残留');
assert(registry.includes('残留原图的颜色'), '人台档仍查彩色残留（衣服/背景没变白）');
assert(registry.includes('模型把画面生成成空白了'), '空白结果被拦下');
assert(/std < \(tier === "clear" \? 1\.5 : 6\)/.test(registry), '清场档空白阈值放宽到 1.5（干净棚拍场景不再误杀）');
assert(registry.includes('structureScore') && registry.includes('STRUCT_MIN') && /score < STRUCT_MIN/.test(registry), '人台 / 白模档做结构一致性检查');
assert(/const STRUCT_MIN = 0\.45/.test(registry), '结构阈值 0.45（新比对法下真图正例 0.64 / 0.70，只在明显对不上时提示）');
assert(registry.includes('maskedStructureScore'), '结构分数用剔除「结果被抹白背景」的 maskedStructureScore');
assert(registry.includes('async function subjectOnWhite'), '人台档先把人物抠到纯白再送模型（原图里的椅子包道具会跟着进结果）');
assert(registry.includes('async function clipToSilhouette'), '白模档生成后按原图轮廓收边（模型会把商品重画变形）');
assert(/const canMatte = typeof store\.backend\.mattingModelStatus === "function"/.test(registry), '抠图预处理 / 收边只在有本地抠图的后端跑');
assert(/if \(tier === "blockout" && canMatte && out\.url\)/.test(registry), '白模结果用原图轮廓裁一遍，形状锁在原商品上');
assert(registry.includes('.downloaded'), '本地抠图模型没下载就跳过预处理，不挡出图');
assert(registry.includes('async function pureWhite'), '白模有本地白平衡兜底');
assert(registry.includes('if ((tier !== "blockout" && tier !== "mannequin") || !o.url) return o'), '白平衡对产品 + 人物两档生效');
assert(registry.includes('tier === "mannequin" ? 252 : 250'), '人物档白平衡目标 252、产品档 250');
assert(/if \(!fixed \|\| tier === "mannequin"\)/.test(registry), '人物档只做白平衡、不跑背景平场（平场会洗掉人台形体）');
assert(!/tier === "clear"[^\n]*pureWhite/.test(registry) && !/tier === "clear"[^\n]*flatField/.test(registry), '清空商品不跑白平衡 / 平场（保持原场景颜色）');
assert(/target \/ Math\.max\(1, p\)/.test(registry) && registry.includes('Math.min(1.6'), '白平衡把 99 分位拉到目标值（250 / 252）、系数夹在 1.6');
assert(registry.includes('商品图请改用「产品」档'), '人台档结构不符时引导改用「产品」档（商品图不是清场）');
assert(registry.includes('产品档只该去掉细节'), '产品档结构不符时说明只该去细节');
assert(!registry.includes('这张图里似乎没有人物'), '不再断言「这张图里没有人物」（代码根本不检测人物）');
const blockoutReturn = registry.indexOf('if (tier === "blockout") return {};');
const coloredRule = registry.indexOf('colored / n > 0.02');
assert(blockoutReturn >= 0 && coloredRule > blockoutReturn, '白模档不查彩色残留（背景保留原色）');
assert(registry.includes('const retryRaw = await store.backend.editImage'), '真废图仍自动换更强模型重试');
assert(/if \(verdict\.block\) \{/.test(registry) && /if \(verdict\.block\) throw new Error/.test(registry), '只有 blank 类结论才拦下');
assert(/if \(warn\) store\.toast\(warn, 6000\)/.test(registry), '结构 / 颜色类问题只提示，结果照常写入（长句给足 6 秒）');
assert(/await applyVariant\(store, tid, out, label\);\n    if \(warn\) store\.toast\(warn, 6000\)/.test(registry), '先写入版本再提示（不吞掉花钱生成的结果）');
assert((registry.match(/已拦下不写版本/g) || []).length === 1, '只剩空白图一条「已拦下不写版本」');

/* ---------- 两处提示词：人台原样保留 + 清场新增，且逐字一致 ---------- */
assert(novai.includes('whitemodel:'), 'NOVAI 适配器有白膜提示词');
assert(bridge.includes('case "whitemodel"'), '桌面桥接有 whitemodel');
assert(/p\.tier === "blockout" \? blockout : mannequin/.test(bridge), '桥接按 tier 选提示词');
assert(/whiteTier === "blockout" \? "blockout" : "mannequin"/.test(novai), 'NOVAI 适配器按 tier 选提示词');

const pick = (text, label) => {
  const m = new RegExp(label + ':\\s*"([^"]*)"').exec(text) || new RegExp('const ' + label + ' = "([^"]*)"').exec(text);
  return m ? m[1] : '';
};
const bridgeMannequin = pick(bridge, 'mannequin');
const bridgeBlockout = pick(bridge, 'blockout');
const bridgeClear = pick(bridge, 'clear');
const novaiMannequin = pick(novai, 'mannequin');
const novaiBlockout = pick(novai, 'blockout');
const novaiClear = pick(novai, 'clear');
assert(bridgeMannequin && novaiMannequin && bridgeMannequin === novaiMannequin, '两处「人台」提示词逐字一致');
assert(bridgeBlockout && novaiBlockout && bridgeBlockout === novaiBlockout, '两处「白模」提示词逐字一致');
assert(bridgeClear && novaiClear && bridgeClear === novaiClear, '两处「清场」提示词逐字一致');
assert(bridgeMannequin !== bridgeBlockout && bridgeBlockout !== bridgeClear, '三档提示词互不相同');

// 人台：外形 / 姿势 / 构图原样保留，背景改纯白
assert(/人台模特/.test(bridgeMannequin), '人台提示词 = 服装店人台模特');
assert(/不偏黄/.test(bridgeMannequin), '人台提示词要求不偏黄');
assert(/身上没有衣服/.test(bridgeMannequin), '人台提示词要求去掉原图穿搭');
assert(/保持原来的姿势、动作、镜头角度和构图/.test(bridgeMannequin), '人台提示词要求保持原姿势与构图');
assert(/背景换成无缝纯白/.test(bridgeMannequin), '人物档要求无缝纯白背景');
assert(/不要浅灰底/.test(bridgeMannequin), '人物档明确不要浅灰底');
assert(/商品和人物脚下留淡淡的地面投影/.test(bridgeMannequin), '人物档保留地面投影');
assert(!/浅灰白摄影棚背景/.test(bridgeMannequin), '旧的浅灰白摄影棚背景已删除');

// 白模：保留外形 / 机位 / 接触投影，抹掉细节与颜色，背景保留原样
['纯白色的石膏粗模', '保留原商品的整体轮廓、比例、摆放角度、机位、构图和它与台面的接触投影',
  '缝线', '鞋带结构', '鞋底花纹', 'logo', '印花', '图案', '装饰', '材质纹理', '反光', '表面平滑哑光、纯白',
  '只有大的体块起伏', '背景是无缝纯白、没有任何纹理、渐变、暗角和杂物',
  '商品和背景之间只靠柔和的浅灰投影与极淡的轮廓暗部区分', '除此之外整张画面只有白色和中性灰',
  '不要出现第二个影子', '不要新增物体', '不要文字、水印、边框'].forEach((key) => {
  assert(bridgeBlockout.includes(key), '白模提示词必须写明「' + key + '」');
});
assert(/把画面里的商品做成纯白色的石膏粗模，背景也换成纯白/.test(bridgeBlockout), '白模提示词要求纯白商品 + 纯白底');
assert(bridgeBlockout.includes('商品和背景都是纯白（#FFFFFF）'), '白模提示词写明 #FFFFFF');
assert(bridgeBlockout.includes('不偏黄、不偏米、不偏灰'), '白模提示词要求不偏黄 / 米 / 灰');
assert(bridgeBlockout.includes('背景是无缝纯白、没有任何纹理、渐变、暗角和杂物'), '白模提示词要求无缝纯白、无渐变');
assert(!/浅灰白到纯白/.test(bridgeBlockout), '旧的浅灰白底要求已删除');
assert(!/人台模特/.test(bridgeBlockout) && !/完整移除/.test(bridgeBlockout), '白模提示词既不是人台也不是清场');

// 清场：移除商品 + 接触投影，补全背景，保留机位/构图/布光，且禁止残影 / 二次影子 / 新物体
['把画面里的商品完整移除', '连它压在台面或地面上的接触投影一起去掉', '不要留下任何商品残影', '半透明轮廓',
  '抠图毛边', '自然补全', '保留原来的机位、构图、布光和整体氛围', '背景颜色保持原样', '没有商品的干净场景图',
  '不要出现第二个影子', '不要凭空生成新物体', '不要文字、水印、边框'].forEach((key) => {
  assert(bridgeClear.includes(key), '清场提示词必须写明「' + key + '」');
});

/* ---------- 白模本地兜底：白平衡 + 背景平场 ---------- */
assert(registry.includes('async function flatField'), '白模有背景平场（纯白底不能靠模型给的渐变）');
assert(/Math\.min\(1\.4, Math\.max\(\.9, 250 /.test(registry), '平场系数夹在 0.9–1.4');
assert(registry.includes('const flat = await flatField(fixed)'), '平场跟在白平衡之后、同一处生效');
assert((registry.match(/flatField\(/g) || []).length === 2, '平场只在白模档的兜底链路里调用（定义 + 唯一调用）');

/* ---------- 遮罩内换品：refUrl 链路 + UI ---------- */
assert(/refUrl\?: string/.test(types), 'EditRequest 支持新品参考图 refUrl');
assert(bridge.includes('第三张参考图'), '桥接换品提示词提到第三张参考图');
assert(bridge.includes('100% 以参考图为准'), '换品提示词要求 100% 以参考图为准');
assert(bridge.includes('遮罩以外的区域一模一样'), '换品提示词要求遮罩外不动');
assert(bridge.includes('每一件都必须替换，不能只换其中一件'), '换品提示词要求遮罩里多件商品每一件都换');
assert(novai.includes('每一件都必须替换，不能只换其中一件'), 'NOVAI 适配器同样要求多件商品都换');
assert(/inputs: \[ref\]/.test(bridge), '换品时参考图作为独立附件发（不合成进 source）');
assert(bridge.includes('req.prompt || "自然地重绘这块区域"'), '不挂参考图时仍走老的局部重绘提示词');
assert(novai.includes('name: "新品参考"'), 'NOVAI 适配器把新品参考作为第三张参考图');
assert(novai.includes('把遮罩区域里的商品替换成第三张参考图里的新品'), 'NOVAI 适配器同样发换品提示词');
assert(registry.includes('data-k="mask-ref"'), '局部重绘工具条上有「参考图」pill');
assert(registry.includes('data-k="mask-ref-chip"'), '挂上参考图后显示可移除的小缩略图 chip');
assert(registry.includes('已带上新品参考 · 开始换品'), '挂参考图时提示能看出是换品');
assert(registry.includes('已带上新品参考'), '挂参考图后 toast 说明已带上新品参考');
assert(registry.includes('refUrl: ref!.url'), '运行时会带上 refUrl');

/* ---------- 模拟后端 / 构建产物 ---------- */
assert(mock.includes('req.op === "whitemodel"'), '模拟后端的本地近似效果不崩');
assert(built.includes('"whitemodel"') && built.includes("白膜"), '构建产物已包含白膜入口（act 是变量，按 op / 标签断言）');
assert(built.includes('whitemodel-tier') && built.includes('清空商品'), '构建产物已包含档位切换');
assert(built.includes('把画面里的商品完整移除'), '构建产物已包含清场提示词');
assert(built.includes('纯白色的石膏粗模') && built.includes('#FFFFFF'), '构建产物已包含纯白白模提示词');
console.log('[PASS] 图片节点「白膜处理」：「更多」菜单入口 / 就地编辑条（同涂鸦）/ 产品·人物·清空商品三档（默认产品）/ 两处提示词逐字一致 / 结构自检 / 白平衡与平场 / 遮罩换品 / 桌面与模拟后端 / 构建产物');
