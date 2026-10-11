# Windows 端「点更新 → 包能下载 → 安装/更新阶段失败」诊断报告

- 范围：`NOVAI-v16`（NOVAI 无限画布）Windows 桌面端更新链路
- 结论状态：**主因已定位到具体代码位置**，并用上游框架（electron-builder / electron-updater）已知问题交叉印证；本次工作机是 macOS，无法执行 Windows 安装包，因此"这句报错到底是哪一条"需要在 Windows 机器上取一次原始文本（见 §4、§7）
- §0–§7 是**诊断基线**（其中的 main.py 行号为改动前）；本轮已实施的改动与新行号见 **§8**
- 本轮按 §6 实施了 #1 / #2 / #3 / #5 / #7 / #8；**未实施** #4 / #6 / #9 / #10（见 **§9**）

---

## 0. 一句话结论

"下载成功、安装/更新失败"发生在**下载完成之后的「应用新文件 / 安装」阶段**，也就是**往安装目录写文件**这一步：

- 下载落点是用户可写目录 `%APPDATA%\NOVAI\data\update_staging\...`，备份落点 `%APPDATA%\NOVAI\data\update_backups\...` → **所以下载、备份都能过**；
- 替换/安装要写**安装目录**（`C:\Program Files\NOVAI`，或 Electron 安装目录里的 `resources\backend`），而两条更新链**都不带管理员权限** → 创建/覆盖文件被系统拒绝，或安装程序静默运行失败。

归类：**权限问题（主因）＋ 自研更新器把安装目录当可写目录的设计缺陷（结构性原因）＋ 失败回滚会把第一个错误顶掉、变成"创建文件"这类二次报错（加重项）**。不是网络、下载、校验问题。

---

## 1. 项目里其实有两条完全独立的 Windows 更新链

同一份 Release 里同时上架了两个 Windows 安装包（已实测 GitHub API v1.0.123）：

| 安装包 | 来源 | 装到哪 | 谁负责更新 |
|---|---|---|---|
| `NOVAI-Setup-<版本>.exe`（107MB，README 里"推荐"那个） | `build-win.yml` → `build-all.py` → PyInstaller + `installer.nsi` | `$PROGRAMFILES64\NOVAI`（installer.nsi:22），安装器 `RequestExecutionLevel admin`（installer.nsi:24） | **自研一键更新** `POST /api/update-from-github` |
| `NOVAI-Electron-Setup-<版本>.exe`（184MB） | `build-electron.yml` → electron-builder NSIS | electron-builder 默认（`perMachine` 未设 → 默认当前用户；但 `allowToChangeInstallationDirectory: true`，用户可改到 Program Files/别的盘），desktop/package.json:94-99 | **electron-updater**（desktop/main.js:387-473） |

### 链 A：自研「一键更新」（设置 → 关于 → 更新弹窗 / 右下角常驻更新提醒）

```
点击"开始更新"
→ POST /api/update-from-github                      main.py:3361
→ 归一化源 + 兜底顺序 [所选源, modelscope, github, gitee]   main.py:3303,3366-3370
→ 逐源下载到 %APPDATA%/NOVAI/data/update_staging/<时间戳>-<pid>-<源>/   main.py:3392-3407
   └ GitHub: api.github.com/git/trees?recursive=1 列文件 → raw 逐文件下载   main.py:3259-3280, 2981-3007
   └ ModelScope: 仓库 files API（Recursive=true）→ 逐文件下载             main.py:3009-3065
   └ Gitee: git trees API → raw 逐文件下载                              main.py:3079-3132
   (并发 6 线程；下载阶段占进度 0-80%，UI 显示"下载中 x/y 个文件")
→ verify_staged_update_manifest（若有 update-manifest.json 才逐文件 SHA-256）main.py:3317-3345,3358
→ 备份：根文件 + 整个 static → %APPDATA%/NOVAI/data/update_backups/<时间戳>/  main.py:3385,3424-3439（进度 88%）
→ 应用新文件（进度 96%）：
     static：逐文件 copy2 → <目标>.update_tmp → os.replace          main.py:3443-3454
     根文件：同样 copy2 + os.replace                                 main.py:3462-3471
     失败则回滚 static（rmtree + copytree）与已替换的根文件           main.py:3455-3459,3472-3484
→ auto_restart: 写 BASE_DIR/_self_restart.bat 并杀自己重启            main.py:3487-3488,3152-3251
```

