# hybrid-custody-proxy token rotation runbook

**Last updated: 2026-05-17**

## Symptom

`hybrid_custody_events` pipeline is logging 401 errors against the proxy `/head` endpoint. As of 2026-05-17 there are 26 `proxy /head http_401` errors, all firing since 2026-05-12. The proxy worker is reachable but rejecting our Bearer token.

## Cause

`HYBRID_CUSTODY_PROXY_TOKEN` (the Bearer the route uses) drifted out of sync with the worker's `INGEST_SECRET_TOKEN` secret. Per the **Worker auth surfaces (3 rotation domains)** section of `CLAUDE.md`, `hybrid-custody-proxy` is on the `INGEST_SECRET_TOKEN` (Bearer) surface, NOT the `TS_PROXY_SECRET` (X-Proxy-Secret) surface — rotating the wrong one is a common mistake.

## Recovery

Run from a checkout with the Cloudflare account already authenticated:

```bash
# 1. Decide on the new value. Use a 32-char URL-safe token.
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Push to the Cloudflare worker.
cd workers/hybrid-custody-proxy
echo "$NEW_TOKEN" | npx wrangler secret put INGEST_SECRET_TOKEN

# 3. Push to Vercel (production scope).
#    PowerShell Invoke-WebRequest is required from Windows — `vercel env`
#    CLI also works on macOS/Linux.
vercel env rm HYBRID_CUSTODY_PROXY_TOKEN production --yes
vercel env add HYBRID_CUSTODY_PROXY_TOKEN production
#    Paste $NEW_TOKEN when prompted.

# 4. Trigger a fresh Vercel deployment so the new value is baked in.
#    Dashboard "Redeploy" reuses cache and may NOT re-read env vars.
curl -X POST "https://api.vercel.com/v13/deployments?teamId=team_YWGCVToPBJSS60NgVh8jiCFV" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"rip-packs-city","gitSource":{"type":"github","repoId":"1188272071","ref":"main"}}'

# 5. Verify within ~5 min by tailing pipeline_runs for hybrid-custody-events.
#    Expectation: first new run after deploy is ok=true with no proxy http_401.
```

## What NOT to do

- Do not rotate `TS_PROXY_SECRET` thinking it will fix this. `hybrid-custody-proxy` does not consume that secret.
- Do not amend the `INGEST_SECRET_TOKEN` Vercel-side value to whatever Cloudflare currently has unless you have access to the CF dashboard to confirm — secret values are not pullable from either side (`vercel env pull` returns empty strings for sensitive values; `wrangler secret list` only shows names, not values). Generate a NEW value and push to both surfaces in lockstep.
- Do not skip step 4. Existing deployments cache the env var; "Redeploy from dashboard" with `Use existing Build Cache` checked may keep stale values.

## Cross-references

- **Worker auth surfaces (3 rotation domains)** in `CLAUDE.md` — the canonical map of which workers use which token. `hybrid-custody-proxy` is the only worker on the `INGEST_SECRET_TOKEN` Bearer surface.
- `/api/cron/cadence-payer-balance-check` (added 2026-05-17) — separate but parallel issue for the Cadence service payer running out of FLOW (`0x73f55c4450b8d466`).
