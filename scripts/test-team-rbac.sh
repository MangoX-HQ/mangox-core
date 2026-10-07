#!/usr/bin/env bash
# ============================================================================
# Smoke test for team-based RBAC (REFACTOR_TEAMS.md)
#
# Usage:
#   ./scripts/test-team-rbac.sh
#
# Env (optional):
#   API_HOST       (default: http://localhost:5555)
#   SUPER_EMAIL    (default: superadmin@mangoads.vn)
#   SUPER_PASS     (default: Th@i2004)
#
# Pre-req: server is running + migration has been applied.
# Test scenarios:
#   1. Super admin login
#   2. Create a new team (caller automatically becomes admin)
#   3. Create a tenant within the team (requires team_id)
#   4. Create a new user → invite into the team with role=user
#   5. New user logs in, GET /team → only sees the team they belong to
#   6. New user POST /tenant → 403 (role=user has no permission)
#   7. Create a tenant with a MATCHING slug in a different team → OK (per-team unique)
#   8. Cleanup
# ============================================================================

set -u
API="${API_HOST:-http://192.168.1.143:5555}/api/v1"
SUPER_EMAIL="${SUPER_EMAIL:-superadmin@mangoads.vn}"
SUPER_PASS="${SUPER_PASS:-Th@i2004}"
TS=$(date +%s)

PASS=0
FAIL=0

green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
gray()  { printf "\033[90m%s\033[0m\n" "$*"; }
header(){ printf "\n\033[1;36m── %s ──\033[0m\n" "$*"; }

# ─── tiny helpers ──────────────────────────────────────────────────────────
# api METHOD PATH [JSON_BODY] [BEARER]
api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local args=(-sS -X "$method" "${API}${path}" -H 'content-type: application/json')
  [[ -n "$token" ]] && args+=(-H "authorization: Bearer ${token}")
  [[ -n "$body"  ]] && args+=(-d "$body")
  curl "${args[@]}"
}

# status_eq EXPECTED RESPONSE_JSON DESC
expect_status() {
  local exp="$1" resp="$2" desc="$3"
  local got
  got=$(echo "$resp" | jq -r '.statusCode // 200' 2>/dev/null)
  if [[ "$got" == "$exp" ]]; then
    green "  ✓ $desc (status=$got)"
    PASS=$((PASS+1))
  else
    red "  ✗ $desc — expected $exp got $got"
    gray "    body: $resp"
    FAIL=$((FAIL+1))
  fi
}

extract() { echo "$1" | jq -r "$2" 2>/dev/null; }

# ─── 1. SUPER ADMIN LOGIN ──────────────────────────────────────────────────
header "1. Super admin login"
LOGIN_RES=$(api POST /auth/login "{\"email\":\"${SUPER_EMAIL}\",\"password\":\"${SUPER_PASS}\"}")
SUPER_TOKEN=$(extract "$LOGIN_RES" '.data.accessToken // .data.access_token // .accessToken')
if [[ -z "$SUPER_TOKEN" || "$SUPER_TOKEN" == "null" ]]; then
  red "  ✗ Login failed — body:"
  echo "$LOGIN_RES" | jq . 2>/dev/null || echo "$LOGIN_RES"
  exit 1
fi
green "  ✓ logged in, token=${SUPER_TOKEN:0:20}…"
PASS=$((PASS+1))

# ─── 2. CREATE TEAM A ──────────────────────────────────────────────────────
header "2. Super admin tạo team 'test-a-${TS}'"
TEAM_A=$(api POST /team \
  "{\"title\":\"Test Team A\",\"slug\":\"test-a-${TS}\"}" \
  "" "$SUPER_TOKEN")
TEAM_A_ID=$(extract "$TEAM_A" '.data._id // .data.data._id')
[[ -n "$TEAM_A_ID" && "$TEAM_A_ID" != "null" ]] \
  && { green "  ✓ created team_id=$TEAM_A_ID"; PASS=$((PASS+1)); } \
  || { red "  ✗ create team failed: $TEAM_A"; FAIL=$((FAIL+1)); }

