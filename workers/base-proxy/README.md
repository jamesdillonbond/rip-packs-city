# Base Mainnet JSON-RPC Proxy Worker

Routes Base mainnet JSON-RPC requests through Cloudflare to bypass Vercel IP
blocks and consolidate auth on the same `X-Proxy-Secret` header pattern used by
the other RPC workers.

Upstream: `https://mainnet.base.org` (Base mainnet, chain ID 8453).

> ⚠️ Base's public RPC endpoint is rate-limited per Base's own docs. This is
> fine for low-volume health checks and ad-hoc reads through the proxy. When
> we start running a real indexer against Beezie's Base contract
> `0xbb5ec6fd4b61723bd45c399840f1d868840ca16f`, swap the upstream to a paid
> provider (Alchemy / QuickNode / dRPC) — same worker shape, just change the
> `fetch()` target URL and rotate the deploy.

## Routes

| Path | Upstream |
|------|----------|
| `GET /` | Health check — returns `base-proxy ok` (no auth) |
| `POST /` | mainnet.base.org (JSON-RPC pass-through) |

POST requests require `X-Proxy-Secret` header matching the worker secret. The
body is forwarded as raw text because JSON-RPC payloads can be batch arrays,
not just single objects.

## Deploy (run from your local machine — requires Cloudflare account)

1. npm install -g wrangler
2. wrangler login
3. cd workers/base-proxy && wrangler deploy
4. wrangler secret put PROXY_SECRET
   (enter any strong random string — copy it, you need it for Vercel)
5. Copy the worker URL from deploy output
   e.g. https://base-proxy.YOUR-SUBDOMAIN.workers.dev
6. In Vercel dashboard, add these env vars (production, preview, development):
   EVM_PROXY_URL_BASE_MAINNET = https://base-proxy.YOUR-SUBDOMAIN.workers.dev
   EVM_PROXY_SECRET_BASE_MAINNET = (same value you entered in step 4)
7. Verify the worker is live by curling the URL with GET:
   `curl https://base-proxy.YOUR-SUBDOMAIN.workers.dev`
   Response must be the literal string `base-proxy ok`. If you get a
   Cloudflare 404 instead, the `workers_dev = true` line is missing from
   wrangler.toml and the worker deployed without a public URL.
8. End-to-end smoke test once Vercel env vars are baked into a fresh build:
   `curl 'https://www.rippackscity.com/api/admin/evm-health?chain=base_mainnet&token=$RPC_ADMIN_TOKEN'`
   Expect `chainId: 8453, chainIdMatches: true`.

## Notes
- Cloudflare Workers free tier: 100,000 requests/day — sufficient for
  health checks and low-volume reads, but NOT for a full event-log indexer
  at any meaningful block range. Plan for paid Cloudflare + paid RPC
  provider when indexing kicks off.
- POST requests require the `X-Proxy-Secret` header; GET / is unauthenticated
  for health checks only.
- No data is stored or logged in the worker.
