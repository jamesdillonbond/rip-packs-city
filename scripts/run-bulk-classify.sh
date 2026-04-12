#!/bin/bash
# Repeatedly calls /api/bulk-classify until all unknown moments are classified.
# Each call processes up to ~55 seconds of work; this script loops until done.

OFFSET=0
TOTAL=99999

while [ $OFFSET -lt $TOTAL ]; do
  echo "Processing from offset $OFFSET..."
  RESULT=$(curl -s "https://rip-packs-city.vercel.app/api/bulk-classify?wallet=0xbd94cade097e50ac&token=rippackscity2026&offset=$OFFSET")
  echo "$RESULT"
  # Extract nextOffset from the last JSON line in the stream
  LAST_LINE=$(echo "$RESULT" | tail -1)
  NEXT=$(echo "$LAST_LINE" | grep -o '"nextOffset":[0-9]*' | grep -o '[0-9]*')
  TOTAL_NEW=$(echo "$LAST_LINE" | grep -o '"total":[0-9]*' | grep -o '[0-9]*')
  STATUS=$(echo "$LAST_LINE" | grep -o '"status":"[^"]*"' | head -1)

  if echo "$STATUS" | grep -q "done"; then
    echo "All moments classified!"
    break
  fi

  if [ -n "$NEXT" ]; then
    OFFSET=$NEXT
  else
    echo "No nextOffset found — stopping."
    break
  fi

  if [ -n "$TOTAL_NEW" ]; then
    TOTAL=$TOTAL_NEW
  fi

  sleep 2
done
echo "Done!"
