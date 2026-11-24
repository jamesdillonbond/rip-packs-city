-- 2026-11-24 (PT) — v_collection_marketplace_status: the Candy row names OpenSea as a secondary venue.
--
-- Flagged 11-23 ~10:55 PM PT (docs/strategy/collections/candy-mlb.md, #58), done the morning after,
-- with no other session active on the view. The row still said "Secondary trading STOPPED rather than
-- moving venues ... so no OpenSea feed is needed" and named only Magic Eden. Measured 2026-11-24 ~7:45 AM PT
-- (sales, Candy, last 7 days): magic_eden 187 sales / $4,687 · opensea 111 / $4,782 (the 7Aru program, relabelled
-- OpenSea 11-23 night) · tensor 1 / $1. OpenSea carries about half of Candy's dollars, and the key-free chain
-- lanes have been reading its book since 11-23 (`candy-opensea-chain-listings`, 1,204 live asks on the
-- 10:41 PM PT run).
--
-- What changes (Candy row only, literal values in the view body):
--   secondary_venue   'magic_eden' -> 'magic_eden_and_opensea'  (read by lib/marketplace-status.ts only as data;
--                                                                 no caller branches on it — grepped 11-24)
--   last_verified_at  2026-11-20 14:50 UTC -> 2026-11-24 15:45 UTC
--   notes             the stale sentence is marked superseded in place (history kept, as every earlier
--                     re-verify was) and a dated re-verify is appended.
--   secondary_status  UNCHANGED ('thin_since_2026_11_19'). v_rpc_trust_health reads only a
--                     'silent_since_%' value, so this row change moves no trust arm.
--
-- HOW: a DO block that rewrites the LIVE definition (pg_get_viewdef) rather than a transcribed body.
-- A hand-copied 6 KB body is the stale-draft risk CLAUDE.md names ("CREATE OR REPLACE IS A FULL-BODY
-- WRITE"). Each replace target is asserted to occur EXACTLY once, or the migration raises and changes
-- nothing. security_invoker = true is restated (CREATE OR REPLACE VIEW resets reloptions).
-- Revert: the same DO shape with the replacements reversed, or re-apply
-- 20261120144221_audit_20261120_candy_marketplace_reverified_trading_resumed_thin.sql's body.

DO $mig$
DECLARE
  v_def text := pg_get_viewdef('public.v_collection_marketplace_status'::regclass);
  v_old_venue   constant text := $q$'magic_eden'::text AS secondary_venue$q$;
  v_new_venue   constant text := $q$'magic_eden_and_opensea'::text AS secondary_venue$q$;
  v_old_lv      constant text := $q$'2026-11-20 14:50:00+00'::timestamp with time zone AS last_verified_at$q$;
  v_new_lv      constant text := $q$'2026-11-24 15:45:00+00'::timestamp with time zone AS last_verified_at$q$;
  v_old_stale   constant text := $q$Secondary trading STOPPED rather than moving venues (2026-10-25 Solana collection census, #58), so no OpenSea feed is needed.$q$;
  v_new_stale   constant text := $q$[SUPERSEDED 2026-11-24 — see the last re-verify: OpenSea IS a live secondary venue] Secondary trading STOPPED rather than moving venues (2026-10-25 Solana collection census, #58), so no OpenSea feed is needed.$q$;
  v_old_tail    constant text := $q$Facts live in this view, not collection_config (Flow-shaped). buy_ctas_enabled=false: RPC is read-only.'::text AS notes$q$;
  v_new_tail    constant text := $q$RE-VERIFIED 2026-11-24 7:45 AM PT (Cowork cloud): OpenSea is a live secondary venue. Its Solana Marketplace Program (7Aru…QF9V, a Tensor fork) carried 111 sales / $4,782 in the last 7 days against Magic Eden at 187 / $4,687 (tensor 1 / $1); those fills were captured as solana_7aru and relabelled opensea 11-23 night. Its asks and offers are read key-free from the chain (candy-opensea-chain-listings, 1,204 live escrowed asks on the 11-23 10:41 PM PT run). secondary_venue is now magic_eden_and_opensea; secondary_status (thin_since_2026_11_19) is unchanged. Facts live in this view, not collection_config (Flow-shaped). buy_ctas_enabled=false: RPC is read-only.'::text AS notes$q$;
  n int;
BEGIN
  FOREACH n IN ARRAY ARRAY[
    (length(v_def) - length(replace(v_def, v_old_venue, ''))) / length(v_old_venue),
    (length(v_def) - length(replace(v_def, v_old_lv, ''))) / length(v_old_lv),
    (length(v_def) - length(replace(v_def, v_old_stale, ''))) / length(v_old_stale),
    (length(v_def) - length(replace(v_def, v_old_tail, ''))) / length(v_old_tail)
  ] LOOP
    IF n <> 1 THEN
      RAISE EXCEPTION 'v_collection_marketplace_status: a replace target occurs % times (expected exactly 1) — the live body moved; re-read it', n;
    END IF;
  END LOOP;

  v_def := replace(v_def, v_old_venue, v_new_venue);
  v_def := replace(v_def, v_old_lv, v_new_lv);
  v_def := replace(v_def, v_old_stale, v_new_stale);
  v_def := replace(v_def, v_old_tail, v_new_tail);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_collection_marketplace_status WITH (security_invoker = true) AS ' || v_def;
END
$mig$;