关键路径前提（代码事实）：

- `BASE_DIR` = 环境变量 `NOVAI_APP_DIR`，即 **exe 所在目录 = 安装目录**（main.py:351-353；launcher.py:36-42 取 exe 目录，launcher.py:200 设 `NOVAI_APP_DIR`）
- `STATIC_DIR = BASE_DIR/static`（main.py:358）；`safe_update_target()` 的目标 = `BASE_DIR/<rel>`（main.py:3134-3142）
- `DATA_DIR` = `NOVAI_DATA_DIR/data` = `%APPDATA%\NOVAI\data`（main.py:365-369,451；launcher.py:196-201）
- **`BASE_DIR`（安装目录）与 `DATA_DIR`（用户数据目录）是两个完全不同权限的目录** —— 这就是"下载能过、落盘不过"的根源

### 链 B：Electron 自动更新（electron-updater）

```
app 启动 8s 后 autoUpdater.checkForUpdates()            desktop/main.js:472
→ update-available 弹窗"立即更新" → downloadUpdate()      main.js:402-417（autoDownload=false，main.js:394）
→ 下载 184MB 的 NOVAI-Electron-Setup-<版本>.exe（走 GitHub Releases；
   报错时切国内镜像 generic: modelscope .../electron-release）  main.js:400,443-456
→ update-downloaded 弹窗"立即重启" → quitAndInstall()      main.js:418-442
→ before-quit → shutdownBackend()（仅 backendProc.kill()，不等待、不杀进程树）main.js:221-225,604
→ NSIS 安装器静默替换安装目录文件 → 这一步失败              （框架行为，非本仓库代码）
```

---

## 2. 报错来源定位：仓库里没有"创建文件失败"这句文案

- 全工作区检索 `创建文件失败` / `createFile failed` / `Failed to create file` → **0 命中**（`NOVAI-v16` 及其 `_claude_backup` 备份、含全部 md/js/vue/打包脚本）。
- 所以界面/日志上那句"创建某个文件失败"**不是项目里的固定文案**，只能是：① Windows/Python 抛出的系统原文被界面原样显示，② NSIS 安装器自己的错误框，或 ③ 用户转述。**必须拿到原始文本才能钉死**（§4 给了一行命令）。

会抛出"创建文件"类错误的具体代码点（链 A）：

| 位置 | 调用 | Windows 上可能的原始报错 |
|---|---|---|
| main.py:3453 / 3468 | `shutil.copy2(src, <目标>.update_tmp)` | `[WinError 5] 拒绝访问。: 'C:\Program Files\NOVAI\...\x.update_tmp'`；`[WinError 3] 系统找不到指定的路径`；`[WinError 112] 磁盘空间不足`；被杀软拦截时也可能是 5/225 |
| main.py:3454 / 3469 | `os.replace(tmp, 目标)` | `[WinError 5] 拒绝访问`（目标只读或无权限）、`[WinError 32] 另一个程序正在使用此文件`（被占用） |
| main.py:3443 / 3448 / 3466 | `os.makedirs(..., exist_ok=True)` | `[WinError 183] 当文件已存在时，无法创建该文件。`（同名处已存在"文件"而非目录） |
| **main.py:3456-3458** | 回滚 `rmtree(static_dir, ignore_errors=True)` + `copytree(backup, static_dir)` | **`[WinError 183] 当文件已存在时，无法创建该文件。: '...\static'`** —— rmtree 在 Windows 上遇到占用文件会静默跳过，目录没删干净；`copytree` 默认 `dirs_exist_ok=False` 直接抛错，**异常在 except 块里抛出，会把第一个错误顶掉**，用户看到的是这条二次报错 |
| main.py:3205 | `open(BASE_DIR/_self_restart.bat, "w", encoding="mbcs")` | 安装目录不可写 → `[WinError 5] 拒绝访问`（被 `schedule_self_restart` 整体 catch 掉，main.py:3249-3251，只在日志里） |

界面上错误怎么来的（能拿到原文）：
- 新前端：`startUpdate()` 失败时 `summarize('fail','更新失败', e.message)`，`e.message = data.detail`（web/src/lib/update.js:275-288），弹窗在 web/src/shell/UpdateModal.vue:46-47 渲染
- 后端：`detail=f"更新失败：{exc}"`（main.py:3528-3530）
- 旧外壳：static/index.html:6014 起同一接口

