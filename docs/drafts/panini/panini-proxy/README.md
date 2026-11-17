# panini-proxy worker (DRAFT — not deployed)

Plane-A `onepanini` fallback. Only needed if we go the direct-Panini-marketplace route instead of (or alongside)
CryptoSlam's commercial API. CryptoSlam is the recommended primary; this is the high-fidelity backstop.

## Why a worker
`POST https://nft.paniniamerica.net/onepanini` is bot-protected (Signifyd device checks; naive calls return
HTTP 426 "Invalid request"). Vercel/Supabase egress is the kind of traffic that gets blocked. A Cloudflare Worker
runs from CF IPs, holds the dedicated secret, and replays the app's exact request headers. RPC routes never call
Panini directly — always through this worker (same discipline as topshot-proxy / pinnacle-proxy).

## One open discovery item (blocks real use)
Capture the Panini SPA's exact `/onepanini` request from a **logged-in session** (DevTools → Network → the
`onepanini` POST → copy request headers + body). Fill `UPSTREAM_HEADERS` in `index.js` with the static headers
(app-version / client-id / etc. — never a user token), and confirm the body shape RPC must send for the
edition/circulation query. Until then the worker honestly passes through the 426.

## Deploy (at go-live only)
1. Move this folder to `workers/panini-proxy/` (workers deploy via manual `wrangler`, not git push — see the
   worker-deploy-drift note in CLAUDE.md).
2. `wrangler secret put PANINI_PROXY_SECRET --name panini-proxy` (fresh value; not shared with any other surface).
3. `wrangler deploy`.
4. Set Vercel envs: `PANINI_PROXY_URL`, `PANINI_PROXY_SECRET` (same value), and `PANINI_FEED_MODE=onepanini`.
5. Smoke: `lib/chains/panini/feed.ts` `fetchPaniniEditions()` returns rows; `ingest/panini-editions` writes
   `panini_editions`.

## Auth surfaces (do not conflate)
`PANINI_PROXY_SECRET` (this worker, X-Proxy-Secret) is independent of `TS_PROXY_SECRET`, `INGEST_SECRET_TOKEN`,
`SPORK_PROXY_SECRET`, and `HELIUS_PROXY_SECRET`. Rotate on its own.
