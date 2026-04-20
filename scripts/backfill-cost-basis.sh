#!/bin/bash
# Run from project root: bash scripts/backfill-cost-basis.sh
# Processes all owned moments in chunks of 50, looping until done.

if [ -z "$INGEST_SECRET_TOKEN" ]; then
  echo "ERROR: INGEST_SECRET_TOKEN env var is required" >&2
  exit 1
fi

WALLET="0xbd94cade097e50ac"
BASE_URL="https://rip-packs-city.vercel.app/api/cost-basis-gql-backfill"
TOKEN="$INGEST_SECRET_TOKEN"

OFFSET=0
LIMIT=50
TOTAL_INSERTED=0

echo "Starting cost basis GQL backfill for $WALLET"

while true; do
  echo ""
  echo "--- Processing offset=$OFFSET limit=$LIMIT ---"

  RESPONSE=$(curl -s -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"wallet\":\"$WALLET\",\"offset\":$OFFSET,\"limit\":$LIMIT}")

  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

  INSERTED=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('inserted',0))" 2>/dev/null || echo "0")
  DONE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('done',False))" 2>/dev/null || echo "False")
  NEXT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nextOffset',0) or 0)" 2>/dev/null || echo "0")

  TOTAL_INSERTED=$((TOTAL_INSERTED + INSERTED))

  if [ "$DONE" = "True" ] || [ "$DONE" = "true" ]; then
    echo ""
    echo "=== COMPLETE ==="
    echo "Total inserted: $TOTAL_INSERTED"
    break
  fi

  OFFSET=$NEXT
  # Small delay between calls to be kind to the API
  sleep 2
done
