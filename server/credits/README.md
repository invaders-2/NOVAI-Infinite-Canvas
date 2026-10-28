# 积分制后端（NOVAI Credits）

一句话：**1 NOVAI 积分 = 1 APIMart Credit = $0.1 成本**；生成前按 APIMart 价目表预扣，
完成后按上游实际成本（有就按实际、没有就按估价）多退少补，失败/取消全额退款。

## 1. 价目来源与文件

- 来源：https://apimart.ai/zh/pricing（构建期抓取，**运行时不联网**）
- 产物：`server/credits/apimart_pricing.json`（339 个模型）
- 解析器：`python3 tools/apimart_pricing.py --html /tmp/apimart-pricing.html --pages /tmp/apimart_pages`
- 详情页抓取（可选，补齐视频/音频档位）：`python3 tools/fetch_apimart_pages.py --html ... --pages ... --proxy http://127.0.0.1:7897`

覆盖（以本次抓到的页面为准）：

| 类别 | 模型数 | 档位来源 |
|---|---|---|
| 图像 image | 49 | 页面内嵌 initialCatalog：每个模型全部规格档 × 黄金/铂金/钻石/官方价 |
| 视频 video | 57 | 模型详情页价格表：分辨率/时长/参考视频档位 × 四档价 |
| 音频 audio | 43 | 详情页价格表：音乐动作/音色档位 × 四档价 |
| 文本 chat | 190 | 起步价索引：输入/输出 每 1M token 黄金价（其余档位按页面固定折扣推导并标 derived） |

> 说明：价目页本次实际渲染出 **48 张图片卡片**，结构化目录里是 **49 个图像模型**（多出的是
> 仅出现在起步价表的官方渠道模型）。任务书里说的「55 个图片模型卡片」与页面实际数量不一致，
> 以页面结构化数据为准。索引表合计 296 个模型。

价格字段统一存 **USD / 计费单位**：gold / platinum / diamond / official，同时给出换算后的
credits（usd ÷ 0.1）。运行时按 APIMART_TIER 选一档作为成本。

### 未映射清单（后台可见）

GET /api/credits/pricing、GET /api/credits/charges 可看到 pricing_fallback / unmapped。

当前 APIMart provider 已配置但价目表没有独立价格的模型（按类型兜底，记录里标 pricing_fallback:true）：

- 音频/语音：gpt-4o-audio-preview、gpt-4o-audio-preview-2024-10-01、gpt-4o-mini-tts、
  gpt-audio-mini、gpt-audio-mini-2025-10-06、tts-1、tts-1-1106、tts-1-hd、tts-1-hd-1106、whisper-1
  （价目页音频区只有 flowmusic / suno）
- 其余图像/视频/文本模型均在价目表内；gpt-image-1、gpt-image-2.5-flare/sunburst 是
  token 计价，按「输入 token + 估算图像输出 token」估价，不算未映射。

兜底规则：每类取该类主计费方式的**中位价模型**（fallback 字段写在 JSON 里），
不用写死的固定金额。

## 2. 计费口径（全部可配置）

| 环境变量 | 默认 | 含义 |
|---|---|---|
| NOVAI_CREDIT_USD | 0.1 | 1 积分成本美元（= 1 APIMart Credit） |
| CREDIT_MARKUP | 1.3 | 售价 = 成本 × 加价 |
| APIMART_TIER | gold | 成本档位 gold/platinum/diamond/official |
| NOVAI_CREDITS_DISABLED | 空 | 1 关闭整条计费链路 |
| NOVAI_PRICING_FILE | server/credits/apimart_pricing.json | 价目文件 |
| NOVAI_IMAGE_OUTPUT_TOKENS | 1024 | token 计价图像模型的输出 token 估算 |
| NOVAI_VIDEO_DEFAULT_SECONDS | 5 | 视频未传时长的估价秒数 |
| NOVAI_TEXT_DEFAULT_OUTPUT_TOKENS | 800 | 文本未给输出 token 的估价 |
| NOVAI_SSE_HEARTBEAT_SECONDS | 20 | 积分 SSE 心跳 |

售价规则（pricing.price_for_cost）：
1. price = ceil(cost × markup, 0.01)；
2. 必须严格大于成本，且至少 +0.01 积分（成本极小时也保证这一分利差）；
3. 利润 = price - cost，USD 按 × 0.1 记录。

成本档位切到 official 后，售价同比例变贵；platinum / diamond 同理。

## 3. 数据表

