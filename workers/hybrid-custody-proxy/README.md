# hybrid-custody-proxy

Fronts the Flow Access REST API for HybridCustody account-linking detection.
Cloudflare Workers can reach `rest-mainnet.onflow.org` reliably from anywhere;
Supabase / Vercel egress occasionally hits rate-limiting or transient blocks
when calling the Flow node directly.

## Routes

| Path | Method | Purpose |
|------|--------|---------|
| `/events` | POST | Proxies `/v1/events` for whitelisted HybridCustody event types. Body: `{ type, start_height, end_height }`. Range capped at 250 blocks. |
| `/script` | POST | Proxies `/v1/scripts` for Cadence script execution. Body: `{ script: <b64>, arguments: [<b64>] }` (Flow REST shape). |
| `/head`   | GET  | Returns `{ height }` from `/v1/blocks?height=sealed`. |

All routes require `Authorization: Bearer <PROXY_SECRET>` where PROXY_SECRET
matches the worker secret. The token value is the existing
`INGEST_SECRET_TOKEN` so callers can reuse the same auth they already use for
Supabase edge functions.

## Whitelisted event types

The `/events` route only forwards these:

- `A.d8a7e05a7ac670c0.HybridCustody.AccountUpdated`
- `A.d8a7e05a7ac670c0.HybridCustody.OwnershipGranted`
- `A.d8a7e05a7ac670c0.HybridCustody.AccountSealed`
- `A.d8a7e05a7ac670c0.HybridCustody.ChildAccountPublished`

Anything else returns 400.

## Deploy

```sh
cd workers/hybrid-custody-proxy
wrangler deploy
# When prompted, paste the value of INGEST_SECRET_TOKEN:
echo "$INGEST_SECRET_TOKEN" | wrangler secret put PROXY_SECRET --name hybrid-custody-proxy
```

## Smoke test

```sh
# /head should return { height: <number> }
curl -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
  https://hybrid-custody-proxy.tdillonbond.workers.dev/head

# /events for a 250-block range — should return [] for any range with no
# AccountUpdated activity.
HEAD=$(curl -s -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
  https://hybrid-custody-proxy.tdillonbond.workers.dev/head | jq -r .height)
curl -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"A.d8a7e05a7ac670c0.HybridCustody.AccountUpdated\",\"start_height\":$((HEAD-100)),\"end_height\":$HEAD}" \
  https://hybrid-custody-proxy.tdillonbond.workers.dev/events
```

## Vercel / Supabase env wiring

After deploy, set on consumers:

```
HYBRID_CUSTODY_PROXY_URL    = https://hybrid-custody-proxy.tdillonbond.workers.dev
HYBRID_CUSTODY_PROXY_SECRET = <same value as INGEST_SECRET_TOKEN>
```

(`HYBRID_CUSTODY_PROXY_SECRET` is intentionally a separate name from
`INGEST_SECRET_TOKEN` so the worker can be rotated independently when needed.)