---

## 3. 逐项核查（每一格都有代码或实测依据）

| 排查方向 | 依据 | 判定 |
|---|---|---|
| 目标目录权限不足、更新进程未提权 | 安装目录 `$PROGRAMFILES64\NOVAI`（installer.nsi:22）；安装器才要管理员（:24）；`launcher.py` 把 exe 目录当 `NOVAI_APP_DIR`（:36-42,200）→ `BASE_DIR`；替换写的是 `BASE_DIR/<rel>`（main.py:3138,3466-3469）；全仓 `runas/IsUserAnAdmin` 只出现在**未被使用的** `installer.py:16-18`，更新链路里**没有任何提权代码** | **支持（主因）** |
| 临时目录/解压目录与安装路径不一致 | 暂存/备份在 `%APPDATA%\NOVAI\data`（可写，main.py:3385,3393），落盘在安装目录（main.py:3138） | **支持（同一根因的另一面）** |
| 目标文件已存在/被占用/只读 | `os.replace` 是唯一会因占用/只读失败的调用；代码没有"等占用进程退出"的逻辑；本机无 Windows 无法复现 | **待验证**（关键取证：安装目录残留 `*.update_tmp` 就是 `os.replace` 失败的铁证） |
| 路径含中文/空格/超长 | 实测：从 ModelScope 列出的**167 个可更新文件**（共 16.5MB）与本地工作树逐条比对 → 无"同名处已是目录"、无"祖先已是文件"、无非法字符/保留名/大小写冲突；且下载阶段已成功创建同深度路径 | **基本排除** |
| 磁盘空间不足 | 需下载 16.5MB + 备份复制一份 static | **待验证**（低成本排除项） |
| 防病毒/安全软件拦截 | 更新会写 .py/.js 并生成执行 `_self_restart.bat`；README.md:76 已把"杀毒软件误报"列为已知问题 | **待验证**（查 Defender/杀软拦截记录） |
| 校验失败后仍继续创建文件 | 顺序是"校验(main.py:3358) → 应用(3421+)", 校验失败即抛错中止，**不会继续写**；但实测**仓库与镜像都没有 `update-manifest.json`**（`git ls-files` 无此文件，ModelScope 清单无此文件），`verify_staged_update_manifest` 永远走"missing→跳过"（main.py:3321-3323） | **排除"因校验失败而失败"**；同时发现**哈希校验实际未生效**这个真实问题，而且**现在急着发布清单会让更新 100% 中止**（实测依据见 §8.3） |
| UAC 缺失 / 静默参数不对 | 链 B：electron-builder NSIS 已知限制——`oneClick:false` + `allowToChangeInstallationDirectory:true` 且装在 per-machine 目录时，静默更新无提权，装不进去（electron-builder issue #1857 / #2363 / #7502，见文末链接） | **支持（链 B 主因）** |
| 打包/发布清单与目标不匹配 | 实测：同一 Release 同时上架两个 Windows 安装包；**v1.0.120 的 Release 完全没有 `NOVAI-Electron-Setup-1.0.120.exe`，也没有 `latest.yml`**；ModelScope 镜像 `electron-release/` 里同样缺 1.0.120，且还留着旧命名 `NOVAI Setup 1.0.117.exe`（带空格） | **发现真实发布问题**（不一定是本次根因，但会制造"下错包/更新对不上"） |
| 两套更新器并存 | Electron 包里，自研"一键更新"只会替换 `resources\backend` 下的**源码**，而运行时用的是冻结的 `resources/backend/NOVAI.exe`（build-electron.yml:57-71）→ 点了"更新成功"版本也可能没变 | **真实设计缺陷** |

---

## 4. 日志位置与"怎么拿到本次失败原文"

### 链 A（自研一键更新）——最快的一条命令

1. **接口拿原文（推荐）**：失败后后端进程还活着，错误被原样保留在进度快照里（main.py:3526/3529，`running=False` 不清 error）：
   ```powershell
   curl.exe -s http://127.0.0.1:3000/api/update-progress
   ```
   看返回里的 `"error"` 字段 —— 这就是界面上"更新失败"后面那段原文（含 WinError 编号和完整文件路径）。
   （前端每秒轮询同一接口：web/src/lib/update.js:242-252）
