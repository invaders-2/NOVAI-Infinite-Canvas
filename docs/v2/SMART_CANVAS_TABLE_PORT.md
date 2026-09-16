# 把多维表格同步到智能画布（实施计划）

> 结论先说：智能画布**完全没有**表格实现；要做的不是"同步几个改动"，而是把经典画布的
> 表格节点作为**一份共享实现**接进智能画布。计划分三步，每步独立提交、可回滚。

## 现状（已核实 2026-09-16）

| | 经典画布 canvas.html | 智能画布 smart-canvas.html |
|---|---|---|
| `shared/table-model.js`（数据层） | ✅ | ❌ 未引入 |
| `css/table-node.css`（样式） | ✅ | ❌ 未引入 |
| 表格节点实现（渲染/通道/批量/LLM 出表） | ✅ 在 `canvas.js`（1942 行） | ❌ 一行都没有 |
| `node-registry` 的 `spec('table')` | ✅ | ✅（共享，但没实现） |

智能画布的节点类型是 `smart-image / smart-prompt / smart-group / smart-loop / smart-container`，
生成走**助手/agent 工具链**，没有经典画布那种"每个节点自带 runner"的生成节点。
用户说的「上传节点」= `smart-image`（写着「拖拽 / 粘贴 / 点击上传」、图片视频都收）。

## 目标流程

```
参考图 / 白底图 ─┐
                 ├→ LLM 节点（智能画布的 prompt 节点，LLM 模式）
提示词 ──────────┘     ├ 文本输出
                       ├ 多维表格      ← 点运行后自动出表 + 自动连线
                       └ 视频分镜表
                                    │
                                    └→ 上传节点（smart-image）
                                        上方出现「生成输入」批量列表（同经典画布）
```

## 关键手法：工厂函数 + 宿主注入（不改那 1942 行）

表代码依赖 20 多个画布钩子。**不要逐个改名**，改成"宿主注入 + 闭包"：

```js
// shared/table-node.js
(function(root){
  root.NovaTableNode = function createTableNode(host){
    // 宿主提供的钩子解构成局部名字，后面 1942 行原样不动
    const { nodes, connections, addNode, render, scheduleSave, saveCanvas, uid, pushUndo,
            defaultPoint, mediaKindForNode, mediaKindForRef, mediaKindForUpload,
            outputUrlValue, isMissingAssetUrl, canvasPreviewImgHtml, canvasVideoPreviewHtml,
            nowMs, responseErrorMessage, refreshIcons, renderNode, runGenerator, runVideoNode,
            selected, showErrorModal } = host || {};
    /* 原 canvas.js 表格段，逐行搬过来，未改动 */
    ...
    return { renderTableBody, addTableNode, addTableRow, /* …对外要用的那些… */ };
  };
})(typeof window !== 'undefined' ? window : globalThis);
```

画布侧：

```js
// canvas.js（原表格段位置换成这几行）
const tableApi = window.NovaTableNode({ nodes, connections, addNode, render, /* … */ });
const { renderTableBody, addTableNode, addTableRow, tableRowInputs, runTableBatch,
        llmOutputModeButtonsHtml, tableBatchPanelFor } = tableApi;
```

要点：
- 宿主名字必须**在调用工厂时就已经存在**（`nodes/connections/nodesEl/selected` 等是文件顶部的
  `let/const`；`render/scheduleSave/uid…` 是函数声明，会被提升）。
- 工厂返回的是"对外要用的那批函数"，用脚本扫 `canvas.js` 表格段以外的引用点算出来。

## 三步

### 第一步：抽模块（经典画布零行为变化）
1. `git mv` 思路：把 `canvas.js` 里 `function novaTableModel(){` 到 `function defaultNodeSize(type){` 之间
   的 1942 行原样搬进 `shared/table-node.js` 的工厂里；
2. `canvas.js` 原地换成工厂调用 + 解构；
3. 验收：`node --check` + 5 套测试全绿（`test_table_model` / `test_table_node_dom` /
   `test_table_node_wiring` / `test_select_menu` / `test_dark_mode_canvas`）+ **浏览器打开经典画布点一遍表格**；
