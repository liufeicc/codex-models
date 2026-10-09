#!/bin/bash
# test/e2e.sh — 端到端回归：全部打本地假上游，不碰任何真实网关
#
# 覆盖：
#   1) responses 档：代表名 → 真实模型改写、上游令牌替换、工具调用闭环（经典工具模式）
#   2) chat 档：Responses ⇄ Chat 转译（工具拍平、工具调用闭环）
#   3) 换档：代表名换档 / cxm use 外部换档 / 回声不扳回档位
#   4) usage 口径归正（Anthropic 口径自动补 cached）
#   5) 超长报错文案适配
#   6) dropReasoning：按档位剔除跨上游的 reasoning（思维链）条目
#   7) 升级 Codex 后自动跟上：目录缓存按 codex 身份重抓 + 守护进程同步决策矩阵
#   8) 与用户 ~/.codex、~/.codex-models 完全隔离（只写 CXM_E2E_DIR），并显式钉住 Codex 真身
#
# 用法：npm run build && bash test/e2e.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CXM_E2E_DIR="${CXM_E2E_DIR:-/tmp/cxm-e2e}"
export CXM_HOME="$CXM_E2E_DIR/home"
PORT=4281
PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1（$2）"; else bad "$1：期望 [$3] 实得 [$2]"; fi; }
# 出现次数断言：输出里同一段文本可能因流式回显出现多次，只要求 ≥ 期望次数
check_at_least(){ if [ "${2:-0}" -ge "$3" ] 2>/dev/null; then ok "$1（$2 次）"; else bad "$1：期望 ≥$3 次，实得 [${2:-0}]"; fi; }

echo "== 准备环境 =="
# 显式钉住 Codex 真身：装过 cxm 壳的机器上，PATH 里的 codex 就是壳本身，
# 不钉的话测试结果会随环境变化（隔离 CXM_HOME 里没有 state.json 记录）。
REAL_CODEX="$(node -e "import('$ROOT/dist/codexBin.js').then(m=>console.log(m.resolveRealCodex()||''))" 2>/dev/null)"
if [ -z "$REAL_CODEX" ]; then
  echo "找不到 Codex 真身（PATH 里的 codex 是壳且无法反推）。请先安装 Codex CLI。"
  exit 1
fi
echo "Codex 真身：$REAL_CODEX"
python3 - "$CXM_E2E_DIR" "$REAL_CODEX" <<'PY'
import os, sys, json, shutil
d = sys.argv[1]
shutil.rmtree(d, ignore_errors=True)
os.makedirs(d + "/logs", exist_ok=True)
os.makedirs(d + "/home/run", exist_ok=True)
cfg = {
  "port": 4281,
  "defaultProfile": "probe",
  "codexBin": sys.argv[2],
  "profiles": {
    "probe":   {"name": "responses档", "baseUrl": "http://127.0.0.1:4199/v1", "apiKey": "upstream-key-responses", "model": "probe-real-model", "wireApi": "responses", "contextWindow": 200000},
    "chatter": {"name": "chat档",      "baseUrl": "http://127.0.0.1:4300/v1", "apiKey": "upstream-key-chat",      "model": "chat-real-model",  "wireApi": "chat", "contextWindow": 131072},
    "anom":    {"name": "口径异常档",  "baseUrl": "http://127.0.0.1:4400/v1", "apiKey": "k", "model": "anom-real-model", "wireApi": "responses"},
    "err":     {"name": "报错档",      "baseUrl": "http://127.0.0.1:4200/v1", "apiKey": "k", "model": "err-real-model",  "wireApi": "responses"},
    "keep":    {"name": "留思维链档",  "baseUrl": "http://127.0.0.1:4500/v1", "apiKey": "k", "model": "keep-real-model", "wireApi": "responses"},
    "drop":    {"name": "剔思维链档",  "baseUrl": "http://127.0.0.1:4500/v1", "apiKey": "k", "model": "drop-real-model", "wireApi": "responses", "dropReasoning": True}
  }
}
open(d + "/home/config.json", "w").write(json.dumps(cfg, ensure_ascii=False, indent=2))
PY
setsid node "$ROOT/test/mocks.mjs" >> "$CXM_E2E_DIR/mocks.log" 2>&1 &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true   # 脱离作业控制：清理时不再打印 "Killed" 噪声
sleep 1
cleanup() { kill -9 "$MOCK_PID" 2>/dev/null; CXM_HOME="$CXM_HOME" node "$ROOT/dist/cli.js" stop >/dev/null 2>&1; }
trap cleanup EXIT