2. 安装目录残留（判断卡在哪一步）：
   ```powershell
   dir /s /b "C:\Program Files\NOVAI\*.update_tmp" "C:\Program Files\NOVAI\*.rollback_tmp"
   ```
   有残留 → 卡在 `os.replace`（占用/只读）；没有残留但存在备份目录 → 卡在 `shutil.copy2`（权限/路径/磁盘/杀软）。
3. 备份目录（证明"备份阶段跑过、失败在应用阶段"）：`%APPDATA%\NOVAI\data\update_backups\<时间戳>\`
4. 后端控制台日志：`[update] 尝试下载源 …` / `[update] 下载源 X 失败：…` + `traceback.print_exc()`（main.py:3400-3417）——**但 exe 桌面版把控制台窗口隐藏了**（launcher.py:17-26），需从命令行直接跑 `NOVAI.exe` 或改用源码方式 `python main.py` 才能看到。
5. 启动日志：`%TEMP%\novai_startup.log`（launcher.py:178）。
6. 暂存目录 `%APPDATA%\NOVAI\data\update_staging\...` 失败后会被 finally 删除（main.py:3532-3533），不要指望在里面找残留。

### 链 B（Electron / electron-updater）

1. **`%APPDATA%\novai-electron.log`**（desktop/main.js:28-42 写入）——里面有 `[updater] 检查更新失败: <原始错误>`（main.js:444）、`[boot]`、`[backend]`。
   ⚠️ 注意 main.js:443-471 把**下载失败和安装失败都写成同一句"检查更新失败"**，弹窗还统一说"可能是网络…"，**真实原因会被掩盖成网络问题** —— 取证时必须看日志原文，不要信弹窗。
2. NSIS 安装阶段的报错一般由安装器自己弹框（英文典型：`Error opening file for writing: <完整路径>`），**路径就是最终证据**。
3. electron-updater 的下载缓存（pending 目录）与安装器日志路径随 app 名变化 —— **待验证**，可在失败机器上按 `dir /s /b "%LOCALAPPDATA%\*updater*"` 定位。

### 权限/环境取证（两条链通用）

```powershell
icacls "C:\Program Files\NOVAI"                     # 目录 ACL 是否给当前用户写权限
whoami /groups | findstr /i "S-1-16-12288"            # 是否高完整性（提权）运行
Get-PSDrive C | Select-Object Used,Free                # 磁盘剩余空间
```

---

## 5. 根因结论

**失败发生在"下载完成之后"的哪一步：**
链 A 是在 **应用新文件（applying，进度 96%）** 阶段，具体在 main.py:3445-3454（static 逐文件）或 main.py:3462-3471（根文件）里的 `shutil.copy2(... update_tmp)` / `os.replace(...)`；如果这两个循环的 except 抛错，则实际冒到界面的是 main.py:3456-3458 的**回滚 copytree** 报的错。链 B 是在 electron-updater 把 `.exe` 交给 **NSIS 静默安装之后**。

**创建文件失败的直接原因（主因）：**
更新进程以**普通用户权限**向**安装目录**创建/覆盖文件被系统拒绝。下载与备份之所以能成功，是因为它们落在 `%APPDATA%\NOVAI\data`（用户可写）；一旦要写 `C:\Program Files\NOVAI`（或 Electron 安装目录内的 `resources\backend`），普通权限进程无法创建文件，Windows 侧表现为 `WinError 5 拒绝访问`；若目标是只读或正被占用，则是 `WinError 5 / WinError 32`。

**加重症状的两个实现问题：**
1. main.py:3456-3458 的回滚 `rmtree(ignore_errors=True)` + `copytree(...)`（未加 `dirs_exist_ok`）在 Windows 上极易二次抛 `[WinError 183] 当文件已存在时，无法创建该文件`，**把首个错误顶掉**，于是用户看到的恰好是"创建文件失败"这一类文案，而不是真正的"拒绝访问"。
2. Electron 客户端里两套更新器并存：自研"一键更新"改的是 `resources\backend` 的源码，运行时用的却是冻结的 `NOVAI.exe`，且同样受安装目录权限约束。

**归类：权限问题为主（安装目录 vs 普通权限进程），自研更新器的设计缺陷为辅（无写权限预检、无提权路径、回滚不健壮），不是网络、下载或校验问题。**

### 5.1 本地隔离复现（macOS 上等价验证，非 Windows 实机）

用与 main.py 完全相同的调用序列，在只读目录里复现"应用阶段"：

1. 目标目录不可写时：`shutil.copy2(src, <目标>.update_tmp)` → `PermissionError: [Errno 13] Permission denied: '.../xxx.js.update_tmp'`
   （Windows 上对应 `[WinError 5] 拒绝访问。: 'C:\\Program Files\\NOVAI\\...\\xxx.js.update_tmp'`）
2. 回滚路径（main.py:3458）在"static 目录没被删干净"时：`shutil.copytree(backup, static_dir)` → `FileExistsError: [Errno 17] File exists: '.../static'`
   （Windows 上对应 `[WinError 183] 当文件已存在时，无法创建该文件。: '...\\static'`）

第 2 步实测结果：**冒到用户面前的是 copytree 的报错，最初的 PermissionError 只留在 `__context__` 里**，而 `detail=f"更新失败：{exc}"`（main.py:3530）不会带出 `__context__` —— 所以界面/日志里那句"创建文件失败"**很可能就是这条二次报错**，而真正的原因（拒绝访问）被吃掉了。这是本次诊断里"报错文案对不上系统错误"的关键解释，也是修复项 #2 的依据。

---

## 6. 修复方案（只列改动，等确认后再实施）

| # | 改动位置 | 改动内容 | 风险 / 影响 |
|---|---|---|---|
| 1 | main.py `update_from_github()` 开头（3384 附近） | 用已有的 `_dir_writable(BASE_DIR)`（main.py:386-396）做**预检**；不可写就直接返回明确文案："安装目录需要管理员权限，请用管理员身份运行 NOVAI 后再更新，或下载安装包覆盖安装" | 低。只加前置判断，不改更新逻辑；能立刻把"创建文件失败"变成可操作提示 |
| 2 | main.py:3456-3458 / 3472-3484 | 回滚健壮化：`copytree(..., dirs_exist_ok=True)`；把首个异常用 `raise ... from exc` 保留；日志同时打印首个异常和回滚异常 | 低。纯健壮性；**注意 dirs_exist_ok 需 Python≥3.8（项目要求 3.10+，满足）** |
| 3 | main.py:3162-3206 | 把 `_self_restart.bat` / `_self_restart.log` 从 `BASE_DIR` 改到 `DATA_DIR`（可写），或失败时降级为"提示用户手动重启" | 低。会改变重启脚本位置，需同步 `launcher.py` 相关假设（当前无其他代码依赖该路径） |
| 4 | main.py `update_from_github()` / 前端 | 增加**提权子进程**路径：Windows 上生成一个 updater 批处理，用 `ShellExecuteW(None,"runas",...)` 以管理员身份执行"替换+重启"，主进程等待其完成 | 中。会弹 UAC；需处理用户取消 UAC、失败回滚、并发 UPDATE_LOCK 语义 |
| 5 | 安装包默认目录 | `installer.nsi:22` 的 `InstallDir "$PROGRAMFILES64\NOVAI"` 改为默认用户可写目录（`$LOCALAPPDATA\NOVAI`），保留"可改到 Program Files 但要求管理员运行"；Electron 侧在 desktop/package.json:94-99 显式 `perMachine:false` 并把默认目录放到用户目录 | 中。老用户升级路径会变（可能装出两份）；需要迁移/兼容策略，建议配合"检测到 Program Files 安装就引导重新下载安装包" |
| 6 | tools/make_update_manifest.py + `.github/scripts/sync-domestic-release.sh` | **让 `update-manifest.json` 真正发布出去**：发版时生成并随源码一起推到镜像根目录（脚本 153-183 那段补一个文件），否则 main.py:3321-3323 永远跳过哈希校验 | 低。能真正启用完整性校验；需两个源都同步，否则不同源行为不一致 |
| 7 | desktop/main.js:418-442, 604 | `quitAndInstall()` 前**彻底结束后端进程树并等待退出**：Windows 用 `taskkill /F /T /PID <pid>`（或 `tree-kill`），并轮询确认进程消失后再安装，避免文件被占用 | 低-中。改的是退出时序，需回归"关窗到托盘/正常退出/重启后端"三条路径 |
| 8 | desktop/main.js:443-471 | 把 `updater` 的 error 处理**区分阶段**（检查/下载/安装），并把日志原文显示到弹窗；至少把"安装失败"和"网络不可用"分开 | 低。纯提示与可观测性；不改变更新行为 |
| 9 | desktop/main.js:387-473 与前端"一键更新" | Electron 版**不要再暴露自研一键更新**（或改为提示"本版请用内置自动更新"），避免"源码更新了、跑的二进制没变"这种假成功 | 中。产品交互改动，需要定一个明确的更新入口 |
| 10 | 发布/镜像清理 | 清理 ModelScope `electron-release/` 里旧命名 `NOVAI Setup 1.0.117.exe`；补/确认 `NOVAI-Electron-Setup-*` 每个版本都存在（1.0.120 缺）；Release 里把"传统安装包"和"Electron 安装包"说明清楚 | 低。仅发布侧；能避免"下错包"类误判 |

---

## 7. 待验证清单（拿到这几条就能把结论钉死）

1. **用户装的哪个包？** `NOVAI-Setup-*.exe`（PyInstaller，链 A）还是 `NOVAI-Electron-Setup-*.exe`（Electron，链 B）——决定看哪套日志。
2. **原始报错文本**：链 A → `curl.exe -s http://127.0.0.1:3000/api/update-progress`；链 B → `%APPDATA%\novai-electron.log`。
3. **安装目录在哪、是否可写、进程是否提权**：`icacls "C:\Program Files\NOVAI"`、`whoami /groups`。
4. **是否残留 `*.update_tmp` / `*.rollback_tmp`**（决定是 `os.replace` 阶段还是 `copy2` 阶段）。
5. **失败时刻杀软/Defender 有无拦截记录**。
6. **磁盘剩余空间**。
7. **镜像 `latest.yml` 内容**与本地已下载的安装包名是否一致（浏览器打开 `https://modelscope.cn/models/bllack/NOVAI-releases/resolve/master/electron-release/latest.yml`；工具侧拉取被 `application/octet-stream` 挡住，需人工确认）。

