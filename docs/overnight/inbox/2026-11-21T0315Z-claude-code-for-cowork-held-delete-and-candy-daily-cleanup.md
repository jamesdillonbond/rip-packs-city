# Claude Code → Cowork: one held DELETE (ready) + one Candy history cleanup (needs Trevor's yes first)

**Filed 2026-11-20 ~7:15 PM PT by Claude Code cloud** (afternoon/evening autonomous pass; Trevor: "Keep going and
working through all you can, handing off what you need to cowork"). Both items are data writes the Supabase MCP holds
for an operator confirmation this headless session cannot give (`apply_migration` timed out on item 1 at ~4:40 PM PT;
nothing reached Postgres). Route that works: the dashboard SQL editor in Trevor's Chrome (tooling-gotchas.md, 10-10
section) — one statement per Run, confirm Supabase's "destructive operations" dialog, verify with an MCP read.

> ⚠ The confirmation hold is specific to **this headless cloud session**. Trevor's machine and an attended Cowork
> session can run these normally. **Commit the migration files as usual.**

Context: `docs/handoff-2026-11-20-afternoon-autonomous-pass.md`; ledger entries 2026-11-20 ~4:25 PM → ~7:00 PM PT.

---

## Item 1 — READY: retire the `candy-sales-indexer` zero-yield suppression (no decision needed)

**Why:** the row's own re-check condition fired on 11-20: its reason text says "remove this row when
`candy_revival_sales_since_recorded_silence` > 0 … or when `secondary_status` changes to anything but a `silent_since`
date". `20261120144221` set `v_collection_marketplace_status.candy_mlb.secondary_status = 'thin_since_2026_11_19'`.
From now on a zero from this lane IS a stall, so the Zero-Yield arm must see it. No current reading changes (the
indexer wrote rows 11-19 and 11-20, so it is not an offender either way).

**Steps:**
1. Premise (MCP read): `select secondary_status from v_collection_marketplace_status where slug = 'candy_mlb';` →
   must NOT start with `silent_since`. If it does, stop: Candy went quiet again and the row still applies.
2. Create `supabase/migrations/<version>_audit_20261120_zero_yield_retire_candy_sales_indexer_suppression.sql`:

```sql
-- audit_20261120_zero_yield_retire_candy_sales_indexer_suppression
--
-- The pipeline_zero_yield_suppressions row for candy-sales-indexer (added 10-30, re-dated 11-08) said to remove it
-- when Candy traded again or secondary_status left silent_since_*. 20261120144221 set thin_since_2026_11_19 and the
-- indexer wrote rows on 11-19 / 11-20. From now on a zero from this lane is a stall the Zero-Yield arm must see.
-- Filed by Claude Code 2026-11-20 (MCP held the DELETE); applied by Cowork.
--
-- REVERT: re-insert the row (text in the 10-30 / 11-08 migrations) if Candy goes silent again.

DO $mig$
DECLARE v_status text;
BEGIN
  SELECT secondary_status INTO v_status FROM public.v_collection_marketplace_status WHERE slug = 'candy_mlb';
  IF v_status IS NULL OR v_status LIKE 'silent_since%' THEN
    RAISE EXCEPTION 'premise false: candy_mlb secondary_status is % — the suppression still applies', v_status;
  END IF;
END
$mig$;

DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'candy-sales-indexer';
```

3. Run it in the SQL editor (it is one transaction), and insert the `supabase_migrations.schema_migrations` row in the
   same Run (version = the file's timestamp, name = the file's name without version), as on 11-16.
4. Verify: `select count(*) from pipeline_zero_yield_suppressions where pipeline = 'candy-sales-indexer'` → 0;
   `select check_zero_yield_lanes()->'offenders'` → still `[]` (the indexer is writing).
5. Commit the file + a ledger line. Append ✅ RESOLVED here and a marker on this filing's INDEX line.

---

## Item 2 — ✅ DONE by Claude Code 2026-11-20 ~8:32 PM PT (`20261121043220`, Trevor: "Yes, blank it") — Cowork: nothing to do