cxm() { CXM_HOME="$CXM_HOME" node "$ROOT/dist/cli.js" "$@"; }
logs() { cat "$CXM_E2E_DIR/logs/$1.jsonl" 2>/dev/null; }
reset_logs() { for f in responses chat rsn; do : > "$CXM_E2E_DIR/logs/$f.jsonl"; done; }

cxm start >/dev/null || { echo "网关启动失败"; exit 1; }
cxm catalog >/dev/null

echo "== 1) responses 档：模型改写 + 令牌替换 + 工具闭环 =="
reset_logs
cxm probe exec --skip-git-repo-check "跑一下" > "$CXM_E2E_DIR/probe.out" 2>&1
check "上游收到的模型" "$(logs responses | python3 -c "import sys,json; print(json.loads(sys.stdin.readline())['model'])")" "probe-real-model"
check "上游收到的令牌" "$(logs responses | python3 -c "import sys,json; print(json.loads(sys.stdin.readline())['auth'])")" "upstream-key-responses"
check "经典工具模式（顶层 tools 非空）" "$(logs responses | python3 -c "import sys,json; d=json.loads(sys.stdin.readline()); print('yes' if d['tools'] else 'no')")" "yes"
check_at_least "工具调用闭环（真身执行了命令）" "$(grep -c 'responses-tool-ok' "$CXM_E2E_DIR/probe.out" || true)" 1

echo "== 2) chat 档：Responses ⇄ Chat 转译 + 工具闭环 =="
reset_logs
cxm chatter exec --skip-git-repo-check "跑一下" > "$CXM_E2E_DIR/chat.out" 2>&1
check "上游收到的模型" "$(logs chat | python3 -c "import sys,json; print(json.loads(sys.stdin.readline())['model'])")" "chat-real-model"
check "工具被拍平下发（含命名空间）" "$(logs chat | python3 -c "import sys,json; t=json.loads(sys.stdin.readline())['tools']; print('yes' if 'exec_command' in t and any('.' in x for x in t) else 'no')")" "yes"
check_at_least "工具调用闭环（真身执行了命令）" "$(grep -c 'chat-tool-ok' "$CXM_E2E_DIR/chat.out" || true)" 1
check "第一轮消息里没有 additional_tools 噪声" "$(logs chat | python3 -c "import sys,json; print('no' if any('additional_tools' in m for m in json.loads(sys.stdin.readline())['messages']) else 'yes')")" "yes"

