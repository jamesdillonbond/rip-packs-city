-- audit_20261123_trust_health_ufc_wmc_null_edition_key_arm
--
-- 2026-11-23 ~7:55 PM PT (Claude Code, Trevor's laptop; Trevor: "Keep going" after the UFC enrichment-chain fix).
--
-- WHY. 155 UFC (ufc_strike) wallet_moments_cache rows sat with edition_key NULL for up to 4 days in two wallets
-- (inbox 2026-11-24T0114Z): the enrichment chain's 45 s page timeout aborted page 0 and every run restarted at 0,
-- and its fallback drain has had no caller since 10-18. Such a moment renders with no fighter, set or value. Nothing
-- alarmed: the 11-10 continuous arm (topshot_wmc_null_edition_key_rows, 20261110230853) is Top-Shot-only, and the
-- only UFC watcher was check_wmc_null_edition_key inside rpc_ops_snapshot() — a READ, not an alarm. The chain was
-- fixed in f04a8cd (unkeyed-only keyset pages, 140 s timeout); this arm is the alarm if it ever stops draining.
--
-- WHAT. ONE inline arm, ufc_wmc_null_edition_key_aged_rows = UFC wmc rows with edition_key IS NULL AND created_at
-- older than 1 hour; breach_at 25. Why AGED: the chain runs right after each walk and finished 149 rows in 3 pages
-- within ~2 min on 11-23, so a fresh walk legitimately holds a few hundred unkeyed rows for minutes. A plain count
-- would breach on healthy walks; a row still unkeyed after an hour means the chain did not reach it. Baseline
-- measured 2026-11-23 ~7:50 PM PT: 0 of 5,706 UFC rows (created_at is never NULL on UFC rows: 0). 25 = the
-- snapshot watcher's new-row gate.
--
-- HOW. Same method as 20261110230853: the arm is inserted into the LIVE definition at a fixed anchor (before the
-- topshot_wmc_null_edition_key_rows arm), so no other arm is rewritten from a possibly-stale copy. The block refuses
-- if the anchor is not found exactly once or the metric already exists. Columns unchanged; security_invoker
-- re-asserted (CREATE OR REPLACE VIEW resets reloptions). No function created or changed.
--
-- REVERT: regexp_replace the arm text (from "UNION ALL SELECT 'ufc_wmc_null_edition_key_aged_rows'" up to the next
-- "UNION ALL") out of pg_get_viewdef, CREATE OR REPLACE VIEW, and re-assert security_invoker = on.

DO $mig$
DECLARE
  v_def   text := pg_get_viewdef('public.v_rpc_trust_health'::regclass, false);
  v_anchor constant text := $re$UNION ALL\s+SELECT 'topshot_wmc_null_edition_key_rows'::text$re$;
  v_arm   constant text := $arm$UNION ALL
         SELECT 'ufc_wmc_null_edition_key_aged_rows'::text AS text,
            ( SELECT (count(*))::numeric AS count
                   FROM wallet_moments_cache w
                  WHERE ((w.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid) AND (w.edition_key IS NULL) AND (w.created_at < (now() - '01:00:00'::interval)))) AS count,
            (25)::numeric AS "numeric",
            'UFC wallet_moments_cache rows with NO edition_key, created over 1 hour ago (installed 2026-11-23). Such a moment renders with no fighter, set or value. The only UFC keying path is the enrich-ufc-wallet chain that wallet-backfill-ufc runs right after each walk (unkeyed-only keyset pages, f04a8cd); it drains a walk within minutes, so a row unkeyed after an hour means the chain did not reach it. 2026-11-23: 155 rows in 2 wallets sat unkeyed for up to 4 days with no alarm (inbox 2026-11-24T0114Z). On a breach: Vercel logs "[ufc-enrich-chain]" / "[wallet-backfill-ufc] enrich chain" for the wallets holding them (fetch failed, page write failed, deadline reached), then one manual wallet-backfill-ufc call per wallet.'::text AS text
        $arm$;
  v_new   text;
BEGIN
  IF position('ufc_wmc_null_edition_key_aged_rows' in v_def) > 0 THEN
    RAISE EXCEPTION 'v_rpc_trust_health already has ufc_wmc_null_edition_key_aged_rows';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, v_anchor, 'g')) <> 1 THEN
    RAISE EXCEPTION 'anchor (topshot_wmc_null_edition_key_rows arm) not found exactly once in the live v_rpc_trust_health';
  END IF;
  v_new := regexp_replace(v_def, v_anchor, v_arm || $s$UNION ALL
         SELECT 'topshot_wmc_null_edition_key_rows'::text$s$);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;
