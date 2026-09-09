# Phase 5 · First-party App 统一迁移规则

> 适用范围：Phase 5 及其后所有第一方 App 的 manifest 化迁移。
> 已按本规则完成的样板：**chat**（`apps/chat/`）。

## 0. 一句话原则

**迁移的是「归属与元数据」，不是「代码」。**
App 包只声明「我是谁、入口在哪、有什么能力」，业务实现继续留在唯一的 Legacy 页面里。

## 1. ⛔ 铁律：禁止复制 Legacy HTML

不得把 `static/*.html` 的业务源码整份复制进 `apps/<id>/`。

涉及页面（当前 5 个待迁移 App 的 Legacy 基础）：

| App id | Legacy 页面 |
| --- | --- |
| `image-generation` | `/static/online.html` |
| `infinite-canvas` | `/static/smart-canvas.html` |
| `assets` | `/static/asset-manager.html` |
| `api-settings` | `/static/api-settings.html` |
| `workflow-settings` | `/static/comfyui-settings.html` |

复制会造成：双份源码必然分叉、Legacy 与 App 两份真相、后续每次改动要改两处。

## 2. 标准结构（Thin Migration Entry）

```
apps/<id>/
├── manifest.json     # novai-app/v1 契约，后端 scan 自动发现
└── <entry>.html      # Thin Entry：只做同 iframe 导航，不含业务代码
```

`<entry>.html` 的标准内容（`location.replace` 而非 `assign/href`）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>…</title>
<script>location.replace("/static/<legacy-page>.html");</script>
</head>
<body>
  <noscript><p>…<a href="/static/<legacy-page>.html">点击继续</a></p></noscript>
</body>
</html>
```

### 为什么必须是「同一 iframe 内导航」

| 要求 | 由 `location.replace` 保证 |
| --- | --- |
| 不产生 iframe-in-iframe | ✅ 只导航，不新建元素 |
| 不额外增加 history 记录 | ✅ `replace` 而非 `assign` / `href` |
| focus bridge 不失效 | ✅ bridge 绑在 iframe **元素**上，导航不换元素 |
| singleton / keepAlive 语义不变 | ✅ 实例与窗口归属不变 |

链路：`manifest → /apps/<id>/<entry>.html（thin） ──同 iframe──▶ /static/<legacy>.html`

### 何时才把业务资产移入 App 包

仅当该 App **真正重构**（要脱离 Legacy、建立自己的 UI/状态契约）时。
在那之前，业务资产的唯一位置是 `static/`。

## 3. 迁移步骤（逐个 App，一步一 commit）

1. 建 `apps/<id>/manifest.json`：`format/version/id/name/description/entry/singleton/keepAlive/dataVersion/permissions/capabilities` 齐备，过 `novai-app-v1` schema 校验。
2. 建 `apps/<id>/<entry>.html`：Thin Entry（见 §2）。
3. 后端 `registry.scan(APPS_DIR)` 自动发现，无需改后端；`/api/apps` 会返回解析后的 `entry = /apps/<id>/<entry>`。
4. 前端 OS 展示元数据（图标等）在 **Normalize Layer** 补：`osAppRegistry.js` 的 `ICON_BY_ID` 加 `id → osIcon 命名图标`。
   ⛔ 不要写进 manifest —— schema 的 `icon` 要求 `/^/apps//` URL，与命名图标体系不兼容。
5. 删除 `builtinApps.js` 中同 id 的临时描述符（registry 同 id 优先覆盖，删掉才是真正收敛）。
6. 跑 E2E 后再 commit；`git add` 显式列文件，禁 `-A` / `.` / `-a`。

## 4. Entry Validation 契约

`IframeAppAdapter.prepare(def)` 是**异步 preflight**，必须在创建 Window **之前**完成：

```
launch → adapter.prepare → 同源校验 → 可达探测 → ok → createWindowSpec → WM open
                                    └─ fail ─▶ app:error（不建窗）
```

- 仅校验同源（首方 App 均同源）；优先 `HEAD`，`405 / 501` 回退 `GET`。
- 失败统一错误码：

| code | 含义 |
| --- | --- |
| `NO_DEF` | AppDefinition 缺失 |
| `NO_ENTRY` | 无 UI entry（能力型 App，非错误路径） |
| `ENTRY_CROSS_ORIGIN` | entry 非同源（`status: 0`） |
| `ENTRY_UNAVAILABLE` | entry 不可访问 |

`ENTRY_UNAVAILABLE` / `ENTRY_CROSS_ORIGIN` 的 error 形状：

```js
{ code: "ENTRY_UNAVAILABLE", message: "App entry 不可访问（HEAD → 404）",
  appId: "<id>", entry: "/apps/<id>/<entry>", status: 404 }
```

后果：实例落 `state: 'error'` + emit `app:error`。
`osAppStore` 的 `aliveAppIds()` / `runningAppIds()` / `byAppId()` 均排除 `error`
→ Dock 运行指示不误亮（**无 ghost Dock**），且下次 launch 可干净重试。

⛔ 刻意**不依赖 `iframe.onerror`**：那是事后发现，届时空白幽灵窗口已经建出来了。

## 5. Capabilities 语义（declared vs executable）

| 字段 | 含义 |
| --- | --- |
| `declaredCapabilities` | **声明**：manifest 元数据，只说明「宣称有什么能力」 |
| `executableCapabilities` | **可执行**：当前已真正绑定 Action / Adapter handler 的能力 |

- Phase 5 尚无 Action System → `executableCapabilities` 恒为 `[]`。
  例：`chat.ask` / `chat.summarize` 目前 **只 declared，不 executable**。
- 调用面前必须查 `executable`，**不得把 declared 当作可执行依据**：
  `osAppRuntime.getAppCapabilities(appId)` / `canExecute(appId, capId)`。
- ⛔ 不修改后端严格 schema（`novai-app-v1`，`additionalProperties:false`）来加字段；
  这一层语义区分完全落在前端 Normalize Layer。

## 6. 每个 App 的完成判据（E2E）

- `source === 'registry'`（不是 builtin fallback）
- `/apps/<id>/<entry>` 与 `/static/<legacy>` 两者均 200
- 同 iframe 已导航到 Legacy，Legacy 内容真实加载
- Console 0 error
- singleton 复用、Minimize、session keepAlive 重建窗口、iframe focus bridge 全 PASS
