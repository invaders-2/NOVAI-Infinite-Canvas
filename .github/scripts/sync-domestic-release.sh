#!/usr/bin/env bash
# NOVAI 更新产物国内镜像同步（tag 构建时由 build-electron.yml 调用，也可由 sync-mirrors.yml 调用）
#
# 两个目标：
#   1) Gitee invaders/novai Release 附件 —— 人工下载镜像（小文件；安装包分卷见 sync-gitee-installers.sh）
#   2) ModelScope 模型仓库 bllack/NOVAI-releases —— 客户端自动更新的国内源
#      · electron-release/ 目录：electron-updater 的 generic feed
#        https://modelscope.cn/models/bllack/NOVAI-releases/resolve/master/electron-release
#      · 仓库根目录：Python 后端一键更新（main.py / VERSION / static/ 等，白名单见 main.py update_allowed_file）
#
# 失败可见（2026-11 起）：不再「只 warning 然后 exit 0」。
#   · 每个没传上去的文件都打 ::error:: 并写 ${GITHUB_STEP_SUMMARY}（含「影响哪一端用户」）；
#   · 推送完用 ModelScope 仓库文件 API 逐文件复核，缺文件 / 大小不符 / 版本没更新都算失败；
#   · 脚本以非 0 退出，由 workflow 决定怎么标红（Release 已发布，不会回滚）。
#
# 所需环境变量：
#   GITEE_TOKEN       Gitee 私人令牌
#   MODELSCOPE_TOKEN  ModelScope 访问令牌
#   RELEASE_TAG       当前构建的 tag（如 v2.0.06）
#   SYNC_GITEE=0      跳过 Gitee 附件（sync-mirrors 的 electron job 用，安装包由 gitee-installers 负责）
#
# 健壮性：
#   - Gitee 先于 ModelScope 执行，保证人工下载镜像先生效；
#   - git clone / push 用 with_timeout 限制，避免挂到 6 小时上限；
#   - ModelScope 克隆失败改走「本地 init + push 自动建仓」；
#   - 三平台矩阵并发推送时重新克隆最新 HEAD 再推，最多 3 次。

set -u
WORKSPACE="$(cd "${GITHUB_WORKSPACE:-$(pwd)}" && pwd)"
cd "$WORKSPACE"

RELEASE_DIR="desktop/release"
MS_REPO="models/bllack/NOVAI-releases"
MS_BRANCH="master"
MS_BROWSE="https://modelscope.cn/models/bllack/NOVAI-releases/resolve/master"
MS_TREE_URL="https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo/files?Revision=master&Recursive=true"
MS_FILE_API="https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo?Revision=master&FilePath="
GITEE_OWNER="invaders"
GITEE_REPO="novai"
GITEE_SMALL_LIMIT=$(( 95 * 1024 * 1024 ))

RELEASE_TAG="${RELEASE_TAG:-}"
FAILED=0
OK_ROWS=()
FAIL_ROWS=()
LOCAL_VERSION=""
LOCAL_VERSION_NORM=""

size_human() {
  awk -v b="${1:-0}" 'BEGIN {
    if (b >= 1073741824) printf "%.2f GB", b / 1073741824;
    else if (b >= 1048576) printf "%.1f MB", b / 1048576;
    else if (b >= 1024) printf "%.1f KB", b / 1024;
    else printf "%d B", b;
  }'
}

file_size() { wc -c < "$1" | tr -d ' '; }

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe="/"))' "$1"
}

normalize_version() {
  python3 -c '
import re, sys
value = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lstrip("vV")
match = re.match(r"^([0-9]+(?:[.][0-9]+)*)(.*)$", value)
if not match:
    print(value)
else:
    nums = [int(x) for x in match.group(1).split(".")]
    while len(nums) > 1 and nums[-1] == 0:
        nums.pop()
    print(".".join(str(x) for x in nums) + match.group(2).strip().lower())
' "$1"
}

