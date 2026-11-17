# The Underpriced board's "only feeder" is silent — and a datacenter-independent mirror is already running

**Filed 2026-09-19 ~1:1x PM PT (Cowork cloud). Read-only finding; nothing shipped. ⛔ The
substitution below is NOT verified equivalent — see §4 before acting on it.**

## 1. The alarm, and the explanation that does NOT fit

`detect_stalled_pipelines()` reads 2. Both matter, one is high:

| pipeline | severity | silent | last run | threshold |
|---|---|---|---|---|
| `snapshot-institutional-wallets` | **high** | **31.8 h** | 2026-09-18 12:17Z | 1,800 min |
| `topshot-active-listings-ingest` | medium | 18.9 h | 2026-09-19 01:13Z | 900 min |

> ⛔ **CORRECTION, ~7 MINUTES AFTER THIS FILE WAS WRITTEN — THE HIGH ONE HAD ALREADY CLEARED.**
> `snapshot-institutional-wallets` ran at **20:10:45Z**, `ok`, 3 rows, 64,093 moments snapshotted.
> `detect_stalled_pipelines()` now reads **1**, not 2, and the only entry is
> `topshot-active-listings-ingest`. **Everything below about that lane stands; the HIGH row above
> does not.**
>
> ⭐ **And the lesson is NOT "re-measure before filing" — I did.** The reading was taken at ~20:05Z
> and was true then; the run landed at 20:09–20:10Z, while this file was being written. The defect
> is that a **point-in-time sample was published as a standing state**. This repo has the same
> shape on record for the Panini freshness check — *"the alarm was true-when-written and
> stale-when-read"*. 👉 **An alarm table in a filing needs its clock ON the row, and a reader needs
> telling to re-run `detect_stalled_pipelines()` before acting on any line of it.**
>
> ⓘ The lane is erratic rather than dead: it ran 10:07Z and 12:17Z on 09-17 and 09-18, then skipped
> 09-19's morning slot and came back at 20:10Z — a **31.8 h gap against a 30 h threshold**. Worth a
> cadence look, not an outage response.

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

---

## 4b. ⛔ I RAN THAT DIFF, AND IT REFUTES MY OWN LEAD — the mirror is NOT a drop-in, and not even fresher

Same session, ~20 minutes later. Three findings, in the order they arrived, because two of them are
mistakes I made while testing my own suggestion.

**(i) The obvious filter selects the wrong side of the market.** My first join used
`offer_type = 'SERIAL'` — which looks right for a serial-level board and is **bids, not asks**.
Listings in this table are `kind = 'listing'` with **`offer_type IS NULL`**. The tell was a result
too clean to be real: **259 of 259 prices "disagreed"**, because I was comparing asks against
offers. ⭐ *A 100% disagreement rate is not a finding, it is a broken join.*

**(ii) "Is it still live" has THREE predicates here and they do not agree.** Over listings seen in
the last 2 h: `completed` = 13,497, `purchased_at IS NOT NULL` = 13,497 (identical), but
`purchased` = **8,031**. Pick the wrong one and "active" silently means something else.

**(iii) 🚨 THE LEAD IN §4 IS WRONG, AND THE DIFF IS WHY.** Corrected join (`kind='listing'`, latest
row per `nft_id`) against the 357 rows the board calls `active`:

| | count | of 357 |
|---|---|---|
| matched a listing row in the mirror | 244 | 68.3% |
| **absent from the mirror entirely** | **113** | **31.7%** |
| of the 244: mirror says `completed` | **83** | 34% of matched |
| of the 244: prices agree | 166 | 68% |
| of the 244: **prices disagree** | **78** | **32%** |

And the decisive one — I expected the disagreements to be the board being stale and the mirror
being right. **They are not.** Of those 78: the mirror is fresher on **2**, the board on **76**,
and the mirror's rows average **70.5 hours OLDER** than the board's already-18.7-hour-old rows.

⭐⭐ **So §4's "36 seconds old" was an AGGREGATE over 2.38 M nfts used as a proxy for a PER-ROW
property, and for these particular listings it is false.** That is the identical error class this
same session found on the Panini squeeze board eight hours earlier — a whole-group statistic
standing in for a per-slice one — **made again, by me, in the filing that named it.**

## 4c. What survives, and what to do instead

✅ **The board really is publishing finished listings as live.** Independent of the mirror's
suitability, **83 of the 244 matched rows are `completed`** upstream while the board still shows
them `active` — which is exactly what an 18.7 h-stale `active` flag produces, and it is a real
accuracy defect on a public surface.

⛔ **Do NOT repoint the board at `topshot_atlas_market_events`.** It misses 31.7% of the rows,
disagrees on 32% of the prices, and is ~3 days staler per-row on the disagreements. The row count
and ingest rate that made it look like a ready replacement describe the TABLE, not the LISTINGS.

👉 **The actual fix is the boring one: get `topshot-active-listings-ingest` running again** (§1–§2
— the task is silent on a box that is demonstrably awake). A second feeder may still be the right
long-term answer, but this table is not it on today's evidence.


## 5. Not done, and why

Nothing was shipped. The two live causes need Trevor's box (Task Scheduler is UIPI-blocked from
here), and repointing a public pricing board's data source is a design decision with a measured
precedent for going wrong. Filing beats guessing.

## Drained 2026-09-22 — RESOLVED (currently) — `topshot-active-listings-ingest` ran 11:16 AM PT 09-22, browser mode, 0 skipped, 393 active listings 0.5 h old. Still a single feeder (Trevor's laptop).

*(Per-item drained marker, the mechanism `docs/reference/autonomous-tasks.md` names as the unblock for archival. Re-derived live by the 2026-09-22 daytime Cowork pass; archiving remains Trevor's call.)*
