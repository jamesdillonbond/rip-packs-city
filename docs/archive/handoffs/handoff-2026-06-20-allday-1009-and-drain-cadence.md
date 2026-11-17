RPC Claude Code handoff — AllDay serial-backfill 1009 (still broken) + sales-history-backfill effective cadence (2026-06-20)

Two unrelated CC items found while verifying GitHub Actions + closing the sales-completeness thread. Item 1 is a genuinely-still-broken pipeline (low priority); Item 2 is an optional speed lever. Verify file paths + the live request shapes before editing — your direct inspection wins over this doc.

=== ITEM 1 (priority — it's the one failing pipeline) — AllDay serial-backfill Cloudflare 1009 ===

State (measured 2026-06-20): the `allday-listing-serial-backfill` pipeline fails EVERY run — chunk_errors:5, serials_resolved:0, rows_upserted:0; `allday_moment_serials` stuck at 2 rows. The prior fix (commit f53a92118, "reuse the resolver's exact User-Agent") did NOT work: 4 post-fix runs (15:34/18:34/21:34Z 06-19, 00:34Z 06-20) all still 0 serials. So the User-Agent is NOT the (only) difference. The 1009 is nflallday's Cloudflare WAF rejecting the request (http_403), and the sibling `allday-unmapped-resolver` — SAME nflallday consumer GQL through the SAME topshot-proxy `/allday-consumer` route — runs clean (72/0). Both edge functions share the worker's egress IP, so it's a request-FINGERPRINT difference, not an IP difference.

A read-only investigation this session found leads but they are CONTRADICTORY, so do NOT just apply one blindly:
- The working Vercel-side paths (lib/chains/flow/allday-video.ts ~L52-54; allday-fmv-populate) OMIT the User-Agent entirely.
- BUT the `allday-unmapped-resolver` edge fn reportedly works WHILE sending a branded UA — which is exactly the UA f53a92118 copied, and that fix failed. So "omit the UA" and "match the resolver's UA" can't both be the fix; one of the premises is wrong.
- A second real difference surfaced: the GQL page size — the resolver chunks `searchMomentNFTsV2(byFlowIDs)` at `first:40` (the consumer hard-caps at 40 edges/page), while the serial-backfill requests a larger batch (`first:200` / batch_requested 200 in its pipeline_runs extra). A 200-edge request is a different request shape the WAF may treat differently.

How to actually fix it (don't guess — the WAF can't be reasoned about from code alone, it must be tested live, which you can do by deploying the edge fn + reading the next pipeline_runs):
1. Find both edge functions (grep supabase/functions for "allday" + the pipeline names `allday-listing-serial-backfill` and `allday-unmapped-resolver`; the failing one is likely supabase/functions/backfill-allday-listing-serials/).
2. Capture/compare the EXACT outbound request each makes to the `/allday-consumer` proxy route — the full header set (Content-Type, User-Agent, Origin, Referer, Accept, X-Proxy-Secret, anything else), the GraphQL operation/query string + variables, and the page size. Make the failing one BYTE-IDENTICAL to the proven resolver in every request-level field, not just the UA — pay special attention to any header the resolver sends that the backfill omits (Origin/Referer are common WAF fingerprints) and align the page size to 40.
3. Deploy the edge fn (MCP deploy_edge_function), wait one tick, confirm pipeline_runs `allday-listing-serial-backfill` flips to ok=true with serials_resolved>0 and `allday_moment_serials` climbing past 2. Iterate if still 1009.

Priority LOW — this is AllDay serial-number DISPLAY only on the deal board; the AllDay deal buy-link works without it. Revert: redeploy the prior edge-fn version / git revert.

=== ITEM 2 (optional — speed lever for the TS sales-history drain) ===

.github/workflows/topshot-sales-history-backfill.yml schedules `7,22,37,52 * * * *` (every 15 min = 96/day intended). GitHub heavily throttles high-frequency scheduled workflows, so it actually fires only ~10-20×/day — which is the real reason the ~8,500-edition history drain is pacing toward ~3 weeks rather than days. The YAML cron is already aggressive; bumping it won't help (GitHub ignores the extra ticks).

To actually drive the drain faster (only if you want it compressed — it's a fine background job as-is): the route app/api/cron/topshot-sales-history-backfill/route.ts currently drains SYNCHRONOUSLY (up to its ~240s budget), so it can't move to cron-job.org as-is (30s client cap). Wrap it in the 202+after() pattern you just applied to the offer-fill backfill (validate Bearer synchronously → after(() => drain()) → return 202 + keep the per-tick budget/log), THEN add a cron-job.org entry at every ~12 min (off-rush minutes). cron-job.org fires reliably, so the effective cadence jumps from ~15/day to ~120/day → the drain finishes in a couple days instead of three weeks. Leave the GHA entry as a fallback or retire it. Purely optional.

=== GUARDRAILS ===
- Work directly on main, no branches/PRs. Commit via PowerShell git (Git Bash can no-op); re-verify with git rev-list --count origin/main..HEAD = 0.
- Vercel Pro maxDuration cap 800s; keep any after() drain inside it.
- After any edge-fn/DB change: check_public_security_invariants()=0, check_secdef_anon_execute_violations()=[].
- Don't broad-read secret-bearing console pages.

=== EXPECTED END STATE ===
Item 1: allday-listing-serial-backfill ok=true, serials_resolved>0, allday_moment_serials climbing — AllDay deal board shows floor serials. Item 2 (if done): sales-history-backfill on cron-job.org firing reliably every ~12 min, the 9,091-edition queue draining in ~2 days instead of ~3 weeks.
