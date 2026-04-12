#!/bin/bash
TOKEN="rippackscity2026"
BASE="https://rip-packs-city.vercel.app/api/ingest/backfill"

for YEAR in 2025 2024; do
  echo "========== BACKFILLING $YEAR =========="
  CURSOR=""
  TOTAL_INSERTED=0
  TOTAL_SKIPPED=0
  PAGE=1
  ZERO_STREAK=0

  while true; do
    URL="$BASE?year=$YEAR&limit=500"
    [ -n "$CURSOR" ] && URL="$URL&cursor=$CURSOR"

    echo "--- Page $PAGE (cursor=${CURSOR:-start}) ---"
    RESP=$(curl -s -X POST "$URL" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json")

    echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"

    INSERTED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('rows_inserted',0))" 2>/dev/null)
    SKIPPED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('rows_skipped',0))" 2>/dev/null)
    HAS_MORE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hasMore',False))" 2>/dev/null)
    NEXT=$(echo "$RESP" | python3 -c "import sys,json; c=json.load(sys.stdin).get('nextCursor',''); print(c if c else '')" 2>/dev/null)
    OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null)

    if [ "$OK" != "True" ]; then
      echo "ERROR on page $PAGE — stopping $YEAR"
      break
    fi

    TOTAL_INSERTED=$((TOTAL_INSERTED + INSERTED))
    TOTAL_SKIPPED=$((TOTAL_SKIPPED + SKIPPED))

    echo ">> year=$YEAR page=$PAGE inserted=$INSERTED skipped=$SKIPPED hasMore=$HAS_MORE running_total=$TOTAL_INSERTED"

    if [ "$INSERTED" -eq 0 ] 2>/dev/null; then
      ZERO_STREAK=$((ZERO_STREAK + 1))
    else
      ZERO_STREAK=0
    fi

    if [ "$ZERO_STREAK" -ge 3 ]; then
      echo "3 consecutive pages with 0 inserts — stopping $YEAR"
      break
    fi

    if [ "$HAS_MORE" != "True" ] || [ -z "$NEXT" ]; then
      echo "No more data for $YEAR"
      break
    fi

    CURSOR="$NEXT"
    PAGE=$((PAGE + 1))
  done

  echo "========== $YEAR FINAL: inserted=$TOTAL_INSERTED skipped=$TOTAL_SKIPPED =========="
  echo ""
done
