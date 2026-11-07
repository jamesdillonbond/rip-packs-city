import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import { isLockKnown, getLocked } from "../lib/collection/helpers"

// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Top Shot's GraphQL host is DECOMMISSIONED — 530 since ~2026-08-30, re-verified
// 2026-09-13 from a residential IP (so it is not Vercel egress and not a WAF
// verdict) — and it is not coming back. #65 re-pointed six other consumers onto
// Atlas-via-database; wallet-search's per-moment leg was never among them.
//
// Verified in production 2026-09-13 against a real wallet: 5 of 5 rows came back
// `enrichFailed: true` with every `thumbnailUrl` null and `tier` empty. So the
// flagship collection's wallet view has rendered imageless, tierless, askless
// rows for roughly two weeks.
//
// `wallet_moments_cache` already holds it for wallets the platform has walked —
// whole-table coverage of 1,767,825 Top Shot rows: image_url 98.9%, tier 98.9%,
// mint_count 98.9%, league 66.3%.
//
// ⛔ THE HALF THAT MATTERS MORE THAN THE FILL. `wallet_moments_cache.is_locked`
// has `column_default false` and 1,160,468 of those rows have `lock_checked_at`
// NULL — with `is_locked = true` on EXACTLY ZERO of them, which is the proof
// that the value is the default and not a reading (register #112). Copying that
// column without its timestamp would republish `LOCKED: No` on 1.16M unexamined
// moments — reintroducing, through a back door, the precise defect `eaf0b2b`
// removed from this same route hours earlier.
//
// So the property pinned here is TWO-SIDED, and the second side is the one a
// future rewrite is most likely to lose:
//   1. a checked lock IS recovered and reaches the user, and
//   2. an UNCHECKED lock is NOT, no matter how convenient the boolean looks.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  gqlNullData: false,
  ownedIds: [] as number[],
  metadataById: {} as Record<string, Record<string, string>>,
  wmcRows: [] as Array<Record<string, unknown>>,
  wmcError: null as { message: string } | null,
  wmcQueries: 0,
}))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: (_k: string, _t: number, fn: () => unknown) => fn(),
}))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string; args?: (a: unknown, t: unknown) => unknown[] }) => {
      if (opts.cadence.includes("getIDs")) return state.ownedIds
      const collected: string[] = []
      opts.args?.(((v: unknown) => {
        collected.push(String(v))
        return v
      }) as never, {} as never)
      const meta = state.metadataById[collected[1]]
      if (!meta) throw new Error("no nft")
      return meta
    },
  },
}))
// The dead host, behaving exactly as production does.
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => {
    // 2026-11-07: an ANSWER that carries no moment, the other way the host fails
    if (state.gqlNullData) return { getMintedMoment: { data: null } }
    throw new Error("Top Shot GraphQL failed with 530. Response body: error code: 530")
  },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () => ({ found: false }),
}))

const { POST } = await import("@/app/api/wallet-search/route")

const WALLET = "0xbd94cade097e50ac"
const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const post = (body: Record<string, unknown>) =>
  new NextRequest("https://t/api/wallet-search", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })

const meta = (serial: string) => ({
  player: "Damian Lillard",
  team: "POR",
  setName: "Base Set",
  series: "5",
  serial,
  mint: "",
  playID: "45",
  setID: "3",
})

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

/**
 * The harness returns fixtures per TABLE, so `wallet_moments_cache` is served
 * from `state.wmcRows` / `state.wmcError` and every read of it is counted.
 */
function install() {
  const spy = makeInstrumentedSupabaseFixture({
    collections: { data: { id: TS_UUID }, error: null },
    editions: [
      { data: null, error: null },
      { data: [{ id: "uuid-ed-1", external_id: "3:45" }], error: null },
    ],
    cached_listings: { data: [], error: null },
    "rpc:get_editions_latest_fmv_wide": { data: [], error: null },
    get wallet_moments_cache() {
      state.wmcQueries += 1
      return state.wmcError
        ? { data: null, error: state.wmcError }
        : { data: state.wmcRows, error: null }
    },
    moment_acquisitions: { data: null, error: null },
    sales: { data: [], error: null },
    "rpc:get_wallet_acquisition_data_scoped": { data: [], error: null },
    "rpc:get_acquisition_stats": { data: [], error: null },
  } as unknown as Fixtures)
  state.sb = spy.fixture
  return spy
}

const rowsOf = async (body: Record<string, unknown> = { input: WALLET }) =>
  (await (await POST(post(body))).json()).rows as Array<Record<string, unknown>>

beforeEach(() => {
  state.gqlNullData = false
  state.ownedIds = [101, 102]
  state.metadataById = { "101": meta("5"), "102": meta("77") }
  state.wmcRows = []
  state.wmcError = null
  state.wmcQueries = 0
  install()
})

