# dune-proxy

Cloudflare Worker fronting the [Dune Analytics Query Results API](https://docs.dune.com/api-reference/executions/endpoint/get-query-result)
for the TopShot **ownership-index** sync (Pipeline A — see
`docs/handoff-2026-06-26-ownership-index.md`).

Dune's API key must never reach Vercel edge logs, so the worker holds it and
Vercel calls the worker with its own Bearer secret. This is a **4th independent
auth rotation surface** — it does **not** share `TS_PROXY_SECRET`,
`INGEST_SECRET_TOKEN`, or `SPORK_PROXY_SECRET` (CLAUDE.md → "Worker auth surfaces").

## Routes

| Route | Upstream | Notes |
|---|---|---|
| `GET /results?query_id=<id>&limit=<n>&offset=<n>` | `GET api.dune.com/api/v1/query/<id>/results` | Injects `X-Dune-API-Key`. Pass-through JSON. Walk `offset` until the response stops returning a `next_offset`. |
| `GET /health` | — | `{ ok: true }`, no upstream. |

Auth on `/results`: `Authorization: Bearer <DUNE_PROXY_SECRET>`.

## Setup (operator)

1. Create a Dune account + API key (cost-flat decision — confirm the row volume
   of the ownership query fits the chosen plan before committing; ~300k+ TS NFTs).
2. Author the ownership query in Dune (see the handoff for the exact SQL shape);
   note its numeric query id.
3. Secrets:
   ```
   cd workers/dune-proxy
   wrangler secret put DUNE_PROXY_SECRET --name dune-proxy   # pick a fresh secret
   wrangler secret put DUNE_API_KEY      --name dune-proxy   # the Dune API key
   wrangler deploy
   curl https://dune-proxy.<subdomain>.workers.dev/health    # -> {"ok":true}
   ```
4. Vercel env (PowerShell `Invoke-WebRequest`, per CLAUDE.md):
   - `DUNE_PROXY_URL`    = `https://dune-proxy.<subdomain>.workers.dev`
   - `DUNE_PROXY_SECRET` = same value put on the worker
   - `DUNE_OWNERSHIP_QUERY_ID` = the numeric query id from step 2
5. The Vercel route `/api/cron/sync-topshot-ownership-dune` stays **inert** (logs
   `skipped: dune_not_configured`) until `DUNE_PROXY_URL` + `DUNE_PROXY_SECRET` +
   `DUNE_OWNERSHIP_QUERY_ID` are all set. Once set, wire a daily cron-job.org
   entry (`Authorization: Bearer <INGEST_SECRET_TOKEN>`), off the :00 rush.
