# Dapper GQL Proxy Worker

Routes GQL requests through Cloudflare to bypass Vercel IP blocks.
Supports multiple Dapper Labs collections via URL path routing.

## Routes

| Path | Upstream |
|------|----------|
| `POST /` | public-api.nbatopshot.com/graphql (legacy default) |
| `POST /topshot` | public-api.nbatopshot.com/graphql |
| `POST /allday` | public-api.nflallday.com/graphql |

All routes require `X-Proxy-Secret` header matching the worker secret.

## Deploy (run from your local machine — requires Cloudflare account)

1. npm install -g wrangler
2. wrangler login
3. cd workers/topshot-proxy && wrangler deploy
4. wrangler secret put PROXY_SECRET
   (enter any strong random string — copy it, you need it for Vercel)
5. Copy the worker URL from deploy output
   e.g. https://topshot-proxy.YOUR-SUBDOMAIN.workers.dev
6. In Vercel dashboard, add these env vars:
   TS_PROXY_URL = https://topshot-proxy.YOUR-SUBDOMAIN.workers.dev
   TS_PROXY_SECRET = (same value you entered in step 4)
   AD_PROXY_URL = https://topshot-proxy.YOUR-SUBDOMAIN.workers.dev/allday
7. Redeploy RPC (empty commit or click Redeploy in Vercel dashboard)

## Notes
- Cloudflare Workers free tier: 100,000 requests/day — sufficient
- Worker only accepts POST with correct X-Proxy-Secret header
- No data is stored or logged in the worker
- CORS preflight (OPTIONS) is handled automatically
