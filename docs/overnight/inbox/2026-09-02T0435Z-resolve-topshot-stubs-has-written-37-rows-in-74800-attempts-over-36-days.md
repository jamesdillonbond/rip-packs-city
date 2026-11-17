# `resolve-topshot-stubs` has written **37 rows in 74,800 attempts over 36 days** — 520 permanently-stuck editions re-queried ~4× a day

**Filed 2026-09-01 ~21:35 PT (2026-09-02 ~04:35Z), Claude Code cloud session.**
**Nothing changed.** Found by sweeping for the class two of tonight's fixes belong to — *which
pipelines find work and convert none?* — not by a filing. The measurement is solid; the **decision is
not mine**, and the cheap fix has a trap in it.

## The number, and it comes from the DURABLE rollup, not the 73 h table

`pipeline_runs_daily` (indefinite retention) for `resolve-topshot-stubs`:

| | |
|---|---:|
| days recorded | **36** (2026-07-29 → 2026-09-02) |
| runs | **1,497** |
| targets processed (`rows_found`) | **74,800** |
| rows written | **37** |
| yield | **0.049 %** |
| best single day | 32 — i.e. **5 rows in the other 35 days** |

⚠ **Deliberately measured from `pipeline_runs_daily` and not `pipeline_runs`**, which retains ~73 h —
a 3-day window would have shown `0 / 2,300` and been indistinguishable from a brief outage. The
36-day shape is what makes this a standing state rather than a bad afternoon.

## What it is doing

`get_topshot_stub_targets(50)` selects Top Shot editions missing `player_name`, `set_name` or `tier`
that carry both on-chain ids. **520 editions qualify, and all 520 were touched in the last 24 h** —
so the queue cycles completely about **4.4 times a day** (46 runs × 50 ÷ 520).

Every run reports `targets_found: 50 · rows_resolved: 0 · rows_no_change: 50 ·
rows_no_change_no_onchain_player: 50` — the chain has no player name for any of them.

⭐ **This is NOT the treadmill the buyer-backfill lane had, and the difference matters.** That one
re-picked the identical 45 rows because it had no rotation. This picker was written with rotation on
purpose — `ORDER BY updated_at ASC NULLS FIRST`, with a comment saying exactly why — and it works.
**The rotation is doing its job; the job has nothing left to find.**

## Cost, stated honestly

~2,300 chain lookups a day through the edge function, plus ~2,300 `editions` UPDATEs a day whose only
effect is bumping `updated_at` (that bump is what drives the rotation, so it is not waste in the
ordinary sense — it is the mechanism). On a table this size that is row churn, index maintenance and
autovacuum load for a 0.049 % yield. **It is not urgent and nothing is wrong;** the question is whether
a 520-row queue is worth 4.4 sweeps a day.

## ⛔ The obvious cheap fix has a trap — do not ship it without thinking

*"Exclude editions attempted in the last 24 h"* cuts the work 4.4× at no loss of coverage. **But the
attempt bump and the freshness signal are THE SAME COLUMN.** A brand-new stub edition also has a recent
`updated_at`, so that predicate would delay every genuinely new stub by up to 24 h — trading a real
capability for a saving on a queue that is already bounded.

**What the fix actually needs is a discriminator that does not exist yet: attempt time separate from
change time.** Options, in increasing order of blast radius:

1. `editions.stub_attempted_at` (a nullable timestamptz — instant to add on PG 11+), stamped by the
   RESOLVER. ⛔ The resolver is `supabase/functions/topshot-stub-resolver/index.ts`, so this needs an
   edge deploy.
2. The same column stamped by the PICKER instead — `get_topshot_stub_targets` becomes VOLATILE and
   marks what it hands out. **No deploy at all**, and it survives a resolver crash (the rows stay
   marked, which is the right behaviour for a backoff). ⚠ A claim function that writes is surprising
   and deserves a loud comment.
3. Decide the 520 are permanently unresolvable and retire or heavily slow the schedule. **Trevor's
   call** — it asserts the Top Shot catalog will never gain these plays.

👉 With a real attempt column, the right shape is an **exponential backoff** on attempts, not a flat
exclusion: a stub that has failed 200 times does not deserve the same cadence as one that has failed
once.

