#!/usr/bin/env bash
# 真机 A/B 数据隔离冒烟（需要后端已用 NOVAI_AUTH_ENABLED=1 跑在 $BASE）。
# 用法：BASE=http://127.0.0.1:8899 bash tests/cloud_admin_smoke.sh
set -u

BASE="${BASE:-http://127.0.0.1:8899}"
PY="${PY:-venv/bin/python}"
JAR_DIR="/tmp/novai-cloud-admin-jars"
PNG="/tmp/novai-iso.png"
rm -rf "$JAR_DIR"; mkdir -p "$JAR_DIR"
FAILED=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS  $label ($actual)"
  else
    echo "FAIL  $label (expected $expected, got $actual)"
    FAILED=$((FAILED + 1))
  fi
}

json_get() {
  "$PY" -c "import json,sys; data=json.load(open(sys.argv[1])); print($2)" "$1" 2>/dev/null
}

"$PY" - <<'PY'
import base64
from pathlib import Path
Path("/tmp/novai-iso.png").write_bytes(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
PY

echo "== 0. 管理员登录 =="
curl -s -c "$JAR_DIR/admin.jar" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"test-pass-123"}' "$BASE/api/auth/login" -o "$JAR_DIR/admin-login.json" -w "status=%{http_code}\n"
cat "$JAR_DIR/admin-login.json"; echo

echo "== 1. 生成邀请码并注册 alice / bob =="
curl -s -b "$JAR_DIR/admin.jar" -H 'Content-Type: application/json' -d '{"uses":1,"days":7}' \
  "$BASE/api/admin/invites" -o "$JAR_DIR/inv-a.json"
CODE_A=$(json_get "$JAR_DIR/inv-a.json" "data['code']")
echo "invite_alice=$CODE_A"
curl -s -b "$JAR_DIR/admin.jar" -H 'Content-Type: application/json' -d '{"uses":1,"days":7}' \
  "$BASE/api/admin/invites" -o "$JAR_DIR/inv-b.json"
CODE_B=$(json_get "$JAR_DIR/inv-b.json" "data['code']")
echo "invite_bob=$CODE_B"

curl -s -c "$JAR_DIR/alice.jar" -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice\",\"password\":\"iso-pass-123\",\"invite_code\":\"$CODE_A\"}" \
  "$BASE/api/auth/register" -o "$JAR_DIR/alice-reg.json" -w "alice_register=%{http_code}\n"
curl -s -c "$JAR_DIR/bob.jar" -H 'Content-Type: application/json' \
  -d "{\"username\":\"bob\",\"password\":\"iso-pass-123\",\"invite_code\":\"$CODE_B\"}" \
  "$BASE/api/auth/register" -o "$JAR_DIR/bob-reg.json" -w "bob_register=%{http_code}\n"
ALICE_ID=$(json_get "$JAR_DIR/alice-reg.json" "data['user']['id']")
BOB_ID=$(json_get "$JAR_DIR/bob-reg.json" "data['user']['id']")
echo "alice_id=$ALICE_ID bob_id=$BOB_ID"

echo "== 2. alice 建画布，bob 不可见/不可读写 =="
curl -s -b "$JAR_DIR/alice.jar" -H 'Content-Type: application/json' -d '{"title":"alice 云画布"}' \
  "$BASE/api/canvases" -o "$JAR_DIR/canvas.json" -w "create_canvas=%{http_code}\n"
CANVAS_ID=$(json_get "$JAR_DIR/canvas.json" "data['canvas']['id']")
OWNER_ID=$(json_get "$JAR_DIR/canvas.json" "data['canvas']['owner_id']")
echo "canvas_id=$CANVAS_ID owner_id=$OWNER_ID (alice=$ALICE_ID)"
check "canvas owner_id == alice" "$ALICE_ID" "$OWNER_ID"

