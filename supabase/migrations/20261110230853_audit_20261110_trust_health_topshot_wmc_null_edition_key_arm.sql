-- audit_20261110_trust_health_topshot_wmc_null_edition_key_arm
--
-- 2026-11-10 ~3:10 PM PT (Claude Code, laptop; Trevor: "Keep going" after landing the weekly sweep's handoff
-- docs/handoff-2026-11-10-ts-wmc-null-key-backlog.md, item 3).
--
-- WHY. An 11-09 wallet walk wrote 5,207 Top Shot wallet_moments_cache rows with edition_key NULL across two saved
-- wallets (0xc246d05ba775362e: 4,583 of 9,171; 0xe68c3edbdc6c9376: 604). Those moments render with no player,
-- edition or FMV. heal_topshot_wmc_null_keys(20) drains ~20/h (cap sized under the access node's burst limit,
-- 20260929200823), so a bulk walk takes days to clear. Nothing watched it continuously: the WEEKLY data-quality
-- sweep found it ~16 h later. This arm makes the same count visible on every Sentinel read.
-- CORRECTION to the handoff's "no continuous watcher": check_wmc_null_edition_key (20260929205000) already counts
-- these in rpc_ops_snapshot() (new_7d > 25, total > 100, per collection) — but that is a READ a session or the
-- nightly pass takes, not an alarm, so nothing paged on 11-09. This arm is the alarm; the snapshot guard stays the
-- finer-grained read (all collections, lower thresholds).
-- Applied via apply_migration 2026-11-10 3:08 PM PT; recorded version 20261110230853. Trial first in a rolled-back
-- transaction (41 arms, new arm 604/ok, security_invoker=on); live read-back identical.
--
-- WHAT. ONE inline arm, topshot_wmc_null_edition_key_rows = count of TS wmc rows with edition_key IS NULL,
-- breach_at 1000. Measured 2026-11-10 3:00 PM PT: 604 (the whale already cleared; the rest drain at ~20/h); the
-- healer's normal residual is ~10-20 and the 11-09 spike was 5,207, so 1000 trips on a bulk walk and not on the
-- trickle. Cost: index-only scan on idx_wmc_coll_ek_serial_cover, 107 buffers / 43 ms cold.
--
-- HOW. Same method as 20261104155301: the arm is inserted into the LIVE definition at a fixed anchor (before the
-- topshot_fmv_pct_stale_30d arm), so no other arm is rewritten from a possibly-stale copy. The block refuses if the
-- anchor is not found exactly once or the metric already exists. Columns unchanged; security_invoker re-asserted
-- (CREATE OR REPLACE VIEW resets reloptions).
--
-- REVERT: re-run this block's logic in reverse — regexp_replace the arm text (from "UNION ALL SELECT
-- 'topshot_wmc_null_edition_key_rows'" up to the next "UNION ALL") out of pg_get_viewdef, CREATE OR REPLACE, and
-- re-assert security_invoker = on.

DO $mig$
DECLARE
  v_def   text := pg_get_viewdef('public.v_rpc_trust_health'::regclass, false);
  v_anchor constant text := $re$UNION ALL\s+SELECT 'topshot_fmv_pct_stale_30d'::text$re$;
  v_arm   constant text := $arm$UNION ALL
         SELECT 'topshot_wmc_null_edition_key_rows'::text AS text,
            ( SELECT (count(*))::numeric AS count
                   FROM wallet_moments_cache w
                  WHERE ((w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AND (w.edition_key IS NULL))) AS count,
            (1000)::numeric AS "numeric",
            'Top Shot wallet_moments_cache rows with NO edition_key (installed 2026-11-10). Such a moment renders in a collector''s holdings with no player, edition or FMV. heal_topshot_wmc_null_keys (pg_cron hourly :27) resolves them from a chain read, capped at 20 reads/run, so a bulk saved-wallet walk outruns it: 5,207 rows on 2026-11-09 (two saved wallets) were found ~16 h later by the WEEKLY sweep, the only watcher then. Normal residual ~10-20. A breach means a walk wrote many keyless rows: check pipeline_runs extra for topshot-wmc-null-key-heal (filled, waiting, refused_impossible_serial) and which wallets hold them; a sustained breach with filled=0 means the healer is stuck, not slow.'::text AS text
        $arm$;
  v_new   text;
BEGIN
  IF position('topshot_wmc_null_edition_key_rows' in v_def) > 0 THEN
    RAISE EXCEPTION 'v_rpc_trust_health already has topshot_wmc_null_edition_key_rows';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, v_anchor, 'g')) <> 1 THEN
    RAISE EXCEPTION 'anchor (topshot_fmv_pct_stale_30d arm) not found exactly once in the live v_rpc_trust_health';
  END IF;
  v_new := regexp_replace(v_def, v_anchor, v_arm || $s$UNION ALL
         SELECT 'topshot_fmv_pct_stale_30d'::text$s$);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;
