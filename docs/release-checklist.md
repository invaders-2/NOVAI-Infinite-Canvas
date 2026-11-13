# 发版检查清单（桌面端 / 国内镜像）

> 适用范围：推 `v*` tag 发版（build-electron + build-win + build-mac 三条流水线）。
> 目标：客户端（Electron 自动更新 + Python 一键更新）真正会拉的每个文件都在，
> 缺了要当场看见，而不是等用户装不上才发现。
>
> 2026-11 审计时的真实状态（修完这轮之后请以检查脚本结果为准）：
> - ModelScope 最新只到 **2.0.05**：2.0.06 的 VERSION / update-notes / electron-release 全部没同步（推送失败被吞了）；
> - ModelScope 上 `latest.yml` 指向 `NOVAI-Electron-Setup-2.0.5.exe`，但这个 exe **404**（清单和文件对不上）；
> - Gitee 的 v2.0.06 / v2.0.05 Release 里只有 `latest*.yml` 和源码包，**没有任何安装包/分卷**；
> - Gitee 仓库 `invaders/novai` 的 main 分支只有 README + `static/images`，**没有 VERSION / update-notes / 源码**，
>   所以客户端「Gitee 源码更新源」实际不可用（GitHub / ModelScope 正常时会自动跳过它）。

## 0. 先搞清楚：客户端到底会拉什么

| 客户端请求 | 文件 / 地址 | 现在谁负责上传 | 少了的后果 |
| --- | --- | --- | --- |
| Python 后端一键更新查版本 | `VERSION`（GitHub raw main / Gitee raw main / ModelScope 根目录） | GitHub：git push main；Gitee：**实测未同步**（main 只有 README + 图片）；**ModelScope：build-electron 的 sync-domestic-release.sh** | 国内用户检测不到新版本 |
| 更新说明弹窗 | `static/update-notes.json`（三源同上） | 同上（ModelScope 由 sync-domestic-release.sh 复制 `static/`；代码实际只轮询 GitHub / ModelScope 两个源） | 升级后说明弹窗空/旧 |
| Python 一键更新下载源码 | 白名单文件（`main.py`、`static/**`、`server/**`、`tools/**` 等） | ModelScope：sync-domestic-release.sh；GitHub/Gitee：仓库 main 分支 | 一键更新失败 |
| Electron 检查更新（Windows） | `electron-release/latest.yml` → `NOVAI-Electron-Setup-<版本>.exe`（+ `.blockmap`） | ModelScope：sync-domestic-release.sh | Windows 国内自动更新直接不可用 |
| Electron 检查更新（macOS） | `electron-release/latest-mac.yml`（客户端还会直接请求它）→ `NOVAI-<版本>-arm64-mac.zip` / `.dmg`（+ `.blockmap`） | 同上 | macOS 国内自动更新不可用 |
| Electron 检查更新（Linux） | `electron-release/latest-linux.yml` → `NOVAI-<版本>.AppImage` / `novai-desktop_<版本>_amd64.deb` | 同上 | Linux 国内自动更新不可用 |
| 人工下载安装包 | Gitee Release 附件：`NOVAI-Setup-*.exe/.dmg`、`NOVAI-Electron-Setup-*.exe`（>95MB 分卷 `.partNN`） | **sync-mirrors 的 gitee-installers**（build-electron 里那一步只负责等 + 补小文件） | 国内网页下载没有安装包 |

要点：
- **Windows 的更新源顺序是「镜像优先、GitHub 兜底」**（`desktop/main.js` 的 `updateFeedOrder`）；macOS / Linux 是 GitHub 优先、镜像兜底。所以 ModelScope 坏掉时 Windows 用户最先受影响。
- tag 是 `v2.0.06`，Electron 清单里是 `2.0.6`（去前导零），检查脚本会按数字比较，不要手改。
- `blockmap` 缺失不会让更新失败，只是增量下载退化为全量下载（流量/耗时变大）。

## 1. 发版后逐项勾选

- [ ] **三个 tag 构建都是绿的**
      Actions 里确认 `build-electron`、`build-win`、`build-mac`（tag 触发）全部 success。
      任何一个红：先修构建，不要继续下面的镜像步骤。
- [ ] **main 分支已 push，VERSION / static/update-notes.json 与 tag 一致**
      GitHub raw 与 Gitee raw 的 `VERSION` / `static/update-notes.json` 读的都是各自仓库的 **main 分支**
      （见 `main.py` 397-405），不是 Release 资产；Gitee 仓库若走镜像同步，确认它已经跟上。
      ```bash
      curl -sS https://raw.githubusercontent.com/invaders-2/NOVAI-Infinite-Canvas/main/VERSION
      curl -sS https://gitee.com/invaders/novai/raw/main/VERSION
      ```
- [ ] **GitHub Release 资产齐全（13 个左右）**
      ```bash
      gh release view v2.0.06 --json assets --jq '.assets[].name' | sort
      ```
      至少要看到：`latest.yml`、`latest-mac.yml`、`latest-linux.yml`、
      `NOVAI-Electron-Setup-2.0.6.exe` + `.blockmap`、
      `NOVAI-2.0.6-arm64-mac.zip` + `.blockmap`、`NOVAI-2.0.6-arm64.dmg` + `.blockmap`、
      `NOVAI-2.0.6.AppImage`、`novai-desktop_2.0.6_amd64.deb`、
      `NOVAI-Setup-2.0.06.exe`、`NOVAI-Setup-2.0.06.dmg`。
