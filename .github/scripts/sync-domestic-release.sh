#!/usr/bin/env bash
# NOVAI Electron 更新产物国内镜像同步（tag 构建时由 build-electron.yml 调用）
#
# 两个目标：
#   1) Gitee invaders/novai Release 附件 —— 人工下载镜像（先跑，快且稳）
#   2) ModelScope 工作室仓库 bllack/NOVAI —— 客户端自动更新的国内源
#      （Electron 端 GitHub 检查失败时自动切换到该 generic 更新地址：
#        https://modelscope.cn/studios/bllack/NOVAI/resolve/master/electron-release）
#      注：用户实际拥有的是 studio 仓（models 命名空间的 NOVAI-releases 并不存在），
#      因此产物推到 studio/bllack/NOVAI 的 electron-release/ 子目录，URL 也用 studios/。
#
# 所需环境变量：
#   GITEE_TOKEN       Gitee 私人令牌（缺失则跳过 Gitee 同步）
#   MODELSCOPE_TOKEN  ModelScope 访问令牌（缺失则跳过 ModelScope 同步）
#   RELEASE_TAG       当前构建的 tag（如 v1.0.112-beta.2）
#
# 健壮性：
#   - Gitee 先于 ModelScope 执行，保证即便 ModelScope 推送到国内很慢/挂起，
#     人工下载镜像也已就绪。
#   - git clone / git push 全部包一层带超时的 with_timeout（POSIX 兼容，
#     在 mac/linux/windows-bash 都能用），避免无超时导致整条流水线挂到 6 小时上限。
#   - ModelScope 克隆失败时改走「本地 init + push 自动建仓」，绕开 REST 建仓接口。
#   - 任何一步失败只 warning，不中断 job（对应 step 已 continue-on-error）。
#
# 注意：三个平台矩阵任务都会执行本脚本，各自只上传本平台产物；
#       ModelScope push 带 rebase 重试以容忍并发。

set -u
cd "${GITHUB_WORKSPACE:-$(pwd)}"

RELEASE_DIR="desktop/release"
MS_REPO="studio/bllack/NOVAI"
MS_BRANCH="master"
GITEE_OWNER="invaders"
GITEE_REPO="novai"

# 可移植超时包装：with_timeout <秒> <命令...>
# 用子 shell + 后台 killer 实现，macOS 无 GNU timeout 也能用。
with_timeout() {
  local t=$1; shift
  "$@" &
  local pid=$!
  local killer_pid
  ( sleep "$t"; kill -9 "$pid" 2>/dev/null ) &
  killer_pid=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill -9 "$killer_pid" 2>/dev/null
  return $rc
}

