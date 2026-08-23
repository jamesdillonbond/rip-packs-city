# Golazos Series 2 and 3 never existed on chain — and the series route, dead on every collection when I started, now returns 200 on all 26 URLs

**Filed 2026-08-22 (PT) 22:49 by Claude (Cowork, cloud), with Chrome + Flow mainnet egress.**
⚠ The filename carries the UTC stamp (`2026-08-23T0210Z`) as this directory does; the PT date is the 22nd. Timestamp read from the DB, not the sandbox clock.
Closes [the 08-22 filing](2026-08-23T0020Z-golazos-collection-series-claims-two-seasons-that-no-instrument-can-see.md).

⚠ **This document was rewritten twice as I got things wrong. Both corrections are kept in
place rather than edited out — §3 and §4 are the useful part of the filing.**

---

## 1. Series 2 / Series 3 — settled from the contract, rows deleted

Flow mainnet `/v1/scripts` against the Golazos contract at **`0x87ca73a41bb50ad5`**:

| on-chain field | value | what it settles |
|---|---|---|
| `Golazos.nextSeriesID` | **2** | exactly ONE series ever created — `{id 1, "Series 1", active}` |
| `Golazos.nextEditionID` | **576** | 575 editions ever minted, the exact size of our catalogue |
| `Golazos.totalSupply` | **1,919,761** | matches `get_series_detail(...).total_circulation` exactly |

Three instruments outside our pipelines agree: `laligagolazos.com` serves `/editions/575` (200)
and 500s from 576 up, with marketplace facets topping out at season **2022-2023** and no Series
facet at all (footer still © 2023); `dapper.market/laliga/edition/600` is "Edition not found"
while 541 renders; our own `editions` holds ids **1..575 with zero gaps**.

⚠ The prior filing's "second contract" hypothesis is **refuted**, not merely unsupported — a
second contract would still surface on the vendor's own front-end.

**Applied:** `audit_20260823_drop_phantom_golazos_series_2_3`. Pre-flight: nothing FK-references
`collection_series`, and no Golazos edition carries `series` 2 or 3.

```sql
-- REVERT
INSERT INTO collection_series (id, collection_id, series_number, display_label, season) VALUES
  (29,'06248cc4-b85f-47cd-af67-1855d14acd75',2,'Series 2','2023-24'),
  (30,'06248cc4-b85f-47cd-af67-1855d14acd75',3,'Series 3','2024-25');
```

## 2. The state I found the series route in

Every `/[collection]/series/[slug]` page was returning **HTTP 500** with
`canceling statement due to statement timeout` (SQLSTATE **57014**), logged from both
`generateMetadata` and the page. R19 in the page source already counted **259 occurrences across
38 users in 7 days**, and all 26 of those URLs are submitted to Google by
`lib/sitemap-data.ts:591-598`.

`get_series_detail` cost, `EXPLAIN (ANALYZE)` — one `LEFT JOIN LATERAL` over `fmv_snapshots`
**per edition**:

| series | editions | before |
|---|---|---|
| NFL All Day `series-4` | 54 | 10 ms |
| Golazos `series-1` | 575 | 1,573 ms warm / 4,610 ms cold |
| Top Shot `series-4` | 3,600 | 21,229 ms warm / 43,750 ms cold |

⛔ **First correction.** I wrote "the 8 s ceiling never fires — the guard rail is decorative",
inferred from a 21–44 s completion against a function declaring `SET statement_timeout TO '8s'`.
That is [[function-proconfig-statement-timeout-is-inert]] **case (b)** (psql/pg_cron). Production
reaches it as a **PostgREST `rpc/` entry point** — **case (a), where it binds and fires**, which
is exactly what the 57014 in the logs says. Memory recorded that correction on 2026-08-17 and I
re-derived the wrong half before reading it.

## 3. ⛔ Second correction, and the actual defect: the rollup already existed

Before finding this I designed, built, verified and populated a `series_stats_rollup` table plus
a refresh function. Then I listed `cron.job` and found:

> jobid **357** `rpc-series-detail-rollup` — `59 * * * *`, `cron_heavy`,
> `SELECT public.refresh_series_detail_rollup(240);`

**`series_detail_rollup` already existed, complete (26 rows, all five collections including
Pinnacle), fresh (21 minutes old when I found it), and correct** — its numbers matched the live
computation exactly. `get_series_detail` simply never read it.

👉 **The defect was never a missing rollup. It was a rollup with no reader.** A precomputed table
nobody queries is indistinguishable, from the outside, from a table that does not exist — and
the second-order cost is that the next person builds it again. I did. **`cron.job` and
`information_schema` are part of "grep first", not just the repo.**

