import { describe, it, expect, vi } from "vitest"
import { retryEmptyPlayerSearch } from "@/lib/search/player-search-retry"

// #207 platform-wide (2026-10-22): one rule for every surface whose player search
// reaches the database accent-sensitively. Only an EMPTY, non-failed answer is
// retried, only with the resolver's single label, and the swap is reported.

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const one = (name: string) => ({ status: "one", query: "q", query_slug: "q", matched_via: "slug", namesakes: [], player: { id: "p", name, slug: "s", team: null, edition_count: 1, labels: [name] }, aliases: [], identity: null, relations: [], matched_query_as: "q" })
function sb(verdict: unknown) {
  const rpc = vi.fn(async () => ({ data: verdict, error: null }))
  return { rpc }
}

describe("retryEmptyPlayerSearch", () => {
  it("an empty answer is retried with the resolver's single spelling, and the swap is reported", async () => {
    const supabase = sb(one("Luka Dončić"))
    const run = vi.fn(async (label: string) => ({ data: [{ player_name: label }], error: null }))
    const out = await retryEmptyPlayerSearch({ supabase, collectionUuid: TS, typed: " doncic ", first: { data: [], error: null }, run })
    expect(supabase.rpc).toHaveBeenCalledWith("resolve_player_name", { p_collection_id: TS, p_name: "doncic" })
    expect(run).toHaveBeenCalledWith("Luka Dončić")
    expect(out.data).toEqual([{ player_name: "Luka Dončić" }])
    expect(out.playerResolved).toEqual({ from: "doncic", to: "Luka Dončić" })
  })

  it("a search that matched anything is untouched — no resolver call", async () => {
    const supabase = sb(one("Luka Dončić"))
    const run = vi.fn()
    const out = await retryEmptyPlayerSearch({ supabase, collectionUuid: TS, typed: "curry", first: { data: [{ x: 1 }], error: null }, run })
    expect(out).toEqual({ data: [{ x: 1 }], error: null, playerResolved: null })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("a FAILED read is never retried into an answer", async () => {
    const supabase = sb(one("Luka Dončić"))
    const run = vi.fn()
    const err = { message: "statement timeout" }
    const out = await retryEmptyPlayerSearch({ supabase, collectionUuid: TS, typed: "doncic", first: { data: null, error: err }, run })
    expect(out.error).toBe(err)
    expect(out.playerResolved).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it("ambiguous / unknown / unavailable resolutions never guess", async () => {
    for (const verdict of [{ status: "ambiguous", query: "vinicius", query_slug: "v", candidates: [], note: "" }, { status: "none", query: "zzz" }]) {
      const run = vi.fn()
      const out = await retryEmptyPlayerSearch({ supabase: sb(verdict), collectionUuid: TS, typed: "vinicius", first: { data: [], error: null }, run })
      expect(out.playerResolved).toBeNull()
      expect(run).not.toHaveBeenCalled()
    }
    const failing = { rpc: vi.fn(async () => ({ data: null, error: { message: "boom" } })) }
    const out = await retryEmptyPlayerSearch({ supabase: failing, collectionUuid: TS, typed: "doncic", first: { data: [], error: null }, run: vi.fn() })
    expect(out).toEqual({ data: [], error: null, playerResolved: null })
  })

  it("a retry that finds nothing, or fails, leaves the original empty answer unlabelled", async () => {
    for (const again of [{ data: [], error: null }, { data: null, error: { message: "x" } }]) {
      const out = await retryEmptyPlayerSearch({ supabase: sb(one("Luka Dončić")), collectionUuid: TS, typed: "doncic", first: { data: [], error: null }, run: async () => again })
      expect(out).toEqual({ data: [], error: null, playerResolved: null })
    }
  })

  it("no typed text, or no collection in scope, does nothing", async () => {
    const supabase = sb(one("x"))
    for (const [typed, uuid] of [["", TS], ["   ", TS], ["doncic", null]] as const) {
      const out = await retryEmptyPlayerSearch({ supabase, collectionUuid: uuid, typed, first: { data: [], error: null }, run: vi.fn() })
      expect(out.playerResolved).toBeNull()
    }
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it("across collections, retries only when they agree on ONE spelling", async () => {
    const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
    const agree = { rpc: vi.fn(async (_f: string, a: { p_collection_id: string }) => ({ data: a.p_collection_id === TS ? one("Luka Dončić") : { status: "none", query: "doncic" }, error: null })) }
    const run = vi.fn(async (label: string) => ({ data: [{ player_name: label }], error: null }))
    const out = await retryEmptyPlayerSearch({ supabase: agree, collectionUuid: [TS, AD], typed: "doncic", first: { data: [], error: null }, run })
    expect(agree.rpc).toHaveBeenCalledTimes(2)
    expect(out.playerResolved).toEqual({ from: "doncic", to: "Luka Dončić" })
    const disagree = { rpc: vi.fn(async (_f: string, a: { p_collection_id: string }) => ({ data: one(a.p_collection_id === TS ? "Mike Smith" : "Michael Smith"), error: null })) }
    const run2 = vi.fn()
    const out2 = await retryEmptyPlayerSearch({ supabase: disagree, collectionUuid: [TS, AD], typed: "smith", first: { data: [], error: null }, run: run2 })
    expect(out2.playerResolved).toBeNull()
    expect(run2).not.toHaveBeenCalled()
  })

  it("a retry that THROWS leaves the original empty answer standing", async () => {
    const out = await retryEmptyPlayerSearch({ supabase: sb(one("Luka Dončić")), collectionUuid: TS, typed: "doncic", first: { data: [], error: null }, run: () => { throw new Error("boom") } })
    expect(out).toEqual({ data: [], error: null, playerResolved: null })
  })
})