# ─── 3. CREATE TEAM B ──────────────────────────────────────────────────────
header "3. Tạo team 'test-b-${TS}'"
TEAM_B=$(api POST /team \
  "{\"title\":\"Test Team B\",\"slug\":\"test-b-${TS}\"}" \
  "" "$SUPER_TOKEN")
TEAM_B_ID=$(extract "$TEAM_B" '.data._id // .data.data._id')
[[ -n "$TEAM_B_ID" && "$TEAM_B_ID" != "null" ]] \
  && { green "  ✓ created team_id=$TEAM_B_ID"; PASS=$((PASS+1)); } \
  || { red "  ✗ create team B failed: $TEAM_B"; FAIL=$((FAIL+1)); }

# ─── 4. POST /tenant — no team_id → 400 ─────────────────────────────
header "4. POST /tenant thiếu team_id → expect 400"
NO_TEAM=$(api POST /tenant \
  "{\"title\":\"X\",\"slug\":\"x-${TS}\",\"type\":\"public\"}" \
  "" "$SUPER_TOKEN")
expect_status 400 "$NO_TEAM" "phải reject vì thiếu team_id"

# ─── 5. CREATE TENANT trong TEAM A — slug=shared ──────────────────────────
header "5. Tạo tenant slug='shared-${TS}' trong TEAM A"
T_A=$(api POST /tenant \
  "{\"title\":\"Tenant A\",\"slug\":\"shared-${TS}\",\"type\":\"public\",\"team_id\":\"${TEAM_A_ID}\"}" \
  "" "$SUPER_TOKEN")
T_A_ID=$(extract "$T_A" '.data._id // .data.data._id')
[[ -n "$T_A_ID" && "$T_A_ID" != "null" ]] \
  && { green "  ✓ tenant_id=$T_A_ID"; PASS=$((PASS+1)); } \
  || { red "  ✗ create tenant A failed: $T_A"; FAIL=$((FAIL+1)); }

# ─── 6. CREATE TENANT with the same slug in TEAM B → OK ─────────────────────────
header "6. Tạo tenant slug='shared-${TS}' (trùng) trong TEAM B → expect 200"
T_B=$(api POST /tenant \
  "{\"title\":\"Tenant B\",\"slug\":\"shared-${TS}\",\"type\":\"public\",\"team_id\":\"${TEAM_B_ID}\"}" \
  "" "$SUPER_TOKEN")
T_B_ID=$(extract "$T_B" '.data._id // .data.data._id')
[[ -n "$T_B_ID" && "$T_B_ID" != "null" ]] \
  && { green "  ✓ per-team unique OK, tenant_id=$T_B_ID"; PASS=$((PASS+1)); } \
  || { red "  ✗ per-team unique FAILED: $T_B"; FAIL=$((FAIL+1)); }

# ─── 7. CREATE TENANT with the same slug in TEAM A → 409 ────────────────────────
header "7. Tạo lại slug='shared-${TS}' trong TEAM A → expect 409"
T_DUP=$(api POST /tenant \
  "{\"title\":\"Dup\",\"slug\":\"shared-${TS}\",\"type\":\"public\",\"team_id\":\"${TEAM_A_ID}\"}" \
  "" "$SUPER_TOKEN")
expect_status 409 "$T_DUP" "duplicate slug trong cùng team phải bị reject"

# ─── 8. REGISTER new USER ─────────────────────────────────────────────────
header "8. Register user 'tester-${TS}@x.test'"
NEW_USER_EMAIL="tester${TS}@x.test"
NEW_USER_PASS="Test@1234"
REG=$(api POST /auth/register \
  "{\"email\":\"${NEW_USER_EMAIL}\",\"username\":\"u${TS}\",\"phone\":\"0901234567\",\"password\":\"${NEW_USER_PASS}\"}")