- users.credits REAL NOT NULL DEFAULT 0（幂等 ALTER TABLE）
- credit_transactions(id,user_id,delta,balance_after,kind,ref,note,cost_usd,price_usd,profit_usd,created_at)
- credit_charges(id,user_id,task_ref,model,kind,params_json,estimate,charged,cost_usd,price_usd,profit_usd,status,created_at,settled_at, estimate_cost,actual,pricing_fallback,unmapped_json,matched_spec,note)

status：pending（已预扣）→ settled（按实际结算）/ refunded（失败/取消退款）。
actual=1 表示用了上游成本字段或真实 token 数；0 表示按预扣估价结算。

## 4. API 契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/credits/me | {balance, unit:'credit', usd_per_credit, markup, tier, enabled, auth_enabled} |
| GET | /api/credits/transactions?limit=50 | {balance, transactions:[...]} |
| POST | /api/admin/users/{id}/credits | {delta, note?} → {balance}；扣到 0 以下 400 INSUFFICIENT_BALANCE |
| GET | /api/credits/price?model=&kind=&width=&height=&duration=&quality=&rows= | {cost, price, currency:'credit', usd:{cost,price,profit}, matched_spec, pricing_fallback, unmapped, ...} |
| GET | /api/credits/stream | SSE：{type:'balance', balance}；20s 心跳 ": ping" |
| GET | /api/credits/charges（admin） | 任务扣费明细（含 pricing_fallback / unmapped） |
| GET | /api/credits/pricing（admin） | 价目覆盖、兜底模型、未映射清单 |
| GET | /api/credits/debtors（admin） | 后付费欠费用户（负余额）列表 |

默认 **全局后付费**（CREDIT_BILLING_MODE=postpaid）：生成前不预扣、不查余额、不返回 402；完成后按实际/估价结算，余额可为负。
仅显式 `CREDIT_BILLING_MODE=prepaid` 才保留旧的预扣 + 402 流程（body 顶层 {code:'INSUFFICIENT_CREDITS', estimate, balance}）。
响应里带 credits:{mode, postpaid, estimate, price, balance_after, cost_usd, price_usd, profit_usd, actual, pricing_source, charge_id}。

rows 用于批量（多维表格）：一张表 N 行 = N 个生成单位，前端批量前可用
GET /api/credits/price?rows=N 预估总额。

## 5. 接入点（main.py 统一调用）

只有三个函数，路由分支不自己算钱：

- credits_charge_start(kind, model, params, user_id=None, task_ref="") → 预扣 + 402 校验
- credits_charge_settle(charge, result=None, actual_cost_usd=None) → 结算（幂等）
- credits_charge_refund(charge, reason="") → 失败/取消退款（幂等）

已覆盖：

| 生成类型 | 入口 |
|---|---|
| 图片（同步） | POST /api/online-image |
| 图片（异步任务） | POST /api/canvas-image-tasks + run_canvas_image_task |
| 视频（同步/异步） | POST /api/canvas-video + run_canvas_video_task |
| 分镜视频 | POST /api/storyboards/{id}/render、/render-all（中途不足会回滚已建任务和预扣） |
| 音乐 | POST /api/canvas-audio |
| TTS | POST /api/canvas-tts |
| 音频智能切分 | POST /api/canvas-audio-split（按文本 token） |
| 文本 LLM | POST /api/canvas-llm、/api/canvas-llm/stream（流式正常结束结算、报错退款） |
| Agent 服务端生图 | AGENT_IMAGE_GENERATE 包装 capability_generate_image |
| 多维表格批量 | 前端逐行调用图片/视频入口，逐行扣费；批量预估走 /api/credits/price?rows=N |

任务取消/失败/删除：task_run、runner、task_delete 统一退款；服务启动时把超过 24h 的
pending 扣费单自动退款，避免余额被永久占用。

未接入：对话页 /api/chat*（会话式聊天，和画布 LLM 是两套入口）与本地 ComfyUI
（/api/generate，不产生上游费用）；ModelScope 图片入口 (/api/ms/generate) 目前未扣费。
这三处如需计费，复用同一组 credits_charge_start/settle/refund 即可。

## 6. 实测 APIMart 成本字段（真实接口）

- 模型：flux-3-image-klein（最便宜图片），1:1 + 1k
- 提交：POST https://apib.ai/v1/images/generations → {code:200, data:[{status:'submitted', task_id:...}]}，**提交响应没有成本字段**
- 完成：GET https://apib.ai/v1/tasks/{task_id} → data.cost = 0.0072（USD）、data.credits_cost = 0.072（APIMart 积分）、data.usage = null
- 结论：**上游最终任务体有 cost / credits_cost**，服务端把它提到结果顶层并按实际成本结算（actual=true）；提交响应没有，所以不能用提交响应做“实际成本”依据。
- 价格一致性：0.0072 USD 与价目表 flux-3-image-klein 1K 黄金价完全一致；credits_cost 0.072 = 0.0072 / 0.1。

