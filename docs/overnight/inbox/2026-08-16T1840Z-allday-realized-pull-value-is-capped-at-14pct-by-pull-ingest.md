# All Day realized pull value is capped at ~14% by pull ingest, not by the rollup — and the TS dist_id "collapse" is a maturation curve

Filed 2026-08-16 18:40Z (11:40 PT) by Claude Code, from a pack-coverage audit of
ownership / opens / purchases / sales across Top Shot + All Day. The instrument
half of this shipped (`v_pack_pipeline_health` rebuild, `c9cd1c69`); the items
below need lanes this session did not have.

---

## 1. ⚠ THE ONE MOST LIKELY TO BE RE-OPENED AS AN INCIDENT, AND IT IS NOT ONE

Top Shot `primary_withdraw` rows with a resolved `pack_dist_id`, by week:

| week | rows | with dist | pct |
|---|---|---|---|
| 2026-04-20 | 14,341 | 14,113 | 98.4% |
| 2026-05-18 | 31,797 | 29,421 | 92.5% |
| 2026-06-08 | 10,242 | 6,049 | **59.1%** |
| 2026-07-13 | 20,520 | 13,301 | **64.8%** |
| 2026-07-27 | 2,234 | 894 | 40.0% |
| 2026-08-03 | 11,901 | 1,229 | **10.3%** |
| 2026-08-10 | 1,488 | 168 | **11.3%** |

That reads like a pipeline collapsing. **It is a maturation curve.** A Top Shot
`PackNFT.Withdraw` event does not carry `distId` — it resolves when the pack is
**opened**. Measured on the 2026-06-08 cohort: of **4,193** unresolved primary
packs, only **82 (2.0%)** have ever been opened. The unresolved rows are unopened
packs, exactly as the mechanism predicts, and the headline 82.6% is an age-mix.

**Do not go looking for a broken resolver.** The genuine laggards are the two
big-drop weeks stuck below the ~95% norm for their age — **2026-06-08 (59.1%)**
and **2026-07-13 (64.8%)** — i.e. the already-tracked `TS-PACK-DIST-NAME-BACKLOG`.

**The product consequence is the real finding, and it is structural:** for a
still-sealed Top Shot pack we usually know *who holds it* but not *what it is*.
A pack never opened never gets a `dist_id`.

---

## 2. All Day realized pull value: the rollup is fine, the pull ingest is the cap

`pack_rips.pull_value_usd` is populated on **2.2%** of All Day rips (63,274 of
2,815,884). The chain, measured:

- `rollup_allday_rip_pull_value` writes it only when **every** pull in the pack is
  priced (`valued_pulls = total_pulls`). That all-or-nothing gate is **correct** and
  must not be relaxed — a partial sum is a smaller number that reads exactly like a
  real one, making a good pull look like a bad pack.
- It reads `allday_pack_pull`, which holds ~**1.31 M** rows covering roughly
  **393 k** of 2.82 M rips — so even perfect resolution caps pull value at **~14%**.
- Within that, a proper **5% hash sample on `pack_nft_id`** (19,642 packs):
  **19.6% fully valued**, **2.5% fillable** (all editions resolved, FMV missing),
  **78.0% blocked** on at least one unresolved `edition_id`.

**So the dominant blocker is moment→edition resolution, not FMV and not the rollup.**
`allday_pack_pull.fmv_usd` is populated on **217,635** rows and `edition_id` on
**294,046** — i.e. FMV is filled wherever the edition resolved and essentially
nowhere else.

**Filling the ~76 k edition-known/FMV-missing rows is a 0.4 pp move** (~9,800 more
fully-valued packs, 2.2% → ~2.6%). Not worth a bulk UPDATE on a 1.31 M-row table,
certainly not into the saturation measured this session.

**The real fix is the resolver that was built and never wired.**
`get_allday_unresolved_pulls` exists as a SECDEF RPC with **zero callers anywhere in
the repo**. The 2026-08-01 backfill (`audit_20260801_allday_pull_edition_backfill_*`)
used `wallet_moments_cache` + `sales` as sources and staged **65,430** mappings —
that is the ceiling of those two sources, because a moment reaches them only if it
sits in a tracked wallet or has traded. The rest needs upstream hydration via
`getMintedMoment` on the **All Day consumer GQL** (`topshot-proxy` route
`/allday-consumer`), which is the same surface as the standing WAF-403 operator item.
⚠ Confirm the apply ran before assuming otherwise: 79,749 of 80,638 matching rows
already carry an `edition_id`, so the staging→apply step is **not** the gap.

