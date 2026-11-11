-- audit_20261110_topshot_wmc_null_key_heal_backlog_slot
--
-- 2026-11-10 ~4:25 PM PT (Claude Code, laptop; Trevor: "Keep going and fix any of this"). Handoff
-- docs/handoff-2026-11-10-ts-wmc-null-key-backlog.md item 2: the healer's steady state cannot absorb a bulk walk.
--
-- WHY. heal_topshot_wmc_null_keys(20) runs hourly at :27 (job 640) and dispatches at most 20 Flow REST reads a
-- run, so a bulk saved-wallet walk (5,207 key-less rows on 11-09) drains at ~20/h — ~11 days. 584 remain now.
--
-- WHAT. A SECOND slot at :57 that runs the SAME function with the SAME 20-read cap, but ONLY while more than 100
-- Top Shot wmc rows are key-less. Normal residual is ~10-20, so in steady state this job does nothing and the
-- platform keeps exactly one 20-read burst an hour. Under a backlog the drain doubles (~40/h) with no burst
-- larger than today's.
--   * Per-burst cap unchanged (the 09-29 reason for 20 — under the access node's burst limit — still holds).
--   * :57 measured 2026-11-10 (6 h of net._http_response, the retention window): 0 HTTP 429s of ~300 responses;
--     the 429s sat at :23-:45. The healer's own reads in the last 3 h: 317 responses, 0 x 429.
--   * Gate cost: index-only scan on idx_wmc_coll_ek_serial_cover, 107 buffers.
--   * Same pipeline name (topshot-wmc-null-key-heal) — a :57 row in pipeline_runs is this slot.
-- Watcher: v_rpc_trust_health.topshot_wmc_null_edition_key_rows (20261110230853) breaches at 1000.
--
-- Applied via apply_migration 4:23 PM PT 11-10: job 863, recorded version 20261111002347.
-- REVERT: SELECT cron.unschedule('rpc-topshot-wmc-null-key-heal-backlog');

SELECT cron.schedule(
  'rpc-topshot-wmc-null-key-heal-backlog',
  '57 * * * *',
  $cmd$SELECT public.heal_topshot_wmc_null_keys(20) WHERE (SELECT count(*) FROM public.wallet_moments_cache WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND edition_key IS NULL) > 100$cmd$
);
