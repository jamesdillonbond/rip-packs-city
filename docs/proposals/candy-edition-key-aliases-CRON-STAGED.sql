-- audit_20261113_candy_edition_key_aliases_schedule — the SECOND half of #247. Run ONLY after the census code from
-- docs/proposals/candy-edition-key-aliases-REPO-STAGED.patch.txt is live on production (Vercel READY on that commit):
-- the old census, meeting a filled alias table, would "repoint" every aliased card back each walk (harmless, but a
-- repoint + listings/offers RPC per card per walk).
-- (1) fill the aliases now; (2) refresh daily at 6:08 AM PT; (3) move rows already on an alias, 3,000 holdings per
-- tick every 5 minutes (~205k rows -> ~6 h), logged as pipeline 'candy-edition-key-alias-apply' (extra.wmc_left).
-- Revert: SELECT cron.unschedule('rpc-candy-edition-key-aliases-refresh'); SELECT cron.unschedule('rpc-candy-edition-key-alias-apply');
SELECT public.refresh_candy_edition_key_aliases();
SELECT cron.schedule('rpc-candy-edition-key-aliases-refresh', '8 14 * * *', 'SELECT public.refresh_candy_edition_key_aliases()');
SELECT cron.schedule('rpc-candy-edition-key-alias-apply', '*/5 * * * *', 'SELECT public.candy_apply_edition_key_aliases(3000)');
