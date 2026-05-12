# Flow EVM JSON-RPC Proxy Worker

Routes Flow EVM JSON-RPC requests through Cloudflare to bypass Vercel IP blocks.
Upstream: `https://mainnet.evm.nodes.onflow.org` (Flow EVM mainnet, chain ID 747).

## Routes

| Path | Upstream |
|------|----------|
| `GET /` | Health check — returns `flowevm-proxy ok` (no auth) |
| `POST /` | mainnet.evm.nodes.onflow.org (JSON-RPC pass-through) |

POST requests require `X-Proxy-Secret` header matching the worker secret. The
body is forwarded as raw text because JSON-RPC payloads can be batch arrays,
not just single objects.

## Deploy (run from your local machine — requires Cloudflare account)

1. npm install -g wrangler
2. wrangler login
3. cd workers/flowevm-proxy && wrangler deploy
4. wrangler secret put PROXY_SECRET
   (enter any strong random string — copy it, you need it for Vercel)
5. Copy the worker URL from deploy output
   e.g. https://flowevm-proxy.YOUR-SUBDOMAIN.workers.dev
6. In Vercel dashboard, add these env vars:
   FLOWEVM_PROXY_URL = https://flowevm-proxy.YOUR-SUBDOMAIN.workers.dev
   FLOWEVM_PROXY_SECRET = (same value you entered in step 4)
7. Verify the worker is live by curling the URL with GET:
   `curl https://flowevm-proxy.YOUR-SUBDOMAIN.workers.dev`
   Response must be the literal string `flowevm-proxy ok`. If you get a
   Cloudflare 404 instead, the `workers_dev = true` line is missing from
   wrangler.toml and the worker deployed without a public URL.

## Notes
- Cloudflare Workers free tier: 100,000 requests/day — sufficient
- POST requests require the `X-Proxy-Secret` header; GET / is unauthenticated
  for health checks only
- No data is stored or logged in the worker
