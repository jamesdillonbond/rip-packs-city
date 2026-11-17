# Operator runbook — what Trevor needs to do (2026-06-25)

**Bottom line:** Nothing is required for any shipped/running work — the studio deep-history backfills (all 5 collections), the Flowty unmapped drain, all media recovery (dead-media 0/0), FMV, security, and watchlists are all live and healthy. There are exactly **two** operator items below: **Item B is a quick, real, current fix; Item A is an optional, lowest-value enhancement you can skip entirely.**

---

## Item B — `topshot-listing-cache` has not refreshed in ~11.8h (look at GitHub Actions, not cron-job.org)

**Verified facts (read the files / ran the query 2026-06-25):**
- `topshot-listing-cache` last logged a run at **09:53Z (~11.8h ago)**, `last_ok=true`. `topshot-sales-indexer` and `fmv-recalc` logged runs ~11–16 min ago.
- It is triggered by the **GitHub Actions** workflow `.github/workflows/rpc-pipeline.yml` ("RPC Data Pipeline", schedule `5,25,45 * * * *`), via a `curl` step marked `continue-on-error: true` (a failing step is silent and won't fail the workflow). It is **NOT** in `vercel.json` and **NOT** a cron-job.org job — an earlier claim of mine that it was cron-job.org was wrong.

**What I could NOT determine from here (so I'm not guessing the cause):** whether the GitHub Actions workflow stopped, or it's running and only the listing-cache step/route is failing. `fmv-recalc` running recently does not prove the workflow ran — it has other triggers.

**You do:** GitHub → **Actions** tab → "RPC Data Pipeline" → recent run history + the "Top Shot Listing Cache" step output. That's the only place that shows whether it's the workflow or the step.

**Impact:** the TS live-listings cache is ~11.8h stale. I have not measured the downstream effect beyond that.

---

## Item A — wire the spork-proxy for the pre-2024 deep tail (OPTIONAL, lowest value)

**Read this first — decide whether it's worth doing:** This unlocks on-chain history for **2022-04-06 → 2024 only** (TS-Flowty/AllDay-Flowty sales + the 2022-24 buyer-address tail). Pre-2022-04 is **permanently unrecoverable** (Flow decommissioned those spork nodes — measured fact). It's the earliest, thinnest-liquidity era. **The platform is 100% complete without any of this.** Do it only if pre-2024 Flowty/buyer depth genuinely matters to you. If not — skip the whole section.

**Prerequisites:**
- Cloudflare: logged into the account that owns `*.tdillonbond.workers.dev` (`wrangler login`, or `CLOUDFLARE_API_TOKEN` set).
- Vercel: access to project `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96` (team `team_YWGCVToPBJSS60NgVh8jiCFV`).
- Latest `main` pulled (CC's worker change = commit `59ddb6b`).

### A1 — Deploy the updated worker
```
cd workers/spork-proxy
npx wrangler deploy
```
Ships CC's corrected spork boundaries + the added mainnet17/18/27. Deploys to `spork-proxy.tdillonbond.workers.dev`.

### A2 — Set the worker's auth secret
```
cd workers/spork-proxy
npx wrangler secret list                      # optional: see if SPORK_PROXY_SECRET already exists
npx wrangler secret put SPORK_PROXY_SECRET     # paste a long random string; REMEMBER it for A4
```
Pick a strong random value. (The worker currently 401s all authed requests; this makes the secret a value you control. If one already exists and you don't know it, just overwrite with a fresh one.)

### A3 — Verify end-to-end (the code requires this before enabling — worker route is `GET /?tx=<hex>`)
This is a real 2022-04-07 TS sale tx (exactly the kind the lane targets):
```
curl -i -H "Authorization: Bearer <your-secret-from-A2>" \
 "https://spork-proxy.tdillonbond.workers.dev/?tx=6a3eee174fdc2f3446cfb95f223b5dbf1dcf5d34e56a62e70f275f483cd13184"
```
- **Expect:** HTTP 200 + JSON body with events + an `X-Spork-Node` header naming the spork used.
- 401 → secret/bearer mismatch (re-check A2). 
- A bare ping `https://spork-proxy.tdillonbond.workers.dev/?` (no params) returns `{"ok":true,...}` and is intentionally unauthenticated — that only proves reachability, NOT auth, so don't stop there (this is exactly the test that fooled me into calling it a "stub").

### A4 — Set Vercel env vars (must MATCH the worker secret), then redeploy
- `SPORK_PROXY_URL` = `https://spork-proxy.tdillonbond.workers.dev`
- `SPORK_PROXY_SECRET` = the exact value from A2
- Redeploy (env vars only bake in on a fresh deploy).

**After A1–A4 the proxy is live and reachable from Vercel.** The two sub-uses below are independent:

### A5 — (optional) turn on the 2022-2024 buyer-address backfill (~42K null-buyer rows)
- Vercel env: `TS_HISTORICAL_BUYER_BACKFILL_ENABLED=1`, redeploy.
- Wire a low-cadence cron (cron-job.org) → `POST https://www.rippackscity.com/api/admin/backfill-topshot-buyers?mode=historical`, header `Authorization: Bearer <INGEST_SECRET_TOKEN>`. Logs as `topshot-buyer-backfill-historical`. The route is already built + inert; this just turns it on.

### A6 — (CC's follow-up, NOT you) the Flowty SALES deep tail
Once A1–A4 are verified, tell Claude Code: *"spork-proxy is live, SPORK_PROXY_URL/SECRET are set in Vercel."* CC then ships the `topshot-flowty-sales-history-backfill` floor extension — it was **deliberately not shipped blind** because it's an off-limits sales-ingest route that can't be tested until the proxy is wired. That's what actually captures the pre-2024 Flowty-venue *sales* history.

---

## Summary of what's literally on you
1. **(look)** `topshot-listing-cache` stale ~11.8h — check GitHub → Actions → "RPC Data Pipeline" (it's a GHA step, not cron-job.org). I can't see the Actions run history, so I can't tell you the cause from here.
2. **(optional)** If you want pre-2024 depth: `wrangler deploy` the spork-proxy + `wrangler secret put SPORK_PROXY_SECRET` + set `SPORK_PROXY_URL`/`SPORK_PROXY_SECRET` (+ optionally `TS_HISTORICAL_BUYER_BACKFILL_ENABLED=1` + a cron) in Vercel, verify with the curl above, then hand A6 to CC.

Everything else from the thread is shipped, verified, and self-running.