shopt -s nullglob
ARTIFACTS=("$RELEASE_DIR"/*.dmg "$RELEASE_DIR"/*.zip "$RELEASE_DIR"/*.exe \
           "$RELEASE_DIR"/*.AppImage "$RELEASE_DIR"/*.deb "$RELEASE_DIR"/*.blockmap)
YML_FILES=("$RELEASE_DIR"/latest*.yml)

if [ ${#ARTIFACTS[@]} -eq 0 ] && [ ${#YML_FILES[@]} -eq 0 ]; then
  echo "::warning::desktop/release 下没有找到任何产物，跳过国内镜像同步"
  exit 0
fi

# ------------------------------------------------------------------- Gitee
# 先跑：api 上传，快且稳定，作为人工下载镜像。
sync_gitee() {
  if [ -z "${GITEE_TOKEN:-}" ]; then
    echo "::warning::未配置 GITEE_TOKEN，跳过 Gitee Release 附件同步"
    return 0
  fi

  local api="https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}"
  local release_id

  echo "== Gitee: 创建/获取 Release ${RELEASE_TAG} =="
  # 用 python 稳妥解析顶层 id（旧版贪婪 sed 会误抓 JSON 末尾 author.id，
  # 导致附件上传静默 404 / 二进制缺失）。
  local body
  body=$(curl -sS --max-time 60 -X POST "${api}/releases" \
    -H "Content-Type: application/json" \
    -d "{\"access_token\":\"${GITEE_TOKEN}\",\"tag_name\":\"${RELEASE_TAG}\",\"name\":\"NOVAI ${RELEASE_TAG}\",\"body\":\"国内下载镜像（与 GitHub Release 相同内容）。\",\"target_commitish\":\"main\",\"prerelease\":true}")
  release_id=$(printf '%s' "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

  if [ -z "$release_id" ]; then
    release_id=$(curl -sS --max-time 60 "${api}/releases/tags/${RELEASE_TAG}?access_token=${GITEE_TOKEN}" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
  fi
  if [ -z "$release_id" ]; then
    echo "::warning::Gitee Release 创建/查询失败（tag 是否已推送到 gitee？），跳过附件上传"
    return 0
  fi

  local f name
  for f in "${ARTIFACTS[@]}" "${YML_FILES[@]}"; do
    [ -n "$f" ] || continue
    name=$(basename "$f")
    echo "== Gitee: 上传附件 $name =="
    # 单附件超时 300s；失败仅 warning（可能超 Gitee 单附件限制或网络抖动）
    curl -sS --max-time 300 -X POST "${api}/releases/${release_id}/attach_files" \
      -F "access_token=${GITEE_TOKEN}" \
      -F "file=@${GITHUB_WORKSPACE}/${f}" > /dev/null || \
      echo "::warning::附件 $name 上传失败（可能超过 Gitee 单附件 100MB 限制或超时）"
  done
  echo "== Gitee: 附件同步完成 =="
  return 0
}

# ---------------------------------------------------------------- ModelScope
# 后跑：git + lfs 推送，从 GitHub 境外服务器到国内可能很慢/偶发挂起，
# 全部用 with_timeout 限制，最坏情况被步骤级 timeout-minutes 兜底杀掉。
sync_modelscope() {
  if [ -z "${MODELSCOPE_TOKEN:-}" ]; then
    echo "::warning::未配置 MODELSCOPE_TOKEN，跳过 ModelScope 同步（国内自动更新镜像将不可用）"
    return 0
  fi

  local work=/tmp/novai-ms-releases
  rm -rf "$work"

  local auth_url="https://oauth2:${MODELSCOPE_TOKEN}@modelscope.cn/${MS_REPO}.git"
  if with_timeout 120 git clone --depth 1 "$auth_url" "$work" 2>/dev/null; then
    echo "== ModelScope: 克隆成功 =="
  else
    echo "== ModelScope: 克隆失败（仓库可能不存在或网络超时），改为本地 init 后推送（自动建仓）==="
    mkdir -p "$work"
    ( cd "$work" && git init -q && git remote add origin "$auth_url" 2>/dev/null ) || true
  fi

  ( cd "$work" || return 0
    git config user.email ci@novai.local 2>/dev/null
    git config user.name novai-ci 2>/dev/null
    git lfs install 2>/dev/null || true
    git checkout "$MS_BRANCH" 2>/dev/null || git checkout -B "$MS_BRANCH" 2>/dev/null || true

    git lfs track "electron-release/*.dmg" "electron-release/*.zip" "electron-release/*.exe" \
                  "electron-release/*.AppImage" "electron-release/*.deb" "electron-release/*.blockmap" 2>/dev/null

    mkdir -p electron-release
    local f
    for f in "${ARTIFACTS[@]}" "${YML_FILES[@]}"; do
      [ -n "$f" ] && cp -f "${GITHUB_WORKSPACE}/$f" electron-release/ 2>/dev/null
    done

    git add .gitattributes electron-release/ 2>/dev/null
    if git diff --cached --quiet; then
      echo "== ModelScope: 无变更 =="
      return 0
    fi
    git commit -q -m "electron-release ${RELEASE_TAG} ($(uname -s))" 2>/dev/null || {
      echo "::warning::ModelScope commit 失败"; return 0
    }

    local i
    for i in 1 2 3; do
      if with_timeout 600 git push origin "HEAD:${MS_BRANCH}"; then
        echo "== ModelScope: 推送成功 =="
        return 0
      fi
      echo "== ModelScope: 推送冲突/超时，rebase 重试 ($i/3) =="
      with_timeout 120 git fetch origin "$MS_BRANCH" 2>/dev/null && git rebase "origin/${MS_BRANCH}" 2>/dev/null || true
      sleep $((i * 5))
    done
  ) || true

  echo "::warning::ModelScope 推送未成功（可能网络超时或权限不足），跳过；GitHub 主源仍可用，Gitee 人工下载镜像已就绪"
  return 0
}

sync_gitee
sync_modelscope
echo "== 国内镜像同步步骤结束 =="
exit 0