echo "== 3) 换档三态 =="
ADMIN=$(cat "$CXM_HOME/run/admin-token")
TOKEN=$(curl -sS -X POST -H "x-cxm-admin: $ADMIN" -H 'content-type: application/json' -d '{"profile":"probe"}' "http://127.0.0.1:$PORT/__cxm/register" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
req() { curl -sS -o /dev/null -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"model\":\"$1\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}],\"stream\":true}" \
  "http://127.0.0.1:$PORT/v1/responses"; }
cur() { curl -sS -H "x-cxm-admin: $ADMIN" "http://127.0.0.1:$PORT/__cxm/sessions" | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'][0]['profile'])"; }
reset_logs; req cxm-profile-probe; check "首次请求走 probe" "$(cur)" "probe"
cxm use chatter --session "$TOKEN" >/dev/null
reset_logs; req cxm-profile-probe; check "cxm use 后回声仍留 chatter" "$(cur)" "chatter"
check "回声确实打到 chat 上游" "$(wc -l < "$CXM_E2E_DIR/logs/chat.jsonl" | tr -d ' ')" "1"
reset_logs; req cxm-profile-probe; check "连续回声不漂移" "$(cur)" "chatter"
cxm use probe --session "$TOKEN" >/dev/null
reset_logs; req cxm-profile-chatter; check "选择器换到 chatter 档" "$(cur)" "chatter"
reset_logs; req cxm-profile-probe; check "选择器换回 probe 档" "$(cur)" "probe"
curl -sS -X POST -H "x-cxm-admin: $ADMIN" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" "http://127.0.0.1:$PORT/__cxm/detach" >/dev/null

echo "== 4) usage 口径归正（auto：连续 3 次矛盾后开始补 cached） =="
TOKEN2=$(curl -sS -X POST -H "x-cxm-admin: $ADMIN" -H 'content-type: application/json' -d '{"profile":"anom"}' "http://127.0.0.1:$PORT/__cxm/register" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
TOKEN="$TOKEN2" req cxm-profile-anom >/dev/null
TOKEN="$TOKEN2" req cxm-profile-anom >/dev/null
OUT=$(TOKEN="$TOKEN2" curl -sS -X POST -H "authorization: Bearer $TOKEN2" -H 'content-type: application/json' \
  -d '{"model":"cxm-profile-anom","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"stream":true}' "http://127.0.0.1:$PORT/v1/responses")
check "第 3 次已把 cached 补进 input_tokens" "$(echo "$OUT" | grep -o '"input_tokens":[0-9]*' | tail -1)" '"input_tokens":8120'
check "网关日志有归正记录" "$(grep -c 'usage归正' "$CXM_HOME/run/proxy.log")" "1"
curl -sS -X POST -H "x-cxm-admin: $ADMIN" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN2\"}" "http://127.0.0.1:$PORT/__cxm/detach" >/dev/null

echo "== 5) 超长报错文案适配 =="
TOKEN3=$(curl -sS -X POST -H "x-cxm-admin: $ADMIN" -H 'content-type: application/json' -d '{"profile":"err"}' "http://127.0.0.1:$PORT/__cxm/register" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
ERR=$(curl -sS -X POST -H "authorization: Bearer $TOKEN3" -H 'content-type: application/json' \
  -d '{"model":"cxm-profile-err","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"stream":true}' "http://127.0.0.1:$PORT/v1/responses")
check "文案被改写并带上结构化字段" "$(echo "$ERR" | python3 -c "import sys,json; d=json.load(sys.stdin)['error']; print('yes' if d['message'].startswith('context window exceeded') and d['codex_error_info']=='context_window_exceeded' else 'no')")" "yes"

echo
echo "== 6) dropReasoning：剔除跨上游的思维链条目 =="
# 带一条「别家产」的 reasoning 条目（encrypted_content 是 UUID + 明文 reasoning_text）
rsn_req() { # $1=令牌 $2=代表名
  curl -sS -o /dev/null -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"model\":\"$2\",\"input\":[{\"type\":\"reasoning\",\"id\":\"rs_1\",\"summary\":[],\"encrypted_content\":\"01cbf936-8e07-413d-a39c-44865f48c135-0\",\"content\":[{\"type\":\"reasoning_text\",\"text\":\"跨家思维链\"}]},{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}],\"stream\":true}" \
    "http://127.0.0.1:$PORT/v1/responses"; }
reg() { curl -sS -X POST -H "x-cxm-admin: $ADMIN" -H 'content-type: application/json' -d "{\"profile\":\"$1\"}" "http://127.0.0.1:$PORT/__cxm/register" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])"; }
rsn_types() { python3 -c "import sys,json; print(json.dumps(json.loads(open('$CXM_E2E_DIR/logs/rsn.jsonl').readline())['inputTypes'], ensure_ascii=False))"; }
reset_logs
TK_KEEP=$(reg keep); TK_DROP=$(reg drop)
rsn_req "$TK_KEEP" cxm-profile-keep
rsn_req "$TK_DROP" cxm-profile-drop
check "默认档位原样透传 reasoning 条目" "$(rsn_types)" '["reasoning", "message"]'
check "dropReasoning 档位剔除 reasoning 条目" "$(python3 -c "import sys,json; print(json.dumps(json.loads(open('$CXM_E2E_DIR/logs/rsn.jsonl').readlines()[1])['inputTypes'], ensure_ascii=False))")" '["message"]'
check "上游收到的模型已改写" "$(python3 -c "import sys,json; print(json.loads(open('$CXM_E2E_DIR/logs/rsn.jsonl').readlines()[1])['model'])")" "drop-real-model"
check_at_least "网关日志记录了丢弃条数" "$(grep -c '丢弃思维链=1条' "$CXM_HOME/run/proxy.log" || true)" 1

echo
echo "== 7) 升级 Codex 后自动跟上 =="
# 7a) 内置目录缓存"身份过期"（换了 codex 版本）→ 必须自动重抓，并把生成的目录一并重建。
# 这里同时把 model-catalog.json 的 mtime 调到比 config.json 新，确保重建只能是
# "身份过期"触发的 —— 否则 mtime 规则会先命中，测不到我们新加的判断。
python3 - "$CXM_HOME" <<'PY'
import json, os, sys, time
home = sys.argv[1]
bc, mc = os.path.join(home, "builtin-catalog.json"), os.path.join(home, "model-catalog.json")
d = json.load(open(bc)); d["codexIdentity"] = "v:0.0.0-bogus"; json.dump(d, open(bc, "w"), ensure_ascii=False)
g = json.load(open(mc)); g["models"] = g["models"][:1]; json.dump(g, open(mc, "w"), ensure_ascii=False)
now = time.time() + 10; os.utime(mc, (now, now))
PY
cxm catalog >/dev/null
EXPECT_ID="$(node -e "import('$ROOT/dist/codexBin.js').then(m=>console.log(m.codexIdentity('$REAL_CODEX')))")"
check "身份过期的内置缓存被重抓" "$(python3 -c "import json;print(json.load(open('$CXM_HOME/builtin-catalog.json'))['codexIdentity'])")" "$EXPECT_ID"
check "生成的目录被一并重建" "$(python3 -c "
import json
cfg = json.load(open('$CXM_HOME/config.json'))
cat = json.load(open('$CXM_HOME/model-catalog.json'))
print('yes' if len(cat['models']) == len(cfg['profiles']) else f\"no({len(cat['models'])}vs{len(cfg['profiles'])})\")")" "yes"
# 7b) 身份一致时不该重复抓取：往缓存里塞个哨兵，再强制走一次重建路径
python3 - "$CXM_HOME" <<'PY'
import json, os, sys, time
home = sys.argv[1]
bc, mc = os.path.join(home, "builtin-catalog.json"), os.path.join(home, "model-catalog.json")
d = json.load(open(bc)); d["_sentinel"] = "keep-me"; json.dump(d, open(bc, "w"), ensure_ascii=False)
old = time.time() - 3600; os.utime(mc, (old, old))   # 比 config.json 旧 → 必然重建
PY
cxm catalog >/dev/null
check "身份一致时复用缓存（不重复抓取）" "$(python3 -c "import json;print(json.load(open('$CXM_HOME/builtin-catalog.json')).get('_sentinel','已丢失'))")" "keep-me"
# 7c) 守护进程同步的决策矩阵（纯函数，不会真的去动守护进程）
#     顺序：版本一致 / 倒挂且无窗口 / 倒挂且有窗口 / 倒挂且窗口数不明 / 读不到守护进程版本 / 读不到客户端版本
DM=$(node -e "
import('$ROOT/dist/codexSync.js').then(m=>{
  const d=m.decideAppServerSync;
  console.log([d('1.0.0','1.0.0',0), d('2.0.0','1.0.0',0), d('2.0.0','1.0.0',3), d('2.0.0','1.0.0',null), d('2.0.0',null,0), d(null,'1.0.0',0)].join(','));
});")
check "同步决策矩阵（只在无窗口时动手）" "$DM" "skip,sync,warn,warn,skip,skip"

echo
echo "===== 结果：通过 $PASS 项，失败 $FAIL 项 ====="
[ "$FAIL" = "0" ] || exit 1
