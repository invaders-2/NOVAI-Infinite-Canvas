# BEAT 画布助手 Agent 化改造 · 四阶段收尾（FINAL）

> 同内容随版本存档于 docs/AGENT_V2_FINAL.md

- 文档时间：2026-11-12（Asia/Shanghai）
- 仓库：NOVAI-v16，分支 main；版本号 VERSION = 2.0.07（本轮未 bump）
- 范围：阶段一（上下文引擎）／阶段二（跨会话记忆）／阶段三（思考与自检）／阶段四（主动性与自治）+ 卡片菜单/弹层修复
- 纪律：全程未 commit / 未 push；改动版一律独立端口 + 临时 NOVAI_DATA_DIR，3000（正式安装版）全程未碰
- 证据目录：_verification-beat-agent-v2/（该目录被 .gitignore 的 _verification-*/ 忽略，只在本地留档，不进提交）

---

## 0. 本次收尾实测数字（不是估算，命令见 §6）

| 命令 | 结果（2026-11-12 实测） |
|---|---|
| python3 -m pytest tests/test_agent_*.py -q（默认配置 = SLIM_TOOLS 未设置，临时 NOVAI_DATA_DIR 口径） | 8 failed / 1171 passed / 1 skipped / 183 subtests passed，23.35s；8 条失败全部是 test_agent_skill_ref.py（技能正文缺失的环境项） |
| 同一命令（仓库默认数据目录口径） | 11 failed / 1156 passed / 13 skipped；多出的 3 条失败是 activate_skill / canvas_p0 / web_image_search（本机配置/上游相关），13 条 skip 是 fix4 预算/续跑等测试在 DATA_DIR 不是临时目录时主动跳过（保护真实数据） |
| node tests/run-all.js（本轮实测） | 182/190 通过，8 条失败：6 条在 tests/known-failures.json 基线内（test_beat_popup_thumbnails / test_canvas_assistant_glass_addmenu / test_canvas_carousel_layout / test_chat_memory_toggle_scope / test_novai_canvas_lightbox_compare / test_shell_sidebar_gear_align），另 2 条是改造前就存在的存量红（已删除的对话页测试 / test_novai_canvas_workflow_bundle）；测试总数 183 → 190 |
| 开关全关行为快照（显式 NOVAI_AGENT_V2_SLIM_TOOLS=0，其余 NOVAI_AGENT_V2_*=0） | agent_surface_snapshot.py --compare agent-v2-off-snapshot-pre.json <本次> → behavior_identical=True，behavior_sha256=c99349bce48e7154dd160294b9281f704f4cb0b1a10bef09bb71bcb199fea2b6；tools=27 catalog=27 cli=26 |
| NOVAI_AGENT_V2_SLIM_TOOLS 默认开（不设=on） | 工具表 29 → 7、system 字符 24,961 → 10,534（−57.8%）；显式 0 时提示词/工具面逐字回到改造前（快照见上）。默认 on 时行为面变化属预期，详见 §8 |
| 静态缓存号 | python3 tools/refresh_static_versions.py = dry-run 0 处待刷新（VERSION 2.0.07；static/novai-canvas/canvas.js|css 已于 2026-11-12 10:08 按菜单修复重建） |
| 全量后端 pytest（终态回归，见 FINAL-regression.md） | 33 failed / 2741 passed / 5 skipped / 536 subtests，111.36s；与阶段一开工前基线（34 failed / 2434 passed / 5 skipped）逐条对比：新增失败 0 条、消失 1 条（基线采集窗口内的并发编辑假红 test_default_data_root::test_windows_program_files_is_protected，终态该用例全量跑通过）、其余 33 条逐条相同（环境/数据 18 + 与本轮无关的存量 15） |
| unittest discover（终态回归） | Ran 1063 tests，失败 8 条（7 failures + 1 error），失败文件只有 tests/test_agent_skill_ref.py（技能正文缺失的环境项，与 pytest 该文件 8 条同源） |
| node run-all --ci-baseline（终态回归） | 基线内 6 / 新增 2 / 过期 0，exit 1；8 红名单与基线完全一致（新增 0 / 消失 0 / 不变 8），新增的 2 条都是前端存量（已删除的对话页测试 / test_novai_canvas_workflow_bundle） |
| 证据截图 | _verification-beat-agent-v2/shots/ 共 182 张 png |

> 全量 pytest / unittest / node --ci-baseline 的数字来自 _verification-beat-agent-v2/FINAL-regression.md（2026-11-12 10:18–10:25 采集，main.py sha256 25fc72cb…，跑前跑后 sha 一致、无并发噪声；原始输出在 raw/final-*.txt）；agent 子集与分阶段专项计数是本文件写入时实测。
>
> 修复批（§7）与收尾补验（§8）完成后的复测数字：agent 子集默认配置 + 临时数据目录 = 8 failed / 1171 passed / 1 skipped；node = 182/190；显式 SLIM_TOOLS=0 时行为快照与改造前逐字一致（behavior_identical=True）。

分阶段新增测试（本次逐个文件实测，全部通过）：

| 测试文件 | 结果 |
|---|---|
| tests/test_agent_core_context_engine.py | 35 passed |
| tests/test_agent_core_read_tools.py | 18 passed |
| tests/test_agent_core_memory_store.py | 78 passed |
| tests/test_agent_recall.py | 26 passed |
| tests/test_agent_memory_candidates.py | 16 passed |
| tests/test_agent_memory_settings.py | 11 passed |
| tests/test_agent_stream_events.py | 15 passed |
| tests/test_agent_reflect.py | 19 passed |
| tests/test_agent_run_state.py | 7 passed |
| tests/test_agent_suggestions.py | 9 passed |
| tests/test_agent_triggers.py | 11 passed |
| tests/test_agent_autonomy.py | 14 passed |

---

## 1. 四阶段交付摘要

### 阶段一 · 上下文引擎（把「一次大提示词」拆成稳定前缀 + 转录 + 分层预算）

**一句话**：换成「稳定 system 前缀 + 持续增长的消息转录 + 分层预算（memory/canvas/history/transcript）+ 两级压缩（70% 折叠旧工具结果、85% 调模型摘要）」，再把画布信息从「全部塞提示词」改成「一行一节点的地图 + 六个按需只读工具」，面板能看到分层占用和「已整理上下文」。

**关键文件 / 函数**
- server/agent_core/context_engine.py：Budget、estimate_tokens、select_history、canvas_map、render_transcript、fold_old_results、summary_cut、summary_request、assemble
- server/agent_core/transcript.py：Transcript（逐条落盘 data/agent_runs/{run_id}.jsonl；折叠/摘要只追加不删原文）
- server/agent_core/read_tools.py：READ_TOOL_NAMES（read_node / search_canvas / read_table / canvas_diff / view_image / recall_step）、tool_entries
- main.py：_agent_v2_flag 与 _agent_v2_context/read_tools/transcript_enabled、_agent_v2_round_context、_CanvasRunContext.build_system_prefix / build_environment_text、POST /api/agent/runs/{run_id}/compact、GET /api/agent/runs/{run_id}/model-context
- 前端：novai-canvas-ui/src（ContextMeter 分层占用、context_compacted → 「已整理上下文」一行）

### 阶段二 · 跨会话记忆（摘要 / 档案 / recall / 候选卡 / 开关与清理）

**一句话**：让新对话一开口就知道这张画布做过什么——后台把对话摘要写回线程、合并成 800 字以内的画布档案并注入新对话开场；同时建 data/agent_memory/index.jsonl 关键词索引，支持 recall 跨对话/跨画布翻历史；摘要顺带提炼「记忆候选」，用户勾选后才写长期记忆；三把按画布开关 + 删画布清理。

**关键文件 / 函数**
- server/agent_core/memory_store.py：summary_request / parse_summary（固定七段，含【记忆候选】）、thread_should_summarize（阈值 env + 60s 冷却）、parse_candidates / merge_candidates / thread_candidates、merge_profile / render_profile / fit_profile、opening_text、keywords / select_related、readable_text / make_entry / MemoryIndex（add / search / remove_keys / remove_canvas）、load_settings / save_settings
- main.py：NOVAI_AGENT_V2_MEMORY 与 _agent_v2_memory_enabled、_agent_v2_memory_update（后台摘要 + 候选 + 索引）、_agent_v2_memory_opening、_agent_v2_memory_text、_agent_v2_recall_search / recall 工具（纯关键词、scope=thread/canvas/all）、_agent_v2_memory_index_thread/summary/profile/memory、_agent_v2_memory_forget_canvas（删画布清理）
- 路由：GET/PUT /api/agent/memory/settings、GET /api/agent/memory/candidates、POST /api/agent/memory/confirm、POST /api/agent/memory/candidates/dismiss、GET/PUT/DELETE /api/agent/profile/{canvas_id}、GET /api/agent/recall
- 数据：data/agent_memory/{画布}.profile.json、{画布}.settings.json、index.jsonl；线程文档新增 summary / summary_upto / summary_at / memory_candidates；roadmap 是既有字段（本轮修掉「读盘会丢」的 bug）
- 前端：记忆候选卡、记忆开关、项目档案查看/编辑/清空、#aMore → 搜索历史（step5~step7 证据）