describe("the dead-host row is refilled from wallet_moments_cache", () => {
  it("⭐ recovers the tier, league and circulation the dead host used to supply — and DERIVES the art, never copying a cached edition hero", async () => {
    // ⚠ INVERTED 2026-11-06 for the thumbnail half. This test used to pin
    // "thumbnailUrl === the cached editions/…hero.png". Dapper retired the
    // Series-1 hero bucket (12/12 random `/editions/1_*` URLs 404; Trevor's
    // Dame Cosmic #12/49 rendered blank), and this fill was the writer that put
    // the dead URL BACK on every chain-only walk (76,047 rows, 194 wallets). A
    // Top Shot row's art is the per-Moment media URL, derivable from the id.
    state.wmcRows = [
      {
        moment_id: "101",
        image_url: "https://assets.nbatopshot.com/editions/1_cosmic_legendary/x/play_x_1_cosmic_legendary_capture_Hero_2880_2880_Transparent.png",
        tier: "RARE",
        mint_count: 499,
        league: "NBA",
        is_locked: false,
        lock_checked_at: "2026-09-13T00:00:00Z",
      },
    ]
    const rows = await rowsOf()
    const row = rows.find((r) => r.momentId === "101")!
    expect(row.thumbnailUrl).toBe("https://assets.nbatopshot.com/media/101/image?width=180")
    expect(row.thumbnailUrl).not.toMatch(/\/editions\//)
    expect(row.tier).toBe("RARE")
    expect(row.league).toBe("NBA")
    expect(row.circulationCount).toBe(499)
  })

  it("a moment with no cache row is left exactly as it was — absent, not invented (art excepted: a Top Shot id always derives its media URL)", async () => {
    state.wmcRows = [] // walked nothing for this wallet
    const rows = await rowsOf()
    const row = rows.find((r) => r.momentId === "101")!
    expect(row.thumbnailUrl).toBe("https://assets.nbatopshot.com/media/101/image?width=180")
    expect(row.isLocked).toBeUndefined()
    expect(row.lockKnown).toBeUndefined()
  })

  // ⚠ INVERTED 2026-11-07 (review): this test pinned `thumbnailUrl === null` on
  // a failed cache read — the defect. The Top Shot media URL is derived from the
  // Moment id and needs no read, so a failure in the CACHE (another source) must
  // not blank it. Everything the cache supplies still stays unfilled.
  it("⚠ a FAILED cache read fills nothing FROM THE CACHE — the id-derived Top Shot art still lands", async () => {
    // Three states, not two. supabase-js returns errors rather than throwing, so
    // without the explicit branch this is indistinguishable from "never walked".
    state.wmcError = { message: "canceling statement due to statement timeout" }
    const rows = await rowsOf()
    expect(rows).toHaveLength(2)
    const row = rows.find((r) => r.momentId === "101")!
    expect(row.thumbnailUrl).toBe("https://assets.nbatopshot.com/media/101/image?width=180")
    expect(row.lockKnown).toBeUndefined()
  })
})

describe("⛔ lock state is only recovered WITH its provenance", () => {
  it("a CHECKED lock is recovered and reaches the user as a real reading", async () => {
    state.wmcRows = [
      { moment_id: "101", is_locked: true, lock_checked_at: "2026-09-13T00:00:00Z" },
    ]
    const row = (await rowsOf()).find((r) => r.momentId === "101")!
    expect(row.isLocked).toBe(true)
    expect(row.lockKnown).toBe(true)
    // ...and the render gate now treats it as known despite the failed live read.
    expect(isLockKnown(row as never)).toBe(true)
    expect(getLocked(row as never)).toBe(true)
  })

  // 2026-11-07 review: a GraphQL answer with a null `getMintedMoment.data` was
  // assembled as a measured `isLocked: false`, which ALSO blocked the cache from
  // supplying the checked reading (it fills only an unknown lock).
  it("a GraphQL answer with NO moment never becomes 'not locked' — the checked cache reading wins", async () => {
    state.gqlNullData = true
    state.wmcRows = [{ moment_id: "101", is_locked: true, lock_checked_at: "2026-09-13T00:00:00Z" }]
    const row = (await rowsOf()).find((r) => r.momentId === "101")!
    expect(row.isLocked).toBe(true)
  })

  it("🚨 a NEVER-CHECKED lock is NOT recovered, however convenient the boolean looks", async () => {
    // This is register #112 in one row: is_locked reads false because the column
    // DEFAULTS to false, not because anyone looked. 1,160,468 Top Shot rows are
    // in this state and `is_locked = true` on zero of them.
    state.wmcRows = [{ moment_id: "101", is_locked: false, lock_checked_at: null }]
    const row = (await rowsOf()).find((r) => r.momentId === "101")!
    expect(row.isLocked).toBeUndefined()
    expect(row.lockKnown).toBeUndefined()
    // The user is told "unknown", which is the truth.
    expect(isLockKnown(row as never)).toBe(false)
  })

  it("⛔ and the same row does not leak in through the OTHER fields either", async () => {
    // A cache row may legitimately supply a thumbnail while its lock is unknown.
    // The fill must be per-FIELD, not all-or-nothing in either direction.
    state.wmcRows = [
      {
        moment_id: "101",
        image_url: "https://assets.nbatopshot.com/editions/y/hero.png",
        tier: "COMMON",
        is_locked: false,
        lock_checked_at: null,
      },
    ]
    const row = (await rowsOf()).find((r) => r.momentId === "101")!
    // (art is derived for Top Shot, 2026-11-06 — the per-field point is tier vs lock)
    expect(row.thumbnailUrl).toBe("https://assets.nbatopshot.com/media/101/image?width=180")
    expect(row.tier).toBe("COMMON")
    expect(row.isLocked).toBeUndefined()
  })
})

describe("isLockKnown's provenance branch", () => {
  it("lockKnown outranks enrichFailed, because they describe different sources", () => {
    expect(isLockKnown({ enrichFailed: true, isLocked: true, lockKnown: true } as never)).toBe(true)
  })

  it("⛔ but enrichFailed still wins when there is no provenance — eaf0b2b's contract is intact", () => {
    expect(isLockKnown({ enrichFailed: true, isLocked: false } as never)).toBe(false)
    expect(isLockKnown({ enrichFailed: true } as never)).toBe(false)
    // lockKnown must be an explicit true; nothing else may satisfy the branch.
    expect(isLockKnown({ enrichFailed: true, lockKnown: false } as never)).toBe(false)
    expect(isLockKnown({ enrichFailed: true, lockKnown: undefined } as never)).toBe(false)
  })
})
