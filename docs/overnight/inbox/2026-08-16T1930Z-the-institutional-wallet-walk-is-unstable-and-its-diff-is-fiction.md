# The institutional wallet walk is unstable, and everything derived from its diff is fiction

**Filed 2026-08-16 19:30Z (Claude Code, interactive). Contained downstream, root cause NOT fixed.**

## What is wrong

`snapshot-institutional-wallets` writes a daily `wallet_holdings_snapshot` row per
(wallet, collection) holding a `moment_ids` array, and
`compute_institutional_wallet_diff()` compares consecutive days to emit
"arrivals" into `topshot_insider_buybacks` as `acquisition_method='direct_transfer'`.

**The walk does not return a stable set, so the diff manufactures arrivals out of
the wallet's own existing stock.**

Measured live on `0x4d2c9216f1dca098` (NBATopShotCommunity):

| measurement | result |
|---|---|
| distinct moments recorded as "acquired" | 41,307 |
| **of those, ALREADY HELD on the first snapshot (2026-05-19)** | **41,301 (99.99%)** |
| genuinely new across the whole history | **6** |
| rows vs distinct moments | 161,366 / 41,307 = **3.91×** |
| daily "arrivals" present in the wallet TWO DAYS EARLIER | **62–86%** across 9 consecutive day-triples |
| sampled direct_transfer moments appearing in `sales` at any time | **0 of 200** |
| positive control — marketplace rows on the same join key | **208 of 208, all priced** |

Corroborating: holdings are flat at ~52,120 (daily deltas 0, ±1, ±4) while the
table claimed ~6,500 acquisitions/day. And the snapshot array itself is **13.6%
duplicates** — 52,123 entries, 45,059 distinct — so `moment_count` (and
`seeded_wallets.cached_moment_count`) **overstate the real holding**. Duplicate
emission plus skipping is the classic signature of paginated iteration with
unstable page boundaries.

⚠ **The 62–86% flip-flop figure is a LOWER bound** — it only catches moments
absent for exactly two days. A moment absent for three or more days and then
returning is equally impossible as an acquisition and is not counted there.

## What was contained (shipped 2026-08-16)

- `rpc_topshot_buyback_analytics` now aggregates **only** `acquisition_method='marketplace'`
  and reports `coverage.excluded_snapshot_rows` + `excluded_reason`, so the board
  explains its own size instead of implying the buyback programme is inactive.
  Migration `20260816192708_audit_20260816_buyback_analytics_exclude_snapshot_diff_artifacts.sql`.
- `/api/analytics/insider/signals` now filters to `marketplace`. ⚠ **That panel is
  on the live `/analytics` page and had been rendering fabricated events as
  "insider buyback detected"** — the artifact rows outnumber real ones ~375:1 and
  carry today's date, so they occupied every slot. Pinned by a guard that asserts
  the `.eq()` is issued (mutation-verified).

## What was NOT fixed, and what to check before touching it

The walk itself. Two candidate causes, not yet separated:

1. **Pagination instability in the Cadence/GraphQL wallet walk** — overlapping or
   skipping page boundaries would produce duplicates AND omissions simultaneously,
   which is exactly what is observed.
2. **A partial-success write** — the snapshot is written even when the walk did not
   complete, so a short read is recorded as the day's truth.

⚠ **Do not "fix" this by de-duplicating `moment_ids` on write.** That removes the
13.6% duplicate symptom and leaves the omissions, which are the half that
generates the false arrivals — the board would look repaired while the diff kept
fabricating. The duplicates are evidence, not the defect.

⚠ **Do not raise a threshold or add a floor to the diff.** The arrivals are not
noisy-but-real; they are 99.99% impossible.

⚠ **Check `compute_institutional_wallet_diff`'s DEPARTURE arm too.** This
investigation only measured arrivals; departures (5,432 on 2026-08-16) are
produced by the same comparison and are presumably equally unreliable. Nothing
downstream consumes them today, which is the only reason they are not also a
live defect.

## Blast radius verified at filing time

- `topshot_insider_alerts`: **0** rows of type `cluster_buyback` / `low_serial_buyback`
  / `set_concentration`, so the buyback detector has never emitted an alert. The
  alerting path is clean.
- `/analytics` InsiderSignals panel: **was** affected, now filtered.
- `/analytics/buyback`: **was** affected, now filtered.
- The 161,366 rows are left in `topshot_insider_buybacks` deliberately — they are
  the evidence, and no consumer reads them any more.

## The generalizable lesson

A diff between two observations is only as trustworthy as the *stability* of the
observation. Nothing in the pipeline compared a snapshot against anything except
its immediate predecessor, so a walk that returned a different subset each day
produced a large, plausible, self-consistent stream of events — ~6,500 a day for
three months — that no cadence monitor, row-count check or freshness arm could
distinguish from real activity. **The cheapest available falsifier was one query:
were these moments already in the wallet before?**

