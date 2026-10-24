#!/usr/bin/env bash
# M3 画布权限真机冒烟（需要后端以 NOVAI_AUTH_ENABLED=1 跑在 $BASE）。
# 用法：BASE=http://127.0.0.1:8897 bash tests/canvas_perms_smoke.sh
set -u

BASE="${BASE:-http://127.0.0.1:8897}"
PY="${PY:-venv/bin/python}"
JARS="/tmp/novai-canvas-perms-jars"
rm -rf "$JARS"; mkdir -p "$JARS"
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

jget() { "$PY" -c "import json,sys; data=json.load(open(sys.argv[1])); print($2)" "$1" 2>/dev/null; }

echo "== 0. 管理员登录 =="
curl -s -c "$JARS/admin.jar" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"test-pass-123"}' "$BASE/api/auth/login" -o "$JARS/admin.json" -w "login=%{http_code}\n"
cat "$JARS/admin.json"; echo

echo "== 1. 创建 alice / bob / carol =="
for name in alice bob carol; do
  curl -s -b "$JARS/admin.jar" -H 'Content-Type: application/json' -d '{}' "$BASE/api/admin/invites" -o "$JARS/inv-$name.json"
  code=$(jget "$JARS/inv-$name.json" "data['code']")
  curl -s -c "$JARS/$name.jar" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$name\",\"password\":\"$name-pass-123\",\"invite_code\":\"$code\"}" \
    "$BASE/api/auth/register" -o "$JARS/$name.json" -w "$name=%{http_code}\n"
done
ALICE_ID=$(jget "$JARS/alice.json" "data['user']['id']")
BOB_ID=$(jget "$JARS/bob.json" "data['user']['id']")
CAROL_ID=$(jget "$JARS/carol.json" "data['user']['id']")
echo "alice=$ALICE_ID bob=$BOB_ID carol=$CAROL_ID"

echo "== 2. alice 建画布并分享 bob 为 viewer =="
curl -s -b "$JARS/alice.jar" -H 'Content-Type: application/json' -d '{"title":"团队共享画布"}' \
  "$BASE/api/canvases" -o "$JARS/canvas.json" -w "create=%{http_code}\n"
CANVAS_ID=$(jget "$JARS/canvas.json" "data['canvas']['id']")
echo "canvas=$CANVAS_ID"
curl -s -b "$JARS/alice.jar" -H 'Content-Type: application/json' -d '{"username":"bob","role":"viewer"}' \
  "$BASE/api/canvases/$CANVAS_ID/members" -o "$JARS/share.json" -w "share=%{http_code}\n"
cat "$JARS/share.json"; echo

echo "== 3. bob 列表 / 打开 / 写 =="
curl -s -b "$JARS/bob.jar" "$BASE/api/canvases" -o "$JARS/bob-list.json" -w "bob_list=%{http_code}\n"
check "bob 列表 role=viewer" "viewer" "$(jget "$JARS/bob-list.json" "[c['access_role'] for c in data['canvases'] if c['id']=='$CANVAS_ID'][0]")"
check "bob 列表 owner_username=alice" "alice" "$(jget "$JARS/bob-list.json" "[c['owner_username'] for c in data['canvases'] if c['id']=='$CANVAS_ID'][0]")"
check "bob GET 200" "200" "$(curl -s -b "$JARS/bob.jar" -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"
check "bob PUT 403" "403" "$(curl -s -b "$JARS/bob.jar" -X PUT -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"
check "bob DELETE 403" "403" "$(curl -s -b "$JARS/bob.jar" -X DELETE -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"
check "bob 权限 my_role=viewer" "viewer" "$(curl -s -b "$JARS/bob.jar" "$BASE/api/canvases/$CANVAS_ID/permissions" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["my_role"])')"

echo "== 4. 改成 editor → bob 可保存、仍不能删 =="
curl -s -b "$JARS/alice.jar" -X PATCH -H 'Content-Type: application/json' -d '{"role":"editor"}' \
  "$BASE/api/canvases/$CANVAS_ID/members/$BOB_ID" -o "$JARS/patch.json" -w "patch=%{http_code}\n"