My duplicate was dropped in `audit_20260823_drop_duplicate_series_stats_rollup`, including the
one `pipeline_runs` row it wrote, so no retired pipeline name can read as "stopped reporting".

## 4. ⛔ Third correction: RETRACTING the "permanent spinner" finding

Earlier drafts of this filing claimed a second, distinct failure mode: pages whose server render
succeeded but whose Suspense boundary never completed, leaving **"SCANNING THE MARKETPLACE…"**
on screen forever with the full page stranded in `<div hidden id="S:0">`. I called it
route-specific on the strength of one control — `/laliga-golazos/edition/541`, which had
relocated its `S:0` normally earlier in the same session.

**That control does not hold. Re-run at the end of the session, the edition page strands its
`S:0` too** — same browser, same session, a page whose CTA I had watched render at 217×47.

And the served HTML is complete. Fetched with a Googlebot UA from outside the browser entirely:

| url | status | bytes | edition links | JSON-LD | `$RC` script |
|---|---|---|---|---|---|
| `/nba-top-shot/series/series-7` | 200 | 253,522 | 11 | `numberOfItems: 25` | `$RC("B:0","S:0")` present |
| `/laliga-golazos/series/series-1` | 200 | 227,914 | 25 | `numberOfItems: 25` | `$RC("B:0","S:0")` present |

The server sends the content **and** the script that swaps it in. So whatever I was watching is
a condition of this browser session — the likeliest candidate being that this box is
**logged in as Trevor** and every page load preloads **15,108 owned moments**
([[chrome-mcp-live-qa-gotchas]] already records the logged-in caveat) — not something an
anonymous visitor or a crawler hits. **Not a site bug. Withdrawn.**

⚠ The lesson is the cheap one: **a control that passes once is not a control.** Re-run it at the
end, against the same claim, or it is just an anecdote that happened to agree with you.

## 5. What shipped, and the proof

| migration | what |
|---|---|
| `audit_20260823_drop_phantom_golazos_series_2_3` | deletes the two phantom Golazos series |
| `audit_20260823_get_series_detail_reads_existing_series_detail_rollup` | `get_series_detail` reads the rollup; each branch keeps its original live computation as the fallback for a series with no row, so a new series is slow-but-correct rather than fast-and-wrong |
| `audit_20260823_drop_duplicate_series_stats_rollup` | removes my duplicate |
| `audit_20260823_get_series_editions_project_after_limit` | projects **after** the `LIMIT`, so `entity_rep_nft_id()` runs 100× instead of 4,895×, plus a partition-pruning predicate |
| `audit_20260823_series_detail_rollup_enable_rls` | pre-existing `check_public_security_invariants()` violation, now clean |
| `audit_20260823_series_detail_rollup_duration_ms_never_recorded` | an instrument that could never fire |

**Before / after, Top Shot `series-7` — 4,895 editions, the heaviest series we have:**

| rpc | before | after |
|---|---|---|
| `get_series_detail` | 21,229 ms, 23k buffers | **37 ms, 523 buffers** |
| `get_series_editions` | 36,134 ms, 32,461 buffers, 4,026 reads | **219 ms, 18,198 buffers, 125 reads** |
| `get_series_rollups` | 104 ms | unchanged |

**Equivalence, checked before each swap rather than after:**

- `get_series_detail`: all six aggregates against the live lateral on **all 26 series**, three
  collections plus Pinnacle, 0–4,895 editions. Every column matched.
- `get_series_editions`: the new two-phase shape against the old single-CTE shape for Top Shot
  `series-7`, position by position — **100 rows, 0 mismatches** on `route_slug`, `fmv_usd` and
  `rep_nft_id`.

**End-to-end:** all **26/26** series URLs return **HTTP 200** with full payloads, 0.33–4.27 s,
fetched with a Googlebot UA from outside the browser. Zero non-200.

`check_public_security_invariants()` and `check_secdef_anon_execute_violations()` both return
`[]`.

## 6. What is NOT fixed

- **`get_series_editions` still costs ~3.5 ms per edition** in phase 1, because ordering the grid
  by FMV needs a latest-FMV read for every edition in the series. It fits inside 8 s today at
  4,895 editions; it will not at ~2× that. The durable fix is a per-edition latest-FMV rollup —
  the thing the `fmv_current` VIEW pretends to be — which would also serve other surfaces.
  **Deliberately not built here:** it is shared architecture, and I had already built one
  redundant rollup tonight without checking (§3).
- **`get_series_detail` now depends on cron jobid 357.** A missing row falls back correctly; a
  STALE row does not announce itself. The refresh currently takes **7.0 s** for all 5 collections
  against a 240 s budget, writes `pipeline_runs('series-detail-rollup')`, and now records
  per-collection `duration_ms`. Worth a staleness arm on the trust board.
