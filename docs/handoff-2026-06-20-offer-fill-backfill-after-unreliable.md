RPC Claude Code handoff — offer-fill historical backfill: 202+after() drain is being dropped; move to GHA synchronous (2026-06-20)

DIAGNOSIS (measured, Cowork 2026-06-20 ~04:40Z)

The forward offer capture (topshot-offers-indexer) is healthy — this is ONLY the historical offer-fill backfill (/api/admin/backfill-offer-fill-sales, pipeline backfill-offer-fill-sales). It has stalled:
- cron-job.org "RPC Backfill Offer-Fill Sales" fires every 12 min and returns 202 "Successful (~1s)" — enabled, not disabled.
- BUT: no pipeline_runs row and NO cursor movement since the 02:15:35Z run. event_cursor topshot_offer_fill_backfill frozen at 153,679,999 (forward cursor is ~155,389,292, so ~1.7M blocks unwalked). ~12 cron ticks since 02:15 produced zero progress.
- Recovery is ~half done and stuck: offer_fill sales 3,510 / 6,904 filled offers; offers.fill_tx_hash stamped 264 / 6,904.

ROOT CAUSE
The route is 202 + `after(() => drain(...))` (route ~L29 maxDuration=300, L42 BUDGET_MS=235_000, L129 after()). The drain runs ~235s in `after()`. Vercel does NOT reliably keep the lambda alive for a ~235s background `after()` after the 202 response — most runs get the drain dropped before it advances the cursor + calls log_pipeline_run. The 02:15 run happened to complete; the rest don't. This is the exact `after()`-tail unreliability you cited (memory vercel-after-finally-unreliable) when you correctly DECLINED converting topshot-sales-history-backfill to 202+after(). My original offer-fill handoff specced 202+after() for this backfill — that was the mistake for a ~235s drain; cron-job.org's 30s cap pushed it to after(), but after() can't carry a 235s tail.

FIX — mirror the proven topshot-sales-history-backfill design: synchronous drain on GitHub Actions (GHA curl --max-time 600 has no 30s cap and needs no after()).

1. Route app/api/admin/backfill-offer-fill-sales/route.ts: run the drain SYNCHRONOUSLY and return its result, instead of 202+after(). Simplest: a `?sync=1` (or `?wait=1`) branch that does `const r = await drain(maxRange, startBlockOverride); return NextResponse.json(r)` — keeping BUDGET_MS=235s so it finishes inside maxDuration=300. (Or just make it always synchronous and retire the after() path; the forward indexer is the only thing that needs fast-ack, and it's a different route.) log_pipeline_run already fires at the end of drain(), so the synchronous return makes the signal reliable.
2. New GHA workflow .github/workflows/offer-fill-backfill.yml — mirror .github/workflows/topshot-sales-history-backfill.yml exactly: an off-anchor schedule (never :00/:20/:40, clear of the :7,22,37,52 sales-history slots — e.g. `9,24,39,54 * * * *` or similar), curl POST the route with `--max-time 600`, `Authorization: Bearer ${INGEST_SECRET_TOKEN}` from repo secrets, `?sync=1`. Bounded one-time drain → it'll catch up the ~1.7M-block gap over a few hours then no-op.
3. OPERATOR (after the GHA workflow is live): disable the cron-job.org "RPC Backfill Offer-Fill Sales" entry (it's now superseded; leaving it just burns invocations whose after() is dropped).

NOTE: the forward path that captures NEW offer-fills (in app/api/.../topshot-offers-indexer) writes the sale inline during the indexer flow — it is NOT affected and needs no change. Only this historical backfill route + its trigger move.

REVERT: git revert the route/workflow commit; re-enable the cron-job.org entry if rolling back.

VERIFY AFTER DEPLOY: pipeline_runs backfill-offer-fill-sales logs ok=true every GHA tick with the cursor advancing 153.68M → ~155.39M and offers.fill_tx_hash climbing 264 → ~6,900; offer_fill sales rise from 3,510 toward ~6,900. Gap-close check:
SELECT (SELECT count(*) FROM sales WHERE source='offer_fill') AS sales, (SELECT count(*) FILTER (WHERE fill_tx_hash IS NOT NULL) FROM offers WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND status='filled') AS stamped, (SELECT last_processed_block FROM event_cursor WHERE id='topshot_offer_fill_backfill') AS cursor;

GUARDRAILS: direct-to-main, no PRs; PowerShell git commit + verify git rev-list --count origin/main..HEAD = 0; the PAT can't push .github/workflows? — it can for Trevor's local CC (full creds), just not the nightly-pass PAT. tsc clean. Vercel maxDuration cap 800s (300 is fine).
