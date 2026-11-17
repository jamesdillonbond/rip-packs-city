# Handoff → Cowork — All Day LOW haircut 0.55 → 0.75 (2026-11-04, ~9:00 PM PT)
> **Status: ✅ APPLIED by Cowork ~10:27 PM PT 11-04 (apply_migration). Live prosrc = committed file; anon EXECUTE false. Post-check 2 pending: the 10:28 PM PT tick wrote no All Day LOW zero-sale cut rows. Ledger `34151ff`.**


## Context

Thanks for applying `20261105044500` (the haircut stops at the live bid). This is one more change to the same two functions. It is committed to `main` with tests but **not applied**: this Claude Code cloud session still can't run production DDL.

Your own read of the live DB wins over this doc on any disagreement.

## Item — apply `20261105050000_audit_20261104_allday_low_haircut_075`

**What it changes.** It touches both haircut writers: `fmv_apply_thin_sale_haircut` and its fmv-recalc twin `_for_editions`.

An NFL All Day LOW row with unknown depth (0 sales in 30 days, `listing_count` NULL) now takes the 0.75 cut that Top Shot got on 10-23, instead of 0.55. Nothing else changes: the only edit is the collection list on that one ladder arm, in all four copies. Everything else is byte-identical to the live `20261105044500` bodies.

**Why.** On clean All Day sales since 10-05 whose snapshot in force ≥ 1 day before was a LOW `…_haircut` row with 0 sales in 30 days (n = 63), within ±25 % of the sale:

| Cut | Within ±25 % |
|---|---|
| 0.55 (today) | 30.2 % |
| 0.75 | 50.8 % |
| 0.85 | 50.8 % |
| 1.00 (no cut) | 47.6 % |

At 0.55, the median published/sale ratio was 0.56: those prices ran at about half what the Moments sold for. The recent half (n = 51) is decisive. The older half (n = 12) points the other way but is thin.

**Size.** 111 latest All Day rows sit at the 0.55 cut today: $441 → $602 at 0.75. The migration has no backfill. The median haircut row is about 4 hours old, so the next snapshot per edition re-cuts it at 0.75.

**Guard.** It expects the two live bodies to be the `20261105044500` ones:
- `6ef646ad…` (daily);
- `137550f7…` (`_for_editions`).

If the guard raises, re-read both bodies and re-base. If `apply_migration` auto-cancels it, use the SQL editor and record it with a `SELECT 1` apply, as before.

### Post-checks

1. Both md5s changed.
2. After the next All Day fmv-recalc tick, new All Day LOW `_haircut` rows with 0 sales in 30 days sit at 0.75 × `floor_price_usd`:
   ```sql
   select round(fmv_usd / floor_price_usd, 2), count(*)
     from fmv_snapshots
    where collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
      and computed_at > now() - interval '1 hour'
      and algo_version like '%\_haircut' escape '\'
      and confidence = 'LOW'
      and coalesce(sales_count_30d, 0) = 0
    group by 1;
   ```
   This should return 0.75 only.
3. Ledger entry. To revert, re-apply both bodies from `20261105044500`.

## Verified before handoff

- The parse check finds 0 errors.
- `supabase/tests/fmv_apply_thin_sale_haircut.sql` was re-pinned with a new All Day case:
  - LOW with unknown depth → 0.75;
  - ASK_ONLY stays at 0.55;
  - a row with a sale → 0.85;
  - no bid stop outside Top Shot, even with an edition offer present.
- The planted Top-Shot-only body turns the test red.
- The full DB suite passes 291/291, and the drift guard and anon-exec guard pass 367/367.

## Measured tonight, not shipped (no action)

| Idea | Result |
|---|---|
| Top Shot MEDIUM/HIGH priced from the last 3/5/10 sales or a 7-day median | ≤ +1.5 points: published prices are already at the ceiling sale history allows |
| A premium for ordinary low serials (26–250) | It removes the bias (median ratio 0.90 → 0.95) but within ±25 % doesn't move (59.5 → 59.4) |
| All Day ASK_ONLY: last-sale cap or a lower ask multiplier | Gains are inconsistent between halves |
| Top Shot LOW priced from the last-3 median | 58.1 → 60.0 within ±25 % |

## Guardrails

- Direct to `main`; no branches or PRs.
- Expect a ledger conflict on rebase. Re-splice above upstream's newest `^### `.
