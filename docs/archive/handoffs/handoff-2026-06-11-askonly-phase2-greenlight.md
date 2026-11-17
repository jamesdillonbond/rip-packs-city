# Claude Code handoff — 2026-06-11: ASK_ONLY Phase 2 GREEN-LIT — build tonight, drain overnight

Trevor's call: proceed now so the backfill runs overnight. Phase 2 = per-edition historical TS market sales via searchMarketplaceTransactions (consensus-of-many; the data class that fixes the 68%-no-sales ASK_ONLY root cause). Your existing Phase-2 scoping in the plan doc stands — this handoff adds the overnight-safety rails and the green-light. Claude Code's direct file inspection wins over this doc on any disagreement.

BUILD SHAPE (recommended, end-to-end shippable by you tonight):
1. Route: a paced admin/cron route (Bearer INGEST_SECRET_TOKEN) that each tick takes the next N un-drained target editions, pulls their historical marketplace transactions via the topshot-proxy (searchMarketplaceTransactions, paged), and inserts sales rows. Track drain progress in a small cursor/progress table or per-edition stamp so ticks are resumable and idempotent.
2. Scheduler: GHA schedule, NOT cron-job.org (no console dependency at 4am; precedent = the badge catalog-walk workflow with curl --max-time 600). OFF-ANCHOR minutes (never :00/:20/:40) and clear of the wave slots (xx:45Z) and the new TFP slots (1,7,13,19h at :15Z). Suggest every 15 min at 7,22,37,52 with the job no-op-ing fast when the target queue is empty. Kill switch = disable the workflow (one commit) + an env/flag check inside the route.
3. Target set + order: ASK_ONLY TS editions first (~1,021), prioritized by (a) held by tracked user wallets, (b) the 199 LT-matched, then the rest; optionally queue NO_DATA-with-troll-asks editions LAST or not at all (ts-nodata-troll-asks rule: zero-lifetime-sales editions may legitimately have nothing to ingest — write nothing rather than fabricating).

OVERNIGHT-SAFETY RAILS (non-negotiable given today's incident):
- IO budget is CONVALESCING (Supabase banner: near-depleted, 11 MB/s baseline at exhaustion; drops + fixes landed but tonight is the refill window). Pace: <=15-20 editions/tick, batched inserts (<=400 rows/statement — the pack-events 1796-row lesson), total tick wall-clock <=25s synchronous (no after()-tail work; today's findings: after() finally-blocks and waitUntil tails die silently).
- SELF-THROTTLE: at tick start read pipeline_runs fails in the last 30 min; if > ~15, log a skipped-due-to-saturation row and exit. The backfill must never compound a bad window.
- Idempotency: rely on the sales_2026 transaction_hash unique index via upsert/ignoreDuplicates; historical txs may predate 2026 — verify which partition older sold_at rows land in and that a dedup path exists there BEFORE the first real tick (footgun: the unique index is per-partition).
- UUID FOOTGUN (the writer with the dupe history): NEVER key by the GQL set/play UUID pair. Resolve int-pair setID:playID exactly like /api/ingest buildEditionKey does post-9368ade (prefer set.flowId/play.flowID; if null, resolve via fetchTsEditionMeta before keying; if STILL unresolvable, write the rows to unmapped_sales or skip — do not create editions rows). Sales rows should reference the EXISTING canonical edition_id; this backfill creates zero editions.
- Telemetry per today's standard: every exit logs pipeline_runs (including thrown errors from the first DB read), stage extras, counters (editions_drained, sales_inserted, dupes_skipped, gql_errors, skipped_saturation). New pipeline name suggestion: topshot-sales-history-backfill. Do NOT watchlist it until 24h stable.
- FMV side-effects: inserted sales flow into fmv-recalc's normal sweep — that is the POINT, but it means ASK_ONLY editions will flip to sales-derived labels overnight. Do not also force-stale or hand-trigger recalcs; let the sweep do it.

ACCEPTANCE GATE (before declaring Phase 2 a success — tomorrow, not tonight):
- The LT comparison on the matched ASK_ONLY cohort: median |ratio-1| must IMPROVE vs the 0.363 baseline and severe-highs must not grow (the gate that killed three wrong fixes — it decides this one too).
- Spot-check 5 promoted editions' new sales against dapper.market / Top Shot UI history (Cowork verified dapper.market moment pages show purchase history publicly — usable as the second source).
- fmv_sanity_flags stays 0; sentinel TS-UUID-48h stays 0 (proves the keying rules held).

NIGHT-PASS COORDINATION: a companion inbox note ships with this commit so tonight's 08:02Z pass treats the new pipeline as EXPECTED, watches its counters, and does NOT auto-revert it on first-tick noise (it may only revert per its regression rules if sales-integrity metrics break: sentinel UUID leak, fmv_sanity_flags, or sustained saturation attributable to the backfill — in which case disabling the GHA workflow is the documented revert).

Guardrails: direct-to-main, no branches/PRs; PowerShell git; exact-path staging; npx tsc --noEmit clean; deploy READY + smoke green before the first scheduled tick; maxDuration cap 800; CRLF rules.

End state tonight: route deployed READY, workflow scheduled off-anchor, first 2-3 ticks verified (rows inserted, counters sane, dupes_skipped working, no saturation), then let it drain. Morning: run the acceptance gate and report the verdict with numbers.
