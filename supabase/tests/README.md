# DB-invariant tests

Plain-SQL tests that pin the behavior of high-stakes Postgres functions/triggers
(guards, normalizers) — the layer the vitest suites can't reach because it lives
in the database, not in `lib/` or `app/api/`.

## Why plain SQL (not pgTAP, not a schema apply)

The repo's `supabase/migrations/` are **incremental `audit_*` patches over a base
schema created outside the repo** — they do not rebuild the schema from scratch,
and some prod objects (e.g. the destructive-op circuit breaker) were applied via
MCP and were never committed as files. So we can't just apply the migrations to a
fresh Postgres and test the real objects.

Instead each test file is **self-contained**: it creates the minimal fixture
tables the function touches, installs a **verbatim copy of the committed function
DDL**, asserts the invariant, and `ROLLBACK`s. This runs on a vanilla
`postgres:16` (only the `unaccent` contrib extension is needed) — including the
GitHub Actions `postgres` service — with no schema bootstrap.

## Drift protection

Embedding the DDL risks it going stale. `__tests__/db-invariants-drift-guard.test.ts`
(in the **blocking** unit-tests job, no DB required) extracts each function's DDL
from both the SQL test and its source migration and asserts they are identical
(whitespace-normalized). Editing the function in a migration without updating the
test copy — or vice versa — fails CI. When you change a pinned function: update
the migration, copy the new DDL verbatim into the test file, and keep the
`>>> BEGIN verbatim ... >>>` / `<<< END verbatim ... <<<` markers.

## Running locally

```bash
# against any reachable postgres (needs the unaccent contrib extension)
DATABASE_URL="postgres://user@host:5432/db" bash scripts/run-db-tests.sh
```

Each `*.sql` file (except `_helpers.sql`) is one test; a failed `_assert` RAISEs,
which under `psql -v ON_ERROR_STOP=1` exits non-zero and the runner reports it.

## What's pinned

| Test | Function | Invariant |
|---|---|---|
| `norm_player.sql` | `_norm_player` | accent-fold + lowercase + strip trailing Jr/Sr/roman-numeral suffixes + drop non-alphanumerics; NULL→''; idempotent. Underpins name matching in challenge-slot resolution and pack-drop pricing. |
| `fmv_block_phantoms.sql` | `fmv_snapshots_block_phantoms` | a `> $10k` FMV is nulled + audited to `fmv_phantom_attempts` UNLESS it is `HIGH` confidence AND `>= 3` recent sales; ordinary FMVs pass untouched. Keeps phantom grail valuations off the public surface. |

## Adding a test

1. Pick a committed function whose deps you can stub with a few `CREATE TABLE`s.
2. New `supabase/tests/<name>.sql`: `BEGIN;` → fixtures → verbatim DDL (with the
   marker comments) → `SELECT _assert…` lines → a `✓` result → `ROLLBACK;`.
3. Add a `PINS` entry to `__tests__/db-invariants-drift-guard.test.ts` pointing at
   the source migration so the copy stays honest.
4. `DATABASE_URL=… bash scripts/run-db-tests.sh` to confirm green locally.
