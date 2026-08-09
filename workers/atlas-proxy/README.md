# atlas-proxy

Cloudflare Worker pass-through to Dapper's Atlas marketplace service, so the
`topshot-active-listings-ingest` pipeline can reach Atlas from an IP that isn't
WAF-blocked (the GitHub Actions runner IP is — `egress_blocked`, ~83% fail).

Single upstream: `api.production.atlas.dapperlabs.com/.../SearchMarketplaceTransactions`.
Auth: `X-Proxy-Secret` header must equal `PROXY_SECRET`.

## Deploy (operator)

```bash
cd workers/atlas-proxy
wrangler deploy
wrangler secret put PROXY_SECRET   # reuse TS_PROXY_SECRET's value, or mint a new one
```

## Verify Cloudflare egress reaches Atlas (do this BEFORE wiring the runner)

⚠ It is **unverified** that Cloudflare egress is Atlas-WAF-allowed — Atlas is a
different WAF/service than the GQL host topshot-proxy already unblocks. Probe once:

```bash
curl -s -X POST "https://atlas-proxy.<subdomain>.workers.dev" \
  -H "X-Proxy-Secret: $TS_PROXY_SECRET" \
  --data-binary '{"product":"nba","completed":false,"editionId":"<realEditionId>","sortByOption":"SERIAL_NUMBER","sortByDirection":"ASC","limit":"1","offset":"0","offers":false}'
```

- A JSON body with `transactions` ⇒ Cloudflare egress works; wire the runner (below).
- An Access-Denied / Cloudflare-challenge / 403 body ⇒ **this lane is dead too**;
  the fallback is running `scripts/ingest-topshot-active-listings.mjs` from the
  residential box (same box that runs the Panini runner), not this worker.

## Wire the runner (only after the probe succeeds)

Set two env vars in the GitHub Actions workflow (`.github/workflows/topshot-active-listings-ingest.yml`)
or the runner environment — the script auto-routes through the proxy when
`ATLAS_PROXY_URL` is present, and stays on the direct-curl path otherwise:

```
ATLAS_PROXY_URL=https://atlas-proxy.<subdomain>.workers.dev
ATLAS_PROXY_SECRET=<PROXY_SECRET value>   # optional; falls back to TS_PROXY_SECRET
```

Until `ATLAS_PROXY_URL` is set, the ingest script's behaviour is byte-identical
to today (direct curl to Atlas) — this worker and the wiring are inert.