原始响应与扣费结果：tests/artifacts/credits/（apimart-live-*.json、live-report.json）。

## 7. 测试与启动

    python3 -m unittest tests.test_credits -v     # 27 个用例

覆盖：迁移 / 充值 / 预扣结算 / 退款 / 并发扣费不过支 / 余额不足 402 / 图片多规格 /
视频按秒 / 音频按次 / 文本按 token / 加价严格大于成本 / 流水对账 / SSE 推送 / auth-off 关闭。

启动（登录开启才计费）：

    NOVAI_DATA_DIR=/tmp/novai-cloud-demo2 \
    NOVAI_AUTH_ENABLED=1 NOVAI_ADMIN_USER=admin NOVAI_ADMIN_PASSWORD=admin12345 \
    NOVAI_LAN_AUTH=0 NOVAI_REGISTER_IP_LIMIT=1000 \
    venv/bin/python main.py --port 8899

auth-off（NOVAI_AUTH_ENABLED 未开）或 NOVAI_CREDITS_DISABLED=1 时整条链路 no-op：
不扣费、不 402、/api/credits/me 返回 enabled:false。

## 8. 合并跑测试的隔离说明

- 积分模块不在 import 时绑定 DATA_DIR/DB，`install()` 也不建表；数据目录每次调用动态解析。
- 测试切换目录/价目后可调用 `server.credits.reset_for_tests()` 清缓存。
- 合并跑命令（117 tests OK）：

```bash
venv/bin/python -m unittest tests.test_credits tests.test_avatar tests.test_api_settings_admin \
    tests.test_share_links tests.test_collab_ws tests.test_cloud_auth tests.test_cloud_isolation \
    tests.test_canvas_permissions tests.test_asset_acl
```

## 9. 价格精度（2026-10 验收）

- `CREDIT_PRICE_STEP=0.01`（2 位小数）。售价 = `ceil(cost×markup/step)×step`，最小 1 step，且严格 > 成本。
- 验收：文本 15 token → 0.01；图片成本 0.072 积分 → 0.10；视频 1.19 → 1.55；TTS 0.00313 → 0.01。
- 文本结算始终按上游 `usage` 的真实 token 重算；图片/视频/音频按上游 `cost` 字段重算。
- 实际成本高于预扣时补扣差额，**允许余额变成负数（debt）**，不再把差额吞掉。

## 10. 每个模型都有价（model_map.json）

`server/credits/model_map.json` 由 `python3 tools/build_credit_model_map.py` 生成：

- `direct`：APIMart 同名/别名，按规格档计费；
- `proxy`：其它 provider 映射到最接近的 APIMart 等价模型，按该模型**最高档价**计费，接口返回 `pricing_source:'proxy'` + `proxy_model`；
- `conservative`：确无等价模型（10 个语音模型、Luma/Ideogram、Sora-2 等），按该类型全价目**最高价**，接口返回 `pricing_source:'conservative'`。

当前覆盖：**configured=123，entries=141（含内置 18），direct=26，proxy=100，conservative=15，uncovered=0**。

审计：

    python3 -m server.credits.audit          # 每个模型的价格/成本/来源/proxy
    python3 -m server.credits.audit --json   # 机器可读
    GET /api/credits/audit                   # admin 接口

## 11. 最终结算口径（2026-10 用户拍板）

- `cost`：APIMart 上游真实扣除（`data.cost`，USD）；文本按 `usage` 实际 token × 单价。
- `price`：用户实付 = `ceil(actual_cost_credits × (1+PROFIT_RATE) / step) × step`（最小 0.01，只基于上游实际成本）。
- `profit`：`price - cost`，三者同时以 USD 和积分记录。
- `PROFIT_RATE` 默认 `0.30`（30%），可用 env 改；有 actual 时必须用 actual 重算。
- 没有 actual 时才用估价，且估价按该模型最高档成本兜底（≥ 最高可能成本 × 1.3）。
- 结算后强校验 `price_usd > actual_cost_usd` 且 `profit_usd > 0`，不满足按 step 上调并记 warning。
- 实际 > 预扣时补扣，余额允许为负（debt）。

## 12. 普通成员只可见/使用 APIMart

