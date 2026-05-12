# rpc-mcp-proxy

Cloudflare Worker exposing the Rip Packs City collector intelligence layer as a Flow MCP server. Streamable HTTP transport per MCP spec `2025-06-18` (single endpoint, JSON-RPC 2.0, plain JSON responses — no SSE in v1).

Deployed at: `https://rpc-mcp.tdillonbond.workers.dev`

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Minimal HTML landing page |
| `GET` | `/health` | `{ ok, version, supabase_reachable, rpcs_reachable, build_sha }` |
| `POST` | `/mcp` | MCP JSON-RPC endpoint (bearer auth required) |
| `GET`/`DELETE` | `/mcp` | 405 — no server-initiated streams or sessions in v1 |

## Authentication

`POST /mcp` requires `Authorization: Bearer rpc_mcp_live_<token>`. The token is sha256-hashed and validated against `mcp_api_keys.key_hash` via `mcp_validate_api_key`. Issue keys through the dashboard at `/dashboard/api-keys` (Track E) or via the DB RPC `mcp_issue_api_key(p_wallet_address, p_label, p_scopes)` for ad-hoc admin keys.

Every authed request also passes through `check_feature_quota(wallet, 'mcp_query')` and returns `429 Retry-After` (seconds until UTC midnight) when the daily cap is hit.

## Tools

| Tool | Backing | Adapter? |
|---|---|---|
| `get_fmv` | `mcp_get_fmv` | yes |
| `get_sniper_deals` | `get_top_deals` / `get_allday_sniper_deals` | no (worker dispatches by slug) |
| `compute_pack_ev` | `mcp_compute_pack_ev` | yes |
| `find_set_completion_path` | `mcp_find_set_completion` | yes |
| `lookup_wallet` | `holdings_summary` + `get_wallet_portfolio` | no (worker composes) |
| `get_badge_data` | `mcp_get_badge_data` | yes |

Full schemas, parameter examples, and known gaps are in [docs/mcp-tool-mapping.md](../../docs/mcp-tool-mapping.md).

## Deploy

```bash
cd workers/rpc-mcp-proxy

# First-time setup (one each, paste secret when prompted):
wrangler secret put SUPABASE_URL --name rpc-mcp
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name rpc-mcp
wrangler secret put MCP_INTERNAL_SECRET --name rpc-mcp

# Deploy with current git short SHA embedded:
npm run deploy
# (equivalent: wrangler deploy --var BUILD_SHA:$(git rev-parse --short HEAD))
```

## Observability

- `mcp_log_tool_call` writes every tool execution to `usage_events` with `feature_name = 'mcp_<tool>'` and `metadata = { duration_ms, gaps_count, error? }`.
- `v_mcp_usage_today` is the hourly rollup over the last 24h.
- `wrangler tail --name rpc-mcp` for live worker logs.

## Hard constraints

- Worker never crashes on upstream failure. Supabase 5xx → JSON-RPC tool result with `gaps: ['upstream_supabase_unavailable_...']` rather than HTTP 500.
- Adapter exceptions caught and surfaced in `gaps: ['adapter_exception_...']` with sanitized SQL error message (max 60 chars).
- `unknown_collection_slug` is gap-flagged, never a hard error.
- `null`/empty result is not a failure — empty arrays + appropriate gaps.

## Not in v1

- No KV / Cache API. Every request hits Supabase directly. (Latency is fine; FMV freshness is cleaner without an intermediate cache layer.)
- No session management. Stateless JSON-RPC; no `Mcp-Session-Id` issued or required.
- No SSE / server-initiated streaming. All responses are plain `application/json`.
- No `MCP_INTERNAL_SECRET` consumption. Provisioned for future inter-worker calls (e.g. cache-flush trigger from `/api/mcp/keys` revoke flow).