impact_for() {
  case "$1" in
    VERSION) echo "国内一键更新检测不到新版本（Python 版 / 网页版 / 桌面端源码更新）" ;;
    static/update-notes.json) echo "国内网络下升级后的更新说明弹窗拿不到或显示旧内容" ;;
    main.py) echo "国内一键更新下载源码失败" ;;
    electron-release/latest.yml) echo "Windows 客户端国内自动更新检查失败" ;;
    electron-release/latest-mac.yml) echo "macOS 客户端国内自动更新检查失败" ;;
    electron-release/latest-linux.yml) echo "Linux 客户端国内自动更新检查失败" ;;
    electron-release/*.exe|electron-release/*.exe.blockmap) echo "Windows 客户端国内自动更新下载失败" ;;
    electron-release/*-mac.zip|electron-release/*-mac.zip.blockmap|electron-release/*.dmg|electron-release/*.dmg.blockmap) echo "macOS 客户端国内自动更新下载失败" ;;
    electron-release/*.AppImage|electron-release/*.deb) echo "Linux 客户端国内自动更新下载失败" ;;
    electron-release/*.blockmap) echo "对应平台增量下载退化为全量下载（仍可更新）" ;;
    Gitee*) echo "Gitee 网页人工下载（自动更新不受影响）" ;;
    *) echo "客户端更新链路" ;;
  esac
}

add_ok() { OK_ROWS+=("$1|$2|$3|$4"); echo "  [OK]   $1 $2 ($3)"; }
add_fail() {
  FAILED=1
  FAIL_ROWS+=("$1|$2|$3|$4")
  echo "::error::[$1] $2 未同步：$4（影响：$3）"
}

write_summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  local row t f s u i d
  {
    echo ""
    echo "### 国内镜像同步（${RELEASE_TAG:-unknown}，$(uname -s)）"
    echo ""
    if [ "$FAILED" != "0" ]; then
      echo "#### ❌ 镜像不完整（GitHub Release 已发布，不需要回滚；补传后再跑一次检查）"
      echo ""
      echo "| 目标 | 文件 | 影响 | 原因 |"
      echo "| --- | --- | --- | --- |"
      for row in "${FAIL_ROWS[@]:-}"; do
        [ -n "$row" ] || continue
        IFS='|' read -r t f i d <<EOF
$row
EOF
        echo "| $t | $f | $i | $d |"
      done
      echo ""
    else
      echo "#### ✅ 同步完成（$(date -u '+%Y-%m-%d %H:%M UTC')）"
      echo ""
    fi
    if [ "${#OK_ROWS[@]}" -gt 0 ]; then
      echo "| 目标 | 文件 | 大小 | 地址 |"
      echo "| --- | --- | --- | --- |"
      for row in "${OK_ROWS[@]}"; do
        [ -n "$row" ] || continue
        IFS='|' read -r t f s u <<EOF
$row
EOF
        echo "| $t | $f | $s | $u |"
      done
      echo ""
    fi
  } >> "$GITHUB_STEP_SUMMARY"
}

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

prerelease_for_tag() {
  case "$1" in
    *-*) printf 'true' ;;
    *)   printf 'false' ;;
  esac
}

gitee_fetch_release() {
  curl -sS --max-time 60 "${GITEE_API_BASE}/releases/tags/${RELEASE_TAG}?access_token=${GITEE_TOKEN}" -o "$1"
}

gitee_json_field() {
  python3 -c '
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    data = {}
field = sys.argv[2]
if field == "id":
    print(data.get("id") or "")
else:
    for asset in (data.get("assets") or []):
        print(asset.get("name") or "")
' "$1" "$2" 2>/dev/null || true
}

shopt -s nullglob
ARTIFACTS=("$RELEASE_DIR"/*.dmg "$RELEASE_DIR"/*.zip "$RELEASE_DIR"/*.exe \
           "$RELEASE_DIR"/*.AppImage "$RELEASE_DIR"/*.deb "$RELEASE_DIR"/*.blockmap)
YML_FILES=("$RELEASE_DIR"/latest*.yml)

if [ ${#ARTIFACTS[@]} -eq 0 ] && [ ${#YML_FILES[@]} -eq 0 ]; then
  add_fail "ModelScope" "desktop/release 全部产物" "所有客户端自动更新" "desktop/release 下没有任何产物（构建失败或下载失败）"
  write_summary
  exit 1
fi

# ------------------------------------------------------------------- Gitee
GITEE_API_BASE="https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}"
GITEE_JSON="$(mktemp)"
GITEE_RESP="$(mktemp)"
trap 'rm -f "$GITEE_JSON" "$GITEE_RESP"' EXIT

sync_gitee() {
  if [ -z "${GITEE_TOKEN:-}" ]; then
    add_fail "Gitee" "Release ${RELEASE_TAG}" "Gitee 网页人工下载" "没有配置 GITEE_TOKEN"
    return 1
  fi

  local release_id pre code f name size
  pre=$(prerelease_for_tag "${RELEASE_TAG:-}")
  echo "== Gitee: 创建/获取 Release ${RELEASE_TAG} =="
  gitee_fetch_release "$GITEE_JSON" || true
  release_id=$(gitee_json_field "$GITEE_JSON" id)

  if [ -z "${release_id:-}" ]; then
    curl -sS --max-time 60 -X POST "${GITEE_API_BASE}/releases" \
      -H "Content-Type: application/json" \
      -d "{\"access_token\":\"${GITEE_TOKEN}\",\"tag_name\":\"${RELEASE_TAG}\",\"name\":\"NOVAI ${RELEASE_TAG}\",\"body\":\"国内下载镜像（与 GitHub Release 相同内容）。\",\"target_commitish\":\"main\",\"prerelease\":${pre}}" \
      -o "$GITEE_JSON" || true
    release_id=$(gitee_json_field "$GITEE_JSON" id)
  fi
  if [ -z "${release_id:-}" ]; then
    add_fail "Gitee" "Release ${RELEASE_TAG}" "Gitee 网页人工下载" "创建/查询 Release 失败（tag 是否已推送到 Gitee？）"
    return 1
  fi
  echo "   Gitee release id = ${release_id}"

  curl -sS --max-time 60 -X PATCH "${GITEE_API_BASE}/releases/${release_id}" \
    -H "Content-Type: application/json" \
    -d "{\"access_token\":\"${GITEE_TOKEN}\",\"tag_name\":\"${RELEASE_TAG}\",\"name\":\"NOVAI ${RELEASE_TAG}\",\"prerelease\":${pre}}" > /dev/null \
    || echo "::warning::Gitee Release ${release_id} 预览标记更新失败（prerelease=${pre}）"

  local existing
  existing=$(gitee_json_field "$GITEE_JSON" assets)

  for f in "${YML_FILES[@]}" "${ARTIFACTS[@]}"; do
    [ -n "$f" ] || continue
    name=$(basename "$f")
    size=$(file_size "$f")
    if [ "$size" -gt "$GITEE_SMALL_LIMIT" ]; then
      echo "  [skip] $name ($(size_human "$size")) 超过 Gitee 单附件 95MB，交给 sync-gitee-installers.sh 分卷"
      continue
    fi
    if printf '%s\n' "$existing" | grep -qxF "$name"; then
      add_ok "Gitee" "$name" "$(size_human "$size")" "${GITEE_API_BASE}/releases/tags/${RELEASE_TAG}"
      continue
    fi
    echo "== Gitee: 上传附件 $name =="
    code=$(curl -sS --max-time 300 -X POST "${GITEE_API_BASE}/releases/${release_id}/attach_files" \
      -F "access_token=${GITEE_TOKEN}" -F "file=@$f" -o "$GITEE_RESP" -w '%{http_code}')
    if [ "$code" = "200" ] || [ "$code" = "201" ]; then
      add_ok "Gitee" "$name" "$(size_human "$size")" "${GITEE_API_BASE}/releases/tags/${RELEASE_TAG}"
      existing="${existing}
$name"
    else
      add_fail "Gitee" "$name" "Gitee 网页人工下载" "上传失败 http=$code $(head -c 160 "$GITEE_RESP")"
    fi
  done
  return 0
}

# ---------------------------------------------------------------- ModelScope
sync_modelscope() {
  if [ -z "${MODELSCOPE_TOKEN:-}" ]; then
    add_fail "ModelScope" "整个镜像" "所有客户端的国内自动更新" "没有配置 MODELSCOPE_TOKEN"
    return 1
  fi

  local missing=0 f
  for f in main.py VERSION static/update-notes.json; do
    if [ ! -s "./$f" ]; then
      add_fail "ModelScope" "$f" "$(impact_for "$f")" "工作区缺少该文件，无法上传"
      missing=1
    fi
  done
  if [ "$missing" != "0" ]; then
    return 1
  fi

  local auth_url="https://oauth2:${MODELSCOPE_TOKEN}@www.modelscope.cn/${MS_REPO}.git"
  local attempt rc
  for attempt in 1 2 3; do
    local work="/tmp/novai-ms-releases-${attempt}"
    rm -rf "$work"
    if GIT_LFS_SKIP_SMUDGE=1 with_timeout 180 git clone --depth 1 "$auth_url" "$work" 2>/dev/null; then
      echo "== ModelScope: 克隆成功（第 $attempt 次）=="
    else
      echo "== ModelScope: 克隆失败（仓库可能不存在或网络超时），改为本地 init 后推送（自动建仓）=="
      mkdir -p "$work"
      ( cd "$work" && git init -q && git remote add origin "$auth_url" 2>/dev/null ) || true
    fi

    (
      cd "$work" || exit 1
      git config user.email ci@novai.local 2>/dev/null
      git config user.name novai-ci 2>/dev/null
      git lfs install 2>/dev/null || true
      git checkout "$MS_BRANCH" 2>/dev/null || git checkout -B "$MS_BRANCH" 2>/dev/null || true

      git lfs track "electron-release/*.dmg" "electron-release/*.zip" "electron-release/*.exe" \
                    "electron-release/*.AppImage" "electron-release/*.deb" "electron-release/*.blockmap" 2>/dev/null

      mkdir -p electron-release
      local f name
      for f in "${ARTIFACTS[@]}" "${YML_FILES[@]}"; do
        [ -n "$f" ] || continue
        name=$(basename "$f")
        if ! cp -f "${WORKSPACE}/$f" "electron-release/$name"; then
          echo "::error::复制更新产物 $name 到 ModelScope 工作目录失败"
          exit 1
        fi
      done

      # 一键更新允许的源码（清单与 main.py 的 update_allowed_file 一致），推到仓库根目录
      local s src
      for s in main.py VERSION update-manifest.json prompt_intelligence.py 安装即梦CLI.bat 安装即梦CLI.command 登录即梦CLI.bat 登录即梦CLI.command launcher.py novai-desktop.py app.py build.py build-all.py build-desktop.py build-mac.py installer.py; do
        src="${WORKSPACE}/$s"
        if [ -f "$src" ]; then
          cp -f "$src" "./$s" || { echo "::error::复制源码文件 $s 失败"; exit 1; }
        elif [ "$s" = "main.py" ] || [ "$s" = "VERSION" ]; then
          echo "::error::源码文件 $s 缺失"
          exit 1
        else
          echo "::warning::可选源码文件 $s 缺失，跳过"
        fi
      done
      for s in static server tools assets/models; do
        src="${WORKSPACE}/$s"
        if [ -d "$src" ]; then
          mkdir -p "./$s" 2>/dev/null || true
          cp -R "$src/." "./$s/" 2>/dev/null || { echo "::error::复制源码目录 $s 失败"; exit 1; }
        else
          echo "::warning::源码目录 $s 缺失，跳过"
        fi
      done
      echo "== ModelScope: 允许更新的源码已同步到仓库根目录 =="

      git add -A 2>/dev/null
      if git diff --cached --quiet; then
        echo "== ModelScope: 无变更 =="
        exit 0
      fi
      git commit -q -m "electron-release ${RELEASE_TAG} ($(uname -s))" 2>/dev/null || { echo "::error::ModelScope commit 失败"; exit 1; }
      with_timeout 600 git push origin "HEAD:${MS_BRANCH}" || exit 1
      echo "== ModelScope: 推送成功 =="
      exit 0
    )
    rc=$?

    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    echo "== ModelScope: 第 $attempt 次推送失败，重新克隆后重试 =="
    sleep $((attempt * 10))
  done

  add_fail "ModelScope" "整个镜像" "所有客户端的国内自动更新" "推送 3 次都失败（网络超时或权限不足）"
  return 1
}

fetch_ms_list() {
  curl -sS --max-time 120 "$MS_TREE_URL" -o "$1" || return 1
  python3 -c '
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(2)
files = ((payload.get("Data") or {}).get("Files")) or []
with open(sys.argv[2], "w", encoding="utf-8") as out:
    for entry in files:
        if not isinstance(entry, dict) or entry.get("Type") != "blob":
            continue
        out.write("%s\t%s\n" % (str(entry.get("Path") or "").replace("\\", "/"), entry.get("Size") or 0))
' "$1" "$1.tsv"
}

ms_required_paths() {
  local f
  echo "main.py"
  echo "VERSION"
  echo "static/update-notes.json"
  for f in "${YML_FILES[@]}"; do
    [ -n "$f" ] && echo "electron-release/$(basename "$f")"
  done
  for f in "${ARTIFACTS[@]}"; do
    [ -n "$f" ] && echo "electron-release/$(basename "$f")"
  done
}

ms_list_has() {
  awk -F '\t' -v p="$1" '$1 == p { found = 1 } END { exit(found ? 0 : 1) }' "$2"
}

verify_remote_version_file() {
  local rel="$1" expect="$2" kind="$3"
  local body remote_version
  body="$(mktemp)"
  if ! curl -sS --max-time 90 "${MS_FILE_API}$(urlencode "$rel")" -o "$body"; then
    add_fail "ModelScope" "$rel" "$(impact_for "$rel")" "读取文件内容失败，无法确认版本"
    rm -f "$body"
    return 1
  fi
  case "$kind" in
    raw)
      remote_version=$(tr -d '[:space:]' < "$body" 2>/dev/null || true)
      ;;
    json)
      remote_version=$(python3 -c '
import json, sys
try:
    print(str((json.load(open(sys.argv[1], encoding="utf-8", errors="replace")) or {}).get("version") or ""))
except Exception:
    print("")
' "$body" 2>/dev/null || true)
      ;;
    *)
      remote_version=$(python3 -c '
import re, sys
try:
    text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
except Exception:
    text = ""
match = re.search(r"(?m)^version:[ \t]*(.+)$", text)
print(match.group(1).strip().strip("\x27\x22") if match else "")
' "$body" 2>/dev/null || true)
      ;;
  esac
  rm -f "$body"
  if [ -z "${remote_version:-}" ]; then
    add_fail "ModelScope" "$rel" "$(impact_for "$rel")" "镜像文件内容为空或格式异常"
    return 1
  fi
  if [ "$(normalize_version "$remote_version")" != "$expect" ]; then
    add_fail "ModelScope" "$rel" "$(impact_for "$rel")" "版本没更新：镜像=${remote_version}，本地=$LOCAL_VERSION"
    return 1
  fi
  echo "  [OK]   ModelScope $rel 版本 $remote_version 与 VERSION 一致"
  return 0
}

verify_modelscope() {
  local list_file="$(mktemp)" rel size remote_size attempt
  LOCAL_VERSION=$(tr -d '[:space:]' < "VERSION" 2>/dev/null || true)
  LOCAL_VERSION_NORM=$(normalize_version "$LOCAL_VERSION")

  attempt=0
  while [ "$attempt" -lt 4 ]; do
    attempt=$((attempt + 1))
    if ! fetch_ms_list "$list_file"; then
      echo "::warning::ModelScope 仓库文件列表读取失败（第 $attempt 次）"
      sleep 5
      continue
    fi
    local wait_more=0
    while IFS= read -r rel; do
      if ! ms_list_has "$rel" "$list_file.tsv"; then
        wait_more=1
      fi
    done < <(ms_required_paths)
    if [ "$wait_more" = "0" ]; then
      break
    fi
    echo "== ModelScope: 文件列表里还缺文件（第 $attempt 次），5s 后重查 =="
    sleep 5
  done

  while IFS= read -r rel; do
    case "$rel" in
      electron-release/*) size=$(file_size "${RELEASE_DIR}/$(basename "$rel")" 2>/dev/null || echo 0) ;;
      *) size=$(file_size "$rel" 2>/dev/null || echo 0) ;;
    esac
    remote_size=$(awk -F '\t' -v p="$rel" '$1 == p { print $2; exit }' "$list_file.tsv" 2>/dev/null || true)
    if [ -z "${remote_size:-}" ]; then
      add_fail "ModelScope" "$rel" "$(impact_for "$rel")" "推送后仓库里找不到该文件"
      continue
    fi
    if [ "${size:-0}" != "0" ] && [ "${remote_size:-0}" != "0" ] && [ "$size" != "$remote_size" ]; then
      add_fail "ModelScope" "$rel" "$(impact_for "$rel")" "大小不符：本地 $(size_human "$size") / 镜像 $(size_human "$remote_size")"
      continue
    fi
    add_ok "ModelScope" "$rel" "$(size_human "${remote_size:-0}")" "$MS_BROWSE/$rel"
  done < <(ms_required_paths)

  verify_remote_version_file "VERSION" "$LOCAL_VERSION_NORM" raw || true
  verify_remote_version_file "static/update-notes.json" "$LOCAL_VERSION_NORM" json || true
  local f
  for f in "${YML_FILES[@]}"; do
    [ -n "$f" ] || continue
    verify_remote_version_file "electron-release/$(basename "$f")" "$LOCAL_VERSION_NORM" yml || true
  done

  rm -f "$list_file" "$list_file.tsv"
  return 0
}

if [ "${SYNC_GITEE:-1}" = "1" ]; then sync_gitee; else echo "== 跳过 Gitee 附件同步（SYNC_GITEE=0，安装包由 sync-gitee-installers.sh 分卷同步）=="; fi
sync_modelscope || true
verify_modelscope || true
write_summary

echo "== 国内镜像同步步骤结束（FAILED=${FAILED}）=="
exit "$FAILED"
