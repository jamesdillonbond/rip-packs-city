// rpc-mcp-proxy — Rip Packs City collector intelligence as a Flow MCP server.
// Streamable HTTP transport per MCP spec 2025-06-18:
//   https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
//
// Single MCP endpoint at POST /mcp accepting JSON-RPC 2.0. v1 returns
// plain application/json responses only — no SSE, no session management.
//
// Auth: bearer rpc_mcp_live_<token>, sha256 hashed, validated via
// public.mcp_validate_api_key. Quota enforced via check_feature_quota.
// Every tool execution is logged via mcp_log_tool_call (fire-and-forget
// through ctx.waitUntil so it does not extend response latency).
//
// Tool surface (six tools, all read-only):
//   get_fmv, get_sniper_deals, compute_pack_ev, find_set_completion_path,
//   lookup_wallet, get_badge_data
//
// See docs/mcp-tool-mapping.md for the canonical tool → backing RPC table.

// ───────────────────────────────────────────────────────────────────────────
// Types & constants
// ───────────────────────────────────────────────────────────────────────────

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MCP_INTERNAL_SECRET: string;
  BUILD_SHA?: string;
}

const VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "rpc-mcp", version: VERSION };

// Long-form collection slugs per RPC_DESIGN_SYSTEM.md §4. Worker translates
// slug→uuid at its boundary for backing RPCs that take uuid directly
// (notably get_top_deals); the adapter-backed tools accept slug as-is.
const COLLECTION_SLUG_TO_UUID: Record<string, string> = {
  nba_top_shot:    "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  nfl_all_day:     "dee28451-5d62-409e-a1ad-a83f763ac070",
  laliga_golazos:  "06248cc4-b85f-47cd-af67-1855d14acd75",
  disney_pinnacle: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
  ufc_strike:      "9b4824a8-736d-4a96-b450-8dcc0c46b023",
};