- [ ] **ModelScope 有 latest*.yml / VERSION / update-notes，且版本是本次 tag**
      ```bash
      curl -sS 'https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo?Revision=master&FilePath=VERSION'
      curl -sS 'https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo?Revision=master&FilePath=static/update-notes.json' | head -5
      curl -sS 'https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo?Revision=master&FilePath=electron-release/latest.yml'
      curl -sS 'https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo?Revision=master&FilePath=electron-release/latest-mac.yml'
      curl -sS 'https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo?Revision=master&FilePath=electron-release/latest-linux.yml'
      ```
      `VERSION` 必须是当前版本，三个 `latest*.yml` 的 `version:` 也必须是当前版本；
      `latest.yml` 里 `files[0].url` 指向的 exe 必须在镜像里真的能下载。
- [ ] **Gitee 安装包分卷齐全**（build-win / build-mac 完成后才能齐）
      打不开 Actions 时可以直接看：
      `https://gitee.com/api/v5/repos/invaders/novai/releases/tags/v2.0.06`
      每个超过 95MB 的安装包要有 `<名字>.part00`、`.part01`…（卷数 = 向上取整(大小/95MB)）。
- [ ] **跑一次完整性检查（本地或 CI 都能跑）**
      ```bash
      GH_TOKEN=... MODELSCOPE_TOKEN=... python3 tools/check_release_completeness.py v2.0.06
      ```
      退出码 0 才算过；退出码 1 会列出「缺哪个文件 + 影响哪一端用户」。
      没 token 也能跑（只做匿名只读检查，GitHub API 限流 60 次/小时）。
- [ ] **真机装旧版验证能收到更新**
      在 Windows 真机装上一版（例如 2.0.5），正常启动 → 设置/关于里点检查更新（或等后台自动检查）→
      应该能发现 2.0.6 并后台下载；下载完只弹右下角卡片，不弹「是否下载」对话框。
      macOS 同理（镜像 `latest-mac.yml` 优先被读）；Linux 可只验证 GitHub 源。

## 2. 检查不过怎么办

| 缺什么 | 怎么补 |
| --- | --- |
| ModelScope 缺文件 / 版本没更新 | Actions → `sync-mirrors` → Run workflow，填 tag（`wait_minutes` 默认 30，等 build-win/build-mac 上传安装包）。它只读 Release、重新推 ModelScope。 |
| Gitee 缺安装包 / 分卷 | 同上，`sync-mirrors` 的 gitee-installers job 负责；脚本可重复执行，已传过的卷会跳过。 |
| GitHub Release 本身缺资产 | 重跑对应的构建 workflow（`build-electron` / `build-win` / `build-mac`）；`build-electron` 支持 `release_tag` 参数重打单平台。 |
| GitHub / Gitee raw 的 VERSION、update-notes 还是旧版 | 把 VERSION 与 `static/update-notes.json` 的提交 push 到 GitHub main；Gitee 仓库按它的同步方式跟上（这两个源走 main 分支，不归镜像脚本管）。 |
| Release 已发出但镜像坏了 | **不要撤销 Release**（用户主源是 GitHub）。修镜像即可；客户端会自动回退到 GitHub 源。 |

补传后再跑一遍 `tools/check_release_completeness.py <tag>`，退出码 0 再收尾。

## 3. 失败可见性（这次改了什么）

- `sync-domestic-release.sh` / `sync-gitee-installers.sh` 失败时**不再 exit 0**：打 `::error::`、
  写 `GITHUB_STEP_SUMMARY`（缺文件表 + 影响端）、以非 0 退出。
- `build-electron` 的两个镜像步骤保留 `continue-on-error`（Release 已发布就算成功、不回滚），
  所以失败时是**步骤红叉 + summary 红字**，后面的 `mirror-gate` 再跑一次只读校验兜总账：
  - `workflow_dispatch` 触发：镜像不完整 → **整个运行判失败**（补传入口必须看到红）；
  - tag push 触发：镜像不完整 → 只标红 check 步骤 + summary，运行整体保持成功。
- `sync-mirrors` 是补传入口：两个同步 job 失败会标红，最后的 `mirror-verify` 不完整就让整条流水线失败。
- ModelScope 推送后用仓库文件 API **逐文件复核**（存在性、大小、VERSION/清单版本），
  所以「清单说 2.0.6、exe 却是 404」这种问题会当场报出来。

## 4. 相关代码位置

- 客户端请求地址：`main.py` 396-413（三源 VERSION / 更新说明 / 文件树）、`desktop/main.js` 3287-3290（镜像 feed）
- 镜像同步：`.github/scripts/sync-domestic-release.sh`、`.github/scripts/sync-gitee-installers.sh`
- 流水线：`.github/workflows/build-electron.yml`、`.github/workflows/sync-mirrors.yml`
- 校验工具：`tools/check_release_completeness.py`
