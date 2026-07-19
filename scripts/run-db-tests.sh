#!/usr/bin/env bash
# Runs the plain-SQL DB-invariant tests in supabase/tests/ against a Postgres.
#
# Each *.sql file is self-contained: it creates its own minimal fixtures + the
# VERBATIM committed function DDL, asserts its invariants (via _helpers.sql), and
# ROLLBACKs. A failed assertion RAISEs; under `psql -v ON_ERROR_STOP=1` that exits
# non-zero, which this runner reports and aggregates into its own exit code.
#
# Connection: set DATABASE_URL (e.g. postgres://postgres@localhost:5432/postgres).
# No extensions beyond `unaccent` are required, so a vanilla postgres:16 works —
# including the GitHub Actions `postgres` service container.
set -uo pipefail

PGURL="${DATABASE_URL:-postgres://postgres@localhost:5432/postgres}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/tests"
HELPERS="$DIR/_helpers.sql"

fail=0
count=0
for f in "$DIR"/*.sql; do
  base="$(basename "$f")"
  [ "$base" = "_helpers.sql" ] && continue
  count=$((count + 1))
  out="$(psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$HELPERS" -f "$f" 2>&1)"
  if [ $? -eq 0 ]; then
    echo "PASS  $base"
    echo "$out" | grep -E '✓' | sed 's/^/      /'
  else
    echo "FAIL  $base"
    echo "$out" | sed 's/^/      /'
    fail=1
  fi
done

echo "── ran $count DB-invariant test file(s)"
exit $fail