> 本报告所有结论均来自仓库代码、`git` 历史、release/model 仓库 API 实测与本地隔离复现（在只读目录下复现了 main.py 的应用阶段：`PermissionError` 抛在 `<目标>.update_tmp`）。仓库中不存在"创建文件失败"这一文案（全工作区 0 命中），凡未取到的原始报错均标注为"待验证"。

---

## 8. 本轮已实施改动（Lead 已逐项复核）

范围：§6 的 #1 / #2 / #3 / #5 / #7 / #8；**未做** #4 / #6 / #9 / #10。

### 8.1 改动清单

| # | 文件 | 位置（改动后） | 内容 |
|---|---|---|---|
| 1 | main.py | 3375-3385 | `update_from_github()` 开头加写权限预检：`_dir_writable(BASE_DIR)` 为假时返回 409 + 明确文案（管理员运行 / 下载安装包覆盖安装 / 查杀毒拦截） |
| 2 | main.py | 3469-3478 | static 回滚：`copytree(..., dirs_exist_ok=True)`；回滚自身失败时 `raise RuntimeError(原始错误…回滚也失败…) from apply_exc`；没有备份时不再 rmtree static |
| 3 | main.py | 3491-3514 | 根文件回滚：逐文件独立 try（失败收集后继续回滚其余文件）；static 回滚同样加保护；只有确实回滚失败才会替换掉原始错误 |
| 4 | main.py | 3165-3167 / 3221-3223 | `_self_restart.bat` / `_self_restart.sh` 与 `_self_restart.log` 从 `BASE_DIR`（安装目录）改到 `DATA_DIR`（不可写时回落） |
| 5 | installer.nsi | 23 | `InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"` → `InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"`；`InstallDirRegKey`(24) 与 `RequestExecutionLevel admin`(25) 未动 |
| 6 | desktop/main.js | 227-256, 426, 435, 451, 453, 475-477, 481-523 | 新增 `stopBackendForUpdate()`：Windows 用 `taskkill /F /T /PID` 杀进程树 + 等 `exit`（15s 兜底）；`quitAndInstall()` 改为在其 `.then` 内调用；updater 错误按"检查/下载/安装"分阶段打日志、安装阶段不再切镜像、弹窗带原始错误 |
| 7 | tests/test_update_write_guard.py（新建）+ .github/workflows/tests.yml:58 | — | 回归用例：安装目录不可写时必须 409、进度 `stage=error`、`UPDATE_LOCK` 已释放、且不发起任何下载；已加入 CI 的 python 单测列表 |

