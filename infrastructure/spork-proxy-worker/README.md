# spork-proxy worker

A Cloudflare Worker that forwards Flow REST API requests to historical
access nodes on port 8070. Used by Supabase edge functions to scan
pre-current-spork blockchain history (mainnet24 through mainnet27 today;
add new sporks to `SPORK_NODES` in `index.ts` as Flow rolls them out).

The current production deployment at `spork-proxy.tdillonbond.workers.dev`
is a stub returning `{"ok":true,"worker":"spork-proxy"}` for every path.
This package replaces it with a real proxy.

## Why a Worker

Cloudflare Workers can `fetch()` HTTP (non-HTTPS) URLs on non-standard
ports — confirmed working pattern. Vercel functions and Supabase edge
functions cannot, because their fetch implementation is locked to HTTPS
and standard ports. A Worker is the smallest piece of infrastructure
that solves this access problem.

## Deploy

```bash
# 1. Install wrangler globally if you haven't already
npm i -g wrangler

# 2. Authenticate against the Cloudflare account that owns
#    spork-proxy.tdillonbond.workers.dev
wrangler login

# 3. Deploy from this directory
cd infrastructure/spork-proxy-worker
wrangler deploy
```

Wrangler reads `wrangler.toml` for the worker name (`spork-proxy`) and
the entry file (`index.ts`). The first deploy from this directory will
overwrite the existing stub.

## Verify

After `wrangler deploy` reports success, confirm the worker is no longer
returning the stub:

```bash
# Health check — should list the available sporks
curl https://spork-proxy.tdillonbond.workers.dev/

# Real Flow query — should return JSON with a block, NOT the stub response
curl 'https://spork-proxy.tdillonbond.workers.dev/spork/mainnet27/v1/blocks?height=sealed'
```

If the second call returns `{"ok":true,"worker":"spork-proxy"}` you're
hitting the stub — wrangler hasn't promoted the new build yet. Wait a
few seconds and retry, or check `wrangler tail` for routing errors.

## Path conventions

Both forms are accepted:

- `https://spork-proxy.tdillonbond.workers.dev/spork/mainnet27/v1/blocks?height=sealed`
- `https://spork-proxy.tdillonbond.workers.dev/mainnet27/v1/blocks?height=sealed`

The first form is preferred by Supabase edge functions for clarity.

## Once deployed

After verification, ping back so we can build the historical indexer
that uses this proxy. The probe edge function `flowty-spork-probe`
(used to discover that the prior deployment was a stub) is no longer
needed once this proxy returns real data — feel free to delete it.

## Notes

- **HTTP/HTTPS gotcha**: the spork access nodes only accept HTTP on port
  8070. Workers permit HTTP outbound, but the public endpoint is HTTPS
  (the Worker terminates TLS for inbound requests). This is fine.
- **Timeouts**: each upstream request has a 25-second timeout. Cloudflare
  Workers themselves have a 30-second wall-clock limit on the free plan,
  so leaving 5 seconds of headroom is intentional.
- **CORS**: the worker advertises `Access-Control-Allow-Origin: *`. The
  proxy is read-only against public Flow REST data, so this is fine.
- **Auth**: there's no auth header on this proxy. If we ever need to
  rate-limit, add a `X-Spork-Secret` header check matching a Cloudflare
  Workers secret (`wrangler secret put SPORK_SECRET`). Not needed today.