---

## ADDENDUM 2026-08-16 ~20:10Z — root cause identified, fixed in repo, NOT deployed

### Root cause: `.range()` paged with no `ORDER BY`

The function does **not** walk the chain. It offset-pages `wallet_moments_cache`
in 250-row chunks with `.range()` and **no `.order()`**. Postgres guarantees no
row order without `ORDER BY`, so across ~209 sequential pages rows land on two
pages or on none.

**Proved from the schema, not inferred.** `wallet_moments_cache` carries
`UNIQUE(wallet_address, collection_id, moment_id)` — duplicates are impossible at
source — and live it holds **52,120 rows / 52,120 distinct** for
`0x4d2c9216f1dca098`. The snapshot it wrote holds **52,123 entries / 45,059
distinct**: ~7,064 rows read twice, ~7,061 missed entirely.

⚠ **The count came out within 3 of the truth** because duplicates and omissions
roughly cancel. That is why three months of this passed every check: the walk read
the right NUMBER of rows and the wrong SET. **An earlier version of this file said
`moment_count` overstates the real holding — that was wrong and is corrected here.**

⚠ `lib/supabase-paginate.ts` already stated the rule verbatim. This function
hand-rolled its own loop instead of calling `fetchAllPaged`. A ratchet now
enforces it: `__tests__/paginated-range-requires-order-ratchet.test.ts`.

### Repo is fixed; production is NOT

`.order("collection_id").order("moment_id")` is committed. **The edge function has
not been redeployed, so production still runs the broken read and will keep
appending artifact rows nightly at 06:00 UTC.** Nothing user-facing is harmed —
both consumers (the buyback board and `/api/analytics/insider/signals`) now read
`acquisition_method='marketplace'` only.

### The deploy is blocked on tooling, not on knowledge

Measured drift, deployed v27 vs repo HEAD:

| | deployed v27 | repo HEAD |
|---|---|---|
| supabase-js import | `https://esm.sh/@supabase/supabase-js@2.45.0` | bare `@supabase/supabase-js` (needs `deno.json`) |
| `isTransientErr` | inlined | imported from `../_shared/institutional-snapshot.ts` |
| holdings aggregation | inlined in `captureSnapshot` | `aggregateHoldingsByCollection` from `../_shared/…` |
| the `ORDER BY` | **absent** | **present** |

So the repo carries an undeployed 2026-07-26 `_shared` refactor *on top of* the
fix. ⚠ **`rpc-edge-fn-deploy` §4 documents the MCP fallback as `[{deno.json},{index.ts}]`
— a two-file shape that does not cover a `../_shared/` import.** Deploying via MCP
means inventing an upload layout (nested paths + `entrypoint_path`) that has not
been proven here, and hand-marshalling 566 lines, which §4 explicitly warns
against. Use the CLI, which resolves `_shared` natively:

```
npx supabase@latest functions deploy snapshot-institutional-wallets \
  --no-verify-jwt \
  --import-map supabase/functions/deno.json \
  --project-ref bxcqstmqfzmuolpuynti
```

⚠ `--no-verify-jwt` is mandatory (live value is `verify_jwt:false`; the CLI
defaults it true and would 401 every caller). ⚠ `--import-map` is mandatory
(bare specifier).

⚠ **If the CLI 401s** — §4 records both auth traps as live on Trevor's box — the
MCP route needs `import_map_path:"deno.json"`, `verify_jwt:false`, and files at
`snapshot-institutional-wallets/index.ts`, `_shared/institutional-snapshot.ts`,
`deno.json`, with `entrypoint_path:"snapshot-institutional-wallets/index.ts"` so
that `../_shared/…` resolves. **That layout is a hypothesis; verify with
`shared-deploy-probe` before pointing it at this function.**

### Verifying the deploy — and the one result that will look like a regression

Per §5, a `pipeline_runs` row proves the gate opened. Then check the SET, not the
count:

```sql
select snapshot_at,
       array_length(moment_ids,1)                        as entries,
       (select count(distinct x) from unnest(moment_ids) x) as distinct_ids
from wallet_holdings_snapshot
where wallet_address='0x4d2c9216f1dca098'
  and collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
order by snapshot_at desc limit 3;
```

**Fixed means `entries = distinct_ids` (~52,120).** Before the fix they differ by
~7,064. ⚠ **`entries` alone tells you nothing** — it was already correct.

⚠ **THE FIRST CORRECT RUN WILL RECORD ITS LARGEST-EVER ARRIVAL BURST (~7.5k), AND
THAT IS THE FIX WORKING, NOT A REGRESSION.** The diff compares a now-complete set
against yesterday's 7k-short corrupt baseline, so every row the old walk kept
missing reads as an arrival exactly once. It should fall to single digits the
following day, which is the real confirmation. Do not revert on the burst; the
consumers are filtered, so it reaches nobody.