⛔ **BUT DO NOT CARRY THAT RECOMMENDATION ACROSS TO THE SERIAL-BACKFILL LANE, WHERE IT WAS ALSO
PROPOSED — measured 2026-09-02 and it is worth ~20% of a small number there.** That lane already has a
flat 24 h cooldown and it is working: over a ~6-day upstream outage its rows average **3.1** retries
against a possible ~72, max 6, none at ≥10. The AllDay case the proposal was written for was **14
attempts per row over 26 days** — two orders of magnitude apart, same table, same picker.
⭐ **And the failure classes want opposite instruments:** `not_in` is a statement about a ROW, so a
per-row backoff fits; `http_530`/`http_429` is a statement about the UPSTREAM, identical for every
row, so a backoff penalises rows for something none of them caused and slows recovery for the ones
that failed most. **That one wants a breaker, not a backoff.** Detail:
[inbox 2026-09-02T0855Z](2026-09-02T0855Z-sales-serial-backfill-topshot-lane-is-100pct-dead-for-6-days-and-pipeline_runs-only-says-unknown.md).

## Falsifier / re-derive before acting

Re-run the rollup query above. **If `rows_written` over the trailing 30 days is materially above ~40,
this filing is wrong and the queue is productive.** Also re-count the qualifying population: 520 today;
if it is growing, new stubs ARE arriving and option 3 is off the table.

**Risk of acting: low. Risk of not acting: also low** — which is exactly why it has run for 36 days
without anyone noticing.

---

## The sweep that found it — and why it must stay a TRIAGE TOOL, never an alarm

Re-runnable, and it reads only the indefinite rollup, so it is not bounded by the 73 h table:

```sql
SELECT pipeline, count(*) days, sum(runs) runs, sum(rows_found) found, sum(rows_written) written,
       round(100.0*sum(rows_written)/NULLIF(sum(rows_found),0), 3) AS yield_pct
FROM pipeline_runs_daily WHERE day > current_date - 30 GROUP BY 1
HAVING sum(rows_found) >= 5000 AND sum(rows_written) * 200 < sum(rows_found) AND count(*) >= 10
ORDER BY sum(rows_found) DESC;
```

**Nine pipelines, 30 days:**

| pipeline | runs | found | written | yield |
|---|---:|---:|---:|---:|
| `snapshot-pack-asks` | 8,147 | 24,090,015 | 9,413 | 0.039 % |
| `allday-price-recover` | 2,054 | 2,026,000 | 1,888 | 0.093 % |
| `pack-events-ingest-backfill` | 2,647 | 190,001 | **0** | 0 % |
| `pinnacle-listings-retry` | 2,704 | 92,164 | **0** | 0 % |
| `topshot-subedition-circulation-backfill` | 18 | 67,484 | 4 | 0.006 % |
| `topshot-stub-resolver` / `resolve-topshot-stubs` | 1,358 / 1,238 | 67,150 / 61,850 | 35 / 35 | ~0.05 % |
| `match-topshot-players` | 29 | 26,980 | **0** | 0 % |
| `wallet-backfill-multicollection-dispatch` | 20,194 | 20,194 | **0** | 0 % |

⛔ **DO NOT TURN THIS INTO AN ARM. Most of these are correct, and I checked rather than assumed.**

- **`snapshot-pack-asks` — the top row by a factor of twelve — is a FALSE POSITIVE, and instructively
  so.** Its `rows_found` is **2,974 on every run**: the size of the currently-listed pack set, not a
  scan. It is a delta snapshot that writes only what changed (`new: 0, changed: 7, dropped: 0`), runs
  in ~3 s, and 24 M is just 2,974 × 8,147. **Working exactly as designed.**
- **`wallet-backfill-multicollection-dispatch`** finds exactly 1 per run — it is a dispatcher; writing
  nothing is its job.
- **`pack-events-ingest-backfill`** reports `caught_up: true` with a block range, so `rows_found` is
  blocks, not rows.
