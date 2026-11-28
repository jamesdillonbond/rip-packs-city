-- audit_20261127_entity_top_fans_cron
--
-- ⚠ APPLIED 2026-11-27 ~6:20 PM PT through the Supabase dashboard SQL editor (the MCP approval check refused
-- cron.schedule twice), so this version is NOT in supabase_migrations.schema_migrations. Live jobids 955/956/957,
-- owner cron_heavy (verified: has_function_privilege('cron_heavy', refresh_entity_top_fans) = true).
-- Re-running it would fail on the duplicate job names; it is the record, not a pending change.
--
-- Daily refresh of the top-fans precompute (20261128000240), as cron_heavy (600 s budget).
-- Three jobs, so the heaviest (Panini: a full scan of panini_card_serials, ~85 s / ~8.6 GB read on 11-27)
-- never shares a budget with the others. 10:xx UTC = 2–3 AM PT; minutes chosen from free slots that hour.
-- Each call is its own transaction inside refresh_entity_top_fans, and a failed collection is logged
-- (pipeline 'entity-top-fans', ok=false) and returns -1 without touching the next statement.
--
-- Revert:
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.unschedule('rpc-entity-top-fans-panini');
--   SELECT cron.unschedule('rpc-entity-top-fans-topshot-candy');
--   SELECT cron.unschedule('rpc-entity-top-fans-rest');
--   RESET ROLE;

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule('rpc-entity-top-fans-panini', '15 10 * * *',
  $$SELECT public.refresh_entity_top_fans('d1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid)$$);

SELECT cron.schedule('rpc-entity-top-fans-topshot-candy', '45 10 * * *',
  $$SELECT public.refresh_entity_top_fans('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid), public.refresh_entity_top_fans('209ade70-32c5-4470-bc7c-4793d660f713'::uuid)$$);

SELECT cron.schedule('rpc-entity-top-fans-rest', '56 10 * * *',
  $$SELECT public.refresh_entity_top_fans('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid), public.refresh_entity_top_fans('06248cc4-b85f-47cd-af67-1855d14acd75'::uuid), public.refresh_entity_top_fans('9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid), public.refresh_entity_top_fans('7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid)$$);

RESET ROLE;