// ───────────────────────────────────────────────────────────────────────────
// Tool schemas — descriptions mirror docs/mcp-tool-mapping.md. Agents pick
// tools by reading these strings, so the vocabulary is sports-collector
// ("moment", "edition", "FMV", "pack", "set") not crypto ("NFT", "token").
// Each description includes a one-line summary plus a "use this when" and a
// "do NOT use this when" hint so the model learns where each tool ends.
// ───────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_fmv",
    description:
      "Look up Rip Packs City Fair Market Value (FMV) and trade-context signals for a single moment edition. Returns latest FMV in USD, weighted-average price (with and without outliers), 7d and 30d sale counts, days since last sale, current Top Shot and Flowty asks, confidence band, liquidity rating, and (if a serial is supplied) the serial-adjusted FMV. " +
      "USE THIS WHEN the agent is reasoning about whether a specific moment is fairly priced, undervalued, or going cold; or when it needs distribution-shape signal (sales velocity, days since sale, liquidity tier) for a single moment. " +
      "DO NOT USE THIS to compute a wallet's total FMV (call lookup_wallet — it aggregates across thousands of moments efficiently) or to discover cheap moments to buy across a whole collection (call get_sniper_deals).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        edition_key: {
          type: "string",
          description:
            "External edition identifier within the named collection. Format is collection-specific: Top Shot uses '<setUUID>:<playUUID>' (e.g. '9e444420-9ae1-4a6a-a42d-ce94e2089af1:5a567d2a-a155-45ba-9323-f330305c16bb'), AllDay uses plain integers (e.g. '1234'), Pinnacle uses '<royalty>:<variant>:<printing>'. Required because external_id is unique within a collection but NOT globally — AllDay and Golazos both use plain-int external_ids that collide.",
        },
        collection_slug: {
          type: "string",
          enum: Object.keys(COLLECTION_SLUG_TO_UUID),
          description:
            "Long-form collection slug. One of: nba_top_shot, nfl_all_day, laliga_golazos, disney_pinnacle, ufc_strike. Required for disambiguation (see edition_key).",
        },
        serial: {
          type: "integer",
          minimum: 1,
          description:
            "Optional serial number for low-serial premium adjustment. Serial 1 → 12× base FMV; ≤10 → 4.5×; ≤23 → 2.8×; else 1×. Example: 7 yields a 4.5× multiplier. Omit if no specific serial.",
        },
      },
      required: ["edition_key", "collection_slug"],
    },
  },
  {
    name: "get_sniper_deals",
    description:
      "List moments currently listed below FMV (undervalued asks) within one collection. Returns up to `limit` rows sorted by discount, each with player, set, ask price, FMV, discount %, confidence, and a direct buy link. Backed by collection-specific deal RPCs (TopShot and AllDay supported today). " +
      "USE THIS WHEN the agent is scanning a whole collection for buy opportunities, building a sniper feed, or filtering by min discount / max price. " +
      "DO NOT USE THIS to evaluate a single moment by edition_key (call get_fmv) or to assemble a set completion plan (call find_set_completion_path). Golazos / Pinnacle / UFC return supported:false until backing RPCs ship.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        collection_slug: {
          type: "string",
          enum: Object.keys(COLLECTION_SLUG_TO_UUID),
          description:
            "Long-form collection slug. Top Shot and AllDay return live deal rows; other collections return supported:false with an explanatory gap until backing RPCs are added.",
        },
        min_discount_pct: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Optional minimum discount percent below FMV. Example: 20 returns only deals at 20% off FMV or deeper. Omit for no floor.",
        },
        max_price: {
          type: "number",
          minimum: 0,
          description:
            "Optional maximum ask price in USD. Example: 50 caps results at $50 ask. Omit for no ceiling.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max rows to return. Default 25. Capped at 100.",
        },
      },
      required: ["collection_slug"],
    },
  },
  {
    name: "compute_pack_ev",
    description:
      "Compute the expected value (EV) of opening a specific pack distribution, given its current remaining pool. Returns pack title, current pack price (USD), slots per pack, and the EV breakdown from compute_pack_ev_from_pool. " +
      "USE THIS WHEN the agent is deciding whether opening a pack is +EV vs buying moments directly on secondary market, or comparing pack EV across distributions. " +
      "DO NOT USE THIS to price a specific moment (call get_fmv) or to discover packs (this assumes the caller already has a dist_id from pack_distributions).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dist_id: {
          type: "string",
          description:
            "Pack distribution identifier from pack_distributions.dist_id. Example: '1765' (WNBA Holo Icon Quick Rip). Top Shot dist_ids are integer-as-string; AllDay dist_ids follow Flowverse's own scheme.",
        },
      },
      required: ["dist_id"],
    },
  },
  {
    name: "find_set_completion_path",
    description:
      "For a specific wallet and a specific set, return the full list of missing editions with cheapest current ask and source per missing edition. Includes total_completion_usd (sum of available cheapest asks) and the backing RPC's FMV-based estimate. " +
      "USE THIS WHEN the agent is building a 'what would it cost to complete this set' answer, picking the cheapest missing piece to fill a gap, or sequencing purchases by ask price. Top Shot and AllDay only. " +
      "DO NOT USE THIS for general portfolio queries (call lookup_wallet) or set discovery (caller must already have a set_id). Pinnacle / UFC / Golazos return supported:false today.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        wallet_address: {
          type: "string",
          description:
            "Flow wallet address, 0x16-hex (e.g. '0xbd94cade097e50ac'). Lowercased server-side; child-account resolution is NOT applied here (call lookup_wallet for canonical-owner views).",
        },
        collection_slug: {
          type: "string",
          enum: Object.keys(COLLECTION_SLUG_TO_UUID),
          description: "Long-form collection slug. Only nba_top_shot and nfl_all_day return supported:true.",
        },
        set_id: {
          type: "string",
          description:
            "Set identifier (editions.set_id uuid). Example: '5b218b5e-4897-4a06-a60f-a40ef2c40ff9' (Rookie Debut, Top Shot S8). Caller can obtain set_id from a prior /api/sets or wallet-portfolio query.",
        },
      },
      required: ["wallet_address", "collection_slug", "set_id"],
    },
  },
  {
    name: "lookup_wallet",
    description:
      "Cross-collection portfolio summary for a wallet. Returns FMV totals per collection, moment counts, tier breakdowns, FMV / tier / metadata coverage percentages, top collection, diversity score, and a concentration label ('primary + light dabbler', 'pure-play', etc). Composes holdings_summary (overview) and get_wallet_portfolio (full breakdowns). " +
      "USE THIS WHEN the agent needs a wallet's total FMV, per-collection breakdown, or holdings posture across all five collections. Optionally filter to one collection_slug. " +
      "DO NOT USE THIS to evaluate a single moment (call get_fmv) or to compute set-completion costs (call find_set_completion_path).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        wallet_address: {
          type: "string",
          description: "Flow wallet address, 0x16-hex (e.g. '0xbd94cade097e50ac').",
        },
        collection_slug: {
          type: "string",
          enum: Object.keys(COLLECTION_SLUG_TO_UUID),
          description:
            "Optional. If supplied, the response's summary.collections is filtered to just this slug. Omit for cross-collection.",
        },
      },
      required: ["wallet_address"],
    },
  },
  {
    name: "get_badge_data",
    description:
      "Return the unified badge data for one moment edition — which curated badges (rookie mints, three-star rookies, milestone plays, etc.) it carries. Backed by get_edition_badges_unified via the mcp_get_badge_data adapter; non-TopShot collections are gap-flagged because badge_editions coverage is TS-centric. " +
      "USE THIS WHEN the agent is reasoning about whether a moment carries a curated badge (badge editions trade at a premium and are a sniper signal). " +
      "DO NOT USE THIS to price the moment (call get_fmv) or to discover which badges exist (caller must already have a specific edition_key). NOTE: the backing RPC currently raises an `unaccent` error on hardened search_path; the adapter EXCEPTION-guards so the call returns badges:{} with the error surfaced in gaps until the search_path bug is fixed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        edition_key: {
          type: "string",
          description: "External edition identifier. Same format rules as get_fmv.",
        },
        collection_slug: {
          type: "string",
          enum: Object.keys(COLLECTION_SLUG_TO_UUID),
          description: "Long-form collection slug. Only nba_top_shot has robust badge coverage.",
        },
      },
      required: ["edition_key", "collection_slug"],
    },
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Supabase REST helper
// ───────────────────────────────────────────────────────────────────────────

