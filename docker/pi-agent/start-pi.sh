#!/usr/bin/env bash
set -euo pipefail

PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
PI_KNOWLEDGE_CUTOFF="${PI_KNOWLEDGE_CUTOFF:-2025-01-01}"
CURRENT_DATE="$(date -u +%F)"
CURRENT_DATETIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

months_gap="$(awk -v current="$CURRENT_DATE" -v cutoff="$PI_KNOWLEDGE_CUTOFF" '
BEGIN {
  split(current, c, "-");
  split(cutoff, k, "-");
  gap = (c[1] - k[1]) * 12 + (c[2] - k[2]);
  if (c[3] < k[3]) gap -= 1;
  if (gap < 0) gap = 0;
  print gap;
}'
)"

mkdir -p "$PI_AGENT_DIR"

cat > "$PI_AGENT_DIR/APPEND_SYSTEM.md" <<EOF
## Temporal Context

- Current UTC date: $CURRENT_DATE
- Current UTC datetime: $CURRENT_DATETIME
- Your approximate knowledge cutoff: early 2025
- Time gap since cutoff: about $months_gap months

## Freshness Protocol

Treat facts that may change over time as potentially stale by default.

High-risk changing topics:
- library/framework versions and release dates
- API signatures, deprecated methods, current best practices
- LLM model names, provider capabilities, context windows, pricing
- tool/package availability in fast-moving ecosystems

High-risk ecosystems for this image:
- Pi Coding Agent and Pi packages
- ralpix and its prompts/config conventions
- OpenAI, Anthropic, Gemini, OpenRouter-style provider/model catalogs
- React, Next.js, LangChain, Prisma, Pydantic, FastAPI

When answering questions about versions, current APIs, current models, release dates, support status, or whether something exists:
- prefer project files and user-provided facts over memory
- prefer official docs, package metadata, or web verification over memory
- never claim "this does not exist" without verification
- if you are not verifying, say the claim is based on training and may be outdated
- unfamiliar modern syntax or model names are not evidence they are invalid
EOF

exec pi "$@"
