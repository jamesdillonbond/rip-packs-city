# Handoff → Cowork — the thin-sale haircut stops at the live bid (2026-11-04, ~8:40 PM PT)

## Context

This follows your 11-04 finding in the ledger entry "APPLIED (3 migrations)". `fmv_apply_thin_sale_haircut*` is an in-place UPDATE that runs *after* the insert. The new BEFORE INSERT offer floor never sees it, so a cut can drop a price back under a live bid. You found one case: 1 of 342 rows at $3.40 `…_haircut`, under a $4.00 open offer.

The fix is committed to `main` with tests but is **not applied**: this Claude Code cloud session still can't run production DDL.

Your own read of the live DB wins over this doc on any disagreement.

## Item — apply `20261105044500_audit_20261104_fmv_haircut_stops_at_the_live_bid`

**What it changes.** It applies to both haircut writers:
- the daily `fmv_apply_thin_sale_haircut(uuid, boolean)`;
- the inline `fmv_apply_thin_sale_haircut_for_editions(uuid[], boolean)` that fmv-recalc step 8 calls.

In both, a Top Shot cut now stops at the best open, unexpired edition offer, when that offer is above the cut price and at most 3× it. The cut never raises a price. A row the bid holds at its current price is no longer counted or stamped. A stopped cut is stamped `…_haircut_bidfloor`. The ladder, the gate and every other collection are unchanged.

**Why — backtest.** On clean Top Shot sales since 10-23 whose snapshot in force ≥ 1 day before was a `…_haircut` row (n = 461), I took the cases where the open offer at that moment sat above the cut and at most 3× it (n = 189):

| Measure | Cut price | Stopped at the bid |
|---|---|---|
| Within ±25 % (the 189) | 50.3 % | 72.5 % |
| Median price/sale ratio (the 189) | 0.75 | 1.00 |
| Within ±25 % (all 461) | 49.7 % | 58.8 % |

**Size today.** It changes 1 of the 1,104 latest Top Shot haircut rows; the offer floor already lifted the rest. The fix stops the next fmv-recalc ticks from re-creating the problem. The migration has no backfill.

**Guards.**
- An md5 guard on both live bodies, read 8:10 PM PT: `1e659bcb…` (daily) and `bb49a577…` (`_for_editions`). If it raises, re-read both bodies and re-base.
- ⚠ `apply_migration` may auto-cancel this one, because the body contains an `UPDATE`. If it does, use the SQL editor as you did tonight, then record it with a `SELECT 1` apply under the same name.

### Post-checks

1. Both bodies' md5 changed.
2. `has_function_privilege('anon', 'public.fmv_apply_thin_sale_haircut_for_editions(uuid[],boolean)', 'EXECUTE')` is still false.
3. After the next Top Shot fmv-recalc tick, this returns 0:

```sql
-- latest Top Shot snapshots stamped _haircut (not _bidfloor) in the last hour that sit under an open edition offer ≤ 3x
with l as (select distinct on (edition_id) edition_id, fmv_usd, algo_version
             from fmv_snapshots
            where collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
              and computed_at > now() - interval '1 hour'
            order by edition_id, computed_at desc)
select count(*)
  from l
 where algo_version like '%\_haircut' escape '\'
   and exists (select 1 from offers o
                where o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                  and o.edition_id = l.edition_id
                  and o.status = 'open' and o.offer_type = 'edition'
                  and (o.expires_at is null or o.expires_at > now())
                  and o.offer_amount_usd > l.fmv_usd
                  and o.offer_amount_usd <= 3 * l.fmv_usd);
```

4. fmv-recalc `extra.haircut_rows` stays in its usual range, and the run does not error.
5. Add a ledger entry. The revert is in the migration header: re-apply both bodies from `20261023235545`.

## Verified before handoff

- The parse check finds 0 errors.
- `supabase/tests/fmv_apply_thin_sale_haircut.sql` was re-pinned. It now carries both bodies verbatim, an `offers` stand-in, and new cases:
  - the best bid;
  - an offer above the price (held, not counted);
  - an offer over 3× the cut, a cancelled one, an expired one and a serial-level one (all ignored);
  - an offer under the cut;
  - a non-Top Shot row;
  - the twin's own run.
- The twin is pinned for the first time: there is a new drift-guard entry.
- Planted defects were caught: removing the 3× bound, or the status filter, turns the test red. (Dropping the `LEAST` is not a defect: the `new < old` filter already stops any raise.)
- The full DB suite passes 291/291 on local Postgres 16; the drift guard and the anon-exec guard pass 367/367.

## Guardrails

- Direct to `main`; no branches or PRs.
- Expect a ledger conflict on rebase. Re-splice above upstream's newest `^### `.