---

## 3. `allday_pack_supply.opened_count` has NO writer — real, and smaller than it looks

`opened_updated_at` max is **2026-06-30** (47 days at time of filing), and no DB
function, edge function, route or script writes the column — it is a one-off snapshot.
It feeds `v_allday_pack_info` → `sync_allday_pack_dist_totals` (pg_cron `24 * * * *`)
→ `pack_distributions.total_opened`, which the pack detail page renders.

**Impact measured before proposing a fix, and it is small.** Against a live count from
`pack_rips` (100% `dist_id` on All Day): **116 dists have advanced, by 1,218 opens
total, worst single gap 337, and ZERO dists where the gap exceeds 5% of supply.** All
Day ended primary pack sales, so the underlying quantity has barely moved.

Cheap fix if wanted: derive from `pack_rips` with `GREATEST(snapshot, rip_count)` —
opened count is monotonic, and the max protects the **52** dists where our rip data
is *behind* the snapshot. ⚠ Do **not** switch wholesale to the rip count: it totals
2,795,541 against the snapshot's 2,819,861, so a straight swap would *reduce* some
counts.

⚠ **Separately, and corrected here:** `allday_pack_supply.total_opened` /
`total_sealed` being 100% NULL is **deliberate**, not a gap. The edge fn
`backfill-allday-pack-supply` omits them with the comment "degenerate for AllDay"
because upstream `availableSupply == totalSupply`. Do not "fix" it.

---

## 4. `allday_pack_purchases_backfill` never terminates (worker lane)

Its auto-stop fires when the backfill cursor is within `ALLDAY_BACKFILL_CATCHUP_THRESHOLD`
(1,000 blocks) of the forward cursor — a threshold that **cannot be met against a
cursor that keeps moving**. Live it sits ~2,072 blocks behind, so it re-treads blocks
the forward cursor already covered forever: **50,877 rows found / 0 written over 7
days** (idempotent `ON CONFLICT`, so harmless but pure waste).

Fix is one constant or a "stop once cursor >= forward at first observation" latch in
`workers/pack-events-ingest/index.ts`. **Needs an operator `wrangler deploy`** — this
session could not deploy a worker.

---

## 5. Things checked and deliberately NOT actioned

- **`rpc-topshot-pack-opens-history` (pg_cron jobid 56)** invokes a backfill that
  returns `done: true` every tick, ~96 calls/day. ⚠ **Do not unschedule it.** The edge
  fn source documents this state explicitly: everything reachable is ingested, the
  sporks below `SPORK_FLOOR` are decommissioned, it is "inert-safe", and it "resumes
  exactly where it left off if the old sporks ever return." It is a deliberate standby,
  not waste. (I nearly retired it before reading the source.)
- **`topshot_pack_purchases_backfill` / `topshot_pack_opens_backfill`** frozen at
  151,610,000 since 2026-05-21/22 are **complete by design** — that is the worker's
  `TARGET_END_BLOCK`. Top Shot on-chain pack-purchase coverage therefore genuinely
  begins ~2026-04 and will not extend backward without a new backfill range.
- **Pack sales is the best-covered of the four** and needs nothing:
  `topshot_pack_sales_history` 584,958 rows back to 2023-09-28 and
  `allday_pack_sales_history` 552,339 back to 2022-12-09, both 100% `dist_id` +
  price, ingesting through today.

---

## 6. Method notes worth keeping

⚠ **An unordered `LIMIT` is not a sample — it is physical order.** A
`select ... from allday_pack_pull limit 300000` reported `edition_id` on **0.1%** of
rows; the true figure is **294,046 (~22%)**. The resolved rows are concentrated
elsewhere in the heap. Every population figure above that needed a sample uses
`abs(hashtext(pack_nft_id)) % 20 = 0` instead.

⚠ **`pipeline_runs_daily` is a SIX-HOURLY rollup** (`11 */6 * * *`) — correct for
volume and trend, wrong for recency. Read `refreshed_at` beside `last_run_at`, and
query `pipeline_runs` directly for "is it running right now".

⚠ **The instance was disk-IO saturated throughout** — five 60 s MCP timeouts,
`fmv-recalc` killed at `maxDuration` on ~63–75% of invocations. Two aggregate queries
in this audit could not complete at all and are recorded as unmeasured rather than
estimated (notably the exact "seen and never ripped" sealed-pack intersection for
Top Shot, which would quantify how many of the 651,183 sealed TS packs have a known
holder).
