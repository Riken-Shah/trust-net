#!/usr/bin/env bash

set -euo pipefail

required_vars=(
  CLOUDFLARE_API_TOKEN
  NVM_API_KEY
  OPENAI_API_KEY
)

missing_vars=()
for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    missing_vars+=("${var_name}")
  fi
done

if (( ${#missing_vars[@]} > 0 )); then
  printf 'Missing required environment variables: %s\n' "${missing_vars[*]}" >&2
  exit 1
fi

printf '%s' "${NVM_API_KEY}" | npx wrangler secret put NVM_API_KEY
printf '%s' "${OPENAI_API_KEY}" | npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
