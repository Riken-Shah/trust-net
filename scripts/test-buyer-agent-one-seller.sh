#!/usr/bin/env bash
set -euo pipefail

SELLER_SELECTOR="${1:-${SELLER_SELECTOR:-}}"
INCLUDE_VERIFIED_TARGET="${INCLUDE_VERIFIED_TARGET:-false}"

if [[ -z "$SELLER_SELECTOR" ]]; then
  echo "Usage: bash scripts/test-buyer-agent-one-seller.sh <seller-selector>" >&2
  echo "The selector must match one of: agents.id, marketplace_id, nvm_agent_id, or exact agent name." >&2
  echo "Optional env:" >&2
  echo "  INCLUDE_VERIFIED_TARGET=true   # include already-verified seller" >&2
  echo "  BUYER_AGENT_TIMEOUT_MS=20000   # override request timeout for this run" >&2
  exit 1
fi

for required_var in NVM_API_KEY OPENAI_API_KEY; do
  if [[ -z "${!required_var:-}" ]]; then
    echo "Error: ${required_var} is required in your environment or .env file." >&2
    exit 1
  fi
done

echo "Running buyer-agent for one seller: ${SELLER_SELECTOR}"
echo "include_verified_target=${INCLUDE_VERIFIED_TARGET}"

BUYER_AGENT_TARGET_SELLER="$SELLER_SELECTOR" \
BUYER_AGENT_MAX_SELLERS=1 \
BUYER_AGENT_INCLUDE_VERIFIED_TARGET="$INCLUDE_VERIFIED_TARGET" \
npm run buyer-agent:run
