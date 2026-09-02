#!/usr/bin/env bash
# The eligibility-gate demo: show a spend working, delete the Sibyl Memory
# authorization entity live, show the same request refused.
#
#   ./scripts/demo-deletion.sh <telegram_user_id>
#
# Ward must be running (`bun run dev`) in another terminal, on the same
# SIBYL_MEMORY_MODE. Load your .env first (`set -a; source .env; set +a`).

set -euo pipefail
TG_ID="${1:-}"
if [[ -z "$TG_ID" ]]; then
  echo "usage: $0 <telegram_user_id>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cat <<EOF

── Ward deletion-gate demo ──────────────────────────────────────────────
Backend: ${SIBYL_MEMORY_MODE:-sibyl-mcp}

  1. In Telegram, send:   swap \$20 usdc for eth      → confirm "yes"
     Expect: "Swapped \$20 USDC → ETH …" with a basescan link.

  Press Enter here when that has settled on camera.
EOF
read -r

echo "  2. Deleting the ward.authorization entity from Sibyl Memory…"
echo
bun run "$ROOT/scripts/forget-auth.ts" "$TG_ID"
echo

cat <<EOF
  3. In Telegram (same chat, or /newsession), send again:
        swap \$20 usdc for eth
     Expect: "I have no authorization on file for you in Sibyl Memory,
              so I won't move any funds …"
     No transaction. No confirmation prompt.

  The agent still runs — it just has no basis for authority. That is the gate.
────────────────────────────────────────────────────────────────────────
EOF
