# Handoff 2026-06-07 (night) — fix the Pipeline Sentinel's three broken checks (+ optional curl hardening)

CONTEXT

The Pipeline Sentinel GHA has been red on EVERY run — but the platform is fine: the workflow's CRITICAL comes from a broken check inside app/api/sentinel/route.ts, not from real breakage. Diagnosed from the live run #726 log (22:33Z) + route source. Claude Code's direct file inspection wins over this doc on any disagreement. File: app/api/sentinel/route.ts.

ITEM 1 (P1, the actual red) — Sniper Feed check fetches without auth → login HTML → JSON parse error → CRITICAL every run
Line ~220: const res = await fetch(sniperUrl, { signal }) — NO Authorization header. /api/sniper-feed is not in proxy.ts's public list, so the self-fetch 307s to /login, gets the login page as HTTP 200 text/html, res.json() throws (Unexpected token '<'), the catch marks critical, the workflow exits 1. This fails identically regardless of platform health — the check has been dead weight, and it MASKED the real signal (the TS-UUID leak tripwire correctly sits at warn).
Fix: add headers: { Authorization: `Bearer ${process.env.INGEST_SECRET_TOKEN}` } to that fetch (proxy.ts honors Bearer first — same pattern as every cron self-call). Keep the 8s timeout. Note the route may then honestly report deals=0 → warn; that's correct behavior, not a regression.

ITEM 2 (P2, broken math — can never alarm) — Edition Coverage divides ALL snapshot rows by edition count
Run #726 reported "479241 of 22759 editions have FMV (2105.7%)". It counts total fmv_snapshots ROWS (history — daily duplicates are intentional) instead of DISTINCT editions with a snapshot. As written it can only fail if rows < editions, i.e., never — a dead detector. Fix: count distinct edition_id (cheap version: SELECT count(DISTINCT edition_id) FROM fmv_snapshots is heavy — prefer counting editions WHERE EXISTS a snapshot, or reuse the canonical latest-per-edition pattern). Threshold as before; the value should read ~100%, alarming if real coverage drops.

ITEM 3 (P3, misleading denominator) — FMV Confidence mixes all collections + inert UUID dupes
"HIGH: 643 (2.8%) | Total: 22759" lumps every collection plus ~6.4k inert TS dupes into one denominator, producing a permanently-scary 2.8% that means nothing (canonical TS alone is ~6% HIGH, 32% HIGH+MED). Fix: scope to canonical TS (editions.external_id ~ '^[0-9]+:[0-9]+$', collection_id = 95f28a17-224a-4025-96ad-adf8a4c63bfd) or emit per-collection lines via the existing sentinel_fmv_confidence_rows(p_collection_id) RPC. Keep warn thresholds proportionate after the rescope so it doesn't go permanently green either.

ITEM 4 (optional, P3) — rpc-pipeline.yml curl hardening
RPC Data Pipeline is healthy (3 failures in ~840 lifetime runs); the recent #833 was curl exit code 35 — a transient TLS handshake error on the runner. If you want the noise gone forever: add --retry 3 --retry-all-errors to the curl invocations in .github/workflows/rpc-pipeline.yml. Skip freely; it's a 0.4% lifetime blip.

VERIFY
After deploy, trigger the sentinel workflow manually (workflow_dispatch) or wait for the next :34 run: expect status WARN (the TS-UUID tripwire, 1,4xx and decaying — it self-clears below 250 ~June 8 afternoon) with Sniper Feed ok/warn and Edition Coverage ~100%. The workflow goes fully green once the tripwire clears. Sentry should show nothing new.

REVERT
git revert (single commit; route + optional yml).

GUARDRAILS (standard)
Direct-to-main, no branches/PRs; PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0); tsc + smoke after deploy.

END STATE: the sentinel measures reality — red means breakage, warn means the tripwire, green means green; Data Pipeline curl blips stop registering as failures.