- **`pinnacle-listings-retry` is CORRECT and its counter is not.** Checked rather than assumed: its
  claim already excludes retired rows (`.lt("retry_count", RETRY_COUNT_CAP)`), and the queue has in
  fact drained — `listing_resolution_failures` holds **141 rows, all unresolved and all at
  retry_count ≥ 10**, so they are retired by design and the recent runs find 3–5, not 34. But
  `rows_written` counts only ONE of its two write paths (the `cached_listings_v2.edition_id`
  backfill) and not the other (marking the failure row resolved), so a run that resolves three
  failures still reports **0 written**. ⚠ That is the null-instrument shape again, one field over:
  the pipeline lands in every zero-yield sweep forever while working correctly. ⓘ Noticed in passing
  and NOT chased: **86,796 of 134,501 `source='direct'` rows in `cached_listings_v2` carry a NULL
  `edition_id`** against only 141 recorded failures — either the failures table tracks one narrow
  event path or there is a coverage gap. **Do not read that as a defect without establishing which**,
  and it is a different subsystem from this filing.
  🔁 **ANSWERED 2026-09-02 ~03:5x PT, and it is NEITHER of the two options this bullet offered.**
  `edition_id` is a UUID FK to `editions`, and **Pinnacle editions live in `pinnacle_editions` keyed by
  `edition_key`, not in `editions`** — so a NULL there is Pinnacle's normal state and is **not the
  resolution criterion**. The indexer's `resolved` gate is `editionKey && knownEditionKeys.has(editionKey)`,
  seeded from BOTH tables, so only genuinely unknown edition_keys are queued: **154 failure rows, not
  86,847.** The split by collection is the tell — AllDay's 47,900 `direct` rows are **0% NULL**,
  Pinnacle's 86,847 are **100%**. 🚨 **The misreading has already caused an incident once:** the code
  comment records that an earlier `!editionUuid` gate *"treated every pinnacle_editions-only edition as a
  failure and re-queued it every tick"*, which fired the per-tick Sentry noise. ✅ Harm test negative:
  every consumer of `cached_listings_v2.edition_id` is AllDay or Golazos; no Pinnacle surface reads it.
  Recorded in the register's NOT-A-FINDING section so it is not raised a third time.
- **`match-topshot-players`** is already known-issues **#54** (a daily no-op needing a product
  decision, not a fix).

⭐ **THE TRANSFERABLE POINT: `rows_found` DOES NOT MEAN THE SAME THING TWICE.** Across these nine it
variously means rows scanned, the size of a live set, blocks traversed, dispatches issued, and
candidates examined. **A fleet-wide yield ratio is therefore a triage list a human reads, never a
threshold a machine fires on** — an arm built on it would page on `snapshot-pack-asks` forever and be
switched off, taking the two real findings with it.

The same sweep at a 24 h window listed 15 pipelines and was even noisier, for the same reason.
**Where it earns its keep is as the FIRST step of a per-pipeline read**, which is how tonight's two
real treadmills (`sales-counterparty-backfill` and `topshot-buyer-backfill-historical`) were found.

---

## ✅ HALF SHIPPED 2026-09-02 ~02:2x PT — and the fix was not the one this filing proposed

This filing framed the problem as a CADENCE problem (4.4 sweeps a day over a 520-row queue)
and offered three fixes, all of them ways to ask the chain **less often**: an attempt column,
an exponential backoff, or retiring the schedule. All three were correct about the cost and
wrong about the cause.

**The chain does not have these player names. Our own database does.** Measured over the 515
stub editions missing a `player_name`: **346 have one in `wallet_moments_cache`.** And the
stubs were created *from* wmc rows — `stub_editions_from_wmc` inserts
`player_name` as `NULL,  -- player to be resolved later` while reading a wmc row that carries
the name. **The row that created the stub had the answer, and threw it away.**

### What shipped

`public.backfill_topshot_stub_player_names_from_wmc(p_limit)` (migration `20260902092542`),
run once: **267 editions filled.** `get_topshot_stub_targets` fell **520 → 253** and Top Shot's
nameless editions **2,000 → 1,733**, so the resolver's ~2,300 chain lookups and ~2,300 no-op
`editions` UPDATEs per day roughly HALVE. That is the displacement argument this instance
requires for anything new: it removes more work than it adds.

Cost of the new scan, measured warm: **107 ms / 51,418 buffers, every one a cache hit.**

### 🚨 The control did NOT come back clean, and the unclean part was not formatting

Comparing wmc against Top Shot editions that **already** carry a `player_name` — a control the
fix cannot move — **46 of 11,866 disagree**. Most are benign (Steph/Stephen, Vučević/Vucevic,
O.G./OG Anunoby). **Three name a different human being:**