### 8.2 验证结果（Lead 实跑）

- `venv/bin/python -m py_compile main.py` → 通过
- `venv/bin/python -m unittest tests.test_update_write_guard -v` → 2/2 通过
- `node tests/run-all.js` → **32/32 通过**
- `venv/bin/python -m unittest tests.test_lan_auth tests.test_asset_dedupe tests.test_lovart_provider_injection tests.test_video_segments tests.test_agent_image_size tests.test_agent_run_history tests.test_agent_run_plan_mode tests.test_update_write_guard` → **94 tests OK**
- `node --check desktop/main.js` → 通过
- `head -c 3 installer.nsi | xxd` → `efbb bf`（UTF-8 BOM 未被破坏；中途曾被 edit 工具弄丢，已补回并复验）
- `git status --short`：本次只动 `main.py`、`installer.nsi`、`desktop/main.js`、`.github/workflows/tests.yml`，新增 `tests/test_update_write_guard.py`；工作区其余大量改动是本轮之前就存在的未提交改动

### 8.3 本轮新发现（直接改变 #6 的做法）

实测 ModelScope 镜像（`bllack/NOVAI-releases` master）与当前检出树逐条对比：

- 镜像里有 **3 个 `server/**/__pycache__/*.pyc`**，而 `update_allowed_file` 允许 `server/` 前缀 → 客户端会下载它们；但 `tools/make_update_manifest.py` 明确排除 `__pycache__` / `.pyc` → **一旦发布 `update-manifest.json`，客户端会因"清单里没有该文件哈希"直接中止整个更新**。
- 镜像里还有 3 个**本地已删除**的旧文件：`static/angle.html`、`static/enhance.html`、`static/klein.html` → 在线更新会把它们重新装回来（镜像只增不减）。
- 反向：本地有 3 个镜像尚未同步的允许文件（`server/matting_refine.py`、`tools/cleanup_test_canvases.py`、`tools/make_update_manifest.py`）→ 镜像落后于源码。