class SupabaseRpcError extends Error {
  constructor(public status: number, public bodyText: string) {
    super(`supabase_rpc_${status}`);
  }
}

async function callSupabaseRpc<T>(env: Env, fnName: string, args: Record<string, unknown>): Promise<T> {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "params=single-object",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SupabaseRpcError(res.status, body.slice(0, 500));
  }
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeForGap(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 60);
}

// ───────────────────────────────────────────────────────────────────────────
// Auth & quota
// ───────────────────────────────────────────────────────────────────────────

interface Principal {
  walletAddress: string;
  plan: string;
  scopes: string[];
  keyId: string;
}

async function validateBearer(env: Env, request: Request): Promise<Principal | null> {
  const auth = request.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(rpc_mcp_live_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const raw = m[1];
  const hash = await sha256Hex(raw);
  const rows = await callSupabaseRpc<Array<{ key_id: string; wallet_address: string; plan: string; scopes: string[] }>>(
    env,
    "mcp_validate_api_key",
    { p_key_hash: hash }
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return {
    keyId: rows[0].key_id,
    walletAddress: rows[0].wallet_address,
    plan: rows[0].plan,
    scopes: rows[0].scopes,
  };
}

interface QuotaResult {
  allowed: boolean;
  reason: string;
  plan?: string;
  daily_limit?: number | null;
  used_today?: number;
  remaining?: number | null;
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(60, Math.ceil((tomorrow - now.getTime()) / 1000));
}

async function checkQuota(env: Env, walletAddress: string): Promise<QuotaResult> {
  return callSupabaseRpc<QuotaResult>(env, "check_feature_quota", {
    p_wallet: walletAddress,
    p_feature: "mcp_query",
  });
}

function logToolCall(env: Env, ctx: ExecutionContext, walletAddress: string, toolName: string, metadata: Record<string, unknown>): void {
  ctx.waitUntil(
    callSupabaseRpc(env, "mcp_log_tool_call", {
      p_wallet_address: walletAddress,
      p_tool_name: toolName,
      p_metadata: metadata,
    }).catch((err) => {
      console.error(`[mcp-log] ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
    })
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Tool handlers — thin wrappers, no business logic
// ───────────────────────────────────────────────────────────────────────────

async function tool_get_fmv(env: Env, args: Record<string, unknown>): Promise<unknown> {
  return callSupabaseRpc(env, "mcp_get_fmv", {
    p_edition_key: String(args.edition_key ?? ""),
    p_collection_slug: String(args.collection_slug ?? ""),
    p_serial: args.serial != null ? Number(args.serial) : null,
  });
}

async function tool_get_sniper_deals(env: Env, args: Record<string, unknown>): Promise<unknown> {
  const collectionSlug = String(args.collection_slug ?? "");
  const minDiscount = args.min_discount_pct != null ? Number(args.min_discount_pct) : null;
  const maxPrice = args.max_price != null ? Number(args.max_price) : null;
  const limit = args.limit != null ? Math.max(1, Math.min(100, Number(args.limit))) : 25;

  if (!(collectionSlug in COLLECTION_SLUG_TO_UUID)) {
    return {
      collection_slug: collectionSlug,
      supported: false,
      reason: "unknown_collection_slug",
      count: 0,
      deals: [],
      gaps: [`unknown_collection_slug_${sanitizeForGap(collectionSlug)}`],
    };
  }

  if (collectionSlug === "nba_top_shot") {
    const rows = await callSupabaseRpc<unknown[]>(env, "get_top_deals", {
      p_player: null,
      p_team: null,
      p_tier: null,
      p_max_price: maxPrice,
      p_min_discount: minDiscount,
      p_has_badge: null,
      p_limit: limit,
      p_collection_id: COLLECTION_SLUG_TO_UUID[collectionSlug],
    });
    return { collection_slug: collectionSlug, count: Array.isArray(rows) ? rows.length : 0, deals: rows ?? [], gaps: [] };
  }
  if (collectionSlug === "nfl_all_day") {
    const rows = await callSupabaseRpc<unknown[]>(env, "get_allday_sniper_deals", {
      p_min_discount: minDiscount,
      p_max_price: maxPrice,
      p_rarity: null,
      p_team: null,
      p_sort_by: null,
      p_limit: limit,
    });
    return { collection_slug: collectionSlug, count: Array.isArray(rows) ? rows.length : 0, deals: rows ?? [], gaps: [] };
  }
  return {
    collection_slug: collectionSlug,
    supported: false,
    reason: "no_sniper_rpc_for_collection",
    count: 0,
    deals: [],
    gaps: [`no_sniper_rpc_yet_for_${collectionSlug}`],
  };
}

async function tool_compute_pack_ev(env: Env, args: Record<string, unknown>): Promise<unknown> {
  return callSupabaseRpc(env, "mcp_compute_pack_ev", {
    p_dist_id: String(args.dist_id ?? ""),
  });
}

async function tool_find_set_completion_path(env: Env, args: Record<string, unknown>): Promise<unknown> {
  return callSupabaseRpc(env, "mcp_find_set_completion", {
    p_wallet: String(args.wallet_address ?? ""),
    p_collection_slug: String(args.collection_slug ?? ""),
    p_set_id: String(args.set_id ?? ""),
  });
}

async function tool_lookup_wallet(env: Env, args: Record<string, unknown>): Promise<unknown> {
  const wallet = String(args.wallet_address ?? "").toLowerCase().trim();
  const filterSlug = args.collection_slug != null ? String(args.collection_slug) : null;
  const gaps: string[] = [];

  const [summaryRaw, portfolioRaw] = await Promise.all([
    callSupabaseRpc<Record<string, unknown> | null>(env, "holdings_summary", { p_wallet: wallet }),
    callSupabaseRpc<Record<string, unknown> | null>(env, "get_wallet_portfolio", { p_wallet_address: wallet }),
  ]);

  let summary = summaryRaw;
  let portfolio = portfolioRaw;

  if (filterSlug != null) {
    if (!(filterSlug in COLLECTION_SLUG_TO_UUID)) {
      gaps.push(`unknown_collection_slug_${sanitizeForGap(filterSlug)}`);
    } else {
      if (summary && Array.isArray(summary.collections)) {
        summary = {
          ...summary,
          collections: (summary.collections as Array<Record<string, unknown>>).filter((c) => c.slug === filterSlug),
        };
        gaps.push(`summary_filtered_to_${filterSlug}`);
      }
      if (portfolio && Array.isArray((portfolio as Record<string, unknown>).collections)) {
        portfolio = {
          ...portfolio,
          collections: ((portfolio as Record<string, unknown>).collections as Array<Record<string, unknown>>).filter(
            (c) => c.slug === filterSlug
          ),
        };
        gaps.push(`portfolio_filtered_to_${filterSlug}`);
      }
    }
  }

  if (summary == null) gaps.push("holdings_summary_returned_null");
  if (portfolio == null) gaps.push("wallet_portfolio_returned_null");

  return {
    wallet_address: wallet,
    collection_slug: filterSlug,
    summary,
    portfolio,
    gaps,
  };
}

async function tool_get_badge_data(env: Env, args: Record<string, unknown>): Promise<unknown> {
  return callSupabaseRpc(env, "mcp_get_badge_data", {
    p_edition_key: String(args.edition_key ?? ""),
    p_collection_slug: String(args.collection_slug ?? ""),
  });
}

const TOOL_HANDLERS: Record<string, (env: Env, args: Record<string, unknown>) => Promise<unknown>> = {
  get_fmv: tool_get_fmv,
  get_sniper_deals: tool_get_sniper_deals,
  compute_pack_ev: tool_compute_pack_ev,
  find_set_completion_path: tool_find_set_completion_path,
  lookup_wallet: tool_lookup_wallet,
  get_badge_data: tool_get_badge_data,
};

function extractGapsCount(result: unknown): number {
  if (result == null || typeof result !== "object") return 0;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.gaps)) return r.gaps.length;
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
// JSON-RPC dispatch
// ───────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

function rpcResult(id: string | number | null | undefined, result: unknown): object {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown): object {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

async function dispatchMcp(env: Env, ctx: ExecutionContext, principal: Principal, body: JsonRpcRequest): Promise<object | null> {
  const { method, id, params } = body;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        instructions:
          "Rip Packs City collector intelligence. Six read-only tools wrapping live FMV, sniper deals, pack EV, set completion, wallet portfolio, and badge data across NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, and UFC Strike.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const toolName = String(p.name ?? "");
      const toolArgs = (p.arguments ?? {}) as Record<string, unknown>;
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return rpcError(id, -32602, `unknown_tool: ${toolName}`);
      }

      const startedAt = Date.now();
      let result: unknown;
      let toolError: string | undefined;
      try {
        result = await handler(env, toolArgs);
        // Treat null adapter results as gap-flagged empty, not failure
        if (result == null) {
          result = { gaps: [`${toolName}_returned_null`] };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const gapTag = err instanceof SupabaseRpcError ? "upstream_supabase_unavailable" : "adapter_exception";
        result = {
          error: gapTag,
          message: msg.replace(/[\r\n]+/g, " ").slice(0, 500),
          gaps: [`${gapTag}_${sanitizeForGap(msg)}`],
        };
        toolError = msg;
      }
      const durationMs = Date.now() - startedAt;
      const gapsCount = extractGapsCount(result);

      const metadata: Record<string, unknown> = {
        duration_ms: durationMs,
        gaps_count: gapsCount,
      };
      if (toolError) metadata.error = toolError.slice(0, 500);
      logToolCall(env, ctx, principal.walletAddress, toolName, metadata);

      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(toolError ? { isError: true } : {}),
      });
    }

    default:
      return rpcError(id, -32601, `method_not_found: ${method}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP entry
// ───────────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Max-Age": "86400",
};

const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rpc-mcp — Rip Packs City MCP server</title>
<style>
  body { font-family: 'Share Tech Mono', ui-monospace, monospace; background:#080808; color:#F1F1F1;
         max-width:640px; margin:8vh auto; padding:0 24px; line-height:1.6; }
  h1 { font-family:'Barlow Condensed', sans-serif; text-transform:uppercase;
       letter-spacing:.06em; color:#E03A2F; font-size:32px; font-weight:800; margin:0 0 16px; }
  a { color:#E03A2F; text-decoration:none; border-bottom:1px solid rgba(224,58,47,.3); }
  a:hover { border-color:#E03A2F; }
  code { background:rgba(255,255,255,.04); padding:2px 6px; border-radius:3px; font-size:13px; }
  .label { font-size:11px; letter-spacing:.2em; text-transform:uppercase;
           color:rgba(255,255,255,.42); margin-bottom:4px; }
</style></head>
<body>
<div class="label">Rip Packs City</div>
<h1>RPC MCP Server</h1>
<p>Flow blockchain collector intelligence as a Model Context Protocol server. Streamable HTTP transport at <code>POST /mcp</code>.</p>
<p>Access requires an issued bearer token. Issue or revoke keys at <a href="https://www.rippackscity.com/dashboard/api-keys">your dashboard</a>.</p>
<p>Tool reference: <a href="https://github.com/jamesdillonbond/rip-packs-city/blob/main/docs/mcp-tool-mapping.md">docs/mcp-tool-mapping.md</a></p>
<div class="label" style="margin-top:32px">Liveness: <a href="/health">/health</a></div>
</body></html>`;

async function handleHealth(env: Env): Promise<Response> {
  const out: Record<string, unknown> = {
    ok: true,
    version: VERSION,
    build_sha: env.BUILD_SHA || null,
    supabase_reachable: false,
    rpcs_reachable: false,
  };
  try {
    // Cheap Supabase reachability probe — sha256 of "rpc-mcp-health-probe" is
    // guaranteed not to match any real key, so the RPC returns [].
    await callSupabaseRpc(env, "mcp_validate_api_key", { p_key_hash: "0".repeat(64) });
    out.supabase_reachable = true;
  } catch (err) {
    out.ok = false;
    out.supabase_error = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }
  try {
    // Adapter reachability — call mcp_get_fmv with a clearly bogus edition_key,
    // expect graceful {error: 'edition_not_found', ...} rather than HTTP error.
    const probe = await callSupabaseRpc<Record<string, unknown>>(env, "mcp_get_fmv", {
      p_edition_key: "__health_probe__",
      p_collection_slug: "nba_top_shot",
      p_serial: null,
    });
    out.rpcs_reachable = !!probe && (probe.error === "edition_not_found" || probe.edition_id != null);
  } catch (err) {
    out.ok = false;
    out.rpcs_error = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }
  return new Response(JSON.stringify(out), {
    status: out.ok ? 200 : 503,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleMcpPost(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Auth
  let principal: Principal | null = null;
  try {
    principal = await validateBearer(env, request);
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "upstream_supabase_unavailable" } }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  if (!principal) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="rpc-mcp"', ...CORS_HEADERS },
    });
  }

  // Quota
  let quota: QuotaResult;
  try {
    quota = await checkQuota(env, principal.walletAddress);
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "upstream_supabase_unavailable" } }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  if (!quota.allowed) {
    const retryAfter = secondsUntilUtcMidnight();
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32002,
          message: "quota_exceeded",
          data: { reason: quota.reason, plan: quota.plan, daily_limit: quota.daily_limit, used_today: quota.used_today, retry_after_seconds: retryAfter },
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter), ...CORS_HEADERS },
      }
    );
  }

  // Parse body
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse_error" } }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid_request" } }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // Dispatch
  let response: object | null;
  try {
    response = await dispatchMcp(env, ctx, principal, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp-dispatch] ${body.method} failed: ${msg}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32603, message: "internal_error", data: { reason: sanitizeForGap(msg) } } }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // Notifications: 202 Accepted, no body
  if (response === null) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" && method === "GET") {
      return new Response(LANDING_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
      });
    }

    if (url.pathname === "/health" && method === "GET") {
      return handleHealth(env);
    }

    if (url.pathname === "/mcp") {
      if (method === "POST") {
        return handleMcpPost(request, env, ctx);
      }
      if (method === "GET" || method === "DELETE") {
        // No server-initiated SSE, no session management in v1.
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "method_not_allowed" } }), {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: "POST", ...CORS_HEADERS },
        });
      }
      return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS", ...CORS_HEADERS } });
    }

    return new Response(JSON.stringify({ error: "not_found", path: url.pathname }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  },
} satisfies ExportedHandler<Env>;
