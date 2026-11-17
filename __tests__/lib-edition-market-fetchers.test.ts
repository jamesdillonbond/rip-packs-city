import { describe, it, expect, vi, beforeEach } from "vitest"

import {
  fetchMarketBundle,
  fetchInsightLinks,
  EMPTY_MARKET_BUNDLE,
  EMPTY_INSIGHT_LINKS,
} from "@/lib/entity/edition-market-fetchers"

// The edition page's last two direct Supabase readers, extracted so a gate can
// see them (app/**/page.tsx is measured by neither coverage config — see
// __tests__/server-page-data-access-ratchet.test.ts).
//
// What these pin is narrower than "the fetchers work", and deliberately so. The
// edition page renders every one of these fields behind a `!= null` /
// `length >= 2` check, so the honesty property here is NOT "a failure is
// disclosed" — it is that a failure produces values those checks REJECT. A
// fetcher that helpfully substituted `0` for a missing listing count, or `[]`
// for a missing ladder, would satisfy its type and silently turn a dead feed
// into "0.0% listed".

const rpc = vi.fn()
const db = { rpc: (...a: unknown[]) => rpc(...a) }

beforeEach(() => {
  rpc.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

/** rpcWithRetry probes for `.abortSignal`; a bare async fn takes the guard path. */
function resolves(value: unknown) {
  rpc.mockResolvedValue({ data: value, error: null })
}
function fails(message: string, code = "57014") {
  rpc.mockResolvedValue({ data: null, error: { message, code } })
}

describe("fetchMarketBundle", () => {
  it("maps a full bundle and reports ok", async () => {
    resolves({
      high_offer: { highest_offer: 42, low_ask: 50, updated_at: "2026-08-15T00:00:00Z", offer_scope: "parallel" },
      ipfs_assets: { video_cid: "cid-v", hero_cid: "cid-h" },
      subedition_siblings: [{ external_id: "48:1652", is_self: true }],
      active_listings: 7,
    })
    const res = await fetchMarketBundle("ed-1", "48:1652", db)
    expect(res.ok).toBe(true)
    expect(res.data.high_offer?.highest_offer).toBe(42)
    expect(res.data.high_offer?.offer_scope).toBe("parallel")
    expect(res.data.subedition_siblings).toHaveLength(1)
    expect(res.data.active_listings).toBe(7)
  })

  it("preserves a genuine ZERO listing count — that is an honest '0.0% listed'", async () => {
    // 0 and null mean different things: 0 is a live source with nothing listed;
    // null is no source at all. Collapsing them is how a dead feed becomes a
    // market claim.
    resolves({ active_listings: 0 })
    const res = await fetchMarketBundle("ed-1", null, db)
    expect(res.data.active_listings).toBe(0)
    expect(res.ok).toBe(true)
  })

  it("rejects a non-number listing count rather than coercing it", async () => {
    // A stringy "0" from a jsonb round-trip must NOT become a count.
    for (const bad of ["0", "7", true, {}, [], undefined]) {
      resolves({ active_listings: bad })
      const res = await fetchMarketBundle("ed-1", null, db)
      expect(res.data.active_listings, `${JSON.stringify(bad)} must not become a count`).toBeNull()
    }
  })

  it("null-safes a partial bundle without inventing rows", async () => {
    resolves({})
    const res = await fetchMarketBundle("ed-1", null, db)
    expect(res.ok).toBe(true)
    expect(res.data).toEqual(EMPTY_MARKET_BUNDLE)
  })

  it("coerces a non-array sibling list to [] rather than passing it through", async () => {
    // `.find` / `.length` downstream would throw on a non-array.
    resolves({ subedition_siblings: { nope: true } })
    const res = await fetchMarketBundle("ed-1", null, db)
    expect(res.data.subedition_siblings).toEqual([])
  })

  it("on a failed read returns ok:false and values every render site REJECTS", async () => {
    fails("canceling statement due to statement timeout")
    const res = await fetchMarketBundle("ed-1", "48:1652", db)
    expect(res.ok).toBe(false)
    // The specific shape matters more than the equality: null listing count ->
    // em-dash, not 0.0%; empty ladder -> section hidden, not "no parallels".
    expect(res.data.active_listings).toBeNull()
    expect(res.data.high_offer).toBeNull()
    expect(res.data.subedition_siblings).toEqual([])
  })

  it("passes the edition id AND external id through", async () => {
    resolves({})
    await fetchMarketBundle("ed-9", "121:4255", db)
    expect(rpc).toHaveBeenCalledWith("get_edition_market_bundle", {
      p_edition_id: "ed-9",
      p_external_id: "121:4255",
    })
  })
})

describe("fetchInsightLinks", () => {
  it("maps the three chips and reports ok", async () => {
    resolves({ squeeze_pct: 61.2, deal_pct: 18, first_mint_x: 3.4 })
    const res = await fetchInsightLinks("ed-1", "48:1652", db)
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ squeeze_pct: 61.2, deal_pct: 18, first_mint_x: 3.4 })
  })

  it("a missing chip is null, not 0 — a 0% squeeze is a claim", async () => {
    resolves({ squeeze_pct: null })
    const res = await fetchInsightLinks("ed-1", null, db)
    expect(res.data).toEqual(EMPTY_INSIGHT_LINKS)
    expect(res.ok).toBe(true)
  })

  it("preserves a genuine zero", async () => {
    resolves({ squeeze_pct: 0, deal_pct: 0, first_mint_x: 0 })
    const res = await fetchInsightLinks("ed-1", null, db)
    expect(res.data).toEqual({ squeeze_pct: 0, deal_pct: 0, first_mint_x: 0 })
  })

  it("on a returned error degrades to empty with ok:false", async () => {
    fails("permission denied", "42501")
    const res = await fetchInsightLinks("ed-1", null, db)
    expect(res).toEqual({ data: EMPTY_INSIGHT_LINKS, ok: false })
  })

  it("survives a THROWN transport failure — the try/catch is not redundant", async () => {
    // supabase-js RETURNS a Postgrest error but THROWS on a transport failure.
    // Without the catch this escapes into the page's blocking Promise.all and
    // takes down the whole render instead of one decorative strip.
    rpc.mockRejectedValue(new Error("fetch failed"))
    const res = await fetchInsightLinks("ed-1", null, db)
    expect(res).toEqual({ data: EMPTY_INSIGHT_LINKS, ok: false })
  })

  it("survives a thrown non-Error too", async () => {
    rpc.mockRejectedValue("boom")
    await expect(fetchInsightLinks("ed-1", null, db)).resolves.toEqual({
      data: EMPTY_INSIGHT_LINKS,
      ok: false,
    })
  })
})

describe("the failure shape is what the edition page's render gates reject", () => {
  it("no failure value can satisfy a `!= null` or `length >= 2` check", async () => {
    fails("timeout")
    const bundle = (await fetchMarketBundle("e", null, db)).data
    const links = (await fetchInsightLinks("e", null, db)).data

    // This is the actual contract the page depends on. If a future edit gives
    // any of these a non-null default "so the section renders", the page starts
    // publishing a fabricated figure — and because the type would still be
    // satisfied, nothing else would catch it.
    expect(bundle.active_listings != null).toBe(false)
    expect(bundle.high_offer != null).toBe(false)
    expect(bundle.subedition_siblings.length >= 2).toBe(false)
    expect(links.squeeze_pct != null).toBe(false)
    expect(links.deal_pct != null).toBe(false)
    expect(links.first_mint_x != null).toBe(false)
  })
})
