#!/usr/bin/env bash
# 把 GitHub Release 里的安装包补到 Gitee Release（Gitee 免费版单附件 100MB，按 .partNN 分卷）。
#
# 背景（2026-11 审计）：这条脚本过去跑在 build-electron 的 ubuntu 任务里，而 NOVAI-Setup-*
# 是 build-win / build-mac 两个独立 workflow 晚几分钟才传上去的，于是这里永远「没找到安装包」，
# 打一行 warning 就 exit 0 —— Gitee 上只剩 latest*.yml 和源码包，没有任何安装包。
# 现在改成：
#   · 用 --wait-for-assets <秒> 等 Release 里出现安装包资产，超时才报错；
#   · 上传失败不再静默：看 HTTP 状态码、逐卷复核、写 ${GITHUB_STEP_SUMMARY}，并以非 0 退出；
#   · 同时补传 latest*.yml 与 *.blockmap（人工下载镜像和人工核对用）。
#
# 用法：
#   sync-gitee-installers.sh <tag> [--wait-for-assets 1800]
# 需要环境变量：GITHUB_TOKEN（读 Release 资产）/ GITEE_TOKEN（写 Gitee Release）

set -u

TAG=""
WAIT_SECONDS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wait-for-assets) WAIT_SECONDS="${2:-0}"; shift 2 ;;
    --wait-for-assets=*) WAIT_SECONDS="${1#*=}"; shift ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) TAG="$1"; shift ;;
  esac
done

REPO="${GITHUB_REPOSITORY:-invaders-2/NOVAI-Infinite-Canvas}"
GITEE_OWNER="invaders"
GITEE_REPO="novai"
GITEE_OWNER_REPO="${GITEE_OWNER}/${GITEE_REPO}"
LIMIT=$(( 95 * 1024 * 1024 ))
WORK="$(mktemp -d)"
FAILED=0
OK_ROWS=()
FAIL_ROWS=()
UPLOADED_NAMES=()
trap 'rm -rf "$WORK"' EXIT

size_human() {
  awk -v b="${1:-0}" 'BEGIN {
    if (b >= 1073741824) printf "%.2f GB", b / 1073741824;
    else if (b >= 1048576) printf "%.1f MB", b / 1048576;
    else if (b >= 1024) printf "%.1f KB", b / 1024;
    else printf "%d B", b;
  }'
}

file_size() { wc -c < "$1" | tr -d ' '; }

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
    echo "### Gitee 安装包分卷同步（${TAG:-unknown}）"
    echo ""
    if [ "$FAILED" != "0" ]; then
      echo "#### ❌ Gitee 人工下载镜像不完整"
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
      echo "#### ✅ 分卷同步完成（$(date -u '+%Y-%m-%d %H:%M UTC')）"
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

prerelease_for_tag() {
  case "$1" in
    *-*) printf 'true' ;;
    *)   printf 'false' ;;
  esac
}

if [ -z "$TAG" ]; then
  add_fail "Gitee" "安装包分卷" "Gitee 网页人工下载" "没有传 tag（用法：sync-gitee-installers.sh <tag>）"
  write_summary
  exit 1
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
  add_fail "Gitee" "安装包分卷" "Gitee 网页人工下载" "没有配置 GITHUB_TOKEN"
  write_summary
  exit 1
fi
if [ -z "${GITEE_TOKEN:-}" ]; then
  add_fail "Gitee" "安装包分卷" "Gitee 网页人工下载" "没有配置 GITEE_TOKEN"
  write_summary
  exit 1
fi

echo "== 目标 tag: ${TAG}  仓库: ${REPO}  等待安装包: ${WAIT_SECONDS}s"

