# pinnacle-proxy

Cloudflare Worker that proxies Disney Pinnacle GraphQL requests from
Vercel-hosted routes. Same auth pattern as `workers/topshot-proxy`.

## Deploy

```bash
# From repo root, auth once:
npx wrangler login

# Deploy:
npx wrangler deploy --config workers/pinnacle-proxy/wrangler.toml

# Set the shared secret (read by the Worker as env.PROXY_SECRET):
npx wrangler secret put PROXY_SECRET --config workers/pinnacle-proxy/wrangler.toml
```

## Smoke test

```bash
curl https://pinnacle-proxy.tdillonbond.workers.dev/graphql \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-Proxy-Secret: <secret>' \
  -d '{"query": "{ __typename }"}'
```

## Vercel env vars needed (add after deploy)

- `PINNACLE_PROXY_URL` = `https://pinnacle-proxy.tdillonbond.workers.dev/graphql`
- `PINNACLE_PROXY_SECRET` = same value as the `PROXY_SECRET` set above

Any route hitting `https://public-api.disneypinnacle.com/graphql` directly
from Vercel should be swapped to `PINNACLE_PROXY_URL` with the
`X-Proxy-Secret` header set to `PINNACLE_PROXY_SECRET`.
