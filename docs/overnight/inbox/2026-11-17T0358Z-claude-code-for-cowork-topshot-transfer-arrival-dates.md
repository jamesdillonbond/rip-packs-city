# Claude Code → Cowork: apply the Top Shot transfer-arrival-dates migration + backfill (Trevor-approved)

**Filed 2026-11-16 ~7:58 PM PT by Claude Code cloud.** Trevor approved this in chat ("Approve"), then, after two
`apply_migration` attempts timed out on the Supabase MCP's unanswered confirmation prompt, said: **"Hand it to cowork to do."**
Nothing has been applied: `apply_topshot_arrival_transfers` does NOT exist in prod (checked 7:50 PM PT).

## What it does

Writes the on-chain ARRIVAL DATE for held Top Shot moments on saved wallets whose latest arrival
(`topshot_arrival_provenance`, kind `T` = transfer from another address, no settlement event) was stored but never
applied. Dry run 2026-11-16 ~7:40 PM PT: **23,608 writable** (20,950 inserts + 2,658 re-dates of a lone `unknown`
placeholder); 927 excluded (sold on/after arrival), 5 excluded (wmc row newer than the probe).
Method stays `unknown` and `buy_price` NULL (no P&L, no claimed gift/trade) — the binder renders it "by <date>"
(`formatAcquiredAt`, shipped `2374da983`). Every write archived in `flowty_archive.acq_chain_arrival_20261114`
(arms `transfer_insert` / `transfer_update_unknown`) and stamps `topshot_arrival_provenance.applied_at`.

## Steps

1. Create `supabase/migrations/20261117044500_audit_20261116_topshot_transfer_arrival_dates.sql` with the EXACT
   contents below (body md5 from `CREATE OR REPLACE` to end: `fb1e4951fd11710f8ce57d5cea91226a`).
2. `apply_migration` name `audit_20261116_topshot_transfer_arrival_dates`, query = the file from `CREATE OR REPLACE` on.
   (Answer the MCP confirmation prompt.) Verify: `select count(*) from pg_proc where proname='apply_topshot_arrival_transfers'` = 1.
3. Run in batches until `candidates` = 0 (each call ≤ 5,000; it excludes everything neither arm writes, so it cannot stall):
   `select public.apply_topshot_arrival_transfers(5000);` — expect inserted + updated_unknown ≈ 23,608 total (re-measure; numbers are dated samples).
4. Verify outcome: `select arm, count(*) from flowty_archive.acq_chain_arrival_20261114 where arm like 'transfer_%' group by 1;`
   and spot-check one wallet's binder Acquired column reads "by <date>" for a transferred moment.
5. Commit the migration file + a ledger entry (date · what shipped · revert path below). Append ✅ RESOLVED here.

## Revert

In the migration header (DELETE `transfer_insert` rows; restore `transfer_update_unknown` rows from `prior`;
clear `applied_at` for `applied_result IN ('transfer_update_unknown','transfer_insert')`; DROP FUNCTION).

## Migration file (verbatim)

