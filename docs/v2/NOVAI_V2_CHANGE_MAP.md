# NOVAI V2 变更地图（PHASE 0 输出 · 基于代码审计）

> 依据：NOVAI_ARCHITECTURE_AUDIT.md（后端）+ NOVAI_FRONTEND_AUDIT.md（前端）
> 原则：增量改造，不重写；每个 Phase 独立验收 + Commit；不做假功能

## 一、现状结论（一句话版）

NOVAI 是"功能完备但结构过时"的巨型单体：后端 185 路由单文件（main.py 19,914 行），前端 18k 行单文件 IIFE + iframe 多页架构。**Task Engine 不存在（但有雏形 CANVAS_TASKS）、Workflow 无版本、Asset 是裸 URL、Agent 是 2 命令聊天窗**——V2 全部目标都缺，但全部都有可增量落地的起点。

## 二、V2 功能 → 现状 → 落地路径总表

| V2 目标 | 现状（审计证据） | 落地路径 | 难度 |
|---|---|---|---|
| **Task Engine** | CANVAS_TASKS 内存字典（task_id/status/timestamps/result/error 已具雏形，L13870-13946）；无持久化/队列/worker/重试 | Phase 1：把 CANVAS_TASKS 升级为持久化任务表（data/tasks/*.json）+ 状态机 + 队列；生成入口（canvas-video/canvas-image-tasks）改走 Task Engine | ★★★ |
| **Workflow 版本化** | 画布 PUT 全量覆盖 + 乐观锁（base_updated_at）；无快照/版本表；内存撤销栈 40 步 | Phase 2：PUT 时旁路存快照（data/canvas_versions/{id}/v{N}.json）+ 版本列表/回滚 API + 前端版本面板 | ★★ |
| **Asset 对象化** | 节点 images[] 存裸 URL；asset_library.json 有索引但节点不引用 Asset ID | Phase 2：定义 Asset 对象（id/kind/metadata/来源），节点 images[] 存 asset_id + 迁移层；Asset ID 引用而非复制 | ★★ |
| **Outputs 页面** | 最接近的是 asset-manager「画布资产」tab（canvas_assets_index 聚合 + zip 下载，只读） | Phase 2/4：扩展成独立 Outputs 页（index.html 一级 iframe，勿再套层）：预览/筛选/收藏/拖回画布 | ★★ |
| **Matrix 批量** | 无（无批量任务概念） | Phase 4：Matrix = 维度笛卡尔积 → 真实创建 N 个 Task 进 Task Engine；任务统计 UI（total/queued/running/success/failed） | ★★★ |
| **Agent/Planner** | chatModal 2 命令（create_node/connect）+ M2 建议条单步闭环 | Phase 5：工具注册表 + 画布快照 API + 多轮上下文 + 计划状态机 + Preview/Apply/Rollback | ★★★★★ |
| **Model Router** | 无（用户手选模型） | Phase 5：意图分析 → 路由（quality/speed/cost/availability）→ 执行；Provider Fallback 记录切换原因 | ★★★ |

## 三、Phase 拆分（严格顺序，跳阶段禁止）

```
PHASE 1 — Task Engine（地基，2-3 周）
  后端：任务表持久化 + 状态机（queued→running→provider_processing→downloading→saving→success/failed/cancelled）
       + 队列/并发限制 + 重试策略（防重复扣费）+ 任务证据链（provider_task_id/timing/error）
       + 生成入口接入：canvas-video、canvas-image-tasks、canvas-comfy-tasks
  前端：任务轮询改用 task_id 持久化 + 节点关联；WS 推任务状态
  验收：真实生成从 queued 走到 success，重启不丢任务，失败可重试

PHASE 2 — Canvas + Asset 对象化（2 周）
  后端：节点 schema（config/inputs/outputs/task_id/schema_version）+ 迁移层（沿用 normalizeLegacySmartNode 模式）
       + Workflow 快照 API（版本化）+ Asset ID 注册
  前端：节点写入标准字段；版本面板（列表/还原）；Outputs 页雏形
  验收：旧画布无损迁移；改坏可还原版本；资产被引用而非复制

PHASE 3 — Video / Storyboard（1-2 周）
  Storyboard 数据对象（scene/visual/prompt/camera/motion/duration/transition/audio）
  视频链路接入 Task Engine（Seedance 编辑/参考视频已在，补任务化）

PHASE 4 — Matrix / Batch（2 周）
  维度定义（character×product×scene×pose×camera×style）→ 真实创建 N 任务 → 统计面板

PHASE 5 — Agent / Planner（3-4 周）
  工具注册表 + 画布快照上下文 + 计划状态机 + Preview/Apply/Rollback + Command Layer（Validator）
  依赖：Phase 1-2 的地基（Agent 改的是真实 Workflow/Task）

PHASE 6 — Asset Intelligence（1-2 周）
  Product Asset 多维元数据（白底图/细节/logo/材质/颜色/品牌/AI描述）

PHASE 7 — 专业生产收尾（1-2 周）
  电商场景模板（鞋子主图等）、错误 UX、日志、回归
```

**总预估：3-4 个月**（每个 Phase 独立验收，时间以验收通过为准，不以代码写完为准）

## 四、先做哪几个（我的建议排序）

按"价值/成本"比，给老板的建议执行顺序：

1. **Phase 1 Task Engine**（必须最先——Matrix/Agent/Outputs 全依赖它）
2. **Phase 2 Canvas 版本化 + Asset 对象化**（趁热打铁，地基连成片）
3. **Outputs 页**（成本最低、用户感知最明显——生成结果不再散落）
4. Matrix（电商批量出图的核心价值）
5. Agent/Planner（最后——依赖前 4 个的地基，且最不确定）

## 五、关键决策点（需要老板拍板）

| 决策 | 选项 | 影响 |
|---|---|---|
| 数据存储 | 继续 JSON 文件（加锁+旁路快照）vs 引入 SQLite | JSON 快但并发弱；SQLite 稳但迁移量大。建议 Phase 1 先用 JSON 扩展（快），Phase 4 批量时再评估 SQLite |
| 双画布 | 智能画布为 V2 主阵地，传统画布冻结（只修 bug）vs 双线并行 | 强烈建议前者——双份维护已多次踩坑 |
| iframe 架构 | 保持（新页做一级 iframe）vs 逐步收敛为 SPA | 建议保持（V2 不重写原则），新模块（Outputs/Tasks）作为 index.html 一级路由 |
| Agent 的 LLM | 现有 resolve_chat_provider 通道 vs 内置专有 Agent 模型配置 | 建议复用现有通道 + 可配置 Agent 专用模型 |