curl -s -b "$JAR_DIR/alice.jar" "$BASE/api/canvases" -o "$JAR_DIR/alice-list.json" -w "alice_list=%{http_code}\n"
check "alice 自己的列表包含画布" "1" "$(json_get "$JAR_DIR/alice-list.json" "int(any(c['id']=='$CANVAS_ID' for c in data['canvases']))")"
curl -s -b "$JAR_DIR/bob.jar" "$BASE/api/canvases" -o "$JAR_DIR/bob-list.json" -w "bob_list=%{http_code}\n"
check "bob 的列表看不到画布" "0" "$(json_get "$JAR_DIR/bob-list.json" "int(any(c['id']=='$CANVAS_ID' for c in data['canvases']))")"
check "bob 直接 GET 被 403" "403" "$(curl -s -b "$JAR_DIR/bob.jar" -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"
check "bob 直接 PUT 被 403" "403" "$(curl -s -b "$JAR_DIR/bob.jar" -X PUT -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"
check "bob 直接 DELETE 被 403" "403" "$(curl -s -b "$JAR_DIR/bob.jar" -X DELETE -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"
curl -s -b "$JAR_DIR/admin.jar" "$BASE/api/canvases?all=1" -o "$JAR_DIR/admin-all.json" -w "admin_all=%{http_code}\n"
check "admin ?all=1 能看到画布" "1" "$(json_get "$JAR_DIR/admin-all.json" "int(any(c['id']=='$CANVAS_ID' for c in data['canvases']))")"
check "admin 直接 GET 200" "200" "$(curl -s -b "$JAR_DIR/admin.jar" -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"

echo "== 3. alice 上传素材，bob 403 / admin 200 =="
curl -s -b "$JAR_DIR/alice.jar" -F "files=@$PNG;type=image/png" "$BASE/api/ai/upload" -o "$JAR_DIR/upload.json" -w "upload=%{http_code}\n"
cat "$JAR_DIR/upload.json"; echo
ASSET_URL=$(json_get "$JAR_DIR/upload.json" "data['files'][0]['url']")
echo "asset_url=$ASSET_URL"
case "$ASSET_URL" in
  /assets/users/"$ALICE_ID"/input/*) echo "PASS  素材落在 users/$ALICE_ID/input";;
  *) echo "FAIL  素材路径不是 users/$ALICE_ID/input: $ASSET_URL"; FAILED=$((FAILED+1));;
esac
check "alice 读取素材 200" "200" "$(curl -s -b "$JAR_DIR/alice.jar" -o /dev/null -w '%{http_code}' "$BASE$ASSET_URL")"
check "bob 读取 alice 素材 403" "403" "$(curl -s -b "$JAR_DIR/bob.jar" -o /dev/null -w '%{http_code}' "$BASE$ASSET_URL")"
check "admin 读取素材 200" "200" "$(curl -s -b "$JAR_DIR/admin.jar" -o /dev/null -w '%{http_code}' "$BASE$ASSET_URL")"
check "匿名读取租户素材 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$ASSET_URL")"

echo "== 4. 管理面：canvas_count / 统计 / 页面权限 =="
curl -s -b "$JAR_DIR/admin.jar" "$BASE/api/admin/users" -o "$JAR_DIR/users.json" -w "admin_users=%{http_code}\n"
cat "$JAR_DIR/users.json"; echo
check "alice canvas_count=1" "1" "$(json_get "$JAR_DIR/users.json" "[u['canvas_count'] for u in data['users'] if u['username']=='alice'][0]")"
check "统计里有今日注册" "1" "$(json_get "$JAR_DIR/users.json" "int('new_today' in data['stats'])")"
check "alice 访问 /admin 被 302" "302" "$(curl -s -b "$JAR_DIR/alice.jar" -o /dev/null -w '%{http_code}' "$BASE/admin")"
check "admin 访问 /admin 200" "200" "$(curl -s -b "$JAR_DIR/admin.jar" -o /dev/null -w '%{http_code}' "$BASE/admin")"
check "匿名访问 /admin 302" "302" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")"

echo
echo "SUMMARY failed=$FAILED"
exit "$FAILED"