```sql
-- audit_20261116_topshot_transfer_arrival_dates
--
-- 2026-11-16 ~9:00 PM PT (Claude Code cloud; Trevor: "Do it all" — fill the acquisition date for moments
-- that arrived with no sale or pack record).
--
-- WHY. topshot_arrival_provenance (Dune 9129294 / 9129489, loaded 11-14/15) holds each held moment's LATEST
-- on-chain arrival. apply_topshot_arrival_provenance() writes only the priced kinds (MP/LC/OC) and pulls (P).
-- Kind T — a TopShot.Deposit whose transaction carried no settlement event and whose Withdraw came from
-- another address — was stored and never written: 24,483 held moments on saved wallets whose only
-- acquisition evidence is a first-seen placeholder or nothing, so the binder showed no date, or the date
-- WE first noticed them.
--
-- WHAT. apply_topshot_arrival_transfers(p_limit) writes the ARRIVAL DATE for those moments and nothing it
-- cannot prove: the method stays 'unknown' (a gift, a trade and a move between one collector's own wallets
-- are the same event on chain), buy_price stays NULL (no P&L), seller_address = the sending address. The
-- binder renders an 'unknown' row as "by <date>" (lib/collection/helpers.ts formatAcquiredAt).
-- A provenance row is used only when ALL hold:
--   · it is the moment's LATEST probed arrival for that wallet, and its kind is T;
--   · the wallet still holds the moment (wallet_moments_cache) and that cache row was created no later than
--     the probe — a row created after it may be a NEWER arrival the probe never saw;
--   · no sale of the moment (any wallet) is recorded ON or after the arrival day — it has not moved since
--     (the date is day-precision, so a same-day sale is ambiguous and excluded);
--   · (nft, wallet, Top Shot) has no acquisition row, or exactly one that is 'unknown' and unpriced — a
--     proven row always wins, and every candidate is writable so a batch never stalls on leftovers.
-- A lone 'unknown' row is re-dated in place; otherwise a row is inserted. Kinds S (re-deposit by the same
-- wallet), N (no withdraw) and X (non-USD settlement) stay unwritten.
-- Every write is archived in flowty_archive.acq_chain_arrival_20261114 (arm transfer_update_unknown /
-- transfer_insert) and stamps topshot_arrival_provenance.applied_at.
--
-- anon-exec: revoked (apply_topshot_arrival_transfers) — writes moment_acquisitions; service_role / postgres only.
--
-- REVERT:
--   DELETE FROM moment_acquisitions m USING flowty_archive.acq_chain_arrival_20261114 r
--     WHERE m.id = r.acq_id AND r.arm = 'transfer_insert';
--   UPDATE moment_acquisitions m SET acquired_date = (r.prior->>'acquired_date')::timestamptz,
--     seller_address = r.prior->>'seller_address', acquisition_confidence = r.prior->>'acquisition_confidence',
--     source = r.prior->>'source'
--     FROM flowty_archive.acq_chain_arrival_20261114 r WHERE m.id = r.acq_id AND r.arm = 'transfer_update_unknown';
--   UPDATE topshot_arrival_provenance SET applied_at = NULL, applied_result = NULL
--     WHERE applied_result IN ('transfer_update_unknown', 'transfer_insert');
--   DROP FUNCTION public.apply_topshot_arrival_transfers(integer);

CREATE OR REPLACE FUNCTION public.apply_topshot_arrival_transfers(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  n_upd int := 0; n_ins int := 0; n_cand int := 0;
BEGIN
  CREATE TEMP TABLE _tcand ON COMMIT DROP AS
  WITH latest AS (
    SELECT DISTINCT ON (p.wallet, p.nft_id) p.wallet, p.nft_id, p.arrival_tx, p.arrival_date, p.kind,
           p.from_addr, p.probed_at, p.applied_at
    FROM topshot_arrival_provenance p
    ORDER BY p.wallet, p.nft_id, p.block_height DESC NULLS LAST, p.arrival_date DESC NULLS LAST
  )
  SELECT l.wallet, l.nft_id, l.arrival_tx, l.arrival_date, l.from_addr
  FROM latest l
  JOIN wallet_moments_cache w ON w.wallet_address = l.wallet AND w.moment_id = l.nft_id AND w.collection_id = v_ts
  WHERE l.kind = 'T' AND l.applied_at IS NULL AND l.arrival_date IS NOT NULL
    AND w.created_at <= l.probed_at
    AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.nft_id = l.nft_id AND s.collection_id = v_ts
                      AND s.sold_at >= l.arrival_date::timestamptz)
    -- writable by exactly one arm below: no row at all, or ONE row that is 'unknown' and unpriced. Anything
    -- else is excluded HERE, so a LIMIT batch never fills with rows neither arm writes (which would stall it).
    AND (SELECT count(*) FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = l.wallet
           AND ma.collection_id = v_ts)
        = (SELECT count(*) FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = l.wallet
           AND ma.collection_id = v_ts AND ma.acquisition_method = 'unknown' AND ma.buy_price IS NULL)
    AND (SELECT count(*) FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = l.wallet
           AND ma.collection_id = v_ts) <= 1
  LIMIT p_limit;
  SELECT count(*) INTO n_cand FROM _tcand;

  WITH tgt AS (
    SELECT ma.id, c.wallet, c.nft_id, c.arrival_date, c.from_addr, to_jsonb(ma) AS prior
    FROM _tcand c JOIN moment_acquisitions ma ON ma.nft_id = c.nft_id AND ma.wallet = c.wallet AND ma.collection_id = v_ts
    WHERE ma.acquisition_method = 'unknown' AND ma.buy_price IS NULL
      AND (SELECT count(*) FROM moment_acquisitions m2 WHERE m2.nft_id = c.nft_id AND m2.wallet = c.wallet
             AND m2.collection_id = v_ts) = 1
  ), upd AS (
    UPDATE moment_acquisitions m
    SET acquired_date = t.arrival_date::timestamptz, seller_address = t.from_addr,
        acquisition_confidence = 'verified', source = 'chain_arrival_transfer'
    FROM tgt t WHERE m.id = t.id
    RETURNING m.id
  ), rec AS (
    INSERT INTO flowty_archive.acq_chain_arrival_20261114 (acq_id, wallet, nft_id, arm, kind, price, prior)
    SELECT t.id, t.wallet, t.nft_id, 'transfer_update_unknown', 'T', NULL, t.prior FROM tgt t JOIN upd u ON u.id = t.id
    RETURNING wallet, nft_id
  ), mark AS (
    UPDATE topshot_arrival_provenance p SET applied_at = now(), applied_result = 'transfer_update_unknown'
    FROM rec r, _tcand c
    WHERE r.wallet = c.wallet AND r.nft_id = c.nft_id
      AND p.wallet = c.wallet AND p.nft_id = c.nft_id AND p.arrival_tx = c.arrival_tx
    RETURNING 1
  )
  SELECT count(*) INTO n_upd FROM rec;

  -- inserts: only where no acquisition row exists at all for (nft, wallet, Top Shot)
  WITH ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_date, acquired_type, seller_address,
      transaction_hash, source, collection_id, acquisition_method, acquisition_confidence)
    SELECT c.nft_id, c.wallet, NULL, c.arrival_date::timestamptz, 1, c.from_addr,
           c.arrival_tx, 'chain_arrival_transfer', v_ts, 'unknown', 'verified'
    FROM _tcand c
    WHERE NOT EXISTS (SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = c.nft_id AND ma.wallet = c.wallet
                        AND ma.collection_id = v_ts)
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id, wallet, transaction_hash
  ), rec AS (
    INSERT INTO flowty_archive.acq_chain_arrival_20261114 (acq_id, wallet, nft_id, arm, kind, price)
    SELECT id, wallet, nft_id, 'transfer_insert', 'T', NULL FROM ins
    RETURNING wallet, nft_id
  ), mark AS (
    UPDATE topshot_arrival_provenance p SET applied_at = now(), applied_result = 'transfer_insert'
    FROM ins i WHERE p.wallet = i.wallet AND p.nft_id = i.nft_id AND p.arrival_tx = i.transaction_hash
    RETURNING 1
  )
  SELECT count(*) INTO n_ins FROM rec;

  DROP TABLE IF EXISTS _tcand;
  RETURN jsonb_build_object('candidates', n_cand, 'updated_unknown', n_upd, 'inserted', n_ins);
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_topshot_arrival_transfers(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_topshot_arrival_transfers(integer) TO service_role;
```