| edition | `editions` | `wallet_moments_cache` |
|---|---|---|
| `2:1::16` | Trae Young | **Alex Sarr** |
| `2:4::16` | John Collins | **Matas Buzelis** |
| `2:7::16` | Julius Randle | **Andre Drummond** |

All three sit on edition_keys where wmc holds **more than one** distinct `player_name`. Split on
that, over subedition (`::NN`) keys, which is where the risk concentrates:

| wmc names for the key | checked | disagree | share |
|---|---:|---:|---:|
| exactly 1 | 2,750 | 8 | 0.29 % — **all eight are Steph/Stephen Curry, ZERO wrong players** |
| more than 1 | 17 | 10 | **58.8 %** |

So the shipped filter is `count(DISTINCT player_name) = 1`, and the **79 ambiguous stubs are
deliberately left nameless**: a Dynamic Duos play genuinely has two players, and picking one is
a false claim, not a partial answer. ⭐ **A source that is right 99.6% of the time and wrong
about *which person this is* 58.8% of the time on an identifiable subset is not a 99.6% source —
it is two sources, and the discriminator is what makes it usable.**

Verified against what was actually written (recorded row-by-row in
`audit_20260902_stub_names_written` *before* the run, so the check does not merely re-derive the
function's own predicate): **267 written · 267 match the pre-recorded candidate · 0 carry a name
wmc does not hold for that edition_key · 0 came from an ambiguous key · 0 left empty.**

### ⛔ What did NOT ship, and why

- **No schedule.** The obvious next step is a daily cron, and the measured inflow does not
  justify one: the resolver wrote 37 rows in 36 days, so locally-resolvable stubs arrive at
  most ~1/day. Re-derive before adding a job — the query is
  `SELECT count(*) FROM editions e JOIN LATERAL (...) w ON true WHERE ... AND w.n_names = 1`,
  the same one in the migration's post-state. **If it climbs back above ~50, schedule it.**
- **`stub_editions_from_wmc` was NOT fixed, though it is the source of the defect.** Seeding
  `player_name` at insert time is the real repair. ⚠ **It has ZERO callers** — checked
  `cron.job.command`, `pg_proc.prosrc`, `pg_views`, and a full-repo grep; it appears only in its
  own pinned test. It is dormant, and this repo has already lost an afternoon to optimising a
  function with no callers. Fix it *if* something starts calling it.
- **The stubs missing `tier` rather than a name** are untouched, and my "same shape, small
  follow-on" guess about them is **measured wrong**: across all **1,100** Top Shot editions with a
  NULL `tier`, wmc supplies a tier for **zero** of them — not ambiguous, absent. `wallet_moments_cache`
  carries a `tier` column, which is what made the guess plausible; it is empty for exactly this
  population. **There is no wmc-shaped fix for tier**, and the same is presumably true of the chain,
  since the resolver has been asking. Recorded so nobody re-derives the hypothesis.
- **This filing's cadence analysis is still correct for the 253 that remain**, and options 1–3
  still apply to them. It is now a much smaller prize.

### ⚠ The lens does NOT generalize to the neighbouring columns — measured, so nobody re-derives it

`wallet_moments_cache` carries `tier` and `mint_count` as well as `player_name`, which makes "do the
same for the other missing edition fields" look obvious. It is not:

| Top Shot editions missing… | rows | unambiguous from wmc | ambiguous | **no wmc value at all** |
|---|---:|---:|---:|---:|
| `player_name` | 2,000 | **267** | 79 | 1,654 |
| `tier` | 1,100 | **0** | 0 | **1,100** |
| `circulation_count` | 1,168 | **5** | 0 | **1,163** |

The columns exist in wmc and are **empty for exactly the populations that need them**. `player_name`
is the one column wmc actually carries for these rows, and that is why this fix works and the two
obvious sequels do not. ⭐ **"The local table has that column" is not "the local table has that
value" — a schema is not a measurement.**

### ⭐ The transferable point, and it is the second time tonight

The other treadmill closed this session (`sales-serial-backfill`'s AllDay `not_in` lane, 700
rows / 9,959 attempts) died the same way: the answer was in a local table the resolver never
read. **Before tuning how often you re-ask a failing upstream, check whether anything local
already knows the answer — a retry policy fixes a *rate*, never a *gap*.** A backoff here would
have made 74,800 futile lookups into 8,000 futile lookups and left 267 editions permanently
nameless.
