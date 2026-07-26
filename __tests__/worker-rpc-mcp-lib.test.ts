import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  COLLECTION_SLUG_TO_UUID,
  isKnownCollectionSlug,
  sanitizeForGap,
  parseBearerToken,
  clampMcpLimit,
  extractGapsCount,
  rpcResult,
  rpcError,
  secondsUntilUtcMidnightFrom,
} from "@/workers/rpc-mcp-proxy/mcp-lib"

// Pins the pure logic of the RPC MCP server worker (rpc-mcp-proxy) — JSON-RPC
// envelope shape, bearer parsing, gap/limit/slug helpers. This is the largest
// worker with real branching logic and was entirely untested.

describe("COLLECTION_SLUG_TO_UUID / isKnownCollectionSlug", () => {
  it("maps the five published slugs to the canonical UUIDs", () => {
    expect(COLLECTION_SLUG_TO_UUID).toEqual({
      nba_top_shot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
      nfl_all_day: "dee28451-5d62-409e-a1ad-a83f763ac070",
      laliga_golazos: "06248cc4-b85f-47cd-af67-1855d14acd75",
      disney_pinnacle: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
      ufc_strike: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
    })
  })
  it("recognizes known vs unknown slugs", () => {
    expect(isKnownCollectionSlug("nba_top_shot")).toBe(true)
    expect(isKnownCollectionSlug("panini")).toBe(false)
    expect(isKnownCollectionSlug("")).toBe(false)
  })
})

describe("sanitizeForGap — safe gap-tag fragment", () => {
  it("collapses non-word runs to a single underscore", () => {
    expect(sanitizeForGap("bad slug!! name")).toBe("bad_slug_name")
  })
  it("caps at 60 chars", () => {
    expect(sanitizeForGap("a".repeat(200)).length).toBe(60)
  })
  it("leaves a clean identifier untouched", () => {
    expect(sanitizeForGap("nba_top_shot")).toBe("nba_top_shot")
  })
})

describe("parseBearerToken — only the rpc_mcp_live_ shape", () => {
  it("extracts a well-formed token", () => {
    expect(parseBearerToken("Bearer rpc_mcp_live_abc-123_XYZ")).toBe("rpc_mcp_live_abc-123_XYZ")
  })
  it("rejects a non-Bearer / wrong-prefix / empty header", () => {
    expect(parseBearerToken("Bearer sometoken")).toBeNull()
    expect(parseBearerToken("rpc_mcp_live_abc")).toBeNull() // no Bearer
    expect(parseBearerToken("Bearer rpc_mcp_test_abc")).toBeNull() // wrong prefix
    expect(parseBearerToken(null)).toBeNull()
    expect(parseBearerToken("")).toBeNull()
  })
  it("rejects a token with a disallowed char (would break the sha256 lookup)", () => {
    expect(parseBearerToken("Bearer rpc_mcp_live_abc$def")).toBeNull()
  })
})

describe("clampMcpLimit — [1,100] default 25", () => {
  it("defaults to 25 when absent", () => {
    expect(clampMcpLimit(null)).toBe(25)
    expect(clampMcpLimit(undefined)).toBe(25)
  })
  it("clamps below 1 and above 100", () => {
    expect(clampMcpLimit(0)).toBe(1)
    expect(clampMcpLimit(-5)).toBe(1)
    expect(clampMcpLimit(1000)).toBe(100)
  })
  it("passes an in-range value through, coercing strings", () => {
    expect(clampMcpLimit(50)).toBe(50)
    expect(clampMcpLimit("30")).toBe(30)
  })
})

describe("extractGapsCount", () => {
  it("returns the gaps array length", () => {
    expect(extractGapsCount({ gaps: ["a", "b"] })).toBe(2)
  })
  it("returns 0 for missing/non-array gaps or non-objects", () => {
    expect(extractGapsCount({})).toBe(0)
    expect(extractGapsCount({ gaps: "nope" })).toBe(0)
    expect(extractGapsCount(null)).toBe(0)
    expect(extractGapsCount(42)).toBe(0)
  })
})

describe("rpcResult / rpcError — JSON-RPC 2.0 envelopes", () => {
  it("builds a success envelope", () => {
    expect(rpcResult(7, { ok: true })).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } })
  })
  it("null-coalesces an absent id to null", () => {
    expect(rpcResult(undefined, {})).toEqual({ jsonrpc: "2.0", id: null, result: {} })
  })
  it("builds an error envelope with the right codes", () => {
    expect(rpcError(1, -32601, "method_not_found: foo")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method_not_found: foo" },
    })
  })
  it("omits data entirely when undefined, includes it when present", () => {
    expect((rpcError(1, -32602, "x") as any).error).not.toHaveProperty("data")
    expect((rpcError(1, -32602, "x", { detail: 1 }) as any).error.data).toEqual({ detail: 1 })
  })
})

describe("secondsUntilUtcMidnightFrom — quota reset window", () => {
  it("computes the remaining seconds to the next UTC midnight", () => {
    // 2026-07-26T23:00:00Z → 1h left
    const ms = Date.parse("2026-07-26T23:00:00Z")
    expect(secondsUntilUtcMidnightFrom(ms)).toBe(3600)
  })
  it("floors at 60 seconds even right at midnight", () => {
    const ms = Date.parse("2026-07-26T23:59:59Z")
    expect(secondsUntilUtcMidnightFrom(ms)).toBe(60)
  })
})

describe("source-drift guard — rpc-mcp-proxy inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const src = norm(readFileSync(path.join(root, "workers/rpc-mcp-proxy/index.ts"), "utf8"))
  const importsLib = /from\s+["']\.\/mcp-lib/.test(src)

  const BEARER = norm("auth.match(/^Bearer\\s+(rpc_mcp_live_[A-Za-z0-9_-]+)$/)")
  const GAP = norm('s.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 60)')
  const RPC_ERR = norm('return { jsonrpc: "2.0", id: id ?? null, error };')
  const LIMIT = norm("Math.max(1, Math.min(100, Number(args.limit)))")
  const NOT_FOUND = norm("return rpcError(id, -32601,")
  const UNKNOWN_TOOL = norm("return rpcError(id, -32602,")

  it.each([
    ["bearer regex", BEARER],
    ["sanitizeForGap replace", GAP],
    ["rpcError envelope", RPC_ERR],
    ["limit clamp", LIMIT],
    ["method_not_found -32601", NOT_FOUND],
    ["unknown_tool -32602", UNKNOWN_TOOL],
  ])("worker imports ./mcp-lib, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsLib || src.includes(expr)).toBe(true)
  })
})
