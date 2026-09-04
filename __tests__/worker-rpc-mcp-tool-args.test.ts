import { describe, it, expect, afterEach, vi } from "vitest"
import worker from "@/workers/rpc-mcp-proxy/index.ts"

// ── rpc-mcp-proxy: the six tools' ARGUMENT COERCION + routing ───────────────
//
// __tests__/worker-rpc-mcp-handler.test.ts covers the HTTP entry surface (auth,
// quota, body validation, dispatch envelopes) and exactly one tool's happy path
// (get_fmv). The other five tools, and every branch inside get_sniper_deals and
// lookup_wallet, were unexecuted — worker branch coverage sat at 53.75%.
//
// What this file pins is the WORKER'S BOUNDARY CONTRACT, not the RPCs behind it:
// an MCP client is an LLM emitting loosely-typed JSON, so `serial` arrives as
// the string "7", `limit` as 500, `wallet_address` with a stray space and mixed
// case. The worker is the only thing standing between that and a Postgres
// function with typed parameters. So every assertion here reads the BODY the
// worker POSTed to Supabase, never just the response — a coercion that silently
// stopped happening would still return a well-formed MCP envelope.
//
// ⚠ THE PAYLOAD IS THE ASSERTION, NOT THE CALL COUNT. Asserting only "one call
// to get_top_deals" passes with every argument wrong.

const env = {
  SUPABASE_URL: "https://db.example",
  SUPABASE_SERVICE_ROLE_KEY: "svc-key",
  BUILD_SHA: "testsha",
} as any

const KEY = "rpc_mcp_live_testkey123"
const VALID_PRINCIPAL = [{ key_id: "k1", wallet_address: "0xabc", plan: "pro", scopes: ["read"] }]
const QUOTA_OK = { allowed: true, reason: "ok", plan: "pro", daily_limit: 1000, used_today: 1, remaining: 999 }

const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD_UUID = "dee28451-5d62-409e-a1ad-a83f763ac070"

function ctx() {
  const waited: Promise<unknown>[] = []
  return { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException: () => {}, waited } as any
}

interface Recorded {
  fn: string
  body: Record<string, unknown>
}

/**
 * Stub global fetch, recording every Supabase RPC call as {fn, body} and
 * routing the response by fn name. Auth + quota are always wired so a tool
 * call reaches its handler; `rpcs` only needs the tool's own backing RPC.
 */
function stubSupabase(rpcs: Record<string, unknown | { status: number; body?: string }> = {}) {
  const calls: Recorded[] = []
  const table: Record<string, unknown> = {
    mcp_validate_api_key: VALID_PRINCIPAL,
    check_feature_quota: QUOTA_OK,
    ...rpcs,
  }
  const spy = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const fn = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1] ?? ""
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse((init?.body as string) ?? "{}")
    } catch {
      /* non-JSON body — recorded as {} */
    }
    calls.push({ fn, body })
    const entry = fn in table ? table[fn] : []
    if (entry && typeof entry === "object" && "status" in (entry as any)) {
      const e = entry as { status: number; body?: string }
      return new Response(e.body ?? "", { status: e.status })
    }
    return new Response(JSON.stringify(entry), { status: 200, headers: { "Content-Type": "application/json" } })
  })
  vi.stubGlobal("fetch", spy)
  return calls
}

