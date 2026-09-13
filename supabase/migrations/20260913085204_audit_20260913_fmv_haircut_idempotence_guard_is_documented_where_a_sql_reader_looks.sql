-- Documents the idempotence guard on public.fmv_apply_thin_sale_haircut. COMMENT ONLY --
-- no function body, no data, no schedule is touched by this migration.
--
-- WHY. The write is MULTIPLICATIVE:
--     fmv_usd = ROUND(fmv_usd * (0.85 | 0.75 | 0.65 | 0.55), 2)
-- with no `haircut_applied` flag, no cursor and no time window. The natural reading is that
-- a second run compounds the discount, and that reading has consequences: it argues against
-- ever giving this daily lane a backstop, and it invites someone to "fix" the guard. The lane
-- missed its 2026-09-12 22:35Z slot (cron-job.org, no pg_cron row, not covered by
-- dead-lane-backstop.yml) and that is exactly the question the next reader will ask.
--
-- THE GUARD is one clause in the WHERE:
--     AND ABS(fs.fmv_usd - fs.floor_price_usd) < 0.01
-- A row qualifies only while its FMV still EQUALS its floor; applying the haircut is what
-- breaks that equality, so the row excludes itself from every later run. The
-- `algo_version || '_haircut'` marker is a RECORD, not the guard -- nothing reads it back.
--
-- MEASURED 2026-09-13, live, rather than argued: of 190,851 snapshot rows carrying a haircut
-- marker, 189,193 read exactly one `_haircut`, 1,657 read `_haircut_p90clamp` (a later
-- writer), and exactly ONE reads `_haircut_haircut`. The guard holds ~1 in 190k.
--
-- THE LEAK HAS A MECHANISM and is therefore not noise: if another writer later re-syncs
-- `floor_price_usd` down to the already-haircut `fmv_usd`, the equality is restored and the
-- row becomes eligible again. One row today; it would grow if floor re-sync became routine.
-- The query that finds it:
--   SELECT count(*) FROM public.fmv_snapshots WHERE algo_version LIKE '%\_haircut\_haircut%';
--
-- REVERT:
--   COMMENT ON FUNCTION public.fmv_apply_thin_sale_haircut(uuid, boolean) IS NULL;
--
-- anon-exec: intentional -- this migration creates and replaces NOTHING
-- (fmv_apply_thin_sale_haircut is untouched), so there is no ACL to set and no new function
-- to revoke. Verified after apply: anon EXECUTE still false.

COMMENT ON FUNCTION public.fmv_apply_thin_sale_haircut(uuid, boolean) IS
  'Applies the thin-sale FMV haircut to the LATEST snapshot per edition, LOW/ASK_ONLY only. '
  'SAFE TO RE-FIRE, and the reason is not obvious from the write: the UPDATE is multiplicative '
  'and there is no applied-flag, but the WHERE requires ABS(fmv_usd - floor_price_usd) < 0.01, '
  'and applying the haircut breaks that equality so the row excludes itself from later runs. '
  'algo_version || ''_haircut'' is a RECORD, not the guard. Measured 2026-09-13: 189,193 rows '
  'haircut exactly once against ONE reading _haircut_haircut (~1 in 190k). That single leak has '
  'a mechanism -- if another writer re-syncs floor_price_usd down to the haircut fmv_usd the row '
  'becomes eligible again -- so re-check with: algo_version LIKE ''%_haircut_haircut%''. '
  'NOTE: safe to re-fire does NOT mean cheap -- it walks DISTINCT ON (edition_id) over '
  'fmv_snapshots, ~13.9%% of instance disk reads, so do not wire it to a 15-minute backstop.';
