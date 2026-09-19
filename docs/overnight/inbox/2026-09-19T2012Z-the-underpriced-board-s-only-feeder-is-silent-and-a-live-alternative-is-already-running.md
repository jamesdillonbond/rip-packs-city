# The Underpriced board's "only feeder" is silent — and a datacenter-independent mirror is already running

**Filed 2026-09-19 ~1:1x PM PT (Cowork cloud). Read-only finding; nothing shipped. ⛔ The
substitution below is NOT verified equivalent — see §4 before acting on it.**

## 1. The alarm, and the explanation that does NOT fit

`detect_stalled_pipelines()` reads 2. Both matter, one is high:

| pipeline | severity | silent | last run | threshold |
|---|---|---|---|---|
| `snapshot-institutional-wallets` | **high** | **31.8 h** | 2026-09-18 12:17Z | 1,800 min |
| `topshot-active-listings-ingest` | medium | 18.9 h | 2026-09-19 01:13Z | 900 min |

The watchlist note on the second says a >900 min gap *"means the desktop that is the board's only
feeder has been dark, which is exactly the detection"*.

🚨 **The desktop was not dark.** In the same window `panini-ingest` — a Windows Task Scheduler job
on the SAME box — logged **679 batches, all ok**, across six walks (21/01/05/09/13/17Z). The box
was up and running scheduled tasks all day. `topshot-active-listings-ingest` ran **once in 30
hours**, and that one run was `ok`.

## 2. What it is not — three causes ruled out with evidence

- **Not the DB.** The 2026-08-26 index fix is intact: `fmv_snapshots_2026_coll_ed_ct_fmv_conf_idx`
  is `indisvalid`, 176 MB, **28,383,238 scans, last used 20:08:09Z — two minutes before filing.**
  (Its 120 MB strict-subset sibling `..._fmv_idx` is gone, which was the recorded follow-up.)
- **Not Atlas.** Positive control, all inside 24 h and all minutes old: `ts-listings-atlas-sync`
  **317/317 ok**, `atlas-market-feed` 630/621, `atlas-editions-refresh` 664/661, `sales-atlas-sync`
  142/142, `topshot-listing-cache` 72/72.
- **Not a partial run.** Both instruments agree nothing landed: no `pipeline_runs` row, and
  `topshot_active_listings.last_seen_at` max is **01:36Z**.

⚠ **What I could NOT separate from here:** "the task never fired" vs "it fired and died before any
write". The documented GET-phase death writes nothing either (known-issues #30 — `log_pipeline_run`
is in the POST phase), so both look identical from the database. **The evidence that separates them
is on the box:** the task's `Tee-Object` log and Task Scheduler's `LastTaskResult`.

⛔ **And one number that looks alarming is NOT evidence.** `pg_stat_statements` shows
`topshot_serial_board_targets` at **225 calls, mean 8,664 ms, max 29,949 ms** — and that max is
99.8% of `service_role`'s 30 s ceiling and *identical* to the documented PRE-fix max. But
`stats_reset` is **2026-08-12**, which is **before the 2026-08-26 index fix**, so the sample spans
the change point and the max is almost certainly a corpse from the old era. It does not show a
regression, and must not be quoted as one.

## 3. The user-facing consequence, which is honest but stale

`topshot_active_listings` (925 rows / 357 `active`) feeds the public **Underpriced #1s /
Perfect-mints** board, and `active` is only cleared by a *successful* ingest. Live right now the
board serves a listing from **2026-06-24** at $199 against a $637 serial FMV — a listing that may
well have sold. The rows carry `last_seen_at` (~18.7 h) and the page prints its age at ≥4 h, so the
surface is **disclosed, not fabricated**. It is simply 18.7 h old.

## 4. 👉 The lead: the "only feeder" may not be the only possible one

`topshot_atlas_market_events`, fed by `ts-listings-atlas-sync` (317/317 ok), measured at filing:

- **2,378,378 rows · 464,378 unsold (`purchased_at IS NULL`)**
- **20,301 rows seen in the last hour**, newest **36 seconds old**
- `offer_type` ∈ **EDITION, PARALLEL, SERIAL** — and the board is SERIAL-level

So a live, datacenter-independent Top Shot market mirror with ~500× the rows and sub-minute
freshness is **already running** beside a board whose source is a day stale. The watchlist note's
own prescription — *"the fix is the box's availability or a second datacenter-independent feeder,
NOT a bigger number"* — has a candidate for that second feeder already in the estate.

⛔ **THIS IS A LEAD, NOT A RECOMMENDATION, AND THE DIFFERENCE IS THE WHOLE POINT.** I have NOT
verified the mirror is equivalent: whether `price_cents` is the same ask the board means, whether
`purchased_at IS NULL` is the same predicate as `active`, whether the dapper.market `listing_url`
and `nft_id` linkage survives, or whether its notion of a live listing matches. **This estate has
already paid for exactly that assumption** — `edition_fmv_current` was "111× faster on an identical
row count" and still carried **233 `fmv_usd` + 79 `confidence` disagreements** and admitted 30
editions the board does not show. A row-count match is not equivalence.

**The cheap next step is a diff, not a swap:** for the 357 currently-`active` rows, compare ask and
liveness against the mirror and count the disagreements before anyone repoints anything.

## 5. Not done, and why

Nothing was shipped. The two live causes need Trevor's box (Task Scheduler is UIPI-blocked from
here), and repointing a public pricing board's data source is a design decision with a measured
precedent for going wrong. Filing beats guessing.