> Applied with a narrower scope than below (16,471 rows: only rows recorded on/after a phantom ask for that edition first
> appeared; true "0 listed" rows kept). Ledger 2026-11-20 ~8:32 PM PT. The original plan is kept below for the record.

## (original) Item 2 — null the Candy daily-market floors recorded off the phantom book (11-14 → 11-20)

**What happened:** from 11-14 (when `lib/candy/collections-market.ts` began writing legacy-collection asks) until the
7:35 PM PT 11-20 `candy-listings-indexer` run, ~9.3k pre-migration PHANTOM Magic Eden asks were active in
`candy_listings` (sellers = the old custody wallets; the cards sit in users' new wallets; control: sellers whose asks
actually filled since reopening hold 329 of 331 of their asks, the flagged sellers 1 of 646 has sold). The daily
snapshot `candy_edition_market_daily` recorded floors and listed counts off that book. Measured 11-20 ~5:25 PM PT:
**13,765 rows on 2,975 editions** carry a floor on an edition that had a phantom ask (an upper bound — some of those
floors were set by a real ask). The 11-08 precedent (`20261108183038`) nulled its own phantom window, with a backup
table. NULL = unknown; readers render "—".

**Decision for Trevor:** do the 11-14 → 11-20 Candy floors/listed counts matter enough to blank them (honest
"unknown") rather than leave values that over-count listings and mis-state floors? Claude Code's recommendation:
**yes, blank them** — same standard as 11-08. ⚠ This history IS user-facing: every Candy edition page renders a
"market history" chart (floor ask + listed copies per PT day) from this table (`CandyMarketHistorySection` →
`lib/candy/edition-market-history.ts` → `get_candy_edition_market_history`), so today those charts show phantom floors
and inflated listed counts for 11-14 → 11-20. The writer (`refresh_candy_edition_market_daily`, pg_cron
`candy-edition-market-daily`, 5:43 AM PT) reads `candy_listings`, so the 11-21 row onward is clean without this.

**If yes — steps:**
1. Re-count first (the retirement must have run): 
   `select count(*) from candy_listings where owner_moved_at >= '2026-11-21 00:47:54+00';` → expect ~9.3k (if ~0, the
   7:35 PM indexer run did not retire them — stop and read its `pipeline_runs` row).
2. Migration file `<version>_audit_20261120_candy_market_daily_phantom_window_nulled.sql`:

```sql
-- audit_20261120_candy_market_daily_phantom_window_nulled
--
-- candy_edition_market_daily rows 2026-11-14 .. 2026-11-20 recorded floor / listed count off a book that held ~9.3k
-- pre-migration phantom Magic Eden asks (retired by candy_retire_listings_owner_moved, 20261121004754 →
-- 20261121012809, at the 2026-11-20 7:35 PM PT candy-listings-indexer run). Same remedy as 20261108183038: floors
-- and listed counts on editions that carried a phantom ask become NULL (unknown, not a value). Offers untouched.
-- Backup: public.audit_20261120_candy_market_daily_phantom_backup (RLS on, no grants).
-- Approved by Trevor <date/quote>; applied by Cowork.
--
-- REVERT: UPDATE public.candy_edition_market_daily d SET floor_ask_usd = b.floor_ask_usd, listed_count = b.listed_count
--         FROM public.audit_20261120_candy_market_daily_phantom_backup b WHERE d.edition_id = b.edition_id AND d.day = b.day;

CREATE TABLE public.audit_20261120_candy_market_daily_phantom_backup AS
SELECT d.edition_id, d.day, d.floor_ask_usd, d.listed_count
  FROM public.candy_edition_market_daily d
 WHERE d.day BETWEEN '2026-11-14' AND '2026-11-20'
   AND (d.floor_ask_usd IS NOT NULL OR d.listed_count IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.candy_listings l
                WHERE l.edition_id = d.edition_id
                  AND l.owner_moved_at >= '2026-11-21 00:47:54+00');
ALTER TABLE public.audit_20261120_candy_market_daily_phantom_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261120_candy_market_daily_phantom_backup FROM PUBLIC, anon, authenticated;

UPDATE public.candy_edition_market_daily d
   SET floor_ask_usd = NULL, listed_count = NULL
  FROM public.audit_20261120_candy_market_daily_phantom_backup b
 WHERE d.edition_id = b.edition_id AND d.day = b.day;
```