- The source comment calling these *"transient RPC failure (statement timeout under contention)"*
  is still there and is still the wrong diagnosis. Route/.tsx edits cannot be pushed from Cowork.

---

## 7. The same defect was on the SET route, and it is 40× more traffic

Once the series shape was understood, `pg_stat_statements` (service_role, PostgREST entry
points) named the rest of the family:

| function | calls | mean_ms | max_ms |
|---|---|---|---|
| `get_edition_detail` | 65,144 | **122.4** | 7,783.9 |
| `get_player_detail` | 15,003 | 326.2 | 6,919.7 |
| **`get_set_editions`** | **6,237** | **1,820.5** | 7,990.3 |
| `get_series_detail` | 173 | 783.9 | 7,975.0 |
| `get_series_editions` | 149 | 961.6 | 6,995.7 |

**`get_set_editions` is the cleanest instance of the defect in the codebase.** Its `ORDER BY` is
`tier_rank, circulation_count, player_name` — three columns of `editions` and **nothing from
FMV** — so the `LIMIT` was always satisfiable from `editions` alone. It still computed the
per-edition `fmv_snapshots` lateral *and* `entity_rep_nft_id()` for every edition in the set
first. `/nba-top-shot/set/base-set` is 3,609 editions of work to render 100.

| | before | after |
|---|---|---|
| `get_set_editions('…','base-set',100,0)` | **10,676 ms**, 29,473 buffers, 3,501 reads | **31 ms**, 2,665 buffers, 20 reads |

Shipped as `audit_20260823_get_set_editions_project_after_limit`. **Equivalence proved by md5 of
the full jsonb output captured BEFORE the swap** — `base-set`, `holo-icon`, `throwdowns`, all
three byte-identical after.

At 6,237 calls × 1,820 ms this was roughly **11,350 seconds of DB time** in the pg_stat_statements
window. That is contention relief for the whole instance, not one page.

`get_player_editions` has the same shape but the largest player in the catalogue has **127**
editions, so the saving is ~27 wasted `entity_rep_nft_id()` calls. **Deliberately not changed** —
churn on a hot public RPC needs a reason bigger than that.

## 8. ⭐ The "45,000 ms class, unexplained since 2026-08-15" is NOT query time

The ledger's R19 entry records `rpc get_edition_detail timed out after 45000ms` **15,388 times
across 2,963 distinct users in 7 days**, and flags the 45 s class as an unexplained regression.

Two measurements settle half of it:

1. **`get_edition_detail` is cheap.** `EXPLAIN (ANALYZE)`: **428 ms** for Golazos edition 541 and
   **88 ms** for `49:1662` — the largest Top Shot edition in the catalogue at 239,882 circulation.
2. **The database never sees a 45 s execution of it.** Across **65,144** PostgREST calls its
   `max_exec_time` is **7,783.9 ms** — pinned just under the function's own 8 s `proconfig`
   ceiling, exactly the clustering signature that ceiling produces. Every sibling in the table
   above is capped the same way (6,919–7,990 ms).

👉 **45,000 ms is `DEFAULT_RPC_TIMEOUT_MS` in `lib/analytics/rpc-with-retry.ts`, and the DB cannot
produce it.** So the 45 s class is a **connection-acquire / transport stall**, not statement
execution — precisely what that file's own 2026-08-13 comment predicted ("a stuck
connection-acquire inside Supavisor parks the await indefinitely… the retry loop never runs,
because there is no error to retry"). The remaining question is what saturates the pool, not what
the query costs.

⚠ Which is why §7 matters more than its page count: removing ~11,350 s of DB time from the
busiest entity RPC is a direct lever on the thing that produces those stalls. **Whether it moves
the 45 s count is now a measurable prediction — check `get_edition_detail` 45 s throws over the
next 7 days against the 15,388 baseline.** If it does not move, the saturation source is
elsewhere and that is worth knowing too.

## 9. Verified after everything

- **26/26** series URLs → HTTP 200 (0.33–4.27 s).
- `/nba-top-shot/set/base-set`, `/set/metallic-gold-le`, `/set/holo-icon` → **200** (3.9–4.6 s).
- `/nba-top-shot/edition/49:1662` → 200 · `/nba-top-shot/player/lebron-james` → 200.
- `check_public_security_invariants()` → `[]` · `check_secdef_anon_execute_violations()` → `[]`.
- Every touched function: **one overload, SECURITY DEFINER intact, `postgres | service_role`
  only** (plus `cron_heavy` on the refresh, which needs it). No `CREATE OR REPLACE` re-grant.