/** Invoke tools/call and return the decoded tool payload plus the RPC log. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  rpcs: Record<string, unknown | { status: number; body?: string }> = {}
): Promise<{ payload: any; isError: boolean; calls: Recorded[] }> {
  const calls = stubSupabase(rpcs)
  const c = ctx()
  const res = await worker.fetch(
    new Request("https://mcp.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    c
  )
  expect(res.status).toBe(200)
  const json: any = await res.json()
  // Let the fire-and-forget mcp_log_tool_call settle so its body is recorded.
  await Promise.all(c.waited)
  return {
    payload: JSON.parse(json.result.content[0].text),
    isError: json.result.isError === true,
    calls,
  }
}

/** The single recorded call to `fn` — fails loudly on zero or many. */
function only(calls: Recorded[], fn: string): Recorded {
  const hits = calls.filter((c) => c.fn === fn)
  expect(hits, `expected exactly one call to ${fn}, saw ${hits.length}`).toHaveLength(1)
  return hits[0]
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("rpc-mcp-proxy tools — scalar coercion at the worker boundary", () => {
  it("get_fmv coerces a string serial to a number and passes slug/key through", async () => {
    const { calls } = await callTool(
      "get_fmv",
      { edition_key: "ts-123", collection_slug: "nba_top_shot", serial: "7" },
      { mcp_get_fmv: { fmv: 12 } }
    )
    expect(only(calls, "mcp_get_fmv").body).toEqual({
      p_edition_key: "ts-123",
      p_collection_slug: "nba_top_shot",
      p_serial: 7,
    })
  })

  it("get_fmv sends null (not 0, not \"\") for an omitted serial", async () => {
    const { calls } = await callTool("get_fmv", { edition_key: "k" }, { mcp_get_fmv: {} })
    const body = only(calls, "mcp_get_fmv").body
    // A missing serial must reach Postgres as SQL NULL — `0` would be read as
    // "serial #0" and `""` would fail the int cast.
    expect(body.p_serial).toBeNull()
    expect(body.p_collection_slug).toBe("")
  })

  it("compute_pack_ev stringifies a numeric dist_id", async () => {
    const { calls } = await callTool("compute_pack_ev", { dist_id: 4212 }, { mcp_compute_pack_ev: { ev: 3 } })
    expect(only(calls, "mcp_compute_pack_ev").body).toEqual({ p_dist_id: "4212" })
  })

  it("find_set_completion_path maps its three args onto the RPC's parameter names", async () => {
    const { calls } = await callTool(
      "find_set_completion_path",
      { wallet_address: "0xFEED", collection_slug: "nfl_all_day", set_id: 88 },
      { mcp_find_set_completion: { missing: [] } }
    )
    // wallet/set_id are renamed (p_wallet / p_set_id) — a rename regression is
    // invisible in the MCP response, which is why this asserts the body.
    expect(only(calls, "mcp_find_set_completion").body).toEqual({
      p_wallet: "0xFEED",
      p_collection_slug: "nfl_all_day",
      p_set_id: "88",
    })
  })

  it("get_badge_data passes edition_key + slug, defaulting both to empty strings", async () => {
    const { calls } = await callTool("get_badge_data", {}, { mcp_get_badge_data: {} })
    expect(only(calls, "mcp_get_badge_data").body).toEqual({ p_edition_key: "", p_collection_slug: "" })
  })
})

describe("rpc-mcp-proxy get_sniper_deals — slug routing", () => {
  it("short-circuits an unknown slug WITHOUT calling any deals RPC", async () => {
    const { payload, calls } = await callTool("get_sniper_deals", { collection_slug: "pokemon" })
    expect(payload.supported).toBe(false)
    expect(payload.reason).toBe("unknown_collection_slug")
    expect(payload.gaps).toEqual(["unknown_collection_slug_pokemon"])
    expect(payload.deals).toEqual([])
    // The point of the guard is that no query runs at all.
    expect(calls.map((c) => c.fn)).not.toContain("get_top_deals")
    expect(calls.map((c) => c.fn)).not.toContain("get_allday_sniper_deals")
  })

  it("sanitizes a hostile slug into the gap tag rather than echoing it", async () => {
    const { payload } = await callTool("get_sniper_deals", { collection_slug: "a b'; drop--" })
    expect(payload.gaps[0]).toMatch(/^unknown_collection_slug_[A-Za-z0-9_]*$/)
  })

  it("routes nba_top_shot to get_top_deals with the slug translated to a uuid", async () => {
    const { payload, calls } = await callTool(
      "get_sniper_deals",
      { collection_slug: "nba_top_shot", min_discount_pct: "20", max_price: "150", limit: 5 },
      { get_top_deals: [{ id: 1 }, { id: 2 }] }
    )
    expect(only(calls, "get_top_deals").body).toEqual({
      p_player: null,
      p_team: null,
      p_tier: null,
      p_max_price: 150,
      p_min_discount: 20,
      p_has_badge: null,
      p_limit: 5,
      p_collection_id: TS_UUID,
    })
    expect(payload.count).toBe(2)
    expect(payload.gaps).toEqual([])
  })

  it("routes nfl_all_day to get_allday_sniper_deals, which takes NO collection id", async () => {
    const { payload, calls } = await callTool(
      "get_sniper_deals",
      { collection_slug: "nfl_all_day" },
      { get_allday_sniper_deals: [{ id: 9 }] }
    )
    const body = only(calls, "get_allday_sniper_deals").body
    expect(body).toEqual({
      p_min_discount: null,
      p_max_price: null,
      p_rarity: null,
      p_team: null,
      p_sort_by: null,
      p_limit: 25,
    })
    expect(body).not.toHaveProperty("p_collection_id")
    expect(body).not.toHaveProperty("p_collection_slug")
    // The All Day RPC has no collection parameter, so passing AD's uuid would
    // be a hard error — assert the uuid never appears in the payload at all.
    expect(JSON.stringify(body)).not.toContain(AD_UUID)
    expect(payload.count).toBe(1)
  })

  it("reports a KNOWN slug with no sniper RPC as unsupported, distinctly from an unknown one", async () => {
    for (const slug of ["laliga_golazos", "disney_pinnacle", "ufc_strike"]) {
      const { payload, calls } = await callTool("get_sniper_deals", { collection_slug: slug })
      expect(payload.supported).toBe(false)
      expect(payload.reason).toBe("no_sniper_rpc_for_collection")
      expect(payload.gaps).toEqual([`no_sniper_rpc_yet_for_${slug}`])
      expect(calls.map((c) => c.fn)).not.toContain("get_top_deals")
      vi.unstubAllGlobals()
    }
  })

  it("counts 0 deals (not a crash) when the deals RPC returns a non-array", async () => {
    const { payload } = await callTool(
      "get_sniper_deals",
      { collection_slug: "nba_top_shot" },
      { get_top_deals: { unexpected: "shape" } }
    )
    expect(payload.count).toBe(0)
  })
})

describe("rpc-mcp-proxy get_sniper_deals — limit clamp", () => {
  const cases: Array<[unknown, number]> = [
    [undefined, 25],
    [5, 5],
    [500, 100],
    [100, 100],
    [0, 1],
    [-9, 1],
    ["30", 30],
  ]
  it.each(cases)("limit %s reaches get_top_deals as %i", async (given, expected) => {
    const args: Record<string, unknown> = { collection_slug: "nba_top_shot" }
    if (given !== undefined) args.limit = given
    const { calls } = await callTool("get_sniper_deals", args, { get_top_deals: [] })
    expect(only(calls, "get_top_deals").body.p_limit).toBe(expected)
  })
})

describe("rpc-mcp-proxy lookup_wallet", () => {
  const SUMMARY = { total: 3, collections: [{ slug: "nba_top_shot", n: 2 }, { slug: "ufc_strike", n: 1 }] }
  const PORTFOLIO = { value: 100, collections: [{ slug: "nba_top_shot", v: 90 }, { slug: "ufc_strike", v: 10 }] }

  it("normalizes the wallet (lowercase, trimmed) for BOTH backing RPCs", async () => {
    const { payload, calls } = await callTool(
      "lookup_wallet",
      { wallet_address: "  0xAbCdEf  " },
      { holdings_summary: SUMMARY, get_wallet_portfolio: PORTFOLIO }
    )
    expect(only(calls, "holdings_summary").body).toEqual({ p_wallet: "0xabcdef" })
    // Note the different parameter name on the second RPC — same wallet, and
    // the normalization must not be applied to only one of them.
    expect(only(calls, "get_wallet_portfolio").body).toEqual({ p_wallet_address: "0xabcdef" })
    expect(payload.wallet_address).toBe("0xabcdef")
    expect(payload.collection_slug).toBeNull()
    expect(payload.gaps).toEqual([])
  })

  it("filters both payloads to a known collection_slug and says so in gaps", async () => {
    const { payload } = await callTool(
      "lookup_wallet",
      { wallet_address: "0xabc", collection_slug: "ufc_strike" },
      { holdings_summary: SUMMARY, get_wallet_portfolio: PORTFOLIO }
    )
    expect(payload.summary.collections).toEqual([{ slug: "ufc_strike", n: 1 }])
    expect(payload.portfolio.collections).toEqual([{ slug: "ufc_strike", v: 10 }])
    // The filter is lossy, so the response must disclose it — an agent that
    // reads a filtered total as the wallet total reports a wrong net worth.
    expect(payload.gaps).toEqual(["summary_filtered_to_ufc_strike", "portfolio_filtered_to_ufc_strike"])
    expect(payload.summary.total).toBe(3)
  })

  it("does NOT filter on an unknown slug — it flags the gap and returns everything", async () => {
    const { payload } = await callTool(
      "lookup_wallet",
      { wallet_address: "0xabc", collection_slug: "pokemon" },
      { holdings_summary: SUMMARY, get_wallet_portfolio: PORTFOLIO }
    )
    expect(payload.gaps).toEqual(["unknown_collection_slug_pokemon"])
    // Silently returning an EMPTY portfolio for a typo'd slug would read as
    // "this wallet holds nothing" — the unfiltered payload plus the gap is the
    // honest answer.
    expect(payload.summary.collections).toHaveLength(2)
    expect(payload.portfolio.collections).toHaveLength(2)
  })

  it("flags each null leg separately rather than reporting an empty wallet", async () => {
    const { payload } = await callTool(
      "lookup_wallet",
      { wallet_address: "0xabc" },
      { holdings_summary: null, get_wallet_portfolio: null }
    )
    expect(payload.gaps).toEqual(["holdings_summary_returned_null", "wallet_portfolio_returned_null"])
    expect(payload.summary).toBeNull()
    expect(payload.portfolio).toBeNull()
  })

  it("flags only the failed leg when one RPC returns null and the other does not", async () => {
    const { payload } = await callTool(
      "lookup_wallet",
      { wallet_address: "0xabc" },
      { holdings_summary: SUMMARY, get_wallet_portfolio: null }
    )
    expect(payload.gaps).toEqual(["wallet_portfolio_returned_null"])
    expect(payload.summary.total).toBe(3)
  })

  it("skips filtering a leg whose collections field is not an array", async () => {
    const { payload } = await callTool(
      "lookup_wallet",
      { wallet_address: "0xabc", collection_slug: "ufc_strike" },
      { holdings_summary: { total: 3 }, get_wallet_portfolio: PORTFOLIO }
    )
    expect(payload.gaps).toEqual(["portfolio_filtered_to_ufc_strike"])
    expect(payload.summary).toEqual({ total: 3 })
  })
})

describe("rpc-mcp-proxy tools/call — result envelope + telemetry", () => {
  it("logs gaps_count and duration_ms, and no error key, on a clean call", async () => {
    const { calls, isError } = await callTool(
      "get_sniper_deals",
      { collection_slug: "laliga_golazos" }
    )
    expect(isError).toBe(false)
    const meta = only(calls, "mcp_log_tool_call").body as any
    expect(meta.p_tool_name).toBe("get_sniper_deals")
    expect(meta.p_wallet_address).toBe("0xabc")
    expect(meta.p_metadata.gaps_count).toBe(1)
    expect(typeof meta.p_metadata.duration_ms).toBe("number")
    expect(meta.p_metadata).not.toHaveProperty("error")
  })

  it("logs gaps_count 0 for a result carrying no gaps array", async () => {
    const { calls } = await callTool("get_fmv", { edition_key: "k" }, { mcp_get_fmv: { fmv: 5 } })
    expect((only(calls, "mcp_log_tool_call").body as any).p_metadata.gaps_count).toBe(0)
  })

  it("converts a null adapter result into a gap-flagged payload, not an error", async () => {
    const { payload, isError } = await callTool("get_fmv", { edition_key: "k" }, { mcp_get_fmv: { status: 200, body: "" } })
    expect(payload).toEqual({ gaps: ["get_fmv_returned_null"] })
    // A null RPC result is "we looked and found nothing", which is a different
    // claim from "the lookup failed" — isError must stay false.
    expect(isError).toBe(false)
  })

  it("tags an upstream 5xx as upstream_supabase_unavailable and marks isError", async () => {
    const { payload, isError, calls } = await callTool(
      "compute_pack_ev",
      { dist_id: "d1" },
      { mcp_compute_pack_ev: { status: 503, body: "upstream down" } }
    )
    expect(isError).toBe(true)
    expect(payload.error).toBe("upstream_supabase_unavailable")
    expect(payload.gaps[0]).toMatch(/^upstream_supabase_unavailable_/)
    expect((only(calls, "mcp_log_tool_call").body as any).p_metadata.error).toBeTruthy()
  })

  it("tags a non-Supabase throw as adapter_exception, distinctly from an upstream failure", async () => {
    // A malformed 200 body makes JSON.parse throw INSIDE the adapter — the
    // upstream was reachable, so conflating the two would misdirect triage.
    const { payload, isError } = await callTool(
      "get_badge_data",
      { edition_key: "k" },
      { mcp_get_badge_data: { status: 200, body: "{not json" } }
    )
    expect(isError).toBe(true)
    expect(payload.error).toBe("adapter_exception")
    expect(payload.gaps[0]).toMatch(/^adapter_exception_/)
  })

  it("collapses newlines and truncates a long upstream message to 500 chars", async () => {
    const long = "line1\nline2\r\n" + "x".repeat(900)
    const { payload } = await callTool(
      "get_fmv",
      { edition_key: "k" },
      { mcp_get_fmv: { status: 500, body: long } }
    )
    expect(payload.message).not.toMatch(/[\r\n]/)
    expect(payload.message.length).toBeLessThanOrEqual(500)
  })

  it("a failing telemetry write does not fail the tool call", async () => {
    const { payload, isError } = await callTool(
      "get_fmv",
      { edition_key: "k" },
      { mcp_get_fmv: { fmv: 5 }, mcp_log_tool_call: { status: 500, body: "log down" } }
    )
    expect(isError).toBe(false)
    expect(payload).toEqual({ fmv: 5 })
  })
})
