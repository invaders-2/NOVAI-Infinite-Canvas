# NOVAI V2 风险报告（PHASE 0 输出）

> 依据：后端/前端两份审计 + 历史踩坑记录（v1.0.83-v1.0.108 修复史）
> 风险分级：🔴 高（会翻车） 🟡 中（拖进度） 🟢 低（注意即可）

## 🔴 高优先级风险

### R1. 单文件巨型单体改不动（最高风险）
- **现状**：main.py 19,914 行单文件、smart-canvas.js 18,092 行 IIFE、canvas.js 16,742 行。无模块边界、无测试、状态全在闭包。
- **V2 冲击**：Task Engine 要改所有生成入口（4-6 处分发点 × 3 类任务），Agent 要改画布状态——任何改动都是"改一处崩三处"。
- **缓解**：① Phase 1 只做增量（加任务层，不改现有调用链，生成入口做适配器包裹而非重写）；② 每个 Phase 强制回归清单（已有 docs/regression-checklist.md 7 组）；③ 先给 smart-canvas.js 补 node --check + 最小冒烟测试再动它。

### R2. 双画布代码基分叉
- **现状**：智能/传统两套画布独立实现，功能双份维护（视频控制条/@引用/canvas_meta 均两处，v1.0.103→1.0.107 连修 7 版就是代价）。
- **V2 冲击**：V2 功能（版本化/Matrix/Agent）若做双份，工作量翻倍且必然漏改。
- **缓解**：**决策点：智能画布为 V2 主阵地，传统画布冻结只修 bug**（需老板确认）。

### R3. 数据模型迁移
- **现状**：存量画布 JSON 无 schema 约束，节点是自由对象；assets 是裸 URL；无迁移框架（只有几个一次性修复函数）。
- **V2 冲击**：加 task_id/config/inputs/outputs/schema_version 字段后，旧数据不兼容。
- **缓解**：Phase 2 先定义 schema + 迁移层（沿用 normalizeLegacySmartNode 模式，L1216-1240 已有先例），迁移前备份 data/ 全目录，迁移后跑全量画布加载测试。

### R4. 画布同步机制脆弱
- **现状**：全量 PUT + 450ms 防抖 + 409 合并（id 并集 + 图片并集，会丢语义级编辑）；离线编辑无队列直接丢；iframe 内无 WS，靠 8s 轮询发现冲突。
- **V2 冲击**：Workflow 版本化 + Agent 自动修改后，多端并发 + 机器改 + 人改的冲突面急剧扩大。
- **缓解**：Phase 2 版本化时顺带做"冲突检测升级"（版本号而非 id 并集）；Agent 修改前强制锁（Workflow 锁定状态，V2 方案 #28 已要求）。

### R5. Agent 能力依赖 LLM 实际水平
- **现状**：对话通道（resolve_chat_provider）支持多平台，但 Agent 需要的"看懂画布→规划→执行→验证"是最高难度 LLM 场景；当前 chatModal 只有 2 个硬编码命令。
- **V2 冲击**：Phase 5 Agent 若做成"半吊子"，违反"不做假功能"原则。
- **缓解**：Agent 前置条件必须全部满足才做（Task Engine 真实、Workflow 版本化真实、工具执行真实）；先做"单意图→单计划→预览→执行"最小闭环，再扩展；每步执行都回读真实结果。

## 🟡 中优先级风险

### R6. 任务扣费与重试冲突
- **现状**：业务生成 5xx 刻意不重试（防重复扣费，L4341/L4415 注释）。
- **V2 冲击**：Task Engine 加"自动重试"必须区分"可安全重试"（网络层/排队超时）与"不可重试"（已提交到 provider）——重试策略设计错误会直接烧钱。
- **缓解**：重试仅限 queued/网络错误；provider_processing 后只允许手动重试且明示可能扣费。

### R7. 存储选型摇摆
- **现状**：纯 JSON + threading.Lock，画布 11 个文件小规模没问题。
- **V2 冲击**：Task 表高频写（状态变化）+ 版本快照累积，JSON 文件锁会成为瓶颈；但换 SQLite 是全量迁移。
- **缓解**：Phase 1 用 JSON 扩展（任务目录分片 data/tasks/{yyyymm}/），Phase 4 批量前评估 SQLite，**先出评估报告再动**。

### R8. WS 推送能力不足
- **现状**：唯一 WS /ws/stats 只推在线数/新图/画布更新，无任务进度百分比；iframe 内不连 WS。
- **V2 冲击**：Task Manager UI 需要实时进度。
- **缓解**：Task Engine 事件源 + 前端轮询兜底（现状已有轮询模式，成本可控）；WS 增强放 Phase 1 尾部。

### R9. Provider 分发是 if/elif 链
- **现状**：图片/视频/对话各一个分发入口，但逻辑在路由内 if/elif（判别函数 is_xxx_provider 遍布代码）。
- **V2 冲击**：Model Router 要抽象 Provider 能力（quality/speed/cost），需要 Provider Adapter 化。
- **缓解**：Phase 5 做 Router 时再 Adapter 化（Phase 1 不动）；新增平台前维持现状。

## 🟢 低优先级风险

- **R10. postMessage 安全**：子页 `*` 发送（接收端有 origin 校验）——V2 新页面注意发送端也校验。
- **R11. 细节 bug**：/api/lan-info 端口写死 3000（测试版 3001 下显示错误）；smart-canvas.html 缺 title——顺手修。
- **R12. canvas_meta 补丁式**：只挂 3 个视频分支，图片分支无 meta——V2 统一为"生成入口全带 canvas_meta"。

## 结论

**V2 最大的风险不是技术难度，而是"在不重写的前提下改造巨型单体"的组织风险**——每次改动都是外科手术。缓解三件套：
1. **智能画布单线化**（传统画布冻结）——砍一半维护面
2. **每 Phase 独立验收 + 回归清单**——防止改坏存量功能
3. **先地基后上层**（Task Engine → 版本化 → Matrix → Agent）——杜绝空中楼阁