结论：#6 必须"先让两边的文件集合一致、再发布清单"。建议顺序：镜像同步时先清掉允许目录里的过期文件 → 客户端下载集合与生成清单时的检出集合对齐（`.pyc`/`__pycache__` 从白名单排除）→ 最后才发布清单。否则会把"校验没生效"升级成"更新一律失败"。

## 9. 仍需确认的事（本轮未做）

### 9.1 老用户（已装在 Program Files）怎么办
#5 只让**新装**用户落到可写目录；老用户因 `InstallDirRegKey` 会沿用旧目录，问题不会自动消失。可选：
- (a) 只靠新文案引导手动重装 —— 零风险，本轮已完成；
- (b) 做 #4 提权（UAC）让原地更新可写 —— 中风险，会弹 UAC，需处理"用户取消"与回滚；
- (c) 检测到安装目录不可写时自动打开发布页下载 —— 低风险，最省事。

建议先 (c)，(b) 二期。

### 9.2 是否发布 `update-manifest.json`
必须先做 §8.3 的集合对齐，否则更新会全部中止。

### 9.3 Electron 版的"一键更新"入口
Electron 客户端里同时有 electron-updater（更新整个 app）与自研一键更新（只改 `resources\backend` 源码，运行时用的却是冻结的 `NOVAI.exe`）→ 点了可能"更新成功但版本没变"。建议 Electron 下隐藏/禁用自研入口并提示走内置自动更新（产品交互改动，等你定）。

### 9.4 发布侧清理（零代码）
ModelScope `electron-release/`：删掉旧命名 `NOVAI Setup 1.0.117.exe`；确认每版都有 `NOVAI-Electron-Setup-*`（1.0.120 缺，且 v1.0.120 的 GitHub Release 连 `latest.yml` 都没有）；Release 说明里区分"传统安装包"和"Electron 安装包"。
