# Handoff — two chronic Sentinel failure-rate alerts (egress-gated)

Date: 2026-08-09 (PT). Author: Claude Code (interactive).

Two `get_pipeline_alerts()` **failure_rate** alerts are firing on chronic egress
blocks. Both were reviewed against live state; the underlying failures are
infra/egress, not code bugs. Per Trevor's call (2026-08-09) the alerts stay
**visible** (not suppressed) — this handoff carries the one code artifact drafted
for the first, plus the infra item for the second.

---

## 1. topshot-active-listings-ingest — `egress_blocked` (~83% fail)

**Cause:** the GitHub Actions runner IP is WAF-blocked by Dapper's Atlas
marketplace service. Degraded, not dead — 3/18 runs still land (`#1` /
perfect-mint serial listings feeding the ask-FMV + premium boards).

**Drafted fix (shipped to `main`, INERT until deployed):** a Cloudflare-worker
pass-through so the ingest rides a Cloudflare egress IP instead of the runner's
— the same trick `topshot-proxy` uses to reach nbatopshot GQL that Vercel can't.

- `workers/atlas-proxy/` — new worker (`index.js`, `wrangler.toml`, `README.md`).
  `X-Proxy-Secret`-gated POST pass-through to
  `api.production.atlas.dapperlabs.com/.../SearchMarketplaceTransactions`,
  injecting the Connect/browser headers server-side.
- `scripts/ingest-topshot-active-listings.mjs` — routes through the worker when
  `ATLAS_PROXY_URL` is set; **unset ⇒ byte-identical direct-curl to Atlas**, so
  nothing changes until you opt in.

### ⚠ Unverified assumption — probe before wiring

It is **not proven** that Cloudflare egress is Atlas-WAF-allowed (Atlas is a
different WAF/service than the GQL host). From CI/cloud we cannot reach Atlas to
test. After deploy, run the one-line probe in `workers/atlas-proxy/README.md`:
- JSON `transactions` back ⇒ it works; set the two envs and the alert clears on
  the next runs.
- Access-Denied / Cloudflare challenge / 403 ⇒ **this lane is dead too**; the
  fallback is running the ingest script from the residential box (the box that
  already runs the Panini runner), not this worker.

### Operator steps
1. `cd workers/atlas-proxy && wrangler deploy && wrangler secret put PROXY_SECRET`
   (reuse `TS_PROXY_SECRET`'s value or mint a new one).
2. Probe (README). If green:
3. Add to `.github/workflows/topshot-active-listings-ingest.yml` env (or the
   runner env): `ATLAS_PROXY_URL=https://atlas-proxy.<subdomain>.workers.dev`
   and optionally `ATLAS_PROXY_SECRET=<value>` (falls back to `TS_PROXY_SECRET`).

### Revert
`git revert <sha>` removes the worker + the script wiring. With `ATLAS_PROXY_URL`
never set, there is nothing to unwind operationally.

---

## 2. sync-nba-projections — `all_upstreams_failed` (100% fail)

**Cause:** NBA **offseason** (no games for ~2 months) *and* all three upstreams
are Akamai/WAF-blocked — including the `rpc-sports-proxy` worker the pipeline
already routes through (the edge-fn header documents "draftkings.com is now
blocking the worker entirely"; live errors: DK 403/502, ESPN 403, scoreboard
502). Even the scoreboard that would prove "no slate" is blocked, so the v9
no-slate/all-upstreams-failed split correctly classifies it as a hard failure.

**No code fix remains** — the worker path is itself blocked and there is no
consumer for projections until the season resumes (~October).

### Options (operator / product call — NOT auto-applied)
- **Do nothing:** the alert self-resolves when the season starts *and* egress
  recovers. It stays red through the offseason (acceptable if you read the board
  knowing why).
- **Time-boxed suppression** via the sanctioned table (reversible), if the red
  arm becomes noise:
  ```sql
  INSERT INTO pipeline_alert_suppression (pipeline, reason, expires_at)
  VALUES ('sync-nba-projections',
          'NBA offseason + all upstreams (incl. rpc-sports-proxy worker) Akamai-blocked; no consumer until preseason. Re-evaluate at season start.',
          '2026-10-14T00:00:00Z');
  -- undo: DELETE FROM pipeline_alert_suppression WHERE pipeline = 'sync-nba-projections';
  ```
  `get_pipeline_alerts()` honors this table on every arm; it auto-expires so the
  alert re-surfaces if projections still can't sync once games return.
- **Egress recon:** if projections are wanted before the block lifts, the only
  lever is a fresh egress path (a residential/mobile IP proxy Akamai hasn't
  fingerprinted) — an infra project, not a code change.
