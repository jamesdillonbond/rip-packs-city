#!/usr/bin/env bash
# Every file in supabase/migrations/ must be PARSEABLE SQL.
#
# WHY THIS EXISTS. On 2026-09-13 migration 20260913032000 was found carrying this
# line, with no `-- ` prefix, in the middle of a comment block:
#
#     CREATE OR REPLACE FUNCTION` does not reset a function ACL, so this
#
# It had lost its comment marker when the file was written, which made the whole
# file INVALID SQL (`syntax error at or near "`"`) from the day it landed. Nothing
# saw it: the migration had already been applied through MCP, so the DB was fine
# and `migration-parity` — which checks the applied-but-not-committed direction —
# had nothing to say. The committed record of a production change simply could not
# be replayed, and read as authoritative anyway.
#
# WHAT IT DOES NOT CLAIM. This is a PARSE check, not a replay. Every file is fed
# to a scratch database with ON_ERROR_STOP disabled, so missing-relation and
# duplicate-object errors are EXPECTED and ignored — these migrations are
# incremental patches over a base schema that does not exist here (see
# supabase/tests/README.md). Only `syntax error` counts, because that is decided
# at parse time and is never a consequence of the empty schema.
#
# ⚠ IT ASSERTS THE COUNT IT INSPECTED. A version of this that globbed nothing
# would exit 0 and read as coverage; inspecting zero files is a FAILURE here.
#
# ⚠ AND IT PROVES IT CAN FAIL, every run, before trusting its own zero. The
# self-test feeds a deliberately broken statement through the same psql path and
# aborts if that is NOT detected — so a silenced/localized/miswired psql cannot
# make this guard pass by seeing nothing.
#
# Usage: DATABASE_URL=postgres://... bash scripts/check-migration-sql-parses.sh
set -uo pipefail

export LC_ALL=C LC_MESSAGES=C   # the check greps an English server message

PGURL="${DATABASE_URL:-postgres://postgres@localhost:5432/postgres}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/supabase/migrations"
SCRATCH="migparse_$$"
NEEDLE="syntax error"

admin() { psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "$1"; }
# Swap the database name in the connection URL, in pure bash — no python3
# dependency, because the only hard requirement of this job is a Postgres.
# Splits any ?query off first so it survives the path rewrite.
scratch_url() {
  local base="${PGURL%%\?*}" query=""
  [ "$base" != "$PGURL" ] && query="?${PGURL#*\?}"
  printf '%s/%s%s\n' "${base%/*}" "$SCRATCH" "$query"
}

admin "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null 2>&1
if ! admin "CREATE DATABASE $SCRATCH;" >/dev/null 2>&1; then
  echo "check-migration-sql-parses: could not create scratch database — is DATABASE_URL a superuser?" >&2
  exit 2
fi
SURL="$(scratch_url)"
cleanup() { admin "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

parse_errors() {  # $1 = file; echoes count of syntax errors
  timeout 60 psql "$SURL" -v ON_ERROR_STOP=0 -q -f "$1" 2>&1 | grep -c "$NEEDLE"
}

# ── SELF-TEST: the instrument must be able to see a failure ────────────────
CANARY="$(mktemp)"; printf 'CREATE OR REPLACE FUNCTION` not a comment\n' > "$CANARY"
if [ "$(parse_errors "$CANARY")" -lt 1 ]; then
  echo "check-migration-sql-parses: SELF-TEST FAILED — a known-bad statement was not detected." >&2
  echo "  The guard cannot see syntax errors, so its zero would mean nothing. Refusing to pass." >&2
  rm -f "$CANARY"; exit 2
fi
rm -f "$CANARY"

# ── The sweep ─────────────────────────────────────────────────────────────
inspected=0; bad=0
for f in "$DIR"/*.sql; do
  [ -e "$f" ] || continue
  inspected=$((inspected + 1))
  n="$(parse_errors "$f")"
  if [ "${n:-0}" -gt 0 ]; then
    bad=$((bad + 1))
    echo "SYNTAX  $(basename "$f")  ($n error(s))"
    timeout 60 psql "$SURL" -v ON_ERROR_STOP=0 -q -f "$f" 2>&1 | grep "$NEEDLE" | head -2 | sed 's/^/        /'
  fi
done

if [ "$inspected" -eq 0 ]; then
  echo "check-migration-sql-parses: INSPECTED ZERO FILES — $DIR is empty or unreadable." >&2
  echo "  A guard that looks at nothing must not report success." >&2
  exit 2
fi

echo "── parsed $inspected migration file(s) — $bad with syntax errors"
[ "$bad" -eq 0 ] || exit 1
