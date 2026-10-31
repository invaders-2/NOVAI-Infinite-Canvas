# canvas-next：新的无限画布

整体替换 `react-canvas/ReactCanvasApp`。界面、交互、生成引擎、Agent 都在这里；后端只通过 `backend/types.ts` 的 `CanvasBackend` 接口访问。

## 目录

| 文件 | 作用 |
|---|---|
| `entry.tsx` | 桌面版接入点 `NextCanvasApp`，props 与旧 `ReactCanvasApp` 相同（win / onOpenModelSettings / onBackToWorkspace …） |
| `CanvasApp.tsx` | 画布根组件：`<CanvasApp backend canvasId host />` |
| `model.ts` | 节点数据模型（生成数据存在 `node.data.gen`，兼容现有 CanvasDoc）、模型能力表、参数、连线关系 |
| `table.ts` | 多维表格：数据、出表提示词与校验、输入列、逐行批量（简化自 NOVAI / DX OS） |
| `engine.ts` | 生成引擎：组装请求、单节点生成、重新生成新建节点、链式运行、文本出表、表格逐行批量 |
| `store.ts` | 状态（文档 / 视口 / 界面 / 运行态），撤销重做，防抖保存 |
| `actions.ts` | 连线、删除、复制粘贴、上传等编辑动作 |
| `stack.ts` | 多节点堆叠（TapNow Stack）：分组节点 + `data.stack` 标记，成员收起不显示 |
| `zip.ts` | 批量下载用的最小 zip 打包（只存储不压缩） |
| `videoTools.ts` | 视频修剪、智能切镜、AI 视频编辑（替换 / 移除 / 续写 / 重拍）、草稿转成片 |
| `elements.ts` | 元素（TapNow Elements）：角色 / 产品 / 场景参考集，提示词里 `@名字` 引用；桌面版同步到个人资产库的 AI 角色；界面在 `ui/Elements.tsx` |
| `search.ts` | 节点搜索：整张画布 / 分组范围、类型（含分组）、关键词 |
| `history.ts` | 跨项目生成历史：合并各画布的生成记录，筛选、搜索、放回画布 |
| `agent/qa.ts` | Agent 问答卡（最多 4 问）与思考强度相关的本地规则；界面在 `agent/QaCard.tsx` |
| `backend/bridge.ts` | 桌面真后端：ReactIsland 直接使用 `window.openarc.canvas / model` |
| `backend/mock.ts` | 模拟后端（独立页 / 测试） |
| `agent/` | Agent：对话、技能、记忆、上下文；真后端时走对话模型 + `plan` 协议 |
| `ui/` | 视口、节点、连线、生成面板、表格节点、菜单、浮层、编辑器、样式 |
| `dev/` | 独立页入口与示例画布 |

## 换入口

```tsx
// src/canvas/react-canvas/main.tsx
import { NextCanvasApp } from "../canvas-next/entry";
createRoot(root).render(<NextCanvasApp />);
```

其他地方引用 `ReactCanvasApp` 的，换成 `NextCanvasApp`（props 相同）。

## 数据兼容

- 文档仍是 `CanvasDoc`，读写走 `react-canvas/persistence.ts`（含旧格式迁移、409 冲突）。
- 生成相关字段在 `node.data.gen`；同时把当前结果同步回 `node.text / url / variants / ratio`，旧组件和导出照常能读。
- 旧版的 table / note / group / 3D / 时间线节点只读显示，不会丢。
- 表格节点：`kind: "table"`，数据在 `node.data.table`；旧版只读表格的 `data` 会自动转换。

## 素材发给模型：链接与降级

`backend/bridge.ts` 的 `linkInputs / modelUrl` 按输入类型处理素材：

- http(s) 地址原样使用；data URL 先经 `canvas/importAsset` 存进资源库；`openarc-asset:…` 引用经 `canvas/assetPublicUrl` 换成 https 链接。
- 主进程实现为 `electron/canvas-asset-public-url.cjs`：读取素材时复用画布权限，按 sha256 去重，链接剩余有效期超过 1 小时才复用，并发同内容只上传一次。
- 当前 runtime 注入授权后的 Litterbox 上传器，保留 24 小时，单文件上限 **200MB**。实际上传仍取决于用户授权、依赖和网络结果，失败按结构化错误返回。
- `canvas/assetPublicUrl` 不可用时，图片压缩到长边 2048、≤1.5MB 后以 data URL 发送；视频 / 音频直接说明不可用原因，不把大文件塞进请求。
- 编辑类原图和蒙版同样优先走链接；远程生成结果由 `canvas/importRemote` 下载并重新登记为资源引用。

## 当前主进程接线

`canvas/assetPublicUrl` 与 `canvas/importRemote` 已登记在 `electron/canvas-bootstrap.cjs` 的命令白名单中，由 `runtime-composition.cjs` 注入同一 `canvasDocService`、上传授权和下载实现。这里不再保留“新增命令”的接入示例。

生成相关后端能力以现有命令和结构化错误为准；没有进度真值时，前端只显示估算进度，不把估算写成后端已返回的 `progress`。

## Agent 数据权威

- 记忆通过 Resource 的 `resource/query / create / readText / delete` 读取和保存。
- 技能通过 SkillService 的 `skill/list / save / enable / disable` 管理；在线技能包预览与安装也有既有命令。
- 历史对话通过 Task 的 `task/list / get` 恢复，不另存一份本地会话副本。
- 个人模板通过画布资产库的 `workflow` 条目保存，不使用 localStorage 充当资产库。
- localStorage 只保存界面偏好、最近运行/模型选择等客户端状态，以及独立 mock 后端的数据，不再是上述后端数据的权威。

## 验证

```bash
npm run typecheck
npm run build
```

独立页仍可使用 mock 后端；桌面版使用上述真实 preload 与主进程链路。
