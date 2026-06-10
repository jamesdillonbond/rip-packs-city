# Handoff 2026-06-10 — wmc rewrite storm, the missed fifth call site (TS wallet-backfill route)

## Context

f41caf4 swapped the 4 batch-upsert call sites in lib/chains/flow/wallet-backfill-helpers.ts to the change-detecting upsert_wmc_batch RPC — verified working (38 calls, mean 169ms vs legacy 4,007ms; first saturation-window hour clean). But Cowork then caught a FIFTH legacy call site the handoff and the swap both missed: app/api/wallet-backfill/route.ts (~L274) has its OWN inline flush path — .from("wallet_moments_cache").upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" }) with last_seen_at: now() in the rows (~L265) — i.e. the exact every-row-always-rewrites pattern, in the route that handles NBA TOP SHOT, the largest collection (303 pipeline runs/24h; its pg_stat_statements entry kept accruing +1,786 calls through the 00Z wave while the helper entries froze). The storm fix is PARTIAL until this lands.

Claude Code's direct file inspection wins over this doc on any disagreement.

## Item 1 — swap the inline upsert to upsert_wmc_batch (mirror f41caf4 exactly)

app/api/wallet-backfill/route.ts, the chunk-flush block at ~L272-283 (and check whether the second .from("wallet_moments_cache") at ~L296 is another write path or a read — handle it the same way if it writes). Replace the .upsert(chunk, ...) with supabase.rpc("upsert_wmc_batch", { p_rows: chunk }), preserving the route's error handling and the totalUpserted accounting (the RPC returns its written count — adapt to its actual return shape, you wrote it). Verify the row objects' field set matches what the RPC ingests (it was built from the helpers' union: wallet_address, collection_id, moment_id, edition_key, serial_number, tier, player_name, set_name, character_name, series_number, acquired_at, last_seen_at — drop any field the RPC doesn't accept rather than widening the RPC casually; fmv_usd must NOT be passed, that wipe is the bug class f41caf4 closed).

## Item 2 (cleanup, same commit if trivial) — the dead cache-refresh upsert

app/api/cache-refresh/route.ts (~L339) carries a wmc upsert with the PRE-2026-05-06 conflict target ("wallet_address,moment_id" — the constraint is 3-column now) and the route has 0 pipeline_runs in 14 days. Dead code wearing a broken conflict clause. Either delete the route (verify zero callers/cron entries first — it's not in cron-schedule.md) or at minimum fix the onConflict and add a header comment that it's dormant. Deleting is cleaner; your call on inspection.

## Verification

npx tsc --noEmit clean; deploy READY; after the next wallet-backfill ticks: the legacy TS pg_stat entry (the ~17K-call INSERT INTO wallet_moments_cache shape) stops accruing; upsert_wmc_batch call count rises with mean staying low; wallet-backfill pipeline_runs stay ok with sane rows_written; a TS wallet spot-check shows edition_key/serial intact. Next 06:00Z wave: TS leg now also cheap — the full DBSAT verdict CC's f41caf4 aimed at.

## Revert

git revert (route falls back to inline .upsert).

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- maxDuration cap 800s. CRLF: full-file writes or findIndex on split lines.
- This is the ingest/backfill path (invisible-failure class): verify DB end-state after deploy, not just the route ack. Run the smoke test.

## End state

One commit: zero legacy wmc batch-upsert call sites remain (grep .from("wallet_moments_cache").upsert returns only the inert candy route), the TS wave goes cheap like the other four, and the wmc rewrite storm is fully closed.
