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

Every authed request also passes through `check_feature_quota(wallet, 'mcp_query')` (a cheap early reject), and every `tools/call` is counted atomically by `mcp_reserve_tool_call(wallet, tool)` **before** the tool runs: it takes a per-wallet advisory lock, reads the quota and writes the counted `mcp_query` row in one transaction, so parallel calls cannot all read the same `used_today` (security audit 2026-10-25, register R138(a); pinned by `supabase/tests/mcp_reserve_tool_call.sql`). A denied call writes nothing and returns JSON-RPC `-32002 quota_exceeded` with `retry_after_seconds` (until UTC midnight); a failed reservation fails closed (`-32000`). A request already over the cap gets `429 Retry-After` from the early check.

> History: until 2026-09-03 the cap could not fire at all (nothing wrote `mcp_query`, and the `feature_quotas` seed used plan names the CHECK forbids) — both fixed that day, `mcp_log_tool_call` writing the quota row from SQL. Until the 2026-10-25 worker is deployed, the LIVE worker still uses that check-then-log path; `mcp_log_tool_call` is kept unchanged so it keeps counting until then.

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

- `mcp_log_tool_detail` writes every tool execution to `usage_events` with `feature_name = 'mcp_<tool>'` and `metadata = { duration_ms, gaps_count, error? }`; the counted `mcp_query` row comes from `mcp_reserve_tool_call` (the pre-2026-10-25 worker used `mcp_log_tool_call`, which writes both).
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
