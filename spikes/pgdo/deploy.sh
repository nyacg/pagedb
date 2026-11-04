#!/bin/sh
# Deploy with the repo's Cloudflare credentials (read from ../../.env, never printed).
cd "$(dirname "$0")"
export $(grep -E '^(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)=' ../../.env | xargs)
exec npx wrangler "${@:-deploy}"