4. 提交。

### 第二步：智能画布适配器
1. `smart-canvas.html` 引入 `table-model.js` / `table-node.css` / `table-node.js`（带 `?v=`）；
2. `smart-canvas.js` 里调同一个工厂，宿主用自己那套实现；
3. `smartNodeBodyHtml`（现有 `if(node.type === …)` 分发处）加 `table` 分支；
4. LLM（prompt 节点的 LLM 模式）加三个输出方式药丸，复用同一份 `llmOutputMode*` 逻辑；
5. 出表后**物化表格节点 + 自动连线**（表格 → 上传节点）；
6. 上传节点上方渲染批量面板；
7. **待定**：批量"跑一行"调用智能画布的哪条生成链路（助手工具链 vs 别的）——这是唯一需要产品确认的接口；
8. 验收同第一步 + 浏览器把链路点一遍。

### 第三步：接线与验收
节点菜单补「多维表格」、老画布加载清理、i18n、`?v=` 版本、`tests/` 补智能画布的静态断言。

## 已算好的宿主接口（脚本扫出来的真实依赖）

`addNode, canvasPreviewImgHtml, canvasVideoPreviewHtml, connections, defaultPoint,
isMissingAssetUrl, mediaKindForNode, mediaKindForRef, mediaKindForUpload, nodes, nodesEl,
nowMs, outputUrlValue, pushUndo, refreshIcons, render, renderNode, responseErrorMessage,
runGenerator, runVideoNode, saveCanvas, scheduleSave, selected, showErrorModal, uid`

（其余是 JS 内建、对象属性名或块内局部变量，不需要宿主提供。）


## 决策更新（用户 2026-09-16 明确）

**不改造现有的上传节点（smart-image），而是新增一个"批量生成节点"。**

用户原话：「采用跟 api 生成节点一样的逻辑，再添加一个输入节点，点击后下方出现编辑器，
点击进行批量生成按钮」。

落地方式：

1. **新节点类型**（暂命名 `smart-batch`，标题「批量生成」），视觉与交互对齐经典画布的
   生成节点接了多维表格之后的样子：
   - **输入端口**：接收多维表格（接表格节点的输出）；
   - **节点主体**：上方「生成输入」批量面板（批量 N 行 / 每行素材缩略图 + 提示词预览 /
     起始行 / 并发 / 出错策略 / 独立运行 / 恢复上次），下方一颗 **「批量生成」** 按钮；
   - 点击节点 → 下方出现编辑器（面板展开），点「批量生成」按行跑。
2. **模型/参数**：与经典画布 API 生成节点同一套设置（平台 / 模型 / 比例 / 分辨率 / 数量 /
   时长），直接复用智能画布已有的设置面板。
3. **每行怎么跑**：复用智能画布**已有的直接生成函数**，不走助手工具链（见上一节）：
   ```
   runRow(行) → runSettings = smartSettingsForNode(批量生成节点)
                kind === 'video' ? runApiVideoGeneration(prompt, refs, runSettings)
                                  : 按 engine 分发 runApiGeneration / runRunningHubGeneration
                                    / runModelscopeGeneration / runComfyGeneration
                轮询：agentPollGenerateTask + GET /api/canvas-image-tasks/{taskId}
   ```
4. **产物落点**：每行产物追加到该节点的历史，并标上行号（一张表跑 4 行 = 4 条历史，可对上是第几行）。
   若之后要"每行平铺一个图片节点"，只改这一处。

这样第二步就不依赖"改造上传节点"，也不动现有 `smart-image` 的任何行为——**新增节点，风险隔离**。

## 教训（写在这里免得再犯）
- 改这类大件：**先补测试垫片/测试，再动生产代码**；
- 每步改完**先在真浏览器点一遍**再提交；
- 中间别用脚本做"回退"式删改（上次回退把 `wrap.appendChild(menu)` 一起删掉，导致菜单点不开、
  还提交了不可用状态）。