### 阶段三 · 思考与自检（流式输出 + 反思轮 + 完成前自检 + 审查死循环修复）

**一句话**：把「黑盒等待」变成可看见的过程——SSE 增量下发思考/正文/工具准备行；失败后强制反思三问、完成前按指令与画布核对一遍「数量/比例/节点」；并修掉「审查后重新生成」的死循环与 C1~C8 一批缺陷。

**关键文件 / 函数**
- server/agent_core/stream.py：StreamParser（reasoning / content / tool_call / tool_done，跨 chunk 拼工具参数）
- main.py：_agent_run_stream_chat、_agent_run_stream_text、_agent_v2_stream_enabled；三类事件 reasoning_delta / message_delta / tool_call_delta；GET /api/agent/runs/{run_id}/stream?after=N（断线续传）
- 反思与自检：_agent_v2_reflect_enabled、_agent_v2_self_check_enabled；自检系列 _agent_self_check_node_ids / _table_rows / _actual_count / _roadmap_scope / _roadmap_items / _constraint_items / _bounce_text；事件 thought{kind:"reflect"|"self_check"} + self_check{round,passed,items}
- 审查死循环修复（§6.5 四条规则）：_agent_regenerate_steps、_agent_start_node_generation、请求指纹 _agent_run_regen_request_key、_agent_run_regen_should_retry、review_counts 上限；审查结论回灌进下一轮
- 阶段三修复批：C1 自检分阶段范围、C2 数量约束、C7 验收标准不再预标「已通过」、C4 回复实时输出、C5 JSON 模式流式、C6 <think> 标签过滤、D1 view_image 提示去重、D2 recall 无可见画布集合时过滤；前端 C3 保留最初源图、C8 SSE 订阅替代高频轮询（agentStream.ts / watchCadence.ts / bridge.ts）
- 前端：思考折叠区逐字、回复逐字、工具准备行原地转正、自检一行 + 反思徽标、方案卡验收标准（step8/step9 证据）

### 阶段四 · 主动性与自治（三档 + 状态机挂起/唤醒 + 事件触发 + 下一步建议）

**一句话**：让助手能按用户给的自治程度自己推进（协作 / 自动推进 / 托管+预算授权），等生成时挂起并在结果回来时唤醒（重启可恢复），画布事件（生成完成/失败、拖入素材、回到有未完成方案的画布）可以主动说一句，任务完成时给 2-3 条下一步建议。

**关键文件 / 函数**
- 自治：_agent_v2_autonomy_enabled、_agent_run_autonomy、_agent_run_budget_limits、_agent_managed_cap、_agent_run_budget_grant、POST /api/agent/runs/{run_id}/budget、budget_required 事件；请求字段 autonomy / budget
- 状态机：server/agent_core/run_state.py（new_state / touch / write_state / read_state / list_states / active_states / resumable_states）、_agent_v2_runstate_enabled、_agent_run_state_read/write/update、_agent_run_resume、_agent_run_resume_all（应用 startup 触发）、run_suspended 事件
- 事件触发：server/agent_core/triggers.py（TriggerPolicy、normalize_event_type、is_throttled、build_message）、_agent_v2_triggers_enabled、POST /api/agent/events（四类事件，同一画布 5 分钟节流）
- 建议：_agent_v2_suggestions_enabled、_agent_decision_suggestions；done / message 带 suggestions
- 前端：自治三档 pill + 托管授权卡、挂起/唤醒状态、主动消息与建议芯片（step11/step12 证据）

### 附 · 卡片菜单/弹层修复（不新增开关）

**一句话**：助手卡片上的菜单/弹层按硬规则改实——加厚底色（浅 0.96 / 深 0.95，保留磨砂模糊）、去掉 1px 环状投影、标题对比度提上去、限高 min(420px, 55vh) + capHeight 翻边选空间大的一侧 + 底部渐隐。

**关键文件**：novai-canvas-ui/src/canvas/tapnow/agent-panel-v2.css（修复段）、novai-canvas-ui/src/canvas/canvas-next/ui/placement.ts（capHeight）、novai-canvas-ui/src/canvas/canvas-next/ui/overlay.tsx（助手弹层传 capHeight）

---

## 2. 全部新增开关清单（grep NOVAI_AGENT_V2_*，共 14 个环境变量 + 3 个按画布文件开关）

### 2.1 环境变量（布尔开关除 SLIM_TOOLS 外缺省一律「关」；_agent_v2_flag(name, default=False)，SLIM_TOOLS 是唯一的 default=True）

