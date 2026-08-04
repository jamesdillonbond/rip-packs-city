UPDATE pipeline_cadence_watchlist
SET severity = 'medium',
    notes = $note$Daily Candy (Solana/Metaplex Core) editions+serials refresh — Vercel cron 40 8 * * * (08:40 UTC) -> GET /api/ingest/candy-editions (Bearer CRON_SECRET). Discovery complete 2026-07-17.

2026-08-04 CORRECTION (two errors in the prior note):
(1) SEVERITY RATIONALE WAS STALE. The old note justified severity=info with "collection candy_mlb stays is_active=false pre-launch". Candy went live 2026-07-31 (CANDY_MLB_PUBLIC=true) and candy-sales-indexer was correctly raised medium->high at that flip; this row was missed. Raised info->medium: a stalled editions/serials refresh is now user-facing, but editions change slowly (rows_found 27,876 / rows_written 28,483 byte-identical across 07-30..08-02), so it does not warrant paging the way the price feed does. Raise to high only if a real drop in candy coverage is ever traced to this arm.
(2) THE 1800m ARITHMETIC WAS WRONG. The old note claimed 1800m "absorbs one missed daily tick + margin". It does not: a daily cron that misses one tick is silent for 48h = 2880m, well past 1800m. The threshold fires on the FIRST missed tick. That is the correct behaviour for a live collection, so the number stays — only the stated reason was wrong.

2026-08-03/04 INCIDENT — this arm was NOT silent, it was being KILLED. Vercel runtime error on /api/ingest/candy-editions: "Task timed out after 300 seconds", last seen 2026-08-03T08:40:21Z. The route logs to pipeline_runs only on completion, so a timeout leaves no row at all and reads as silence rather than failure (same class as the pinnacle-sync after() defect). Duration trend on successful runs: 61.4s (07-30) -> 68.5s (07-31) -> 71.4s (08-01) -> 197.4s (08-02) -> timeout (08-03), with byte-identical row counts throughout — so it is contention/slowdown, not data growth. route maxDuration=300 vs a Vercel Pro ceiling of 800. Fix handed off: docs/handoff-2026-08-04-candy-editions-timeout.md.

Revert: UPDATE pipeline_cadence_watchlist SET severity='info' WHERE pipeline='candy-editions-ingest';$note$
WHERE pipeline = 'candy-editions-ingest';