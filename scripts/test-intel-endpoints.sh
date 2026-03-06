#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:${DB_SERVICE_PORT:-8080}}"
SEARCH_QUERY="${SEARCH_QUERY:-search}"
AGENT_ID="${AGENT_ID:-}"
COMPARE_IDS="${COMPARE_IDS:-}"
CURL_TIMEOUT_SECONDS="${CURL_TIMEOUT_SECONDS:-20}"

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required for pretty-printed JSON output." >&2
  exit 1
fi

print_section() {
  local title="$1"
  echo
  echo "============================================================"
  echo "$title"
  echo "============================================================"
}

pretty_print_json() {
  python3 -m json.tool
}

fetch_json() {
  local url="$1"
  curl --silent --show-error --fail --max-time "$CURL_TIMEOUT_SECONDS" "$url"
}

json_field() {
  local json_input="$1"
  local python_expr="$2"
  python3 -c "import json,sys; obj=json.load(sys.stdin); print($python_expr)" <<<"$json_input"
}

print_section "Health Check"
HEALTH="$(fetch_json "$BASE_URL/health/live")"
echo "$HEALTH" | pretty_print_json

print_section "GET /intel/search?q=..."
SEARCH_JSON="$(fetch_json "$BASE_URL/intel/search?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$SEARCH_QUERY'''))")")"
echo "$SEARCH_JSON" | pretty_print_json

if [[ -z "$AGENT_ID" ]]; then
  AGENT_ID="$(json_field "$SEARCH_JSON" "next((r.get('agent', {}).get('nvmAgentId') for r in obj.get('results', []) if r.get('agent', {}).get('nvmAgentId')), '')")"
fi

if [[ -z "$AGENT_ID" ]]; then
  echo "Error: AGENT_ID is not set and no result from /intel/search provided an nvmAgentId." >&2
  echo "Set AGENT_ID explicitly, e.g. AGENT_ID=1986... bash scripts/test-intel-endpoints.sh" >&2
  exit 1
fi

print_section "GET /intel/agent/:agentId  (agentId=$AGENT_ID)"
AGENT_JSON="$(fetch_json "$BASE_URL/intel/agent/$AGENT_ID")"
echo "$AGENT_JSON" | pretty_print_json

if [[ -z "$COMPARE_IDS" ]]; then
  COMPARE_IDS="$(json_field "$SEARCH_JSON" "','.join([r.get('agent', {}).get('nvmAgentId', '') for r in obj.get('results', []) if r.get('agent', {}).get('nvmAgentId')][:3])")"
fi

COMPARE_COUNT="$(python3 -c "print(len([x for x in '''$COMPARE_IDS'''.split(',') if x.strip()]))")"
if [[ "$COMPARE_COUNT" -lt 2 ]]; then
  echo "Error: Need at least 2 IDs for /intel/compare. Found: '$COMPARE_IDS'" >&2
  echo "Set COMPARE_IDS explicitly, e.g. COMPARE_IDS=id1,id2[,id3] bash scripts/test-intel-endpoints.sh" >&2
  exit 1
fi

ENCODED_COMPARE_IDS="$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$COMPARE_IDS'''))")"

print_section "GET /intel/trending"
TRENDING_JSON="$(fetch_json "$BASE_URL/intel/trending")"
echo "$TRENDING_JSON" | pretty_print_json

print_section "GET /intel/avoid"
AVOID_JSON="$(fetch_json "$BASE_URL/intel/avoid")"
echo "$AVOID_JSON" | pretty_print_json

print_section "GET /intel/compare?ids=...  (ids=$COMPARE_IDS)"
COMPARE_JSON="$(fetch_json "$BASE_URL/intel/compare?ids=$ENCODED_COMPARE_IDS")"
echo "$COMPARE_JSON" | pretty_print_json

echo
echo "Done."
