# STAGED — deal-alert price pool scoped to its readers (2026-11-14)

**Status: written and tested locally, NOT applied.** Waiting on a rolled-back production equivalence check (its `DELETE`s raised the Supabase connector's destructive-statement prompt, which went unanswered).

## Why
Resuming the nine #12524 serial alerts as price-only at $10,000 made `dispatch_due_deal_alerts` build its price-only pool from every collection's asks under $10,000: 5.9k → 21,145 rows. Only ONE Pinnacle sub reads pool rows at that price; the eight Top Shot exact-serial subs read none (pass 1 skips Top Shot for them; pass 3 serves them). Measured on the same instrument, rolled back: **~92k vs ~55k shared buffers per tick (+66 %)**. Runs stay ok (1–10 s vs 90 s budget).

## The change
One predicate on the pool INSERT: a row enters only if some active price-only sub could read it in pass 1 (its collections, under ITS max_price, not Top Shot for an exact-serial sub). Pass 1's WHERE is unchanged, so every sub reads the same rows. Expected pool ≈ 8k.

## Files
- `deal-alert-price-pool-scope-STAGED-20261114184324.sql`: the migration. Move it back to `supabase/migrations/20261114184324_audit_20261114_deal_alert_price_pool_scoped_to_its_readers.sql`. Base md5 `599f8e…` → new body md5 `b6c7faa293020822f7ab01a37fa7121b`.
- `deal-alert-price-pool-scope-pin-and-guard-STAGED.patch`: `git apply` it. It re-pins `supabase/tests/dispatch_due_deal_alerts.sql` (new case: a $50 Top Shot ask stays out of the pool, a $50 Pinnacle ask joins and is delivered; planted "no scope" defect reds) and re-points the drift guard.

## To ship
1. Re-check live md5 = `599f8ecebab2ff8ea1cdc1624bf39b35`.
2. Optional, needs the destructive prompt approved: the rolled-back equivalence check (clear deliveries in-txn → old run → capture → swap body → new run → compare delivery sets + pool sizes → RAISE).
3. Apply with the md5-asserted `replace()` DO block (database.md), move the files back, `git apply` the patch, run the pin, push, and ledger it.
4. Watch `pipeline_runs` `alerts-dispatch` `extra.pool_price` drop to ~8k.
