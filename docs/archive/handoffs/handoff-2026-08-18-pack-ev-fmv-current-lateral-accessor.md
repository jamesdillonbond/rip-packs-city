# Handoff 2026-08-18 — pack-EV `fmv_current` lateral accessor (item 1)

## Context

Cowork shipped nothing for this item and **deliberately did not apply the migration**. HEAD at time of
writing: `5998aba8`. This is a **pricing path** on a saturated instance, and per `focus.md` *"measure in
a quiet window — during a saturation spell no timing is interpretable."* This handoff is the prepared,
reviewable package so it can go out the moment the instance is quiet.

⚠ Unusually, this is **not** a credentials handoff — Cowork can apply migrations. It is handed over
because the change cannot be **verified** from here, and an unverified rewrite of the EV core is the
one thing this codebase has been burned by most.

Scope is the **one pinned, measured function** only: `compute_pack_ev_per_edition_weighted`
(jobid 71's callee, ~100 min/week of `cron_heavy` for zero rows). `compute_pack_ev_from_pool` and
`compute_pack_ev_from_pool_tier_weighted` have **no pin file and no measurement — they must not gate
this.**

---

## Item 1 — replace the `fmv_current` LEFT JOIN with a lateral accessor

### Files touched (all verified to exist)

- `supabase/migrations/<new>_audit_20260818_pack_ev_lateral_fmv_accessor.sql` — new
- `supabase/tests/compute_pack_ev_per_edition_weighted.sql` — **362 lines, exists, needs restructuring (see 1c)**
- `__tests__/db-invariants-drift-guard.test.ts` — PINS entry at **line ~170**, verified present

### 1a. Root cause

The function's pool CTE does:

```sql
FROM pack_drop_pool pdp
LEFT JOIN fmv_current fc
  ON fc.edition_id = pdp.edition_id
 AND fc.collection_id = pdp.collection_id
```

`fmv_current` is a **view**: `SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots ORDER BY edition_id,
computed_at DESC`. The `DISTINCT ON` is not push-downable, so **every dist — even a 21-row one —
materialises the whole 1,149,004-row `fmv_snapshots_2026` partition.** Measured previously: dist 4184
cannot complete; a correlated lookup returns in **35 ms cold / 7 ms warm**.

⛔ **Never `CREATE OR REPLACE VIEW fmv_current`** — it resets `security_invoker`. Fix the **callers**.

### 1b. ⚠⚠ THE EQUIVALENCE SUBTLETY — this is the part to get right

The view dedups on **`edition_id` ALONE**; `collection_id` is merely *carried* from the winning row.
So the existing join means: *take the latest snapshot for this edition across all collections, then keep
it only if that row's collection matches.* Two candidate rewrites are **NOT** equivalent:

```sql
-- (A) STRICTLY EQUIVALENT to today: pick latest across collections, THEN filter
LEFT JOIN LATERAL (
  SELECT x.fmv_usd FROM (
    SELECT fs.fmv_usd, fs.collection_id
      FROM fmv_snapshots fs
     WHERE fs.edition_id = pdp.edition_id
     ORDER BY fs.computed_at DESC
     LIMIT 1
  ) x WHERE x.collection_id = pdp.collection_id
) fc ON true

-- (B) FASTER, and index-only on 2026, but picks latest *within* the collection
LEFT JOIN LATERAL (
  SELECT fs.fmv_usd
    FROM fmv_snapshots fs
   WHERE fs.collection_id = pdp.collection_id
     AND fs.edition_id    = pdp.edition_id
   ORDER BY fs.computed_at DESC
   LIMIT 1
) fc ON true
```

(A) and (B) diverge **only** when one `edition_id` has snapshots under more than one `collection_id`.
Trevor measured that as **0 rows today**, which is why (B) is safe *now*.

👉 **Recommendation: ship (B) for the index-only win, and add the standing invariant that makes it
safe** — assert no `edition_id` spans >1 `collection_id`. That converts a one-time observation into a
permanent guard, so if it ever becomes false, CI fires instead of prices silently drifting.
⚠ If you would rather not carry that invariant, ship (A) — it is correct unconditionally and still
avoids the full-partition scan.

**Index support (verified):** `fmv_snapshots_2026_coll_ed_ct_fmv_idx` on
`(collection_id, edition_id, computed_at DESC) INCLUDE (fmv_usd)` makes (B) **index-only on 2026**.
2025/2027 have the non-covering `(collection_id, edition_id, computed_at DESC)`. (A) is served by
`idx_fmv_edition_time (edition_id, computed_at DESC)`.
⚠ There is **no `computed_at` predicate**, so neither form prunes partitions — each lookup probes all
three. That is ~3 index probes per pool row (~9k for the 3,097-row dist 4184) versus a 1.15M-row scan.

### 1c. ⛔ BLOCKER: the pgTAP test stubs the wrong object

`supabase/tests/compute_pack_ev_per_edition_weighted.sql` currently does:

```sql
-- fmv_current is a view in prod (latest FMV per edition); the function only LEFT
-- JOINs it on (edition_id, collection_id, fmv_usd), so a plain table stands in.
CREATE TABLE fmv_current (edition_id uuid, collection_id uuid, fmv_usd numeric);
```

Once the function reads `fmv_snapshots` directly, **that stub no longer models what is under test** and
the suite would pass while testing nothing. The test must instead:

1. `CREATE TABLE fmv_snapshots (edition_id uuid, collection_id uuid, fmv_usd numeric, computed_at timestamptz)`.
2. Seed **multiple snapshots per edition at different `computed_at`** so "latest wins" is actually exercised.
3. Seed **one edition whose latest snapshot belongs to a different collection** — the single case where
   (A) and (B) diverge. Pin whichever behaviour you ship. **This is the assertion that makes the
   rewrite safe forever**, and it is deterministic without prod data.
4. Keep every existing D-assertion (typical_pull_ev median, `pool_incomplete`, TS forced-remaining
   basis D5, the EV-neutral coverage-denominator D9) — none of them should move.

⚠ **The drift guard requires the DDL block in this test to be a VERBATIM byte-identical copy of the
migration** (`__tests__/db-invariants-drift-guard.test.ts` fails CI otherwise). Update both together.

### 1d. PINS repoint

In `__tests__/db-invariants-drift-guard.test.ts`, the existing entry:

```js
  {
    // Re-pinned 2026-07-31: …
    // Re-pinned 2026-08-02: fmv_coverage_pct / edition_count counted exhausted …
    fn: "compute_pack_ev_per_edition_weighted",
    test: "supabase/tests/compute_pack_ev_per_edition_weighted.sql",
    migration: "supabase/migrations/20260802210000_audit_20260802_pack_ev_coverage_denominator_pullable_only.sql",
  },
```

Change **only** the `migration:` value to the new filename and add a re-pin comment in the established
style, e.g. *"Re-pinned 2026-08-18: the `fmv_current` LEFT JOIN materialised the whole
`fmv_snapshots_2026` partition on every dist regardless of size; replaced by a lateral accessor. EV
outputs unchanged — see the divergence assertion in the test."*

### 1e. Verification (do NOT skip — this is the EV core)

1. **Value equivalence before/after** on a dist with known output — dist **1211** was previously used
   as the control (25 rows compared, 0 mismatches, sums identical to the cent). Re-run it.
2. **Plan check:** `EXPLAIN (ANALYZE, BUFFERS)` the inner pool query on a *small* dist. The whole point
   is that a 21-row dist stops reading 1.15M rows — confirm on **Buffers**, not wall clock.
3. **The pathological case:** dist **4184** (3,097 pool rows) currently cannot complete. It should.
4. ⚠ **Measure in a quiet window.** Per `focus.md`: during saturation no timing is interpretable.
5. `npx tsc --noEmit` clean; pgTAP suite green; drift guard green.

### 1f. Revert path

Re-apply the previous definition from
`supabase/migrations/20260802210000_audit_20260802_pack_ev_coverage_denominator_pullable_only.sql`
(the current pinned copy), revert the PINS `migration:` value, and restore the test's `fmv_current`
stub. The function is **STABLE and writes nothing** — reverting cannot lose data, it only restores the
slow plan.

---

## Guardrails (repeat every handoff)

- **Direct to `main`.** No branches, no PRs. If a `claude/*` branch is checked out, switch to `main` first.
- **Commit via PowerShell `git`** on Windows — Git Bash `git commit` can silently no-op. Re-verify with
  `git rev-list --count origin/main..HEAD` (expect `0`).
- **`curl` fails silently in Git Bash** for Vercel REST — use PowerShell `Invoke-WebRequest`.
- **Vercel Pro `maxDuration` cap is 800s** — higher sends the deploy to ERROR invisibly.
- **CRLF:** no string-replace patching on Windows; full-file writes, or `findIndex` on split lines.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any
disagreement — adapt to the actual file shape.**

---

## Expected end state

One commit on `main` carrying the migration, the restructured pgTAP test (byte-identical DDL) and the
PINS repoint; pgTAP + drift guard green; dist 4184 computing at all; a small dist's pool query reading
thousands of buffers instead of the full `fmv_snapshots_2026` partition; jobid 71's ~100 min/week of
`cron_heavy` for zero rows collapsing.

---

## ADDENDUM 2026-08-18 ~05:00Z — the blast radius is TWO cron jobs, not one

Found by running the standing `SELECT * FROM check_pgcron_recent_failures();` sweep. `focus.md` credits
**jobid 71** as the caller; there is a **second**, and it is not recorded anywhere:

| jobid | jobname | command | owner | schedule | fails / runs (24h) |
|---:|---|---|---|---|---:|
| **71** | `rpc-backfill-historical-pack-ev` | `SELECT public.backfill_topshot_historical_pack_ev(15)` | `cron_heavy` | `13 * * * *` | **6 / 24 (25 %)** |
| **217** | `rpc-atlas-pack-ev` | `SELECT public.refresh_atlas_pack_ev()` | `cron_heavy` | `25 * * * *` | **5 / 24 (21 %)** |

Both fail with `canceling statement due to statement timeout`, and both timeout `CONTEXT` strings are
the **pool CTE of `compute_pack_ev_per_edition_weighted`, verbatim**:

```
CONTEXT:  SQL statement "WITH pool AS (
    SELECT
      CASE WHEN v_use_original THEN COALESCE(pdp.orig_drop_weight, 0) ELSE pdp.drop_weight END A…
```

### Attribution is unique — checked, not assumed

| function | `WITH pool AS` | exact `v_use_original … orig_drop_weight` CASE | reads `fmv_current` |
|---|---|---|---|
| `compute_pack_ev_per_edition_weighted` | **YES** | **YES** | yes |
| `compute_pack_ev_from_pool` | no | no | yes |
| `compute_pack_ev_from_pool_tier_weighted` | no | no | yes |

Only the pinned function carries that CTE, so the `CONTEXT` identifies it unambiguously. Confirmed from
the other direction too: `prosrc` of **both** `backfill_topshot_historical_pack_ev` and
`refresh_atlas_pack_ev` contains `compute_pack_ev_per_edition_weighted`, and **neither** calls
`compute_pack_ev_from_pool`.

👉 **So fixing the pinned function alone repairs two hourly `cron_heavy` jobs**, each currently burning
its full budget ~1 run in 4 before being killed. That strengthens the case for shipping it on its own
and is additional to the ~100 min/week already attributed to jobid 71.

⚠ All three functions read `fmv_current`, so the other two carry the same defect via a different query
shape — consistent with `dac95c8e`'s "scope is 3 functions". They still need measurement and still must
not gate this.