| # | 开关 | 默认 | 作用 | 关掉时的行为 |
|---|---|---|---|---|
| 1 | NOVAI_AGENT_V2_CONTEXT | 关 | 多轮消息列表 + 分层预算 + 70%/85% 两级压缩 + 系统提示词拆稳定段/环境段 + 画布地图 | 回到一次性大提示词；不发 context_usage.layers / context_compacted；工具面不变 |
| 2 | NOVAI_AGENT_V2_READ_TOOLS | 关 | 注册六个只读工具（read_node / search_canvas / read_table / canvas_diff / view_image / recall_step），只读、不占步数、不过确认闸门；同步 CLI 命令表 | 工具不注册、CLI 命令表与改造前逐字一致；系统提示里「先读再动手」那段也不加 |
| 3 | NOVAI_AGENT_V2_TRANSCRIPT | 关 | 运行转录逐条落盘 data/agent_runs/{run_id}.jsonl + recall_step 可回捞 | 转录只在内存（同一次运行内仍可折叠/回捞），不落盘、重启不可恢复 |
| 4 | NOVAI_AGENT_V2_MEMORY | 关 | 阶段二全部能力：线程摘要、画布档案、新对话开场注入、长期记忆相关性挑选、关键词索引与 recall、记忆候选、按画布记忆开关、删画布清理 | 摘要/候选/开场注入/索引/recall 全不跑；recall 工具不注册；/api/agent/recall、/api/agent/memory/candidates、/confirm、/candidates/dismiss、/api/agent/memory/settings 返回 400（如实说明需要开关）；/api/agent/profile/* 仍可读写档案文件（它只依赖模块是否可用，不看 MEMORY 开关）；记忆段退回旧 _agent_memory_prompt |
| 5 | NOVAI_AGENT_V2_SUMMARY_MIN | 2（条） | 只有 MEMORY 打开时生效：自上次摘要后新增多少条消息才值得再摘要。默认 2 = 一次正常问答（user+assistant）结束就能出摘要/候选 | 不生效（MEMORY 关时摘要整条路径不跑）；非法 / <1 回默认 2 |
| 6 | NOVAI_AGENT_V2_SUMMARY_COOLDOWN | 60（秒） | 同一线程两次摘要的最小间隔（摘要是一次真实模型调用，防连发运行刷爆）；0 = 关掉冷却 | 不生效；非法 / <0 回默认 60 |
| 7 | NOVAI_AGENT_V2_STREAM | 关 | 上游 SSE 解析 + 三类增量事件（reasoning_delta / message_delta / tool_call_delta）+ GET /api/agent/runs/{run_id}/stream?after=N 续传 | 模型回复整段返回；前端收不到 delta，按原方式收 message / step_* 事件 |
| 8 | NOVAI_AGENT_V2_REFLECT | 关 | 失败后强制反思三问（期望 vs 实际 / 原因依据 / 换什么做法），写转录 note kind=reflect 并在下一轮消息里带【反思】 | 只保留原来那句「最近一次失败原因…换一种做法」；不发 thought{kind:"reflect"} |
| 9 | NOVAI_AGENT_V2_SELF_CHECK | 关 | 完成前自检（数量/比例/节点/roadmap 阶段验收），self_check{round,passed,items} 事件，未通过时打回一次 | 不做自检、不发 self_check、不打回；done=true 直接收尾 |
| 10 | NOVAI_AGENT_V2_SUGGESTIONS | 关 | done / message 带 suggestions（最多 3 条）；提示词多一句「完成时给 2-3 条下一步建议」 | payload 里没有 suggestions 键，提示词不加这句 |
| 11 | NOVAI_AGENT_V2_RUNSTATE | 关 | 运行状态机落盘 data/agent_runs/{run_id}.json（running / waiting_generation / waiting_user / finished）；等生成时挂起（run_suspended），结果回来自动唤醒，重启后 _agent_run_resume_all 恢复 | 仍按原来的 wait_canvas_results 轮询等待；不写状态文件、不发 run_suspended、不自动恢复 |
| 12 | NOVAI_AGENT_V2_AUTONOMY | 关 | 三个自治档位（collab / auto / managed）与托管预算（budget 字段、POST /api/agent/runs/{run_id}/budget、budget_required 事件） | 一律按 collab 解析：不自动推进、不发 budget_required、不读/写预算，行为与改造前逐字一致 |
| 13 | NOVAI_AGENT_V2_TRIGGERS | 关 | 画布事件触发：POST /api/agent/events（生成完成 / 失败 / 拖入素材 / 回到有未完成方案的画布），按档位决定唤醒或主动消息；同一画布 5 分钟内最多 1 条主动消息 | 路由仍注册但直接返回 {"ok":false,"enabled":false,"action":"none"}，不写线程、不发 SSE |
| 14 | NOVAI_AGENT_V2_SLIM_TOOLS | **开**（未设置 = on，唯一默认开的开关） | 模型可见工具表瘦身：只留 canvas_cli + 没有等价命令的工具（工具 29→7、system 字符 −57.8%）；canvas_cli 命令 enum 与 cli_spec 一致 | 显式 0 / off 时工具表与提示词逐字回到改造前（behavior_identical=True）；执行 / 展开本来就用完整工具表，不受影响 |
| 15 | NOVAI_AGENT_STREAM_FIRST_TIMEOUT_THINK | 60（秒） | K3：思考型模型（能力表/名字带推理，或用户选了思考强度）的流式首包上限；普通模型仍是 NOVAI_AGENT_STREAM_FIRST_TIMEOUT=8 | 不设就是 60；显式调小会立刻收紧思考型首包，显式调大可进一步放宽 |
| 16 | NOVAI_AGENT_STREAM_TOTAL_TIMEOUT_THINK | 180（秒） | K3：思考型模型流式整体上限（首包放宽后不能被 90s 总时限截断） | 不设就是 180；普通模型仍是 _AGENT_STREAM_TOTAL_TIMEOUT_SECONDS=90 |

> 除 SLIM_TOOLS 外，所有布尔开关的「关」也包含「不设该环境变量」（SLIM_TOOLS 不设 = 开，见上表）；判定函数每次都读环境变量（不缓存），开关可在进程内切换（测试就是这么做的）。

### 2.2 按画布的记忆开关（data/agent_memory/{画布}.settings.json，缺省全开）

| 开关 | 默认 | 作用 | 关掉时的行为 |
|---|---|---|---|
| auto_summary | 开 | run 结束后台跑摘要 + 候选（会花一次模型调用） | 后台只补消息索引（不花模型调用），摘要与候选都不跑 |
| candidate_cards | 开 | 摘要顺带产出候选；GET /api/agent/memory/candidates 返回待确认项 | 摘要照跑，但不再产出新候选；GET 返回空（items=[]、pending=0），已有候选留在线程文档，重新打开会再出现 |
| cross_canvas_recall | 开 | recall 与 GET /api/agent/recall 的 scope=all 可跨画布 | scope=all 降级成 canvas，返回 scope_downgraded=true 且 message 写明「本次只查了当前画布」；不允许悄悄跨画布 |

- 为什么按画布而不是全局：这三件事说的是「这张画布怎么用记忆」——长项目画布可能想关自动摘要省模型调用、试稿画布想全开；放全局会把一张画布的偏好强加给所有画布，也没法跟「删这张画布」一起清理。
- 路由：GET /api/agent/memory/settings?canvas_id=（画布 view）、PUT 同路径（画布 edit，body 只带要改的字段）。NOVAI_AGENT_V2_MEMORY=0 时两个路由都 400。

---

## 3. 验收证据索引（全部在 _verification-beat-agent-v2/ 下）

### 3.1 总述与回归基线
- baseline.md：改造前基线（pytest 754 passed / 11 存量红；node 175/183；全量 pytest 34 failed / 2434 passed）
- after.md：阶段一改造后回归（agent 子集失败逐条一致；node 失败名单一致；快照 behavior_identical=True）
- agent-v2-off-snapshot-pre.json / agent-v2-off-snapshot-post.json：开关全关行为快照（sha c99349bc…）
- agent_surface_snapshot.py：快照采集/比对脚本；raw/after-snapshot-compare.txt 原始输出
- acceptance/README.md（阶段一真实模型验收，含 P1 缺陷记录）、acceptance/commands.md（可复现命令）、acceptance/p1-fix/

### 3.2 阶段一（上下文引擎 / 读工具 / 面板）
- 真实模型：acceptance/（README / commands / diagnosis / transcripts / sse / model-context / compact / probe / requests / fixture / logs）
- 截图：shots/step1-*（开关全关对照，10 张）、shots/step2-*（分层占用 + 压缩注入，11 张）；说明见 shots/README.md
- 面板 DOM 断言：shots/dom-report-step1-off.json、dom-report-step2-on.json、dom-report-step3*.json、evidence.json
- 测试：tests/test_agent_core_context_engine.py（35）、tests/test_agent_core_read_tools.py（18）、tests/test_agent_v2_read_canvas_fallback.py、tests/test_agent_context_usage.py

### 3.3 阶段二（记忆）
- 开场注入 / 档案：shots/step3-*（18 张，含对话 A 定方案 → 新对话 B 复述「之前做到哪」）、shots/step3-memory.json、shots/step3-profile.raw.json
- recall：acceptance/recall-tool.md + acceptance/recall-tool/；shots/step5-*（9 张）、shots/evidence-step5.json
- 记忆候选卡：acceptance/memory-candidates.md + acceptance/memory-candidates/；shots/step6-*（12 张）、evidence-step6.json、evidence-step6-poll.json
- 记忆开关 / 档案管理：shots/step7-*（7 张）、evidence-step7.json
- Markdown 渲染（CJK 粗体）顺带修复：shots/step4-cjk-bold*、step4-cjk-bold/README.md
- 测试：tests/test_agent_core_memory_store.py（78）、tests/test_agent_recall.py（26）、tests/test_agent_memory_candidates.py（16）、tests/test_agent_memory_settings.py（11）

### 3.4 阶段三（流式 / 反思自检 / 修复）
- 流式：stream/real-model.md、stream/stream_real_accept.py、stream/stream_real_latency.py、stream/stream_real_tool.py、stream/stream_real_native_tool.py、stream/defect-fix-2026-11-11.md
- 反思 + 自检：reflect/evidence.md、acceptance/reflect-selfcheck.md + acceptance/reflect-selfcheck/
- 审查死循环修复：regen/evidence.md
- C1/C2/C7/C4/C5/C6/D1/D2 修复：fix3/evidence.md
- 前端：step8-streaming/README.md + shots/step8-*（28 张）、step8-json-stream/、step9-selfrefs/、step9-ui-selfcheck/README.md + shots/step9-*（3 张）、step10-c3c8/README.md、step8d-polling/
- C8 计数指标：step10-c8-stream/assert.cjs（README 为空，见 §4 限制）
- 测试：tests/test_agent_stream_events.py（15）、tests/test_agent_reflect.py（19）、tests/test_agent_fix3_selfcheck.py、tests/test_agent_fix3_stream.py、tests/test_agent_fix_main_regen.py、tests/test_agent_fix_main_wiring.py

### 3.5 阶段四（自治 / 状态机 / 触发 / 建议）
- 自治 + 托管预算：autonomy/evidence.md；真实链路 acceptance/phase4.md + acceptance/phase4/
- 状态机：runstate/evidence.md
- 事件触发：triggers/evidence.md
- 建议：suggestions/evidence.md
- 前端：step11-autonomy/README.md + shots/step11-*（3 张）、step12-suggestions/README.md + shots/step12-*（3 张）、shots/evidence-step11.json、evidence-step12.json
- 测试：tests/test_agent_autonomy.py（14）、tests/test_agent_run_state.py（7）、tests/test_agent_triggers.py（11）、tests/test_agent_suggestions.py（9）

### 3.6 收尾补验（2026-11-12 下午二批）
- 阶段四真机：fix5-real.md（3.1 协作档审查 14:09 PASS，唤醒 + review；同文件 13:47/13:56 两次失败记录）、fix5-real/vision31-collab-1409/、phase4-real.md（auto C PASS、托管 13:47 最终 PASS）+ phase4-real/final-budget-1347/
- 批量原图比例真机：batch-ratio-success/（canvas.json / task1.json / task2.json / row1.png / row2.png / server.log）
- 文字与批量修复：fix5/evidence.md（canvas_id 注入、审查不阻塞决策）、fix6/evidence.md（嵌套单元格 / canvas_cli 空命令 / 非流式总时长）、fix7/evidence.md（slim 默认开 / batch inputs 同轮自动填）
- 性能与心跳：perf/evidence.md（建连 4s、TTL 持久化、13.8–155s 上游波动）、stream-timeout/evidence.md、slim-tools/evidence.md（开关对比 29→7 / −57.8%）；脚本 tests/test_agent_fix4_perf.py / stream_ttl.py / heartbeat.py
- 批量 autorun：acceptance/fix5-real/slim-default-smoke3.md、debug-batch-ratio/README.md、shots/step16-heartbeat-{decide,review,dark,gone}.png、shots/step13-*
- 测试：tests/test_agent_fix4_{table_nested,canvas_fill,stream_timeout,stream_ttl,perf,heartbeat,slim_tools}.py、tests/test_novai_canvas_{agent_run_target,agent_count_queue,debug_batch_ratio,heartbeat}.js

### 3.7 卡片菜单/弹层修复
- 修复前基线：menu-check/README.md、menu-check/evidence.json、shots/menu-check-*.png
- 修复后复测：menu-check-fix/README.md、shots/menu-check-fixed-*.png、shots/menu-check-after-*.png、evidence-menu-check-after.json
- 关键数字（见 menu-check-fix/README.md）：弹层底色 alpha 0.78/0.70 → 0.96/0.95；0 0 0 1px 环状投影 → 无；.mh 对比度 1.94:1 / 2.34:1 → 5.07:1 / 6.18:1；参数弹层 316×168 → 364×177 且本地遮挡面积 0

---

## 4. 已知限制与未验证项（如实列出，不美化）

1. **挂起/唤醒：已真机验证 PASS**（含 review 触发）：fix5-real.md 「3.1 协作档审查（main.py 14:09，14:12–14:18）—— PASS」记录 run1 建待生成节点 → 页面 autorun 生成 1 张 → generation_completed 唤醒 resumed=true → waiting → review → task.completed（SUCCEEDED）；review.model = gemini-3.1-pro-preview。证据 fix5-real/vision31-collab-1409/。仍余：进程重启后的恢复未单独测。
2. **托管补额度：已真机验证 PASS**：phase4-real.md 「托管最终复测（main.py 13:47…）—— PASS」：managed + budget image:1 生成 2 张，第 1 张成功 → budget_required + waiting_budget(used.image=1) → POST /budget 200 + resumed=true → 第 2 张成功 → run 最终 finished、waiting_on=[]、used.image=2、done 事件 1 次。证据 phase4-real/final-budget-1347/。已知限制：外部写入服务端文档后当前页不实时感知，需 reload（autorun 在页面加载时消费标记），批量原图比例同此限制。
3. **auto 档：已真机验证 PASS**：phase4-real.md 结论表 C：roadmap 两阶段，第一阶段完成后 thought kind=autonomy「结果合格，自动进入下一阶段」，无新指令自动建第二阶段节点。仍余：生成阶段的自动推进未单独验证。
4. **建议芯片点击未验**：suggestions 渲染成可点芯片有真实截图，但「点一下真的发送」没有真机点选验证（acceptance/phase4.md §5）。
5. **C8 只有无头计数，没有真机长跑计数**：step10-c8-stream/README.md 为空文档，只有 assert.cjs 的 20 秒窗口指标（流健康 0 次 /snapshot、断线兜底 20 次、上限 30）；真机浏览器长跑与真实弱网未统计。
6. **菜单/弹层「遮挡」未完全消除**：底色、环状投影、对比度已修；menu-check/README.md 记录 .ctx-pop 遮输入框 184×54 原样、菜单遮卡片面积略升，判定为「下拉贴按钮展开」的常态，未继续压（低优先级，不作为阻塞项）。
7. **向量检索未做**：recall 当前是纯关键词（中文字符二元组 + 英文词）+ 全量条目扫分（按文件 size/mtime 缓存）；数据量大时需要倒排/分块或引入向量库，本轮没做。
8. **摘要实测很慢**：acceptance/memory-candidates.md 记录摘要调用约 5 分 20 秒，候选出现晚于面板原来的 120s 轮询窗口；后端已保证候选写进线程文档后 GET 立即可读，前端采用延迟轮询。这是模型侧耗时，不是后端可优化的部分。
9. **真实模型验收只覆盖单模型**：验收统一用 apimart gemini-3-pro-preview-thinking；其它 provider / 模型（尤其非思考模型、原生工具调用差的平台）未逐一验收；中文为主，英文长指令未系统测。
10. **MEMORY 与其它新开关的组合验收不完整**：阶段四验收刻意没开 MEMORY（省调用），因此「记忆 + 流式 + 自治 + 触发」同时开启的完整组合没有一轮真实链路记录。
11. **全量 pytest 已补跑，但仍无改造前代码的隔离 diff**：终态回归 33 failed / 2741 passed / 5 skipped，新增失败 0 条（见 FINAL-regression.md）；不过仓库里没有改造前 main.py 的原始副本，只能证明「测试结果无新增失败」，不能证明 agent 段以外零改动（FINAL-regression.md §6 已写明该局限）。
12. **桌面安装包未重打、未真机装**：本轮只改后端与前端源码 + static/novai-canvas 构建产物，Electron 打包产物与真实安装升级未验证。
13. **Token / 费用未完整统计**：验收文档记录的是调用次数与输入 token 估算，没有货币金额（本机取不到价格）；阶段三反思那次实测 9 次调用超预算（acceptance/reflect-selfcheck.md 已如实记录）。
14. **多用户/权限只按现有画布 view/edit 校验**：记忆、recall、候选、档案路由都走 require_canvas_access，但未在多人并发、跨账号场景下测。
15. **行为快照的覆盖范围有限**：agent_surface_snapshot.py 只覆盖开关全关时的 agent 纯函数、工具表、系统提示词与 model-context 端点，不覆盖 UI、不覆盖真实模型调用。
16. **SLIM_TOOLS 默认打开的长期稳定性未验**：目前只有单测 + 单/多次真机冒烟（工具 29→7、system 字符 −57.8%、一次完整流程跑通），没有多天 / 多画布长期观察；显式 0 时行为面与改造前逐字一致（快照 behavior_identical=True）。
17. **工具瘦身对复杂任务的回归面未测**：slim 默认下大型多阶段任务（批量 / 时间线 / 多技能组合）没有做系统性回归；canvas_cli 展开仍用完整工具表兜底，但模型可见工具只剩画布命令，复杂场景的可用性需要再验。
18. **心跳 UI 与日志**：心跳 UI 已拍 4 张（shots/step16-heartbeat-decide / review / dark / gone.png，事件注入），真实长流（>30s）下持续渲染与落后消失的体验未长时间观察；代码里没有 [Agent][heartbeat] 独立日志行（心跳只走 SSE 事件，服务端阶段日志是 [Agent][Timing]）。

---

## 5. 回滚方式与部署注意

### 5.1 回滚（全部开关关掉 = 改造前行为）

- 回到改造前行为：**显式设 NOVAI_AGENT_V2_SLIM_TOOLS=0**（这是唯一默认开的开关，不设它就是瘦身后的工具面），其余 NOVAI_AGENT_V2_* 不设或设为 0/false；每个开关可独立回滚（见 §2 表「关掉时的行为」）。
- 只想回滚部分记忆能力、又不能关整个 MEMORY 时，用按画布开关：auto_summary=false（省模型调用、只补索引）、candidate_cards=false（摘要照跑、卡片不出）、cross_canvas_recall=false（recall 只查本画布，返回里会写明降级）。
- **唯一不受开关控制的行为变化**：_agent_thread_normalize_thread 现在无条件保留线程里的 roadmap。这是修一个存量 bug（以前每次读盘都会把整体方案丢掉，再保存一次就永久没了）——开关关掉后，读盘也不再丢 roadmap。如果确实要回到「读盘丢方案」的旧行为，需要单独回退这一处代码。
- 关掉开关不会自动删数据：data/agent_memory/（档案 / 开关 / 索引）、线程里的 summary / summary_upto / summary_at / memory_candidates、data/agent_runs/*.jsonl / *.json 都会留在磁盘上，只是不再读写。要彻底清掉：
  - 单张画布：删 data/agent_memory/{画布}.*；DELETE /api/canvases/{id}（软删）与 /purge 已会自动清理档案 / 开关 / 候选 / 索引条目；
  - 全部：停服后删 data/agent_memory/、data/agent_runs/（确认没有需要保留的运行证据）。
- 前端构建产物不随开关变化：不重建 static/novai-canvas 时，旧产物与旧后端行为一致（新增面板只在收到新事件时才出现，没有事件时不长空壳）。

### 5.2 部署注意

1. **一起提交**：main.py、server/agent_core/*.py（context_engine / read_tools / transcript / memory_store / stream / run_state / triggers）、server/agents/cli_spec.py、novai-canvas-ui/src/** 对应的面板改动、以及 static/novai-canvas/ 构建产物。后端依赖这些模块，只提交 main.py 会启动降级（模块缺失时阶段一/二能力自动关闭并打日志）。
2. **前端必须走构建**：cd novai-canvas-ui && npm run build（输出到 static/novai-canvas/，不要手改产物）；构建后跑 python3 tools/refresh_static_versions.py --write 刷新 ?v=，再确认 dry-run 为 0 处（本次实测已 0 处，VERSION 2.0.07）。
3. **桌面安装包要重打**：后端代码与新前端产物都在安装包里；本轮没有重打 Electron 包，发版时按 README / docs/release-checklist.md 重新打包并做一次真机安装验证。
4. **发版号 / 更新说明**：本轮未 bump 版本号、未写 update-notes.json；发版时按既有流程 python3 tools/bump_version.py <版本> --write → 补 update-notes.json + python3 tools/sync_update_notes.py → python3 tools/check_version_consistency.py。
5. **测试用临时数据目录**：NOVAI_DATA_DIR=/tmp/...；不要把 data/agent_memory/、data/agent_threads/、data/agent_runs/ 里的验证数据提交进仓库。
6. **默认行为变化要写进发版说明**：NOVAI_AGENT_V2_SLIM_TOOLS 默认开（模型可见工具 29→7），这是唯一「不设变量也生效」的默认变化；灰度 / 回退用 NOVAI_AGENT_V2_SLIM_TOOLS=0，其余开关不设即旧行为。
7. **端口纪律**：改动版一律独立端口（3931/3933 等），3000 是正式安装版，不 kill / 不重启 / 不写它的数据。

---

## 6. 复现命令（本次实测口径）

    # 1) 后端 agent 测试（收尾实测：11 failed / 1060 passed / 183 subtests）
    python3 -m pytest tests/test_agent_*.py -q

    # 2) 前端/node 测试（收尾实测：175/183，8 红 = known-failures 6 + 存量 2）
    node tests/run-all.js

    # 3) 开关全关行为快照（收尾实测：behavior_identical=True，sha c99349bc…）
    python3 _verification-beat-agent-v2/agent_surface_snapshot.py \
      --out /tmp/snap.json --label final
    python3 _verification-beat-agent-v2/agent_surface_snapshot.py \
      --compare _verification-beat-agent-v2/agent-v2-off-snapshot-pre.json /tmp/snap.json

    # 4) 静态缓存号（收尾实测：dry-run 0 处）
    python3 tools/refresh_static_versions.py

    # 5) 分阶段重点测试（收尾实测，全过）
    python3 -m pytest tests/test_agent_core_context_engine.py tests/test_agent_core_read_tools.py \
      tests/test_agent_core_memory_store.py tests/test_agent_recall.py \
      tests/test_agent_memory_candidates.py tests/test_agent_memory_settings.py \
      tests/test_agent_stream_events.py tests/test_agent_reflect.py \
      tests/test_agent_run_state.py tests/test_agent_suggestions.py \
      tests/test_agent_triggers.py tests/test_agent_autonomy.py -q

---

## 7. 2026-11-12 下午修复批（收尾后追加）

> 终态回归之后又修了一批真机问题；本节记录修了什么、对应测试与证据。数字为修复完成后实测（2026-11-12 14:00 前后），代码在本节写入前已定稿，未 commit / 未 push。

**指标（实测）**

- 临时数据目录口径：NOVAI_DATA_DIR=/tmp/novai-fixbatch-clean python3 -m pytest tests/test_agent_*.py -q = **8 failed / 1134 passed / 1 skipped / 183 subtests passed**（20.87s，修复批完成时的数字；收尾补验后为 8 failed / 1171 passed / 1 skipped，见 §8）；8 条失败全部是 test_agent_skill_ref.py（技能正文缺失的环境项）。
- 仓库默认数据目录口径：同一命令 = 11 failed / 1122 passed / 10 skipped；多出的 3 条失败是 activate_skill / canvas_p0 / web_image_search（本机配置/上游相关），10 条 skip 是 fix4 的预算/续跑测试在 DATA_DIR 不是临时目录时主动跳过（保护真实数据，不是失败）。
- node tests/run-all.js = **179/187 通过**（修复批完成时；收尾补验后为 182/190，见 §8）；8 红与基线同一组（known-failures 6 条 + 前端存量 已删除的对话页测试 / test_novai_canvas_workflow_bundle）。
- 开关全关快照：**behavior_identical=True**（behavior_sha256=c99349bce48e7154dd160294b9281f704f4cb0b1a10bef09bb71bcb199fea2b6；tools 27 / catalog 27 / cli 26）。

### 7.1 多维表格 / 批量（后端）

修了什么（详见 table-audit/evidence.md）：

- **对象数组行可建表**：rows 支持 [{"场景":"雨夜","文案":"..."}]；有 columns 按 columns 顺序取值（缺的填空），没有 columns 用键出现顺序生成列名，额外键按顺序补成新列；超过 12 列 / 键放不下时明确点名哪些键报错，不静默丢。
- **单元格类型放宽**：允许字符串 / 数字 / 布尔（数字与布尔转文本）；嵌套 list/dict 才报错。
- **列上限 8 → 12**：新增私有常量 _AGENT_TABLE_MAX_COLUMNS（旧公开 AGENT_TABLE_MAX_COLUMNS 保持 8，避免改变行为快照）；行上限 50 不变。
- **单元格上限 2000 → 8000 字**：旧实现超 2000 静默截断；现在 _AGENT_TABLE_CELL_MAX_CHARS = 8000，超限明确报「最多 8000 字」，不静默。
- **批量节点必须带表格 inputs**：create_node(type=batch) 在 smart 侧补校验（BEAT 原来就有），不再能建出没有上游、永远跑不了的批量节点；create_node 的 batch 说明明确「inputs 必须包含一个多维表格节点」。
- **BEAT 表格改行清下游 journal**：update_node / append_rows 改表格行后，清掉下游批量节点 data.batch.journal（保留 settings）并把 selectedRows 重置为全选，避免 mark_run / run_batch 按旧 journal 误判「上一批还在跑 / 已跑完」。
- **read_table 兼容 smart 表格**：read_tools.CanvasAccess.table / title 同时读 BEAT 的 data.table 与 smart 的 node["table"]（title 也读 node["title"]），read_table / read_node / search_canvas 不再把 smart 表格读成空表（列名 0、行数 0）。

测试：tests/test_agent_fix4_table_validate.py（12 条：rows/columns 非法输入明确报错、行宽补齐、重名列、create_node 表格校验）、tests/test_agent_fix4_table_batch.py（12 条：batch 必须有表格、BEAT batch_generate 落库/连线、BEAT 改行清 journal + selectedRows、smart update rows、run_batch row_numbers、read_table 呈现/分页、batch_generate 参数）。

证据：_verification-beat-agent-v2/table-audit/evidence.md（审计清单 + 根因 + 追加调整「单元格 2000→8000」「对象数组行 + 列上限 12」）；表格 UI 侧另见 table-fix/README.md（P1-1/P1-2/P1-3/P2-1/P2-2/P2-3）、table-check/README-after.md + evidence-after.json（修复后复测：420 宽 clipped 单元格 3 → 0、headerTruncated 1 → 0）。

### 7.2 看图模型黑名单（一次失败永久拉黑 → TTL）

修了什么（详见 vision-deny/evidence.md）：

- _AGENT_VISION_DENY 保留 set 兼容外部读写，新增 _AGENT_VISION_FAILURES 失败记忆：key → {count, last_at, until, hard, reason}。
- TTL 策略：第 1 次失败暂时跳过 10 分钟（_AGENT_VISION_SKIP_SECONDS）；连续第 2 次失败拉黑 30 分钟（_AGENT_VISION_HARD_SKIP_SECONDS），到期自动重试；成功一次 _agent_vision_clear 清空连续失败计数。
- 审查不再把 deny 当硬门槛：_agent_review_pick_chat 当前模型只要像能看图就先试一次，失败一次后再换候选；BEAT 审查与 /api/agent/review 都记录失败原因。
- _agent_pick_caption_model(exclude_key, fallback_chat)：没有其它看图模型时退回当前模型再试一次（TTL 内除外）。
- 文案 _agent_review_unavailable_text 区分「上次看图失败（原因 + N 分钟后重试）」与「未声明支持看图」，并带最近失败的候选原因。

测试：tests/test_agent_fix4_vision_deny.py（能识别 gemini-3.1-pro-preview；第 1 次失败 10 分钟 TTL、过期放行；连续两次才 hard 拉黑 30 分钟、成功清空；审查在 deny 下仍返回当前模型；文案区分两种原因）。
证据：_verification-beat-agent-v2/vision-deny/evidence.md。

### 7.3 批量「原图比例」

修了什么：前端 originalRatio.batchSourceSize 按「每行第一张图的真实像素」算长边等比显式尺寸（如 800×600 + 2K → 2048×1536）；没有源图时回落上游 adaptive，再没有才明确提醒按 1:1，不再静默变 1:1。

测试：tests/test_novai_canvas_batch_source_size.js（纯函数 batchSourceSize + buildRequest 批量带 per-row size）、tests/test_novai_canvas_original_ratio.js（原图比例换算/来源/标签，含方案卡 PlanRatioField）。

真机验证（2026-11-12 15:00，**PASS**）：证据 acceptance/batch-ratio-success/ —— 两条 canvas-image-tasks 的请求 size 分别是 **2048×1536 / 1152×2048**（task1.json / task2.json），实际出图 row1.png **2304×1728**、row2.png **1472×2624**（PIL 实测），宽高比各自跟随源图 4:3 / 9:16，不再静默变 1:1。
已知限制：外部写入服务端画布文档后，当前页不实时感知，需要 reload（autorun 在页面加载时消费标记）。

### 7.4 托管补额度挂起/续跑 + 超时

修了什么（详见 budget-resume/evidence.md、stream-timeout/evidence.md）：

- **新增第五态 waiting_budget**（run_state.py）：托管超预算不再直接 status=ok 结束，改写 waiting_budget（round/steps/history/results/intent/roadmap/instruction/budget_grant/needs/used）、bus suspended，发 run_suspended {reason:"budget"} 并保持总线不关；startup 不自动恢复这一类，resumable_states 仍只含等生成。
- **补额度合并授权并恢复**：POST /api/agent/runs/{id}/budget 对 waiting_budget 不再 409，同模态上限取新旧较大者合并（不缩小已授权额度）；_agent_run_resume 接受 waiting_generation 与 waiting_budget 两种挂起态。
- **used_by_modality 跨挂起保留**：等生成挂起（BEAT + 经典两处）与超预算挂起都把 used_by_modality 写进 run_state，resume 从 state 读回（兼容旧 budget_used）继续累加，不再从 0 重算。
- **唤醒时节点已有结果直接消费**：resume 先把 resume_ids 分成「已完成（直接写 history 消费）」与「仍需等」两类，只对后者调用 wait_canvas_results / wait_tasks；消费完写回 running、waiting_on=[]，不重复等同一个节点；二次唤醒返回 not_suspended。
- **超时**：非流式单次读 90s（provider_timeout，「模型 90 秒未响应」进 fail_notes / 最后一轮结论）；流式首包最早 30s，后按 perf 证据收到 8s（建连 4s）、之后无增量 15s、总 90s；非流式另加外层总时长 120s（见 §8.5）；超时抛 AgentRunError(code=stream_timeout) 并打统一日志（kind=stream_connect / non_stream）。
- 同批相关：唤醒后第 2 轮「模型 JSON 解析失败：Extra data」→ _agent_json_first_balanced / _agent_strip_balanced_json / _agent_parse_decision_json，取第一个括号配平对象，并把尾随对象里的 suggestions 并进决策。

测试：tests/test_agent_fix4_budget_resume.py（超预算 → waiting_budget、补额度 → resume 继续、不补额度保持挂起、used_by_modality 跨挂起、唤醒直接消费已完成节点；默认仓库数据目录时主动 skip，临时目录口径 1134 条里包含它）、tests/test_agent_fix4_stream_timeout.py（首包/无增量/总超时、非流式 90s 文案、日志 kind）、tests/test_agent_fix4_json_tail.py（尾随对象/suggestions 并入）、tests/test_agent_fix4_done_steps.py（done+steps 先执行）。

证据：budget-resume/evidence.md（三次真机复测：13:36 复现 used 未跨挂起 → 13:43 修后仍有收尾问题 → **13:48–13:51 最终 PASS**：2 张图、budget_required + waiting_budget → POST /budget 200 resumed=true → 第 2 张成功 → finished / done 1 次 / used.image=2）、stream-timeout/evidence.md（含上游直连探针 4.48s 与最终 90s 配置）、json-tail/evidence.md、acceptance/phase4-real.md。

### 7.5 卡片 / 面板

- **方案卡参数全部改弹层**：模型（两级：平台 → 模型，含「跟随助手默认」）/ 生成方式 / 分辨率 / 比例（OptCards 画幅格子）/ 张数 / 时长 共 6 个原生 select 全部替换成 PlanParamPickers（PlanModelField / PlanRatioField / PlanListField），统一走 #pop 弹层（磨砂玻璃加厚底、零描边环、软底选中、线性图标），键盘（Enter/Space 打开、Esc 关闭）与禁用态照旧；选中仍走 patchPlanStep 写回 steps。
- **建议芯片**：busy 时入队、空闲直发；pickSendText 保证「直传芯片文案 > 队列文案 > draft」，不会再把上一句旧问题发出去（此前真机 FAIL 原因就是读到了旧 draft）。
- **4 张图拆分执行**：readPlanParams 不再把请求张数静默降到模型 batch；新增 maxBatchOf / countPlan / expandGenerationSteps 按模型 batch 分次执行（尾组不足补到最近合法档并标 bumped，未知 batch 按 1 张并标记），卡片上写明「一次最多 N 张，将分 X 次生成（a + b …）」；队列在内存保存、写队列时把短模型名归一成完整 provider::model（store.modelOf 兼容解析）。真机验证：acceptance/count-4-real/success-113123/（4 条请求 / 同一节点 hist=4 / 4 张 1728×2304 且 sha256 互不相同）。后端 count-preserve 同时修掉 3 处吞张数：画布直发执行端（direct_image_request_batches 按 n_max 分批、总数不吞）、经典 generate_image（按 count 建 count 个任务）、助手 validate（张数保留请求值，模型上限写进 max_batch/batch_note，删掉「张数 4 → 1」误导说明）。
- **done + steps 先执行步骤**：done=true 同时带实际可执行步骤时不再直接结束；先执行步骤、记 pending_done、写转录 system note，再收尾，避免「用户看到已建好但画布 0 节点」。

测试：tests/test_novai_canvas_plan_params.js（PlanModelField / modelConfigId 写回）、tests/test_novai_canvas_original_ratio.js、tests/test_novai_canvas_send_text.js（芯片 → 直传文本优先，busy 入队/空闲直发，pickSendText）、tests/test_novai_canvas_plan_count_groups.js（countPlan 8 条 + expandGenerationSteps 6 条）、tests/test_novai_canvas_agent_count_queue.js（队列保存/模型 id 归一）、tests/test_agent_count_preserve.py（后端 3 处吞张数与 batches）、tests/test_agent_fix4_done_steps.py。

证据：step14-plan-pickers/README.md + shots/step14-plan-{model,ratio,res}-{light,dark}.png（5 张，弹层实测）、step13-count-split/README.md + shots/step13-01-count-split-known.png / step13-02-count-split-unknown.png + shots/evidence-step13.json、count-preserve/evidence.md、done-steps/evidence.md。
真机补验的缺口（如实）：acceptance/phase4-real.md §D + fix 后补验显示——芯片在首轮 run busy 时点击只把文案写进输入框、没有发新 run（入队行为），「指令 == 芯片文案」的完整真机验证未做，目前只有 pickSendText/queue 单测覆盖；4 张拆分**已真机验证**（4 条请求 / 4 张不同结果，证据见 §7.6）。

### 7.6 本批小结

- 已验证较完整的：表格/批量数据模型与 read_table（单测 24 条 + 审计文档）、看图黑名单 TTL（单测 + 真机复现记录）、托管补额度（真机三次复测，最终 PASS）、超时保护（单测 + 上游探针）、**批量原图比例（真机 PASS，两条任务 2048×1536 / 1152×2048 → 出图 2304×1728 / 1472×2624）**、**3.1 看图审查（真机 PASS，review.model=gemini-3.1-pro-preview）**。
- **已真机验证**：4 张拆分——证据 acceptance/count-4-real/success-113123/（approve 4 步；服务端 4 条 canvas-image-tasks；画布同一节点 hist=4；4 个不同 URL：online_3a2515d9cd / online_06bea6d4a4 / online_3f4daaa373 / online_830887b5b7；4 张都是 1728×2304，sha256 各不相同，见该目录 results.json、final-server-canvas.json、probe-extract.txt）；拆分与队列另有 14 条单测（test_novai_canvas_plan_count_groups.js 的 countPlan 8 + expandGenerationSteps 6）。
- 只有单测/源码断言、真机未验的：建议芯片完整「指令==芯片文案」、done+steps 真机路径。

## 8. 2026-11-12 收尾补验（真机结论 + 性能 / 工具瘦身）

> 本节是收尾后的最后一轮补验：阶段四真机结论、批量原图比例、3.1 看图审查、表格/批量补强、性能与心跳、工具瘦身默认开、批量 autorun。数字为 2026-11-12 15:20 前后实测，代码定稿后未再改（未 commit / 未 push）。

**指标（实测）**

- 默认配置（NOVAI_AGENT_V2_SLIM_TOOLS 未设置 = on）+ 临时 NOVAI_DATA_DIR：python3 -m pytest tests/test_agent_*.py -q = **8 failed / 1171 passed / 1 skipped / 183 subtests passed**（23.35s）；8 条失败全是 test_agent_skill_ref.py 环境项。
- 同一命令 + 仓库默认数据目录 = 11 failed / 1156 passed / 13 skipped（多 3 条本机配置/上游相关失败；13 skip 是 fix4 测试在非临时目录主动跳过）。
- 显式 NOVAI_AGENT_V2_SLIM_TOOLS=0（其余 NOVAI_AGENT_V2_*=0）：agent_surface_snapshot 与改造前 pre 比对 = **behavior_identical=True**（behavior_sha256=c99349bce48e7154dd160294b9281f704f4cb0b1a10bef09bb71bcb199fea2b6）。
- node tests/run-all.js = **182/190 通过，8 红**（仍是 known-failures 6 + 前端存量 已删除的对话页测试 / test_novai_canvas_workflow_bundle；测试总数 183 → 190）。

### 8.1 阶段四真机结论（三条全部 PASS）

- **挂起 → 唤醒：PASS（含 review 触发）**。fix5-real.md 「3.1 协作档审查（main.py 14:09，2026-11-12 14:12–14:18）—— PASS」：run1 run_d61d6b2ab949465b（collab）建待生成节点 → approve → run2 run_8c38a2a035384908，页面 autorun 生成 1 张图；generation_completed 唤醒 resumed=true；run2 走 waiting → **review** → task.completed，status SUCCEEDED / waiting_user。日志同轮另有 stream_connect 30.5s 超时 + 非流式回退（超时保护生效）。证据 fix5-real/vision31-collab-1409/。
- **auto 自动推进：PASS**。phase4-real.md 结论表 C：roadmap 两阶段，第一阶段完成后 thought kind=autonomy「结果合格，自动进入下一阶段」，无新指令自动建第二阶段节点。证据 acceptance/phase4-real.md + acceptance/phase4/。
- **托管补额度：PASS**。phase4-real.md 「托管最终复测（main.py 13:47，2026-11-12 13:48–13:51）—— PASS」：managed + budget image:1 生成 2 张；第 1 张成功（online_2fde2e2f9a.png）→ **budget_required + waiting_budget（used.image=1）** → **POST /budget 200 + resumed=true** → 第 2 张成功（online_a5b0160f25.png）→ run 最终 **finished**、waiting_on=[]、**used.image=2**、**done 事件 1 次**、status SUCCEEDED。证据 phase4-real/final-budget-1347/。

### 8.2 批量原图比例：PASS（真机）

- 证据 acceptance/batch-ratio-success/（canvas.json / task1.json / task2.json / row1.png / row2.png / server.log）。
- 两条 canvas-image-tasks 的请求 size：**2048×1536**（4:3）与 **1152×2048**（9:16）。
- 实际出图：row1 **2304×1728**、row2 **1472×2624**（PIL 读像素实测），宽高比各自跟随源图，不再静默按 1:1。
- 已知限制：外部写入服务端画布文档后，当前页不实时感知，需要 reload 才能看到（autorun 在页面加载时消费标记）。这条同时影响「批量节点参数被外部改写」的可见性。

### 8.3 看图审查 3.1：PASS

- fix5-real.md 「3.1 协作档审查（main.py 14:09，14:12–14:18）—— PASS」：run2 走 waiting → **review** → task.completed；**review.model = gemini-3.1-pro-preview**，summary「图片主体不符合便携咖啡机的特征」；没有「没有能看图的模型」报错。
- 证据 fix5-real/vision31-collab-1409/（含 review SSE / 日志 / 截图）。同文件里也记录了 13:47 与 13:56 两次未触发 review 的尝试，说明这是修复后的最后一次 PASS，不是「默认一定立刻审」。

### 8.4 表格与批量补强（后端）

- **嵌套 dict / list 单元格序列化**：_agent_table_rows_from_args 把 dict / list / tuple 单元格用紧凑 JSON 序列化，不再整轮失败；成功结果带 message + warnings 提示「第 x 行第 y 列嵌套对象已序列化」。
- **canvas_cli 空命令返回可用清单**：_validate / _preview 的错误文案追加「可用命令：…」（从 COMMANDS 实时生成）；slim 提示补「command 必填，且必须是清单里的值」。
- **batch inputs 同轮自动填表格**：_agent_fill_batch_table_inputs 在每一步执行前，若本步是 batch_generate 或 create_node(type=batch)、inputs 为空 / 没有表格，且本轮前面刚成功建过 table，则自动把表格 id 放到 inputs 最前面（已有素材保留、step 引用不覆盖、没有同轮表格不动）；两处错误文案补 inputs 示例。
- **canvas_id 缺失自动注入**：_agent_run_fill_canvas_id 对 schema 里有 canvas_id 的工具自动补本次运行画布（显式给了不动，不存在仍按原样报错）；canvas_cli 展开出的内层工具再补一次；producer 里 _AGENT_RUN_CANVAS_ID 改为无条件 set。
- 测试：tests/test_agent_fix4_table_nested.py（6 条：嵌套序列化 / warning / 空命令清单 / 自动填表格 / 无表格不动 / inputs 示例 / 非流式总时长）、tests/test_agent_fix4_canvas_fill.py（5 条）、tests/test_agent_fix4_table_batch.py / test_agent_fix4_table_validate.py。
- 证据：fix5/evidence.md、fix6/evidence.md、fix7/evidence.md、table-audit/evidence.md；真机冒烟 acceptance/fix5-real/slim-default-smoke3.md（表格 + 批量节点 + 1 张图，默认配置跑通；建表过程有一次可避免的 batch inputs 失败记录，后续 fix7 自动填表格已覆盖）。

### 8.5 性能与心跳

- 流式：建连 **4s**（_AGENT_STREAM_CONNECT_TIMEOUT_SECONDS，env NOVAI_AGENT_STREAM_CONNECT_TIMEOUT）、首包 **8s**（NOVAI_AGENT_STREAM_FIRST_TIMEOUT）、之后无增量 15s、总 **90s**；超时抛 AgentRunError(code=stream_timeout)，统一日志「[Agent] 决策超时 … kind=stream_first / stream_idle / stream_total」。
- 非流式：httpx 单次读 90s 之外再加外层总时长 **120s**（_AGENT_CHAT_TOTAL_TIMEOUT_SECONDS，env 可调）；超时抛 provider_timeout「非流式总时长超时」，日志 kind=non_stream_total。此前实测一次非流式累计到 155.7s 就是没有总时长兜底。
- 流式失败 TTL：内存 + 持久化文件 data/agent_stream_failures.json（_AGENT_STREAM_FAILURES_FILE）；普通跳过 10 分钟（_AGENT_STREAM_SKIP_SECONDS）、连续失败 30 分钟（_AGENT_STREAM_HARD_SKIP_SECONDS），进程重启后仍生效；每次决策前先加载持久化 TTL，命中直接走非流式。
- 日志与心跳：[Agent][Timing] 每阶段一行（run / round / stage / elapsed_ms / model）；心跳为 SSE 事件 heartbeat（每 5s，run / round / stage / elapsed_ms / kind，stage 含 decide / tools / review），不写转录、不计步、不改状态。代码里**没有** [Agent][heartbeat] 独立日志行（心跳只走事件，见 §4-18）。
- 上游慢的事实（如实）：非流式单次实测 13.8s–155s 波动（perf/evidence.md 与 fix6 记录），prompt 瘦身的收益是「体积」不是稳定提速；同分钟两次对比首内容 16.36s vs 30.77s，受上游影响不能证明变快。
- 测试：tests/test_agent_fix4_stream_timeout.py、tests/test_agent_fix4_stream_ttl.py、tests/test_agent_fix4_perf.py、tests/test_agent_fix4_heartbeat.py；证据 perf/evidence.md（含 TTL 重启复现、建连 4s + 13.75s ≈ 17.8s、TTL 后 13.8s）、stream-timeout/evidence.md。
- 心跳 UI：已拍 4 张 —— shots/step16-heartbeat-decide.png / step16-heartbeat-review.png / step16-heartbeat-dark.png / step16-heartbeat-gone.png（事件注入）；真实长流（>30s）下的持续渲染 / 落后消失未长时间观察（见 §4-18）。

### 8.6 工具瘦身（NOVAI_AGENT_V2_SLIM_TOOLS）：默认开

- 默认行为：**未设置 = on**（性能默认）；显式 0 / off 才关闭（老行为逐字保留）。_agent_v2_slim_tools_enabled 现在 default=True。
- 效果：工具表 29 → **7**（只留 canvas_cli + 没有等价命令的工具），system 字符 24,961 → 10,534（**−57.8%**）；canvas_cli 命令 enum 与 cli_spec.COMMANDS 完全一致（测试断言命令集合 / 数量）；执行 / 展开仍用完整工具表，只影响模型可见列表。
- 一致性：显式 SLIM_TOOLS=0 时工具表 / 提示词逐字不变，行为快照与改造前 behavior_identical=True（sha c99349bc…，本次复测）；默认 on 时 behavior_sha256=2d3e79bb… 属预期（默认行为变了）。
- 测试：tests/test_agent_fix4_slim_tools.py（6 条：默认 on、显式 0 逐字不变、只留 canvas_cli + 无命令工具、提示词去混用句 / 加命令硬约束、命令 enum 与 COMMANDS 一致）；证据 slim-tools/evidence.md（两次开关对比表、默认打开追加）。

### 8.7 批量 autorun

- 纳入范围：smart-batch、以及任何带 data.batch 的生成节点都纳入 autorun —— agentRunTarget 判定「有上游表格 → batch（runTableBatch）」、smart-batch 没表格时按 smart-batch 单独处理；hasBatchData 识别 data.batch。
- 缺模型补默认：作者建的批量节点没有安装模型时用 store.defaultModel 补默认；写队列时把短模型名归一成完整 provider::model，store.modelOf 兼容解析，避免 autorun 在发请求前失败。
- 验收口：?debugAutorun=1 打开 window.__autorunLog（每节点判定 + 走了哪个分支，最多 200 条，默认始终存在）；?debugBatchRatio=1 在画布文档载入后自动建 2 行（4:3 800×600 / 9:16 600×1067）+ 表格 + 批量节点样本（ratio=auto、2K、agnes 模型，不跑生成）。
- 测试：tests/test_novai_canvas_agent_run_target.js（batch / smart-batch / data.batch / 默认模型）、tests/test_novai_canvas_agent_count_queue.js、tests/test_novai_canvas_debug_batch_ratio.js（5 节点 + group 成员 + 表格通道 + 批量参数/连线断言）；证据 debug-batch-ratio/README.md、shots/step13-*、shots/step16-*。

### 8.8 未验 / 缺口（截至本轮）

- **心跳 UI**：截图已完成（见 8.5），但真实长流（>30s）下持续跳动与「结束后消失」的体验只做了事件注入，未做长时间真机观察；[Agent][heartbeat] 日志行不存在（心跳只走 SSE 事件）。
- **SLIM 默认打开的长期稳定性未验**：只有单测 + 单/多次真机冒烟，没有多天 / 多画布 / 多模型长期观察。
- **工具瘦身对复杂任务的回归面未测**：批量 / 时间线 / 多技能组合等复杂多阶段任务在 slim 默认下没有系统性回归。
- 其余沿用 §4：建议芯片完整「指令==芯片文案」真机未验、done+steps 仅单测、C8 真机计数、向量检索未做、摘要慢（模型侧）等。

## 9. 文档维护

- 本文件是四阶段收尾总览；分阶段细节与原始证据在各子目录的 README.md / evidence.md。
- 发版后再更新：把「未验证项」逐条勾掉或写明仍未验；开关清单若新增，同时更新 docs/待推送清单.md 对应条目的「验收」段。

## 10. I 批归因（2026-11-12）

### 10.1 旧对话页缓存串测试失败：旧外壳 iframe 被未提交改动删除，不是缓存号旧

- **结论**：失败项「index.html 里 iframe 的旧对话页缓存串未升（undefined）」的根因是工作区里「V2 外壳精简」这批**未提交改动**把 `static/index.html` 的旧对话页入口删了（导航项、`<iframe id="frame-对话页">`、`PAGE_IDS` 里的路由 id），不是缓存版本号没刷新。
- **无提交可指**：HEAD `4c52a27`（release: NOVAI 2.0.06）里的 `static/index.html` 仍含旧对话页 iframe（`data-src` 指向该页 + 旧的缓存串）；删除只存在于工作树（`git diff HEAD -- static/index.html` 可见三处 `-` 行），`git log --all -S` 按旧 iframe id 查不到删除提交。
- **涉及文件与 mtime**：`static/index.html` — 2026-11-11 11:47:40；已删除的对话页 — 2026-11-11 10:47:32，其未提交 diff 仅是缓存串 `2.0.05` → `2.0.07`（refresh_static_versions 口径），与本失败无关。
- **基线日志已红**：`_verification-beat-agent-v2/raw/novai-baseline-node.txt`（mtime 2026-11-11 13:38:19）第 408 行已经记录「旧对话页缓存串未升（undefined）」、通过 161 项；早于本轮基线，不是本轮改动引入。
- **缓存刷新记录**：`python3 tools/refresh_static_versions.py --write` → `已刷新 0 个静态页的缓存版本号（共 0 处，VERSION 2.0.07）`，确认没有需要同步的缓存串。
- **测试断言对齐现状**：当时的旧对话页静态断言测试该条由无条件 `ok` 改为按现状分支——iframe 还在时仍校验 `?v=` 后缀 `>= 1789725884`；iframe 不存在时断言页面入口里没有旧 iframe、旧路由 id 不在 `PAGE_IDS`，文案写明「旧外壳已移除该 iframe（页面迁 V2），index.html 不再需要该缓存串同步」。不是无条件跳过，其余 161 项断言未动。
- **验收**：当时该测试全跑通过（162 项 = 通过 162 / 失败 0）；该测试文件已在 2026-11 I1改 随页面下线一并删除。

### 10.2 test_novai_canvas_workflow_bundle.js 未提交改动的来源与 !important 复位放行

- **来源（不是本轮改动）**：该测试文件当前未提交的 `34+ / 2-` 改动来自上一轮「多对话/线程收尾批 task-2 前端」的整改：用 `findForbiddenBorders` / `findForbiddenInsetShadows` 两个 helper 替换原先粗暴的 `/border/`、`/inset/` 断言，为 `SplitNode` 的 `border:none!important`（清 UA 默认边框）误报做的放行。证据：`_verification-beat-agent-threads/REPORT.md` §6；`_verification-beat-agent-threads/attribute-workflow-bundle-failure.cjs` 当时（helper 尚未放行 `!important`）复用同一 helper 对比 HEAD 与工作树——HEAD 段内违例 `[]`、工作树段内违例 `["border: none!important","border: none!important"]`，HEAD 全文 `border:none!important` 计数 0、工作树 2。
- **本轮只改放行规则**：`findForbiddenBorders` 先把值结尾的 `!important` 去掉（大小写不敏感、兼容 `none !important` 这种带空格写法）再按现有 reset tokens（`0` / `0px` / `0em` / `none`）判断，使 `border:0!important` / `border:none!important` 放行；`border:1px solid` 等可见边框照旧判违例。没有改任何 CSS（canvas-next.css 仍保留 `border:none!important`）。
- **常驻自检**：测试顶部新增三条 `assert.deepStrictEqual`——`.x{border:0!important}`、`.x{border:none !important}` 都必须返回 `[]`；`.x{border:1px solid #fff}` 必须返回 `['border: 1px solid #fff']`。helper 被改坏（例如又变成见 border 就报）时立即红。
- **验收**：`node tests/test_novai_canvas_workflow_bundle.js` → `[PASS] 智能画布BEAT 工作流导入导出（选中切片 / 去重 / URL 映射 / ZIP 读写 / 新建画布菜单）`。