cat "$JARS/patch.json"; echo
check "bob PUT 200 (editor)" "200" "$(curl -s -b "$JARS/bob.jar" -X PUT -H 'Content-Type: application/json' -d '{"title":"团队共享画布"}' -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"
check "bob DELETE 仍 403" "403" "$(curl -s -b "$JARS/bob.jar" -X DELETE -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"
check "bob 权限 my_role=editor" "editor" "$(curl -s -b "$JARS/bob.jar" "$BASE/api/canvases/$CANVAS_ID/permissions" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["my_role"])')"

echo "== 5. carol 无关用户不可见 / 不可管理 =="
curl -s -b "$JARS/carol.jar" "$BASE/api/canvases" -o "$JARS/carol-list.json"
check "carol 列表看不到画布" "0" "$(jget "$JARS/carol-list.json" "int(any(c['id']=='$CANVAS_ID' for c in data['canvases']))")"
check "carol 权限 403" "403" "$(curl -s -b "$JARS/carol.jar" -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID/permissions")"
check "carol 加成员 403" "403" "$(curl -s -b "$JARS/carol.jar" -H 'Content-Type: application/json' -d '{"username":"bob","role":"viewer"}' -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID/members")"

echo "== 6. 参数错误 / admin 能力 =="
check "重复添加 409" "409" "$(curl -s -b "$JARS/alice.jar" -H 'Content-Type: application/json' -d '{"username":"bob","role":"viewer"}' -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID/members")"
check "不存在用户 404" "404" "$(curl -s -b "$JARS/alice.jar" -H 'Content-Type: application/json' -d '{"username":"nobody-xyz","role":"viewer"}' -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID/members")"
check "非法角色 400" "400" "$(curl -s -b "$JARS/alice.jar" -H 'Content-Type: application/json' -d '{"username":"carol","role":"owner"}' -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID/members")"
check "admin 权限 my_role=admin" "admin" "$(curl -s -b "$JARS/admin.jar" "$BASE/api/canvases/$CANVAS_ID/permissions" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["my_role"])')"
curl -s -b "$JARS/admin.jar" "$BASE/api/canvases?all=1" -o "$JARS/admin-all.json"
check "admin 列表 access_role=admin" "admin" "$(jget "$JARS/admin-all.json" "[c['access_role'] for c in data['canvases'] if c['id']=='$CANVAS_ID'][0]")"
check "admin PATCH 200" "200" "$(curl -s -b "$JARS/admin.jar" -X PATCH -H 'Content-Type: application/json' -d '{"role":"viewer"}' "$BASE/api/canvases/$CANVAS_ID/members/$BOB_ID" -o /dev/null -w '%{http_code}')"

echo "== 7. 移除成员后立即失去访问 =="
check "移除 bob 200" "200" "$(curl -s -b "$JARS/admin.jar" -X DELETE "$BASE/api/canvases/$CANVAS_ID/members/$BOB_ID" -o /dev/null -w '%{http_code}')"
curl -s -b "$JARS/bob.jar" "$BASE/api/canvases" -o "$JARS/bob-after.json"
check "bob 列表已不可见" "0" "$(jget "$JARS/bob-after.json" "int(any(c['id']=='$CANVAS_ID' for c in data['canvases']))")"
check "bob GET 403" "403" "$(curl -s -b "$JARS/bob.jar" -o /dev/null -w '%{http_code}' "$BASE/api/canvases/$CANVAS_ID")"

# 为 Playwright 截图留一条成员记录：重新把 bob 加成 editor
curl -s -b "$JARS/alice.jar" -H 'Content-Type: application/json' -d '{"username":"bob","role":"editor"}' \
  "$BASE/api/canvases/$CANVAS_ID/members" -o /dev/null -w "screenshot_seed=%{http_code}\n"

echo
echo "SUMMARY failed=$FAILED"
exit "$FAILED"
