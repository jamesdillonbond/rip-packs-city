-- audit_20260902_sales_counterparty_comment_corrected_topshot_marketplace_converts_zero_of_480
-- COMMENT-only. The function body is unchanged (asserted below); this fixes a number IN the comment
-- that five hours of production has refuted.
--
-- The comment said "the real recoverable set is ~42,569". That figure came from a PROBE PROXY — "does
-- the transaction contain a TopShot|AllDay|UFC_NFT Withdraw event" — sampled 8 per source. It is
-- NECESSARY but NOT SUFFICIENT: the worker also has to attribute that Withdraw to the moment on the
-- row. Measured live since the floor shipped:
--
--   nba_top_shot / onchain ............ 91 recovered      ← converts
--   nfl_all_day  / onchain_dapper_v2 .. 18 recovered      ← converts
--   ufc_strike   / onchain .............. 7 recovered     ← converts
--   nba_top_shot / topshot_marketplace .. 0 of 480 attempted over 4 consecutive ticks, ~95 s each
--
-- 1 of 8 sampled `topshot_marketplace` txs HAD a Withdraw event; none of 480 converted.
-- ⭐ **The live conversion beat the probe proxy, and the proxy was mine.** Size a backlog by what a
-- pipeline actually WRITES, not by what its inputs look like.
--
-- CORRECTED SIZING above the floor: 450,987 REACHABLE · 408,309 studio-history listing rows (excluded)
-- · of the 42,562 left, topshot_marketplace 4,959 converts at 0 · **realistic ≈ 37,603**, dominated by
-- nba_top_shot `onchain` (36,872).
--
-- ⛔ topshot_marketplace is NOT excluded, deliberately: 4,959 rows is ~41 ticks (~3.4 h) of the walk
-- and it is BOUNDED and self-limiting — unlike the 408,309 studio-history rows, which were not.
-- 👉 **Exclude a population for being permanently undecodable AND large.** Poor conversion alone is a
-- cost you pay once; an unbounded one is a treadmill.
--
-- REVERT: restore the previous COMMENT (identical apart from the sizing paragraph). Nothing else.

COMMENT ON FUNCTION public.claim_sales_counterparty_batch(integer) IS
  'Newest-first claim for sales-counterparty-backfill: NULL-seller rows carrying a 64-hex Flow tx '
  'hash, bounded ABOVE by state.cursor_sold_at, BELOW by state.floor_sold_at, and restricted to '
  'sources whose transaction_hash is the SALE transaction. '
  '⚠ THE FLOOR IS LOAD-BEARING (2026-09-02). Without it this walk had no lower bound and had already '
  'passed Flow REST''s prune horizon: 288 runs a day, ~10.25 h of runtime, 0 rows recovered, every '
  'instrument green — because past the horizon Flow REST answers HTTP 200 with execution="Pending" '
  'and zero events, indistinguishable from a throttled miss to a caller that checks res.ok. '
  '👉 A cursored backfill needs a FLOOR, not just a cursor. '
  '⚠ A cursor STRICTLY BELOW the floor self-heals to a restart — invalid state no normal apply can '
  'produce, and left alone every tick returns an empty range while reporting "drained". '
  '⛔ THE SOURCE EXCLUSION IS ALSO LOAD-BEARING, and it was measured: allday_studio_history_v1 and '
  'ufc_studio_history_v1 store the NFTStorefrontV2 ListingAvailable transaction on the sale row, not '
  'the transfer — 21 of 21 hash-bucket-sampled txs came back Success with ZERO Withdraw events and one '
  'ListingAvailable, against a 3-of-3 positive control on onchain rows. A listing moves no NFT. '
  'The exclusion is written with IS DISTINCT FROM, not NOT IN, so a NULL source is ATTEMPTED rather '
  'than silently dropped. '
  '📏 SIZING, corrected twice and now measured on CONVERSION rather than on inputs. Above the floor: '
  '450,987 rows are REACHABLE; 408,309 of those are studio-history listing rows and excluded; of the '
  '42,562 that remain, topshot_marketplace (4,959) has recovered 0 of 480 attempted across four '
  'consecutive ticks, so the realistic set is ~37,603 and is dominated by nba_top_shot `onchain` '
  '(36,872), which converts (91 recovered in the first hour, plus 18 AllDay onchain_dapper_v2 and 7 '
  'UFC onchain). '
  '⭐ A PROBE FOR A Withdraw EVENT IS NECESSARY, NOT SUFFICIENT — the worker must also attribute that '
  'Withdraw to the row''s moment. 1 of 8 sampled topshot_marketplace txs had one and none converted. '
  'Size a backlog by what the pipeline WRITES. '
  '⛔ topshot_marketplace is deliberately NOT excluded: 4,959 rows is ~3.4 h of ticks and is bounded, '
  'unlike the 408,309 that were not. Exclude a population for being permanently undecodable AND large.';

DO $mig$
DECLARE
  v_desc text;
BEGIN
  SELECT obj_description(p.oid, 'pg_proc') INTO v_desc
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'claim_sales_counterparty_batch';

  IF v_desc IS NULL THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the comment is missing entirely';
  END IF;
  IF position('42,569' in v_desc) > 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the refuted figure 42,569 is still in the comment';
  END IF;
  IF position('37,603' in v_desc) = 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the corrected figure is not in the comment';
  END IF;
  -- The function body must be UNTOUCHED by a comment-only change.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='claim_sales_counterparty_batch'
        AND p.prosrc LIKE '%IS DISTINCT FROM ''allday_studio_history_v1''%') <> 1 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the function body no longer carries the NULL-safe exclusion';
  END IF;

  RAISE NOTICE 'post-state ok: comment corrected, body untouched';
END
$mig$;