- 非 admin 的 `/api/providers`、`/api/config`、`/api/models`、`/api/provider-registry`、`/api/image-params` 只返回 apimart 及其模型。
- 非 admin 生成请求 provider 为空/旧默认值（comfly 等）→ 归一为 apimart；显式非 apimart → HTTP 403 `{code:'provider_not_allowed'}`。
- admin 仍可见可配全部；auth-off 本地模式保持全量。

## 13. APIMart 语音模型：后付费（postpaid）

10 个语音模型（gpt-4o-audio-preview* / gpt-4o-mini-tts / gpt-audio-mini* / tts-1* / whisper-1）改为生成后付费：

- 请求前不预扣、不检查余额：estimate=0，charge.mode=postpaid；余额 0 也能发起；
- 估价接口返回 `{mode:'postpaid', postpaid:true, cost:0, price:0, message:'生成后按实际用量扣费'}`，不再返回 12.48；
- 完成后优先用上游 `data.cost`/`data.credits_cost`；没有则用 `usage`（字符数/音频秒数/token）按 OpenAI 官方公开单价换算，`pricing_source='openai_official'`：
  - tts-1 / tts-1-1106：$15 / 1M 字符；tts-1-hd*：$30 / 1M 字符；
  - gpt-4o-mini-tts：$0.015 / 分钟（WAV 从文件头读真实时长，非 WAV 用 15 字符/秒估算并标记）；
  - gpt-4o-audio-preview*：音频输入 $40 / 输出 $80 每 1M token；gpt-audio-mini*：$10 / $20 每 1M token；
  - whisper-1：$0.006 / 分钟。
- 结算价 = `ceil(actual_cost_credits × 1.3 / 0.01) × 0.01`（最小 0.01，严格 > 成本），余额可负；
- 完全拿不到成本/usage：该单 0 扣费、status=`unpriced`，`pricing_source='unpriced'`，提示管理员补价，绝不猜固定值。

## 14. 全局后付费（默认）

- `CREDIT_BILLING_MODE=postpaid` 默认：所有类型生成前 estimate=0、不扣款、不查余额、不 402，只建 pending(mode=postpaid)。
- 估价接口所有 kind 返回 `mode:'postpaid', postpaid:true, cost:0, price:0`，并附 `estimated_cost/estimated_price/estimated_usd` 供后台参考；message「生成后按实际用量扣费」。
- 结算优先级：上游 cost/credits_cost → usage（文本 token / 语音字符秒 / 其它）→ 估价表（conservative，actual=false, pricing_source='estimate'）→ 全都没有才 unpriced 0 扣费。
- 失败/取消退款只关闭 pending 单，不扣款。
- 风险：后付费允许欠费（余额为负）。管理员监控入口：
  - `GET /api/credits/charges`：每单 cost/price/profit/actual/pricing_source/status；
  - `GET /api/credits/debtors`：负余额用户列表（按欠费从多到少）；
  - `GET /api/credits/stream`：余额变化实时推送。

## 15. 欠费上限（CREDIT_OVERDRAFT_LIMIT=0.01）

后付费不再无限欠费：

- 发起校验（事务内，postpaid）：`balance <= -overdraft_limit` → 402；`balance + overdraft_limit < estimated_price` → 402，body 带 `{code, estimate, balance, overdraft_limit}`。
- 0 余额：文本估 0.01 可发；图片估 0.10 > 0.01 会 402。无 `estimated_price` 的类型（如部分 Agent 调用）只校验 `balance > -overdraft_limit`。
- 结算仍按实际成本 × 1.3：实际偏差导致余额低于 -0.01 时**允许扣穿**（不 cap、不少收），扣费单标 `overdrawn_over_limit=1` 且 note 里写 `overdrawn_over_limit=1`；下一单会被 402 挡住。
- `/api/credits/me`、`/api/credits/price`、402 body 都带 `overdraft_limit`。
- `GET /api/credits/debtors?over_limit=true` 只看超过欠费上限的用户；返回每人的 `over_limit`。
- 前端 402 文案建议：「积分不足：本次预计 X，当前 Y（可欠费 0.01）」；负余额照常显示。

## 16. 结算必须可追溯（2026-10）

- 最终价只基于上游真实扣费：`data.cost` / `data.credits_cost` → `actual_cost_usd`；再 `ceil(actual_cost_credits×1.3/0.01)×0.01`。
- 每单记录：`actual_cost_usd`、`price_usd`、`profit_usd`、`actual=true`、`cost_source`（`cost` / `credits_cost` / `usage` / `openai_official` / `estimate` / `caller`）。
- 只有完全拿不到实际成本时才用估价单，必须 `actual=false, cost_source='estimate'`；管理员 `/api/credits/charges` 可查完整成本/利润，前端只展示实扣积分。