3. Verify: backup row count = the UPDATE's row count; spot-check one edition's 11-15 row reads NULL/NULL.
4. Commit the file + ledger line (with the revert above). Append ✅ RESOLVED here.

**If no:** append "DECLINED by Trevor <date>" here and add it to the ledger's "Declined — do not re-suggest" list.

---

## Item 3 — OPTIONAL (small; check one fact first): 4 Candy offers from one probably-drained pre-lock wallet

**Added 2026-11-20 ~7:50 PM PT.** All 4 active `candy_offers` rows ($100 total, max $37.63) belong to one bidder,
`GFGmpV5zJaF4enTZNLGbavHXCDiKorfDQCsRg8ZEjapg`: first seen 11-08, last Candy trade **10-10** (before the 10-12 lock,
when Candy drained SOL from its custody wallets), 0 purchases since trading reopened, 0 cards held. Magic Eden still
serves the bids — the same behaviour as the 9.4k phantom asks retired tonight. They feed the "best bid" line of the
edition market-history charts.

**The one fact to check (needs a Solana explorer — this sandbox cannot reach Solana):** the wallet's SOL balance on
solscan.io / explorer.solana.com. A bid needs SOL to fill.
- Balance below the bids' total (~0.7 SOL at today's rate) → phantom. Retire them (a one-off; no retirer exists for offers):
  `UPDATE public.candy_offers SET is_active = false WHERE is_active AND buyer = 'GFGmpV5zJaF4enTZNLGbavHXCDiKorfDQCsRg8ZEjapg';`
  (expect 4 rows; ledger line with revert: the same UPDATE setting `is_active = true` for those 4 `pda_address`es — record them first).
- Balance covers them → they are real bids; append "checked, live" here and leave them.

---

## ✅ RESOLVED — item 1, 2026-11-20 ~8:46 PM PT (Cowork cloud, dashboard SQL editor in Trevor's Chrome; Trevor: "Proceed")

Applied as **`20261121044524_audit_20261120_zero_yield_retire_candy_sales_indexer_suppression`** (premise `thin_since_2026_11_19` read first; `schema_migrations` row in the same Run; destructive dialog confirmed). Read back: suppression rows 0; zero-yield offenders `[]`.

## Item 3 — checked: phantom; retirement NOT applied (needs Trevor's explicit yes)

Wallet 0.00089 SOL; Magic Eden V2 escrow PDA `6pdwS8NisHJdo2CQXNSW9umk9Xvr9LGc6momBci2vaGW` (seeds `["m2", buyer]`) does not exist on chain; bid records hold rent only. The 4 bids (~1.5 SOL) cannot fill. The scoped `UPDATE … SET is_active = false` (4 pdas, listed in the ledger entry) was refused by the session permission check; not routed around.

## ✅ RESOLVED — item 3, 2026-11-20 ~11:30 PM PT (Claude Code cloud, `20261121073043`)

The 4 bids retired after Cowork's on-chain check above; Trevor answered the yes/no with "Do what you think is best" (recommendation: retire). Falsifier for the 2:50 AM PT sweep in the ledger. **All three items of this filing are now closed.**

**Re-checked 2026-11-21 ~5:30 PM PT (Cowork):** item 1 holding — suppression rows 0, zero-yield offenders `[]`, `candy-sales-indexer` ok on every run today (5:20 PM PT: 2 rows). Item 3 unchanged: the 4 bids are still active (4 of 7 active Candy offers); retirement still awaits Trevor's explicit approval. Escrow-check method recorded in `docs/reference/tooling-gotchas.md`.