NEW_USER_ID=$(extract "$REG" '.data._id // .data.data._id')
[[ -n "$NEW_USER_ID" && "$NEW_USER_ID" != "null" ]] \
  && { green "  ✓ user_id=$NEW_USER_ID"; PASS=$((PASS+1)); } \
  || { red "  ✗ register failed: $REG"; FAIL=$((FAIL+1)); }

# ─── 9. INVITE user into TEAM A with role=user ──────────────────────────────
header "9. Add user vào TEAM A với role=user"
UT=$(api POST /user_team \
  "{\"user_id\":\"${NEW_USER_ID}\",\"team_id\":\"${TEAM_A_ID}\",\"role_name\":\"user\"}" \
  "" "$SUPER_TOKEN")
UT_ID=$(extract "$UT" '.data._id // .data.data._id')
[[ -n "$UT_ID" && "$UT_ID" != "null" ]] \
  && { green "  ✓ membership_id=$UT_ID"; PASS=$((PASS+1)); } \
  || { red "  ✗ user_team insert failed: $UT"; FAIL=$((FAIL+1)); }

# ─── 10. New user login ────────────────────────────────────────────────────
header "10. New user login"
USR_LOGIN=$(api POST /auth/login "{\"email\":\"${NEW_USER_EMAIL}\",\"password\":\"${NEW_USER_PASS}\"}")
USR_TOKEN=$(extract "$USR_LOGIN" '.data.accessToken // .data.access_token // .accessToken')
[[ -n "$USR_TOKEN" && "$USR_TOKEN" != "null" ]] \
  && { green "  ✓ token=${USR_TOKEN:0:20}…"; PASS=$((PASS+1)); } \
  || { red "  ✗ login failed: $USR_LOGIN"; FAIL=$((FAIL+1)); }

# ─── 11. New user GET /team → only sees team A ─────────────────────────────
header "11. New user GET /team → chỉ thấy 1 team (team A)"
USR_TEAMS=$(api GET /team "" "$USR_TOKEN")
COUNT=$(extract "$USR_TEAMS" '.data | length')
if [[ "$COUNT" == "1" ]]; then
  green "  ✓ thấy đúng 1 team"
  PASS=$((PASS+1))
else
  red "  ✗ expected 1 team, got $COUNT"
  gray "    body: $USR_TEAMS"
  FAIL=$((FAIL+1))
fi

# ─── 12. New user POST /tenant → 403 (role=user) ──────────────────────────
header "12. New user POST /tenant trong TEAM A → expect 403"
USR_TENANT=$(api POST /tenant \
  "{\"title\":\"X\",\"slug\":\"x-${TS}\",\"type\":\"public\",\"team_id\":\"${TEAM_A_ID}\"}" \
  "" "$USR_TOKEN")
expect_status 403 "$USR_TENANT" "role=user không tạo được tenant"

# ─── 13. New user PUT /team/:id → 403 ─────────────────────────────────────
header "13. New user PUT /team/${TEAM_A_ID} → expect 403"
USR_UPD=$(api PUT "/team/${TEAM_A_ID}" "{\"description\":\"hacked\"}" "$USR_TOKEN")
expect_status 403 "$USR_UPD" "role=user không sửa được team"

# ─── 14. CLEANUP ──────────────────────────────────────────────────────────
header "14. Cleanup (DELETE bulk)"
api DELETE "/user_team?ids=${UT_ID}" "" "$SUPER_TOKEN" >/dev/null
api DELETE "/tenant?ids=${T_A_ID},${T_B_ID}" "" "$SUPER_TOKEN" >/dev/null
api DELETE "/team?ids=${TEAM_A_ID},${TEAM_B_ID}" "" "$SUPER_TOKEN" >/dev/null
# user cleanup
api DELETE "/user?ids=${NEW_USER_ID}" "" "$SUPER_TOKEN" >/dev/null
gray "  cleaned up"

# ─── SUMMARY ──────────────────────────────────────────────────────────────
printf "\n\033[1m═══ SUMMARY ═══\033[0m\n"
green "  passed: $PASS"
[[ "$FAIL" -gt 0 ]] && red "  failed: $FAIL" || gray "  failed: $FAIL"
exit $FAIL
