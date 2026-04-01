# Top Shot Proxy Worker

Routes Top Shot GQL requests through Cloudflare to bypass Vercel IP blocks.

## Deploy (run from your local machine — requires Cloudflare account)

1. npm install -g wrangler
2. wrangler login
3. cd workers/topshot-proxy && wrangler deploy
4. wrangler secret put PROXY_SECRET
   (enter any strong random string — copy it, you need it for Vercel)
5. Copy the worker URL from deploy output
   e.g. https://topshot-proxy.YOUR-SUBDOMAIN.workers.dev
6. In Vercel dashboard → Settings → Environment Variables, add:
   TS_PROXY_URL = https://topshot-proxy.YOUR-SUBDOMAIN.workers.dev
   TS_PROXY_SECRET = (same value you entered in step 4)
7. Redeploy RPC (empty commit or click Redeploy in Vercel dashboard)

## Notes
- Cloudflare Workers free tier: 100,000 requests/day — sufficient
- Worker only accepts POST with correct X-Proxy-Secret header
- No data is stored or logged in the worker
