-- audit_20261023_player_minter_and_linker_hourly_during_mint_season
--
-- WHAT: pg_cron 459 `rpc-ensure-players-from-edition-names` moves from daily 2:50 AM PT
-- (`50 9 * * *`) to hourly at :49, and 612 `rpc-link-editions-to-players` from daily 2:55 AM PT
-- (`55 9 * * *`) to hourly at :57 (same job names → same jobids; commands verbatim).
--
-- WHY (2026-10-23 ~5:15 PM PT, Cowork cloud, autonomous pass): the sitemap derives every
-- /<collection>/player/<slug> URL from `editions.player_name` (lib/sitemap-data.ts, segment 3)
-- while the page needs a `players` row that only the daily minter creates — so a newly minted
-- player is advertised to crawlers, and picked by the E2E DOM Smoke's sitemap discovery, up to
-- ~24 h before the page can serve it. Live case: Keaton Wagler's 4 Rookie Debut editions landed
-- 3:29 PM PT; the 3:27 PM PT deployment smoke (run 40033753464) discovered
-- /nba-top-shot/player/keaton-wagler from the sitemap and FAILED on its 404 (3 attempts), with
-- the `players` row ~11 h away. The 10-22 ledger recorded the same residue for Boozer/Peterson
-- "by design"; during Series 2026-27 minting it is a nightly red and an indexable 404.
-- COST: both lanes are trivial — 7-day reads: minter 7/7 succeeded, 1.27 s avg / 1.41 s max;
-- linker 7/7, 0.45 s avg / 0.76 s max → ~2 s of postgres time an hour. Minutes :49 / :57 are the
-- two lightest non-banned minutes on the live schedule (3 exact-minute jobs each; stagger ban
-- 0/1/20/21/40/41 respected); the linker runs 8 min after the minter it depends on.
-- Applied 2026-10-23 5:04 PM PT; verified: jobids 459 / 612 unchanged, schedules read
-- `49 * * * *` / `57 * * * *`, active, owner postgres.
--
-- EXIT: the next newly minted Top Shot player's page answers 200 within ~1 h of its first
-- edition; no deployment smoke reds on a sitemap-discovered player 404 after this. FALSIFIER:
-- `cron.job_run_details` for 459/612 shows a failed or > 10 s run → revert to daily.
-- REVERT: SELECT cron.schedule('rpc-ensure-players-from-edition-names', '50 9 * * *',
--           'select public.ensure_players_from_edition_names(NULL, 500);');
--         SELECT cron.schedule('rpc-link-editions-to-players', '55 9 * * *',
--           'SELECT public.link_editions_to_players_by_name(NULL)');

SELECT cron.schedule('rpc-ensure-players-from-edition-names', '49 * * * *',
  'select public.ensure_players_from_edition_names(NULL, 500);');

SELECT cron.schedule('rpc-link-editions-to-players', '57 * * * *',
  'SELECT public.link_editions_to_players_by_name(NULL)');
