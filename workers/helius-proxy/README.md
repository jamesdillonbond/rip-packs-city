# Helius Solana DAS Proxy Worker

Routes Solana **Digital Asset Standard (DAS)** JSON-RPC requests through
Cloudflare so the upstream API key never ships to the client and Vercel/Supabase
egress stays off the keyed endpoint — consistent with RPC's proxy-everything
rule. This is the read path for **Candy Digital on Solana** (chain two): Metaplex
Core assets, collection grouping, and per-wallet holdings.

Upstream: a DAS-enabled Solana RPC (Helius recommended; Triton / QuickNode also
work). The full **keyed** endpoint is stored in the worker secret `HELIUS_RPC_URL`
so the API key is never in this source.

## Auth surface (its own rotation domain)

`helius-proxy` has its **own** secret `HELIUS_PROXY_SECRET` (sent as the
`X-Proxy-Secret` header). Per CLAUDE.md "Worker auth surfaces", this is **never**
shared with `TS_PROXY_SECRET` or `INGEST_SECRET_TOKEN` — rotate it independently.

## Routes

| Path | Upstream |
|------|----------|
| `GET /` | Health check — returns `helius-proxy ok` (no auth) |
| `POST /` | `HELIUS_RPC_URL` (DAS JSON-RPC pass-through) |

POST requests require the `X-Proxy-Secret` header matching `HELIUS_PROXY_SECRET`.
The body is forwarded as raw text because JSON-RPC payloads can be batch arrays,
not just single objects.

Typical methods sent through it: `getAssetsByGroup` (all assets in a Candy
collection), `getAssetsByOwner` (a wallet's Candy holdings), `getAsset` (one
asset incl. serial / edition attributes).

## Deploy (run from your local machine — requires a Cloudflare account)

Workers deploy via manual `wrangler`, NOT git push.

1. `npm install -g wrangler`
2. `wrangler login`
3. `cd workers/helius-proxy && wrangler deploy`
4. `wrangler secret put HELIUS_PROXY_SECRET`
   (enter a strong random string — copy it; you need it for Vercel)
5. `wrangler secret put HELIUS_RPC_URL`
   (paste the full keyed DAS endpoint, e.g.
   `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`)
6. Copy the worker URL from the deploy output
   (e.g. `https://helius-proxy.YOUR-SUBDOMAIN.workers.dev`)
7. In Vercel, add these env vars (production, preview, development):
   - `HELIUS_PROXY_URL = https://helius-proxy.YOUR-SUBDOMAIN.workers.dev`
   - `HELIUS_PROXY_SECRET = ` (same value you entered in step 4)
8. Verify the worker is live with a GET:
   `curl https://helius-proxy.YOUR-SUBDOMAIN.workers.dev`
   Response must be the literal string `helius-proxy ok`. A Cloudflare 404
   instead means the `workers_dev = true` line is missing from wrangler.toml.
9. End-to-end smoke test — a `getAssetsByGroup` round-trip should return assets
   for any known Metaplex Core collection (use a public one until Candy's
   collection address is discovered):
   ```
   curl -X POST https://helius-proxy.YOUR-SUBDOMAIN.workers.dev \
     -H "X-Proxy-Secret: YOUR_HELIUS_PROXY_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getAssetsByGroup","params":{"groupKey":"collection","groupValue":"<CORE_COLLECTION_ADDR>","page":1,"limit":10}}'
   ```

## Notes
- Cloudflare Workers free tier: 100,000 requests/day — fine for discovery and
  low-volume reads. A full collection walk paginates at `limit:1000`; plan for
  a paid Helius tier + paid Cloudflare when the Candy editions/wallet indexers
  go to production cadence.
- POST requires `X-Proxy-Secret`; `GET /` is unauthenticated for health checks
  only.
- No data is stored or logged in the worker.
- **NxGen `$CAND` disambiguation:** only ever index Metaplex Core assets under
  Candy Digital's verified collection / update authority — never the unrelated
  NxGen "$CAND" Raydium token.
