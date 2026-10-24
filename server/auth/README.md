# 邀请制登录（M1）

单进程 SQLite 会话 + 邀请码注册，挂在现有 FastAPI app 上；**默认关闭**，本地桌面版无感。
数据落 `DATA_DIR/users.db`（WAL），密码 scrypt 加盐，会话 cookie `novai_session`（HttpOnly）。

## 开关与数据

| 环境变量 | 作用 |
|---|---|
| `NOVAI_AUTH_ENABLED=1` | 启用鉴权（默认关闭） |
| `NOVAI_AUTH_DISABLED=1` | 强制关闭，优先级高于 ENABLED |
| `NOVAI_DATA_DIR` | 数据根目录；`users.db` 落其下 `data/` |
| `NOVAI_ADMIN_USER` / `NOVAI_ADMIN_PASSWORD` | 首次启动、users 表为空时引导管理员 |
| `NOVAI_REGISTER_IP_LIMIT` | 注册限流：每 IP 每小时次数（默认 10） |
| `NOVAI_REGISTER_GLOBAL_LIMIT` | 注册限流：全局每分钟次数（默认 60） |
| `NOVAI_RESET_IP_LIMIT` | 重置码限流：每 IP 每小时次数（默认 10） |
| `NOVAI_TRUST_PROXY=1` | 取 `X-Forwarded-For` 第一段作为客户端 IP（放 nginx 后面时开） |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | `{username,password,invite_code}`，成功即登录 |
| POST | `/api/auth/login` | `{username,password}` |
| POST | `/api/auth/logout` | 清会话 |
| POST | `/api/auth/password` | `{old_password,new_password}`：旧密码错 400 `bad_credentials`；成功后保留当前会话、踢掉其它设备、写审计 |
| GET | `/api/auth/me` | 当前用户；未开启时返回 `{auth_enabled:false}` |
| POST | `/api/auth/username` | `{new_username,password}`：验密码 + 格式/唯一校验，成功写审计 `user_change_username` |
| POST | `/api/auth/reset-password` | 公开：`{username,code,new_password}`，凭管理员发的重置码改密码（见下） |
| GET | `/api/auth/account` | 我的账户：用户信息（含 `created_at`）+ 画布数 |
| GET | `/login` | 登录/注册页（`static/login.html`） |
| GET | `/account` | 我的账户页（`static/account.html`）：auth-off 404，未登录 302 `/login?next=/account` |
| GET | `/reset` | 忘记密码页（`static/reset.html`）：公开可访问（等价于未登录也能看），auth-off 404 |
| POST | `/api/admin/invites` | 管理员生成邀请码，`{uses,days,role}`，默认 1 次 / 7 天 |
| GET | `/api/admin/invites` | 列表（含 status: active / expired / exhausted / disabled） |
| POST | `/api/admin/invites/{code}/disable` | 停用邀请码 |
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users/{id}/disable` | 停用用户并立即作废其会话 |

管理员接口只认 `role=admin` 的会话；未登录 401，非管理员 403。
邀请码为 **6 位数字**（首位非 0，写库查重），历史 `NOVAI-XXXX-XXXX-XXXX` 格式仍可读取（大小写不敏感）。

## C 端用户菜单（注入式）

- `static/js/user-menu.js`：页面加载后探测 `/api/auth/me`，只有 `auth_enabled:true` 才注入
  右上角胶囊（头像首字 + 用户名）与面板；**auth 关闭时零 DOM、零样式、零网络副作用**。
- 面板：用户名/角色、我的账户（跳 `/account`）、修改密码、管理后台（仅 admin，新开 `/admin`）、
  退出登录（跳 `/login`）。
- 改密码弹窗走 `POST /api/auth/password`，错误按接口 code 提示（`bad_credentials` /
  `invalid_password` 等）；成功后提示「密码已修改，其它设备已退出」，当前会话保留。
- 键盘：Esc 关面板/弹窗、Enter 提交、Tab 焦点锁在弹窗内、`:focus-visible` 描边；
  右上角已有固定按钮（如 index 的 `.stage-actions`）时自动向左错开。
- 已注入入口：`static/v2/index.html`（`/` 实际入口）、`static/index.html`（`/legacy`）、
  `static/smart-canvas.html`、`static/canvas-list.html`，以及构建源 `web/index.html`。
  注意：`/` 默认服务 `static/v2/index.html`，只改 `static/index.html` 用户看不到。

## 上线注意

- 云端必须设 `NOVAI_LAN_AUTH=0`：旧的局域网口令门禁会挡非回环来源，和本套鉴权是两套东西（计划书要求最终只留一套）。
- HTTPS 反代后 `X-Forwarded-Proto: https` 会让会话 cookie 自动带 `Secure`。
- 限流是单进程内存实现；多 worker 部署时每个进程各算一份，要精确全局限流得换 Redis。
- 已知限制：无邮箱验证 / 无邮件找回（找回走管理员发的一次性重置码）；不传 `NOVAI_ADMIN_PASSWORD` 且库为空时没有管理员，只能手工建号。

## M2：管理后台 + 数据隔离

### 管理页与接口（仅 `role=admin`）

- `GET /admin`（`static/admin.html`）：邀请码 + 用户两屏；
  auth 关闭时 404，未登录 302 到 `/login?next=/admin`，非 admin 同样 302。
- `POST /api/admin/invites`：`{uses:1-1000, days:0-3650|null, role:user|team|admin}`，默认 1 次 / 7 天。
- `GET /api/admin/invites`、`POST /api/admin/invites/{code}/disable`
- `GET /api/admin/users`：每个用户带 `canvas_count`，响应附 `stats:{users, active_invites, new_today}`
- `POST /api/admin/users/{id}/disable` / `enable` / `role` / `reset-password`
  - 停用/重置密码会立刻删掉该用户全部会话；
  - 重置密码返回的临时密码只出现一次，库里只存 scrypt 哈希；
  - 管理员不能停用自己、不能降低自己的管理员权限。
- 审计：以上写操作 + 画布认领都写 SQLite `audit_log`（时间/操作者/动作/目标/结果/详情），
  接口失败也会记 `result=error` + 错误码。查询：`server.auth.store.list_audit()`。

### 画布隔离（`/api/canvases*`）

- 画布 JSON 新增 `owner_id`（数字）；旧画布没有该字段时视为无主。
- auth-on：列表 / 回收站 / 最近画布只返回自己的；打开 / 保存 / 重命名（meta）/ 删除 / 恢复 / 彻底删除 /
  版本列表 / 读版本 / 还原版本 / 删除版本 / 清日志 一律校验 owner，非本人 403；admin 例外可读写全部。
- admin 默认列表仍只看自己，`?all=1` 才看全部（包括无主旧画布）。
- 新建画布写入当前用户 `owner_id`；版本还原保留 `owner_id`。
- 旧画布过渡：`POST /api/canvases/{id}/claim`（仅 admin）把无主画布认领到当前管理员，写审计。
- auth-off：不写 `owner_id`、不过滤、不校验，行为与旧版一致（有单测锁定）。

### 素材隔离（`ASSETS_DIR` + `/assets`）

- auth-on 时新上传 / 生成结果落 `ASSETS_DIR/users/{uid}/input|output`，URL 形如
  `/assets/users/{uid}/input/xxx.png`；`output_storage()` 由请求级 contextvar（tenant.py）决定目录，
  并发请求不会串用户。
- `/assets/users/{uid}/**`：必须登录且 uid 与当前用户一致（admin 可读），否则 401/403；
  同一份字节被不同用户上传时会各自落一份，不会把别人的 URL 返回给当前用户。
- **存量素材（不在 users/ 下）保持公共只读**：`ASSETS_DIR` 同时承载安装包自带的 library/models 等
  页面资源，一刀切 admin-only 会把普通用户界面资源一起挡掉；M2 先收口新数据，存量治理下一轮做。
- 媒体解析（`output_file_from_url` / 缩略图 / /api/outputs 目录扫描）已识别 `/assets/users/...`。

### 画布权限（M3：分享画布）

- 存储：同一个 `users.db` 的 `canvas_shares(canvas_id,user_id,role,created_by,created_at)`，
  `role CHECK IN ('viewer','editor')`，幂等建表（`server/perms.py`）。
- 角色：owner 全权；admin 全权（可读/可改/可删）；editor = 打开 / 保存 / meta 非标题字段 / touch / 版本读；
  viewer = 只读；无关系 = 列表不可见、GET/PUT 403；auth-off 完全不查这张表、不校验。
- 列表：`GET /api/canvases` 返回「自己 + 被共享」，每项带 `access_role`（owner/admin/editor/viewer）
  与 `owner_username`；`?scope=mine|shared|all`（默认 all）；admin 另支持 `?all=1` 全量（含无主旧画布）。
- 权限接口（仅 auth-on；owner/admin 能改）：
  - `GET /api/canvases/{id}/permissions` → `{owner:{id,username}, members:[{user_id,username,role}], my_role}`
  - `POST /api/canvases/{id}/members {username,role}`（用户不存在 404、重复 409、角色非法 400）
  - `PATCH /api/canvases/{id}/members/{user_id} {role}`
  - `DELETE /api/canvases/{id}/members/{user_id}`
- 成员打开权限弹窗为只读视图；owner/admin 可添加/改角色/移除，即时生效。
- 审计：`canvas_share_add` / `canvas_share_update` / `canvas_share_remove`，
  target 形如 `{canvas_id}:{username}`，失败也记 `result=error`。
- 前端：`static/js/canvas-perms.js` + `static/css/canvas-perms.css`；
  canvas-list 卡片「…」菜单在「复制画布」后加「权限」，共享画布左上角显示「可编辑 / 只读」；
  auth-off 时列表项没有 `access_role`，入口和标记都不渲染。

## 我的账户 + 忘记密码（重置码）

### 我的账户页

- `GET /account`（`static/account.html`，路由在 `server/auth/pages.py`）：
  头像/用户名、角色中文、注册时间、画布数（服务端按 `owner_id` 统计，与后台「画布数」同口径）、
  修改用户名、修改密码、退出登录。auth-off 404；未登录 302 `/login?next=/account`。
- `GET /api/auth/account` 返回 `{user:{id,username,role,status,created_at}, canvas_count}`。
- 页面跟随 `studio_theme` 明暗主题与 marvis 设计令牌。

### 管理员发重置码 → 用户自助重置

- `POST /api/admin/users/{id}/reset-code`（admin）→ `{ok,user,code,expires_at}`：
  6 位数字、15 分钟、一次性；只存 scrypt 哈希；给同一用户重新生成会直接覆盖旧码（旧码失效）；
  写审计 `user_reset_code`（成功/失败都记）。
- `POST /api/auth/reset-password`（公开）`{username,code,new_password}`：
  校验用户 / 码 / 过期 / 一次性（删除成功才算消费，并发只有一个赢家）；成功改哈希 + 踢掉该用户全部会话，
  写审计 `user_reset_code_use`；失败 400 `invalid_reset_code` / `reset_code_expired`（不暴露账号是否存在），
  停用账号 403 `user_disabled`，超过限流 429 `rate_limited`。
- 登录页加「忘记密码？」链接（auth-off 时隐藏）→ `/reset`；页面说明「邀请制：向管理员索取 6 位重置码」。
- 管理后台用户列表新增「生成重置码」按钮，弹窗显示码与过期时间（不显示明文哈希）。
- 与既有「管理员重置密码（临时密码）」并存，互不影响。

## M4：实时协作 WebSocket

- 端点：`GET /ws/canvas/{canvasId}`，握手用现有会话 cookie `novai_session`。
  - 未登录：发 `{type:'error',code:'AUTH_REQUIRED'}` 后 close **4401**
  - 无画布权限：`FORBIDDEN` + close **4403**
  - 房间满（含 viewer，上限 10）：`ROOM_FULL` + close **4409**
  - auth-off：已 accept 后直接 `FORBIDDEN` + close 4403，不查 users.db / canvas_shares。
- 权限复用 M3：owner/admin/editor 可发 patch，viewer 只读（发 patch 回 `error READ_ONLY`）；
  admin 可进任意画布；颜色按 userId 从固定 10 色调色板取，跨房间一致。
- 新加入顺序：`snapshot`（磁盘画布 JSON）→ `hello`（self/role/users/revision）→ 补发房间历史 patch
  → `presence` 广播。owner/editor/viewer 的 role 直接下发。
- 客户端 → 服务端：
  - `{type:'cursor',x,y}`：服务端二次限速 30ms/人，转发 `{type:'cursor',userId,x,y}`（画布坐标）
  - `{type:'patch',patch}`：结构校验 + 512KB/条；通过后 revision +1 并广播给其他人
  - `{type:'request-snapshot'}`：重新从磁盘读画布并回 snapshot
  - `{type:'ping'}` → `{type:'pong'}`
  - 未知类型 → `error BAD_MESSAGE`；非 viewer 发坏 patch → `INVALID_PATCH` / `PAYLOAD_TOO_LARGE`
- patch 格式（服务端只校验结构、不解释内容）：
  ```json
  {
    "title": "可选，新标题",
    "nodes": {"add": [<完整节点>], "remove": ["id"], "update": [{"id": "…", "fields": {...}}]},
    "connections": {"add": [<完整连线>], "remove": ["id"], "update": [{"id": "…", "fields": {...}}]}
  }
  ```
- 内存状态：每房间最近 500 条 patch；断线/心跳 10s 无消息即清理并广播 presence；
  房间空后丢弃（不落盘）。服务重启后 revision 归零，新加入者以磁盘 snapshot 兜底。
- 实现：`server/collab.py` + `main.py` 的 `/ws/canvas/{canvas_id}` 路由；**未改**
  `static/js/smart-canvas.js`（客户端由另一条线接入）。
- 真机冒烟：`tests/collab_smoke.py`（httpx + websockets），日志在 `tests/artifacts/collab/smoke.txt`。

## M5：共享画布的素材读取（asset ACL）

- 背景：M2 把素材收进 `ASSETS_DIR/users/{uid}/`，静态访问只允许本人（admin 例外）；协作时
  对方会看到 owner 的图片 URL 却打不开。M5 在中间件对此放行：
  - 本人 / admin：照旧 200；
  - 其它已登录用户：对目标 `uid` 名下**某个画布**有 view 权限（owner/admin/editor/viewer，复用
    `server.perms`），且该画布文档的任意字符串字段引用了这个具体路径 → 200；否则 403；
  - 路径比较：`/assets/users/{uid}/input/x.png` 全路径一致，忽略 query/fragment，URL decode 后比较；
    绝对 URL 取 pathname 再比；
  - 匿名 401；auth-off 完全不校验（沿用 M2 公共读行为）。
- 缓存：进程内按 `(owner_uid, canonical_path, viewer_id)` 缓存允许/拒绝结果，默认 **45s**
  （`NOVAI_ASSET_ACL_TTL` 可调，建议 30–60）；上限 4096 条，逐出过期项。命中缓存不扫盘，
  未命中才扫描 `CANVAS_DIR/*.json`（跳过回收站/无主画布）。成员变更、画布删除最迟一个 TTL 生效，
  不主动失效；测试用 `server.asset_acl.clear_cache()` 立即验证。
- 实现：`server/asset_acl.py` + `server/auth/middleware.py` 的 `/assets/users/{uid}/**` 分支；
  `main.py` 注入 `CANVAS_DIR`。真机冒烟：`tests/asset_acl_smoke.py`，日志
  `tests/artifacts/asset-acl/smoke.txt`。

## M6：分享链接（登录后可看）

- 数据：同一个 users.db 的 `canvas_share_links(canvas_id PRIMARY KEY, token UNIQUE, role, expires_at,
  password_hash, allow_clone, created_by, created_at, revoked)`；首次调用时
  `CREATE TABLE IF NOT EXISTS`（幂等迁移，不批量改旧数据）。
- token：`secrets` 生成 **10 位**，字符集去掉 I/O/0/1（`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`）；
  更新设置时 token 不变，已发出的链接继续有效；撤销后同 token 重新 POST 会恢复。
- Owner/admin API（走现有会话 + perms，manage 权限）：
  - `GET /api/canvases/{id}/share-link` → `{link:null}` 或 link 对象
    （token/url/role/expires_at/expires_in_days/has_password/allow_clone/created_at）
  - `POST /api/canvases/{id}/share-link` `{expires_in_days:0|1|7|30, password:string|null,
    allow_clone:bool, role:"viewer"}`：无则创建、有则更新；密码传空/null 关闭密码，重设覆盖 hash
  - `DELETE /api/canvases/{id}/share-link` → revoked=1，token 立即失效
  - 非 owner/admin 403；画布不存在 404；auth-off 这些接口 404
- 公开访问（**必须登录**）：
  - `GET /api/share/{token}`：未登录 401 `AUTH_REQUIRED`；链接不存在/撤销 404 `NOT_FOUND`；
    过期 410 `EXPIRED`；有密码且未解锁 401 `PASSWORD_REQUIRED`；通过后返回
    `{canvas,title,owner_username,allow_clone,role:"viewer",authenticated:true,can_clone}`，
    并**自动把当前用户加为 viewer 成员**（owner/已是成员则跳过，幂等）。
  - `POST /api/share/{token}/unlock {password}`：错误 403 `BAD_PASSWORD`（每 IP 10 次/分钟，
    超限 429 `RATE_LIMITED`）；正确设置 HttpOnly cookie `novai_share_access`
    （值 `<token>:<exp>:<hmac>`，7 天且不超过链接过期，SameSite=Lax，Path=/）。
  - `POST /api/share/{token}/clone`：需登录（401 `AUTH_REQUIRED`）；未开克隆 403
    `CLONE_NOT_ALLOWED`；成功 201 `{canvas_id}`，复制到当前用户名下，标题「<原题> 的副本」。
  - `GET /c/{token}`：返回 `static/share.html`（不存在时返回内置占位页，前端可随时放入文件接管）；
    该路径在中间件里公开，页面自己 401 后跳 `/login?next=/c/{token}`。
    登录页已支持 `next`（`static/login.html` 读取并回跳），全站页面拦截也会带 `next`。
- 素材：链接访问通过后用户已成为 viewer 成员，直接复用 M5「共享画布引用」规则；
  不再单独给 token 开素材白名单。密码 cookie 只控制文档访问。
- auth-off：上述 API 与 `/c/` 页面统一 404，不影响旧行为。
- 真机冒烟：`tests/share_links_smoke.py`，日志 `tests/artifacts/share-links/smoke.txt`。

## M7：用户头像 + API 设置仅管理员

### 头像

- `users.avatar TEXT NOT NULL DEFAULT ''`：新库直接带；老库在 `store.connect()` 里
  `PRAGMA table_info(users)` 检测后 `ALTER TABLE users ADD COLUMN avatar ...`（幂等）。
- 文件落 `DATA_DIR/avatars/{user_id}.{png|jpg|webp}`，`users.avatar` 只存相对文件名；
  服务端按 magic bytes 判真实格式，content-type 只辅助校验，单文件 ≤2MB。
- 接口：
  - `POST /api/auth/avatar`（multipart 字段名 `file`）→ `{avatar_url}`；登录用户改自己
  - `DELETE /api/auth/avatar` → `{avatar_url:""}`，删文件并清字段
  - `GET /api/auth/avatar/{user_id}`：登录用户可读任意用户头像；返回
    `Cache-Control: private, max-age=300` + `ETag`/`Last-Modified`，支持 304
  - `POST /api/admin/users/{id}/avatar`（仅 admin）替成员换头像
- `avatar_url` 是绝对路径 `/api/auth/avatar/{id}?v=<mtime_ms>`，无头像为空串；
  `/api/auth/me`、`/api/auth/account`、admin 用户列表都会带。
- auth-off：`GET` 头像 404，上传返回 401/403；不影响旧行为。

### API 设置仅管理员

- 中间件对 auth-on 的以下入口统一要求 `role=admin`，非 admin 返回 403
  `{"detail":"需要管理员权限","code":"forbidden"}`：
  - `/api/settings/*`（输出目录 / 存储 / ASR）
  - `/api/config/token`、`/api/config/storage`、`/api/pick-folder`
  - `/api/providers/{...}`（测试连接 / 探测 / 拉模型 / Lovart 模式 / 子路径）
  - `PUT/POST/PATCH/DELETE /api/providers`（保存供应商）
- 只读列表接口不受影响：`/api/models`、`/api/config`、`GET /api/providers`、`/api/provider-registry`
  （生成页、素材页仍可用）。
- 旧静态页 `/static/api-settings.html`：未登录 302 `/login?next=...`；登录成员 302 回 `/`；
  admin 200。
- auth-off：中间件提前放行，以上接口/页面保持旧行为。

### 本轮明确未做（下一轮）

- 任务队列 / 生成历史 / LLM 对话（`/api/conversations`、`X-User-Id` 口径）仍全局共享。
- 画布项目 `/api/projects` 的计数与删除项目时的画布回迁仍是全局扫描（只暴露计数，不暴露内容）。
- 素材库注册表 / 分类目录（`ASSET_LIBRARY_DIR`）仍全局；Agent 链路里直接改画布的接口
  （除 `/api/agent/rollback` 已加归属校验）未逐个收口。
- codex / jimeng CLI 等在代码里直接写 `OUTPUT_OUTPUT_DIR` 的旁路未全部改到租户目录。
- 协作 / 局域网口令门禁合并。
- M6 分享链接仍要求登录；**匿名公开查看 / 未注册用户访问不做**。
- 分享密码只保护文档访问，不限制已经加入成员的后续访问；移除成员仍走画布权限管理。
- M5 只放行「共享画布实际引用的素材」；owner 目录里未被共享画布引用的素材仍 403。
- 素材的独立分享（不经过画布引用、按素材粒度授权/公开链接）仍不做；旧素材（不在 users/ 下）仍公共只读。
- M7 只收口 API 设置入口；ComfyUI / RunningHub 等独立设置页及其接口本轮未改。
- 头像只支持 png/jpg/webp、≤2MB，无裁剪/多尺寸；前端按 `avatar_url` 自行缩放展示。
