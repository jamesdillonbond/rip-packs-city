# `check_public_security_invariants()` is RED for the first time since it was written — on a table whose grants are correct

**Filed 2026-08-22 ~22:10 PT (2026-08-23 ~05:10Z), Claude Code interactive, read-only.
MEASURED, with the exposure question answered rather than assumed. Nothing changed.**

## The finding in one line

`series_detail_rollup` — created hours earlier by the series-precompute work — is a base table with
**RLS off**, so `check_public_security_invariants()` now returns **1 row** (`rls_off_base_table`).
A SETOF check is **0-rows-clean**, so the repo's own security invariant is red.

## It is NOT an exposure, and that was measured, not assumed

| probe | result |
|---|---|
| `has_table_privilege('anon', …, 'SELECT')` | **false** |
| `has_table_privilege('anon', …, 'INSERT')` | **false** |
| `has_table_privilege('authenticated', …, 'SELECT')` | **false** |
| `has_table_privilege('authenticated', …, 'UPDATE')` | **false** |
| migration's grant line | `REVOKE ALL ON TABLE … FROM PUBLIC, anon, authenticated` |
| only reader | `get_series_detail`, **SECURITY DEFINER** (bypasses RLS regardless) |
| rows | 26 |

⚠ **The migration did the documented-correct thing** — CLAUDE.md's rule is to revoke `FROM PUBLIC,
anon, authenticated` in one statement and verify with `has_table_privilege` rather than the acl text,
and that is exactly what happened. **There is no anon-reachable path to this table.**

## So the defect is the INSTRUMENT, and that is the part that matters

The repo's own canon: *"a permanently-red or permanently-zero instrument is indistinguishable from a
broken one at a glance."* This check has been clean for its whole life, which is what made today's
single row legible at all. Leave it red and the next reader learns to skim it — and the row that
matters will arrive looking exactly like this one.

**Two honest resolutions. Both are one-liners; neither is mine to pick.**

1. **`ALTER TABLE public.series_detail_rollup ENABLE ROW LEVEL SECURITY;`** — with the grants already
   revoked and the only reader a definer function, this is a **no-behaviour-change** statement that
   restores the invariant as written. It matches what every other public base table does.
2. **Teach the check that a base table with zero `anon`/`authenticated` privileges is compliant** —
   arguably more honest (the invariant people actually care about is "not anon-readable", not "RLS
   flag on"), but it widens the check's accepted surface, and a check that accepts more is a check
   that catches less.

⚠ **Do not resolve it by suppressing the row.** The suppression list is for *arms*, not for instances,
and this instance is one statement away from being genuinely clean.

## Two facts recorded while measuring this, both about the map rather than the territory

- **`docs/reference/schema-truth.md` said "Tables with `rowsecurity=false`: 0 — the invariant holds".**
  That is now false. The file has been regenerated (2026-08-22) with this entry and the drifted counts
  (public tables 340 → **372**, views 122 → **136**, `editions` 32 → **36** columns).
- ⚠ **That file has NO generator script** (`grep -rn schema-truth scripts/ package.json
  .github/workflows/` → nothing), yet CLAUDE.md granted it "wins on any disagreement with prose".
  It sat **25 days** stale while outranking `database.md`, which had carried the correct 36-column
  figure since 2026-08-14. **The precedence rule now reads "…but only as fresh as its stamp."**
