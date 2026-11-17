# The counterparty lane spins on a 42-row residue, and the obvious one-line fix is a regression

*(Claude Code, cloud, 2026-09-13 ~11:5x PT. **MEASURED, NOT SHIPPED** — and the point of this
filing is as much the fix I did NOT ship as the defect.)*

> ✅ **RESOLVED ~12:1x PT the same day by migration `20260913190927`, and NOT by any of the three
> shapes ranked below — shape 1 without the Worker deploy it was assumed to need.** The arm lives in
> `apply_sales_counterparty()`, the DB function the worker ALREADY calls on every tick with both
> facts in hand (`v_n` rows in, `v_applied` rows out): `exhausted_at = CASE WHEN v_applied = 0 THEN
> COALESCE(exhausted_at, now()) ELSE exhausted_at END`. ⭐ **The filing's own framing — "the signal
> lives in the worker, not the SQL" — was half wrong: the signal is produced by the worker but
> RECORDED in SQL, one function further along than I had looked.** Everything below stands as the
> diagnosis and as the record of two fixes correctly refused; the function is now pinned
> (`supabase/tests/apply_sales_counterparty.sql`, mutation-controlled). **Left un-archived on
> purpose until the exit condition below is observed on the real lane.**

## What is happening

After today's two changes to `claim_sales_counterparty_batch` (`20260913173355` excluded
`topshot_marketplace`; the floor was raised to 2026-01-01 to contain the scan cost), the lane
walked 2026 down productively — 120/120, 120/120, 95/53 — and then arrived here:

```
11:35:56 PT  batch 42  recovered 0   62,889 ms
11:41:09 PT  batch 42  recovered 0   49,052 ms
11:46:12 PT  batch 42  recovered 0   59,781 ms
```

**The same 42 rows, every tick, forever.** They are a single, fixed, fully-characterised set:

| source | collection | rows | sold_at range | valid tx hash |
|---|---|---:|---|---:|
| `onchain_dapper_v1` | `nfl_all_day` | **42** | 2026-01-02 → 2026-02-11 | 42 of 42 |

⛔ **This is NOT a source to exclude.** `onchain_dapper_v1` converts well in general — 2026 rows of
that source are 99.65% seller-filled, and the lane recovered **893 rows in the eleven ticks before
this one**. These 42 are individually undecodable, not a bad class.

## Why it never stops

`exhausted_at` — the cooldown stamp added this morning by `20260913074912` — arms only on a scan
that returns **ZERO** rows:

```sql
GET DIAGNOSTICS v_found = ROW_COUNT;
IF v_found = 0 THEN ... SET exhausted_at = now() ... END IF;
```

**A residue SMALLER than the batch size can therefore never arm it.** The claim returns 42, which
is not zero, so the lane re-claims the identical 42 every five minutes. ⭐ **Any permanently
undecodable remainder below `p_limit` produces an infinite loop by construction** — the smaller the
residue, the more certainly it spins.

**Cost:** the DB side is now cheap (~100 buffers per claim after the floor fix), but each tick
spends **~55 s** on Flow REST doing 42 decodes plus a serial retry over every miss — and with 0%
conversion *every* row takes the retry path. That is **~84 upstream calls per tick, ~24,000 a day,
all of them failing**, against a third-party host.

## ⛔ The one-line fix is wrong, and the pin already says why

The tempting change is `IF v_found = 0` → `IF v_found < v_limit`: a partial batch does mean the
range below the cursor is drained, and it is strictly more general than the zero case.

**Do not ship it.** `supabase/tests/claim_sales_counterparty_batch.sql` pins the opposite property
deliberately:

> ⭐ *A scan that FOUND something must NOT arm the cooldown, or one good tick would silence the
> lane for two hours.*

That assertion fails under the one-liner, and it is right to. In production the consequence is a
**freshness regression**: the walk reaches the end of its range with a partial batch on nearly
every healthy cycle, so new sales arriving at the head would wait up to `rearm_after` (2 h) for
their counterparty instead of ~5 minutes. **Trading a spin for staleness on live data is a bad
trade, and it would not be visible in any count — the lane would look healthier, not worse.**

## What the fix actually needs

**The claim cannot see the thing that matters.** "Found 42, decoded 0" is knowledge the WORKER has
and the SQL does not: the claim only knows how many rows it handed out, never whether any of them
resolved. So the terminal state has to be armed from the worker side, or attempts have to be
tracked per row.

Three shapes, in the order I would try them:

1. **Worker arms the cooldown on a barren pass.** `workers/sales-counterparty-backfill/index.ts`
   already calls `apply_sales_counterparty` and computes `recovered`. When `rows.length > 0` and
   `recovered === 0`, call a small RPC that sets `exhausted_at` — the machinery is already there,
   it just needs a second way in. Smallest change, exact signal, but it needs a Worker deploy.
2. **Per-row attempt counting.** A side table keyed on `nft_id` incremented by the claim, with rows
   over N attempts excluded. Generalises (it would have handled `topshot_marketplace` without a
   hardcoded source name) but turns a read-mostly claim into a ~120-row-per-tick writer on an
   IO-constrained instance.
3. **Accept and bound.** Leave it, and rely on the residue staying small. ⚠ It will not: every
   undecodable row that the walk ever reaches joins this set permanently.

## ⛔ A second fix considered and REJECTED: raising the floor past them

The cheapest containment is one UPDATE. `floor_sold_at` is already at 2026-01-01 (raised today to
contain a scan cost), and **the entire eligible pool above it is now exactly these 42 rows** — the
population query returns one group and nothing else. Moving the floor to 2026-02-12 would empty the
range, the scan would return ZERO, `exhausted_at` would arm, and the lane would drop straight back
into its healthy 2-hour cycle. New sales are unaffected: they arrive at the head, far above any
floor. Cost: 42 rows that have already been proven undecodable.

**It is still the wrong move, and the reason is not caution.** ⭐ **It removes the only symptom of a
defect that is going to recur.** The residue is not static — *every* undecodable row the walk ever
reaches joins this set permanently — so the next one recreates the spin above whatever floor was
chosen, with nobody watching, and the answer next time will be to raise the floor again. **A lane
that looks healthy because its symptom was moved out of range is worse than a lane that visibly
spins**, and this repo has the rule for it already: fixing the instrument without fixing the record
leaves the incidence unmeasurable.

So the spin is deliberately LEFT RUNNING and visible, at a measured price of ~84 failing Flow REST
calls a tick (~24,000/day, bounded, non-destructive, no DB cost of note). **If someone decides that
price is too high before the structural fix lands, raise the floor — but record it here as a
deliberate mask with an expiry, not as a fix.**

## Exit condition and falsifier

**Exit:** a tick that finds rows and recovers none is followed by a cooldown rather than an
identical tick five minutes later.
**Falsifier for the sizing above:** if `batch` stops reading exactly 42, the residue is not fixed
and the "permanent poison set" framing is wrong — re-derive the population before acting.
