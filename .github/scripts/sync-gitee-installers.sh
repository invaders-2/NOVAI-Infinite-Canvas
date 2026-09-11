#!/usr/bin/env bash
# 把 GitHub Release 里的 NOVAI-Setup 安装包同步到 Gitee Release。
#
# 背景：Gitee 免费版单附件限制 100MB，而安装包已经超过 100MB（1.0.115：dmg 113.5MB /
# exe 101.9MB），原来 CI 里的同步步骤会静默失败——Gitee Release 建出来了，但里面只有
# 几十 KB 的 yml/blockmap，没有安装包。这里补上「分卷 + 上传」，命名沿用 README 里
# 给用户的 .part00/.part01 方案。
#
# 用法：sync-gitee-installers.sh <tag>   需要 GITHUB_TOKEN / GITEE_TOKEN

TAG="$1"
REPO="$GITHUB_REPOSITORY"
if [ -z "$REPO" ]; then REPO="invaders-2/NOVAI-Infinite-Canvas"; fi
GITEE_OWNER="invaders"
GITEE_REPO="novai"
LIMIT=$(( 95 * 1024 * 1024 ))
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -z "$TAG" ]; then echo "::warning::没有传 tag"; exit 0; fi
if [ -z "$GITEE_TOKEN" ]; then echo "::warning::没有 GITEE_TOKEN，跳过"; exit 0; fi

echo "== 目标 tag: $TAG  仓库: $REPO"

# ---- 1. 取该 tag 的 Release 资产清单
curl -sS --max-time 60 -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/releases/tags/$TAG" -o "$WORK/release.json"
python3 - "$WORK/release.json" "$WORK/list.txt" <<'PY'
import json, sys
rel = json.load(open(sys.argv[1]))
assets = [a for a in rel.get("assets", [])
          if a["name"].startswith("NOVAI-Setup-") and a["name"].endswith((".exe", ".dmg"))]
with open(sys.argv[2], "w") as f:
    for a in assets:
        f.write("%s\t%s\t%s\n" % (a["name"], a["id"], a["size"]))
print("   找到 %d 个安装包: %s" % (len(assets), [a["name"] for a in assets]))
PY

if [ ! -s "$WORK/list.txt" ]; then echo "::warning::该 tag 下没有 NOVAI-Setup 安装包"; exit 0; fi

# ---- 2. Gitee Release：取 id，没有就建
API="https://gitee.com/api/v5/repos/$GITEE_OWNER/$GITEE_REPO"
RID=$(curl -sS --max-time 60 "$API/releases/tags/$TAG?access_token=$GITEE_TOKEN" \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('id','') or '')" 2>/dev/null)
if [ -z "$RID" ]; then
  echo "   Gitee 上没有 $TAG 的 Release，新建一个"
  RID=$(curl -sS --max-time 60 -X POST "$API/releases" \
    -d "access_token=$GITEE_TOKEN" -d "tag_name=$TAG" -d "name=NOVAI $TAG" \
    -d "target_commitish=main" -d "prerelease=false" \
    -d "body=国内下载镜像（与 GitHub Release 相同内容）。安装包超过 Gitee 单附件 100MB 限制，已按 .part00/.part01 分卷，下载后合并即可。" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('id','') or '')" 2>/dev/null)
fi
if [ -z "$RID" ]; then echo "::warning::拿不到 Gitee Release id（tag 是否已推到 gitee？）"; exit 0; fi
echo "   Gitee release id = $RID"

# ---- 3. 下载 → 分卷 → 上传
while IFS=$'\t' read -r name aid size; do
  [ -n "$name" ] || continue
  echo "== $name ($(( size / 1048576 )) MB)"
  curl -sSL --max-time 900 -H "Authorization: token $GITHUB_TOKEN" \
       -H "Accept: application/octet-stream" \
       "https://api.github.com/repos/$REPO/releases/assets/$aid" -o "$WORK/$name"
  got=$(stat -c%s "$WORK/$name" 2>/dev/null || echo 0)
  if [ "$got" != "$size" ]; then echo "::warning::$name 下载不完整 $got/$size，跳过"; continue; fi

  rm -rf "$WORK/parts"; mkdir -p "$WORK/parts"
  if [ "$size" -le "$LIMIT" ]; then
    cp "$WORK/$name" "$WORK/parts/$name"
  else
    n=$(( (size + LIMIT - 1) / LIMIT ))
    split -n "$n" -d -a 2 "$WORK/$name" "$WORK/parts/$name.part"
    echo "   分成 $n 卷（单卷上限 95MB）"
  fi

  for p in "$WORK/parts"/*; do
    pn=$(basename "$p"); ps=$(stat -c%s "$p")
    echo "   上传 $pn ($(( ps / 1048576 )) MB)"
    code=$(curl -sS --max-time 2400 -X POST "$API/releases/$RID/attach_files" \
      -F "access_token=$GITEE_TOKEN" -F "file=@$p" -o "$WORK/up.json" -w '%{http_code}')
    if [ "$code" = "201" ] || [ "$code" = "200" ]; then
      echo "     ok ($code)"
    else
      echo "::warning::$pn 上传失败 http=$code $(head -c 200 "$WORK/up.json")"
    fi
  done
done < "$WORK/list.txt"

echo "== Gitee 安装包同步结束"