# ---- 1. 等 Release 里出现安装包资产（build-win / build-mac 与本 workflow 并行，天然会晚）
release_json="$WORK/release.json"
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  code=$(curl -sS --max-time 60 -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" -o "$release_json" -w '%{http_code}' || echo 000)
  if [ "$code" != "200" ]; then
    echo "   读取 Release 失败 http=${code}，稍后重试"
  else
    python3 - "$release_json" "$WORK/installers.tsv" "$WORK/small.tsv" <<'PY'
import json, sys
release_path, installers_path, small_path = sys.argv[1], sys.argv[2], sys.argv[3]
release = json.load(open(release_path, encoding="utf-8"))
installers, small = [], []
for asset in sorted(release.get("assets") or [], key=lambda item: item.get("name") or ""):
    name = str(asset.get("name") or "")
    if not name:
        continue
    if name.endswith((".exe", ".dmg")) and (name.startswith("NOVAI-Setup-") or name.startswith("NOVAI-Electron-Setup-")):
        installers.append(asset)
    elif name.startswith("latest") and name.endswith(".yml"):
        small.append(asset)
    elif name.endswith(".blockmap"):
        small.append(asset)
with open(installers_path, "w", encoding="utf-8") as out:
    for asset in installers:
        out.write("%s\t%s\t%s\n" % (asset.get("name"), asset.get("id"), asset.get("size") or 0))
with open(small_path, "w", encoding="utf-8") as out:
    for asset in small:
        out.write("%s\t%s\t%s\n" % (asset.get("name"), asset.get("id"), asset.get("size") or 0))
print("   安装包 %d 个，小文件 %d 个" % (len(installers), len(small)))
PY
    if [ -s "$WORK/installers.tsv" ]; then
      break
    fi
  fi
  remaining=$(( deadline - $(date +%s) ))
  if [ "$remaining" -le 0 ]; then
    add_fail "Gitee" "安装包分卷" "Gitee 网页人工下载" "等了 ${WAIT_SECONDS}s，Release 里仍没有 NOVAI-Setup-* / NOVAI-Electron-Setup-* 安装包（build-win / build-mac 是否失败？）"
    write_summary
    exit 1
  fi
  echo "   Release 里还没有安装包，${remaining}s 内继续等"
  if [ "$remaining" -gt 20 ]; then
    sleep 20
  else
    sleep "$remaining"
  fi
done

# ---- 2. Gitee Release：取 id，没有就建
API="https://gitee.com/api/v5/repos/${GITEE_OWNER_REPO}"
RID=""
gitee_json="$WORK/gitee.json"
if curl -sS --max-time 60 "${API}/releases/tags/${TAG}?access_token=${GITEE_TOKEN}" -o "$gitee_json"; then
  RID=$(python3 -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data = {}
print((data or {}).get("id") or "")
' "$gitee_json" 2>/dev/null || true)
fi
pre=$(prerelease_for_tag "$TAG")
if [ -z "${RID:-}" ]; then
  echo "   Gitee 上没有 ${TAG} 的 Release，新建一个"
  RID=$(curl -sS --max-time 60 -X POST "${API}/releases" \
    -d "access_token=${GITEE_TOKEN}" -d "tag_name=${TAG}" -d "name=NOVAI ${TAG}" \
    -d "target_commitish=main" -d "prerelease=${pre}" \
    -d "body=国内下载镜像（与 GitHub Release 相同内容）。安装包超过 Gitee 单附件 100MB 限制，已按 .part00/.part01 分卷，下载后合并即可。" \
    | python3 -c '
import json, sys
try:
    print((json.load(sys.stdin) or {}).get("id") or "")
except Exception:
    print("")
' 2>/dev/null || true)
fi
if [ -z "${RID:-}" ]; then
  add_fail "Gitee" "Release ${TAG}" "Gitee 网页人工下载" "拿不到 Gitee Release id（tag 是否已推到 Gitee？）"
  write_summary
  exit 1
fi
echo "   Gitee release id = ${RID}"

curl -sS --max-time 60 -X PATCH "${API}/releases/${RID}" \
  -d "access_token=${GITEE_TOKEN}" -d "tag_name=${TAG}" -d "name=NOVAI ${TAG}" \
  -d "prerelease=${pre}" > /dev/null \
  || echo "::warning::Gitee Release ${RID} 预览标记更新失败（prerelease=${pre}）"

existing_names() {
  curl -sS --max-time 60 "${API}/releases/${RID}?access_token=${GITEE_TOKEN}" -o "$WORK/gitee-current.json" || return 1
  python3 -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data = {}
for asset in ((data or {}).get("assets") or []):
    print(asset.get("name") or "")
' "$WORK/gitee-current.json"
}
existing_names > "$WORK/existing.txt" 2>/dev/null || true

upload_file() {
  local path="$1" name="$2" size="$3" code
  echo "   上传 ${name}（$(size_human "$size")）"
  code=$(curl -sS --max-time 2400 -X POST "${API}/releases/${RID}/attach_files" \
    -F "access_token=${GITEE_TOKEN}" -F "file=@${path}" \
    -o "$WORK/up.json" -w '%{http_code}')
  if [ "$code" = "200" ] || [ "$code" = "201" ]; then
    add_ok "Gitee" "${name}" "$(size_human "$size")" "${API}/releases/tags/${TAG}"
    echo "${name}" >> "$WORK/existing.txt"
    UPLOADED_NAMES+=("${name}")
    return 0
  fi
  add_fail "Gitee" "${name}" "Gitee 网页人工下载" "上传失败 http=$code $(head -c 200 "$WORK/up.json")"
  return 1
}

# ---- 3. 安装包：下载 → 分卷 → 上传（已传过的卷跳过，脚本可重复执行）
while IFS=$'\t' read -r name aid size; do
  [ -n "${name:-}" ] || continue
  if [ -z "${aid:-}" ]; then
    add_fail "Gitee" "$name" "Gitee 网页人工下载" "Release 资产没有 id"
    continue
  fi
  echo "== ${name}（$(size_human "${size:-0}")）"
  asset_file="$WORK/${name}"
  curl -sSL --max-time 900 -H "Authorization: token ${GITHUB_TOKEN}" \
       -H "Accept: application/octet-stream" \
       "https://api.github.com/repos/${REPO}/releases/assets/${aid}" -o "$asset_file"
  got=$(file_size "$asset_file")
  if [ "$got" != "${size}" ]; then
    add_fail "Gitee" "$name" "Gitee 网页人工下载" "从 GitHub 下载不完整 ${got}/${size}"
    continue
  fi

  rm -rf "$WORK/parts"; mkdir -p "$WORK/parts"
  if [ "${size}" -le "$LIMIT" ]; then
    cp "$asset_file" "$WORK/parts/${name}"
  else
    parts=$(( (size + LIMIT - 1) / LIMIT ))
    split -n "$parts" -d -a 2 "$asset_file" "$WORK/parts/${name}.part"
    echo "   分成 ${parts} 卷（单卷上限 $(size_human "$LIMIT")）"
  fi

  for part in "$WORK/parts"/*; do
    [ -e "$part" ] || continue
    part_name=$(basename "$part")
    part_size=$(file_size "$part")
    if grep -qxF "$part_name" "$WORK/existing.txt" 2>/dev/null; then
      add_ok "Gitee" "$part_name" "$(size_human "$part_size")" "${API}/releases/tags/${TAG}"
      UPLOADED_NAMES+=("$part_name")
      continue
    fi
    upload_file "$part" "$part_name" "$part_size" || true
  done
done < "$WORK/installers.tsv"

# ---- 4. 小文件（latest*.yml / *.blockmap）补传，人工下载镜像也完整
while IFS=$'\t' read -r name aid size; do
  [ -n "${name:-}" ] || continue
  if [ -z "${aid:-}" ]; then
    continue
  fi
  if grep -qxF "$name" "$WORK/existing.txt" 2>/dev/null; then
    add_ok "Gitee" "$name" "$(size_human "${size:-0}")" "${API}/releases/tags/${TAG}"
    UPLOADED_NAMES+=("$name")
    continue
  fi
  small_file="$WORK/${name}"
  curl -sSL --max-time 300 -H "Authorization: token ${GITHUB_TOKEN}" \
       -H "Accept: application/octet-stream" \
       "https://api.github.com/repos/${REPO}/releases/assets/${aid}" -o "$small_file"
  got=$(file_size "$small_file")
  if [ "$got" != "${size}" ]; then
    add_fail "Gitee" "$name" "Gitee 网页人工下载" "从 GitHub 下载不完整 ${got}/${size}"
    continue
  fi
  upload_file "$small_file" "$name" "$got" || true
done < "$WORK/small.tsv"

# ---- 5. 复核：这次认为「已同步」的每个名字，必须真的出现在 Gitee 附件列表里
final_names="$WORK/final.txt"
existing_names > "$final_names" 2>/dev/null || true
for name in "${UPLOADED_NAMES[@]:-}"; do
  [ -n "$name" ] || continue
  if ! grep -qxF "$name" "$final_names" 2>/dev/null; then
    add_fail "Gitee" "$name" "Gitee 网页人工下载" "上传后复核：Gitee 附件里没有该文件"
  fi
done

write_summary
echo "== Gitee 安装包同步结束（FAILED=${FAILED}）=="
exit "$FAILED"
