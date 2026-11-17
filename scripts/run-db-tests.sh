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

# ⚠ Pin the SESSION time zone. Several tests assert a rendered `timestamptz`
# (psql prints it in the session zone), so on a non-UTC machine they fail on the
# OFFSET while describing the same instant — e.g.
#   got [2026-06-30 17:00:00-07] want [2026-07-01 00:00:00+00]
# which reads like a logic bug and is not one. CI containers happen to be UTC, so
# this was invisible there while failing for anyone running the suite locally —
# and Trevor's box is PT, which is exactly where it bites. Prod Postgres is UTC,
# so pinning here makes the suite match production rather than the developer.
# Do NOT "fix" a future instance of this by editing the expected string to the
# local offset; that just moves the breakage to the next machine.
export PGTZ=UTC

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
# ⚠ ASSERT THE COUNT INSPECTED. An emptied supabase/tests/ (or a glob matching
# only _helpers.sql) used to exit 0 here — a pass by inspecting nothing. 90 is
# half of the 183 files present on 2026-09-02 and far above the 0 of that shape.
if [ "$count" -lt 90 ]; then
  echo "::error::ran only $count DB-invariant test file(s); 90 is the floor (183 on 2026-09-02). The walk is wrong, not the DB clean."
  exit 1
fi
exit $fail
