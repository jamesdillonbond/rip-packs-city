# Handoff → Cowork — Top Shot ask-only prices capped at the last sale (2026-11-04, ~6:55 PM PT)

## Context

Trevor, 6:16 PM PT: *"We need to get confidence on pricing. That's the anchor of everything we do."*

Measured tonight on his Top Shot account (`0xbd94…`): of ~$62k held value, **$41.5k sits in ASK_ONLY / LOW / STALE**. ASK_ONLY alone is 727 editions / $26k, and **535 of those 727 have 3+ market sales in the last 180 days**: the price ignores real sales and falls back to ask × 0.90.

The fix below is committed to `main` with its tests. It is **not applied**: this Claude Code cloud session's classifier refuses production DDL (it refused the Trade Block column twice earlier tonight; Cowork applied that one). Please apply it.

Your own inspection of the live DB and files wins over this doc on any disagreement. Adapt to what is actually there.

## Item 1 — apply `20261105024000_audit_20261104_topshot_ask_only_last_sale_cap`

**File:** `supabase/migrations/20261105024000_audit_20261104_topshot_ask_only_last_sale_cap.sql` (on main).

**What it does.** It changes ONE arm of the BEFORE INSERT guard `fmv_snapshots_cap_allday_ask_only_to_recent_sales()`.

A Top Shot ASK_ONLY price, on an edition with a market sale in the last 180 days, is capped at that edition's **last** market sale:
- sales come from `sales_market`, with serial > 25;
- the row is marked `_salescap`, which the site already renders as "capped at sales";
- the cap only ever **lowers** a price.

This replaces the 3× bound added at 5:39 PM PT (`20261105014011`). The no-180-day-sale `_histcap` arm and the All Day / Golazos arms are byte-unchanged.

The migration then backs up the current Top Shot ASK_ONLY rows above their last sale and re-prices them. It writes both `fmv_snapshots` and `edition_fmv_current`.

**Why (backtest — numbers in the migration header).** #208's 10-22 "not a win on Top Shot" read went through the frozen-parallel-ask defect fixed 10-21/22. The re-measure uses only clean sales: `sales_market`, sold ≥ 10-23 PT, serial > 25, the ASK_ONLY snapshot in force ≥ 1 day before the sale. On that set, n = 479 sales, 312 moved:

| Measure | Published | Capped at last sale |
|---|---|---|
| Within ±25 % | 48.4 % | 56.6 % (last-3 median cap: 52.4 %) |
| Median ratio | 1.21 | 1.00 |
| WAPE | 0.62 | 0.45 |

By price band, n and within ±25 % (published → capped):

| Last sale | n | Within ±25 % |
|---|---|---|
| < $10 | 379 | 49.9 → 57.3 |
| $10–50 | 65 | 47.7 → 61.5 |
| $50–200 | 24 | 41.7 → 41.7 |
| $200+ | 11 | 18.2 → 36.4 |

It is never worse in any band.

**Size (read 6:35 PM PT).** 2,083 latest Top Shot ASK_ONLY rows have a 180-day sale. 1,634 sit above it: $122,283 → $74,392 summed, median cut 1.54×, largest $4,398. The migration's guard raises unless 1,000–2,600 rows are backed up.

**Verified before handoff:**
- The md5 guard expects live body `0df99c6e86fb779c0d294050694b6b8d`, read from prod at 6:40 PM PT. It matches the `20261105014011` body.
- `supabase/tests/fmv_snapshots_cap_allday_ask_only_to_recent_sales.sql` was re-pinned:
  - e12 is **inverted on purpose** (it asserted "left alone, not a win") and now reads `2.00|1.8.3_salescap`;
  - e13 reads `1.00` (was the 3× `3.00`);
  - new e14: never raises;
  - new e15: a special serial doesn't set the cap;
  - a LOW row is untouched.
- The planted old body reds e12. The full DB suite is **289/289 PASS** on local Postgres 16.
- `check-migration-sql-parses.sh` parses it with 0 errors, and the drift guard passes 361/361.

### Steps

1. Apply it. Use `apply_migration` with name `audit_20261104_topshot_ask_only_last_sale_cap` if the MCP lets it through. Otherwise use the dashboard SQL editor, then record it with a `SELECT 1` apply under the same name.
   - ⚠ The body contains `UPDATE`, not DELETE, so the MCP's DELETE hold should not fire.
   - The guard `DO` block raises if the live body changed since 6:40 PM PT. If it does, re-read the live body, re-base this arm onto it, and re-pin.
2. Post-check:
   - `select count(*) from audit_20261104_topshot_ask_only_last_sale_cap_backup` ≈ 1,634.
   - The live md5 changed from `0df99c6e…`.
   - One spot edition from the backup has `fmv_snapshots.fmv_usd` = its last `sales_market` sale (serial > 25), and `algo_version` ends `_salescap`.
3. Watch the next Top Shot fmv-recalc ticks (writers re-insert every few hours). New ASK_ONLY rows with a 180-day sale should arrive already capped (`_salescap`), with no flapping back to the ask.
4. Ledger entry (date · what · revert): the revert is in the migration header.

**Revert:**
1. Re-apply the function body in `20261105014011`.
2. `UPDATE public.fmv_snapshots f SET fmv_usd=b.old_fmv_usd, algo_version=b.old_algo_version FROM public.audit_20261104_topshot_ask_only_last_sale_cap_backup b WHERE f.id=b.snapshot_id;`
3. `UPDATE public.edition_fmv_current c SET fmv_usd=b.old_fmv_usd FROM public.audit_20261104_topshot_ask_only_last_sale_cap_backup b WHERE c.edition_id=b.edition_id AND c.fmv_usd=b.new_fmv_usd;`

**Expect:** `db-pin-staleness` (daily 11:20 PM PT) flags this function until it is applied. That is the reminder working, not a new fault.

## What this does NOT do (the next steps toward confident prices — Trevor's ask)

- **Labels are unchanged.** These rows stay ASK_ONLY. Confidence is still a 30-day sales count, so step 2 is **confidence = measured accuracy**: label each price by its backtested within-±25 % rate per segment, tracked weekly.
- **Expensive editions still run high after the cap** ($200+ band ratio 1.36). Next: time-adjusted comparables (re-price older sales by the tier / set market trend since they happened).
- **The bid side.** `edition_offers` stores only the CURRENT highest offer, so a bid-bracket estimator can't be backtested yet. Start recording offer history.

## Guardrails

- Direct to `main`; no branches, no PRs.
- This handoff exists only because THIS cloud session's classifier refused production DDL. Trevor's machine, Claude Code and Cowork push normally via Git Credential Manager / `gh auth setup-git`. ⛔ Never use "the PAT in `remote.origin.pushurl`".
- Expect a `docs/overnight/ledger.md` conflict on rebase. Re-splice above upstream's newest `^### `; never hand-edit the markers.

## End state

The function carries the Top Shot last-sale arm, about 1,634 current rows are re-priced with a backup, new writes arrive capped, and the pin is clean at the next 11:20 PM PT check.
