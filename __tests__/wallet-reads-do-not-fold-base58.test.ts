import { describe, it, expect, beforeEach, vi } from "vitest"
import { normalizeAddress, isSupportedAddress } from "@/lib/address"
import { isFlowAddress, isOnChainAddress } from "@/lib/postgrest-safe"

// ⛔ THE DEFECT THIS PINS (fixed 2026-09-19)
//
// Three wallet READ routes were Flow-shaped in two independent ways, and each
// way alone was enough to make a Candy MLB wallet unreachable:
//
//   `if (key.startsWith("0x"))`  — a Solana base58 address has no 0x prefix, so
//        it never entered the saved_wallets branch at all. top-moments and
//        hero-moment fell through to the profile_bio USERNAME lookup, missed,
//        and answered with the VIEWER'S OWN data under someone else's key.
//   `.toLowerCase()`             — base58 is CASE-SENSITIVE (Bitcoin alphabet),
//        so folding it produces a string that matches zero rows. `saved_wallets`
//        has stored base58 verbatim since the write path was fixed, so the read
//        and the write disagreed.
//
// And in app/api/profile/activity/route.ts the address allowlist was
// `isFlowAddress`, whose own doc comment claimed filtering to Flow was
// "lossless, since a non-Flow-address value could never match
// sales.seller/buyer_address anyway". MEASURED 2026-09-19: Candy sales carry
// base58 buyer AND seller addresses on 142 of 142 rows in the trailing 7 days.
//
// ⚠ EVERY ARM BELOW IS PAIRED WITH A FLOW NO-CHANGE CONTROL. Without them,
// "stop lowercasing" would satisfy the base58 assertions while silently
// breaking the Flow path that 100% of today's saved wallets are on — the
// fix-that-destroys-a-true-reading shape.

// A real Candy MLB wallet shape: 32-44 base58 chars, mixed case, no 0x.
const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
const FLOW_MIXED = "0xBD94CADE097E50AC"
const FLOW_LOWER = "0xbd94cade097e50ac"

describe("address normalization is chain-aware", () => {
  it("preserves base58 verbatim and still folds Flow hex", () => {
    expect(normalizeAddress(CANDY)).toBe(CANDY)
    expect(normalizeAddress(FLOW_MIXED)).toBe(FLOW_LOWER) // no-change control
  })

  it("recognizes a base58 address as supported, which the 0x gate could not", () => {
    expect(isSupportedAddress(CANDY)).toBe(true)
    expect(CANDY.startsWith("0x")).toBe(false) // the old gate, stated explicitly
    expect(isSupportedAddress(FLOW_MIXED)).toBe(true) // no-change control
  })
})

describe("isOnChainAddress widens the activity-feed allowlist without widening injection", () => {
  it("accepts base58 where isFlowAddress rejected it", () => {
    expect(isFlowAddress(CANDY)).toBe(false)
    expect(isOnChainAddress(CANDY)).toBe(true)
    expect(isOnChainAddress(FLOW_LOWER)).toBe(true) // no-change control
  })

  it("still rejects every PostgREST filter-grammar metacharacter", () => {
    // The whole safety argument for widening the guard is that the base58
    // alphabet contains none of , ( ) % — assert it rather than assume it.
    for (const bad of [
      "0xbd94cade097e50ac,buyer_address.eq.0x0",
      "abc(def)ghi",
      "%25wildcard%25",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbb",
      "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", // base58 excludes 0 O I l
    ]) {
      expect(isOnChainAddress(bad), `must reject: ${bad}`).toBe(false)
    }
    // Length bounds, both sides.
    expect(isOnChainAddress("1".repeat(31))).toBe(false)
    expect(isOnChainAddress("1".repeat(45))).toBe(false)
  })
})

// ── Route-level: the saved_wallets lookup must receive the key VERBATIM ──────

const savedWalletsEq: { col: string; value: string }[] = []
const savedWalletsRow: { user_id: string | null } = { user_id: null }
const authState: { user: { id: string } | null } = { user: null }

vi.mock("@/lib/supabase", () => {
  const savedWallets = () => {
    const b: any = {
      select: () => b,
      eq: (col: string, value: string) => {
        savedWalletsEq.push({ col, value })
        return b
      },
      limit: () => b,
      maybeSingle: async () => ({
        data: savedWalletsRow.user_id ? { user_id: savedWalletsRow.user_id } : null,
        error: null,
      }),
    }
    return b
  }
  const profileBio = () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
    }
    return b
  }
  return {
    supabaseAdmin: {
      from: (t: string) => (t === "saved_wallets" ? savedWallets() : profileBio()),
      rpc: async () => ({ data: [], error: null }),
    },
  }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => authState.user,
}))

// Matches the shape the route reads (`req.nextUrl.searchParams`), same as
// __tests__/api-wallet-reads.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("top-moments resolves an ownerKey on any supported chain", () => {
  beforeEach(() => {
    savedWalletsEq.length = 0
    savedWalletsRow.user_id = null
    authState.user = null
  })

  it("sends a base58 ownerKey to saved_wallets UNFOLDED and resolves that owner", async () => {
    savedWalletsRow.user_id = "candy-owner"
    // A different viewer is signed in: if the route fell through to the session
    // (the old behaviour) it would answer for THEM, not for the ownerKey.
    authState.user = { id: "some-other-viewer" }
    const { GET } = await import("@/app/api/profile/top-moments/route")
    const res = await GET(req(`https://t/api/profile/top-moments?ownerKey=${CANDY}`))

    expect(res.status).toBe(200)
    const hit = savedWalletsEq.find((e) => e.col === "wallet_addr")
    expect(hit, "base58 ownerKey never reached the saved_wallets lookup").toBeDefined()
    expect(hit!.value).toBe(CANDY)
    expect(hit!.value).not.toBe(CANDY.toLowerCase())
  })

  it("no-change control: a Flow ownerKey is still folded to lowercase", async () => {
    savedWalletsRow.user_id = "flow-owner"
    const { GET } = await import("@/app/api/profile/top-moments/route")
    await GET(req(`https://t/api/profile/top-moments?ownerKey=${FLOW_MIXED}`))
    const hit = savedWalletsEq.find((e) => e.col === "wallet_addr")
    expect(hit!.value).toBe(FLOW_LOWER)
  })
})
