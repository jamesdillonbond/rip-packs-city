import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  atlasCall,
  atlasHeaders,
  atlasNum,
  fetchDistributionEditionIds,
  isCloudflareChallenge,
  parseAtlasDistribution,
  parseDistributionEditionsPage,
  parseOffsetCursor,
  parseSearchDistributionsPage,
  searchAllDistributions,
  supplyOf,
  type AtlasDeps,
} from "@/supabase/functions/_shared/atlas-distributions"

// Pins the Atlas re-sourcing of the three supply-weighted pack-EV writers
// (compute-allday/golazos/pinnacle-pack-ev) after Studio GraphQL died (HTTP 530,
// 2026-11-17 4:23 PM PT). Every fixture below is trimmed from a REAL Atlas
// response probed via pg_net on 2026-11-18 PT — not an invented shape.

// SearchDistributions {product:"laliga"} → dist 235 (Studio gave it the same uuid).
const LALIGA_235 = {
  uuid: "262cbbfb-1d99-44b7-b446-8253f23b3648",
  id: "235",
  title: "Jornadas 1-9",
  price: 4.99,
  tier: "in_season_starter",
  forSaleSupply: "0",
  totalSupply: "8000",
  availableSupply: "0",
  numberOfPackSlots: "4",
  typeName: "A.87ca73a41bb50ad5.PackNFT.NFT",
}
// SearchDistributions {product:"disney"} → a live draw: NO totalSupply/availableSupply keys.
const DISNEY_8923 = {
  uuid: "e770dc31-21d4-4768-a393-23008debe379",
  id: "8923",
  title: "Disney Mickey & Friends: Friends-Giving Vol.2",
  price: 49.95,
  tier: "limited_edition",
  isEnabled: true,
  numberOfPackSlots: "1",
}
// SearchDistributions {product:"nfl"} → a reward pack: price 0 is SENT, not omitted.
const NFL_7714 = {
  uuid: "29ed3898-d14a-4d30-b590-8c67618ab745",
  id: "7714",
  title: "Dak Prescott - Rookie Rewind Gold: Sapphire Reward",
  price: 0,
  totalSupply: "11",
  availableSupply: "0",
  numberOfPackSlots: "1",
}

const CHALLENGE_HTML =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script>(function(){window._cf_chl_opt = {}})()</script></body></html>'

function deps(responses: Array<{ status: number; body: string } | Error>): AtlasDeps & { sent: Array<{ url: string; body: unknown }>; slept: number[] } {
  const sent: Array<{ url: string; body: unknown }> = []
  const slept: number[] = []
  let i = 0
  return {
    sent,
    slept,
    gapMs: 7,
    challengeBackoffMs: [11, 13, 17],
    transientBackoffMs: [19],
    timeoutMs: 1000,
    sleep: (ms) => {
      slept.push(ms)
      return Promise.resolve()
    },
    fetchFn: ((url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) })
      const r = responses[Math.min(i++, responses.length - 1)]
      if (r instanceof Error) return Promise.reject(r)
      return Promise.resolve(new Response(r.body, { status: r.status }))
    }) as typeof fetch,
  }
}

describe("atlasNum — protojson int64 arrives as a STRING; absent is unknown, never 0", () => {
  it("reads numbers and decimal strings", () => {
    expect(atlasNum("8000")).toBe(8000)
    expect(atlasNum(4.99)).toBe(4.99)
    expect(atlasNum("0")).toBe(0)
  })
  it("is null for absent / non-numeric values (no `?? 0`)", () => {
    expect(atlasNum(undefined)).toBeNull()
    expect(atlasNum(null)).toBeNull()
    expect(atlasNum("")).toBeNull()
    expect(atlasNum("abc")).toBeNull()
  })
})

describe("parseAtlasDistribution — the Studio node's fields, re-sourced", () => {
  it("maps a real laliga row: string int64s become numbers, price is dollars", () => {
    expect(parseAtlasDistribution(LALIGA_235)).toEqual({
      uuid: "262cbbfb-1d99-44b7-b446-8253f23b3648",
      id: "235",
      title: "Jornadas 1-9",
      numberOfPackSlots: 4,
      totalSupply: 8000,
      availableSupply: 0,
      price: 4.99,
    })
  })
  it("keeps an OMITTED supply as unknown, so the writers cannot read it as sold out", () => {
    const d = parseAtlasDistribution(DISNEY_8923)!
    expect(d.totalSupply).toBeNull()
    expect(d.availableSupply).toBeNull()
    expect(supplyOf(d)).toEqual({ read: false })
  })
  it("keeps an explicit price 0 (reward pack) as 0, distinct from an omitted price", () => {
    expect(parseAtlasDistribution(NFL_7714)!.price).toBe(0)
    const { price: _p, ...noPrice } = LALIGA_235
    expect(parseAtlasDistribution(noPrice)!.price).toBeNull()
  })
  it("rejects a row with no uuid or id rather than inventing one", () => {
    expect(parseAtlasDistribution({ ...LALIGA_235, uuid: "" })).toBeNull()
    expect(parseAtlasDistribution({ ...LALIGA_235, id: undefined })).toBeNull()
    expect(parseAtlasDistribution(null)).toBeNull()
  })
  it("supplyOf reads both counts when both are present", () => {
    expect(supplyOf(parseAtlasDistribution(LALIGA_235)!)).toEqual({ read: true, total: 8000, available: 0 })
  })
})

describe("parseSearchDistributionsPage", () => {
  it("parses a page and counts malformed rows instead of dropping them silently", () => {
    const p = parseSearchDistributionsPage({
      distributions: [LALIGA_235, { title: "no ids" }],
      pagination: { totalCount: "169", limit: "100", offset: "0", hasMore: true },
    })
    if (typeof p === "string") throw new Error(p)
    expect(p.dists.map((d) => d.id)).toEqual(["235"])
    expect(p.malformed).toBe(1)
    expect(p.rawCount).toBe(2)
    expect(p.totalCount).toBe(169)
  })
  it("an envelope without pagination.totalCount is an error, not an empty catalog", () => {
    expect(typeof parseSearchDistributionsPage({ distributions: [] })).toBe("string")
    expect(typeof parseSearchDistributionsPage({ code: "not_found" })).toBe("string")
  })
})

describe("parseDistributionEditionsPage — Studio's editionIds", () => {
  it("reads editionId (nfl 7148 row shape)", () => {
    const p = parseDistributionEditionsPage({
      editions: [
        { distributionId: "7148", editionId: "5818", originalCount: "2", remainingCount: "0", edition: { id: "5818", tier: "ULTIMATE" } },
        { distributionId: "7148", editionId: "4282", originalCount: "43", remainingCount: "0", edition: { id: "4282" } },
      ],
      totalCount: "616",
    })
    if (typeof p === "string") throw new Error(p)
    expect(p.editionIds).toEqual(["5818", "4282"])
    expect(p.totalCount).toBe(616)
    expect(p.malformed).toBe(0)
  })
  it("the laliga answer is a READ of an empty pool (totalCount 0), not an error", () => {
    const p = parseDistributionEditionsPage({ editions: [], totalCount: "0" })
    if (typeof p === "string") throw new Error(p)
    expect(p.editionIds).toEqual([])
    expect(p.totalCount).toBe(0)
  })
})

describe("isCloudflareChallenge", () => {
  it("recognises the HTML 403 challenge", () => {
    expect(isCloudflareChallenge(403, CHALLENGE_HTML)).toBe(true)
  })
  it("does not treat a Connect JSON 403 or a 404 as a challenge", () => {
    expect(isCloudflareChallenge(403, '{"code":"permission_denied","message":"no"}')).toBe(false)
    expect(isCloudflareChallenge(404, CHALLENGE_HTML)).toBe(false)
  })
})

describe("atlasCall — retries, and every failure names its HTTP status", () => {
  it("sends {product, ...body} to /public/atlas.v1.<Service>/<Method> with the DB lanes' headers", async () => {
    const d = deps([{ status: 200, body: "{}" }])
    const r = await atlasCall("DistributionService", "SearchDistributions", "laliga", { limit: 2 }, d)
    expect(r.ok).toBe(true)
    expect(d.sent[0].url).toBe("https://api.production.atlas.dapperlabs.com/public/atlas.v1.DistributionService/SearchDistributions")
    expect(d.sent[0].body).toEqual({ product: "laliga", limit: 2 })
    expect(atlasHeaders("nfl").origin).toBe("https://nflallday.com")
    expect(atlasHeaders("disney").origin).toBe("https://nbatopshot.com")
    expect(atlasHeaders("laliga")["connect-protocol-version"]).toBe("1")
  })
  it("retries a Cloudflare challenge on its backoff and succeeds", async () => {
    const d = deps([{ status: 403, body: CHALLENGE_HTML }, { status: 403, body: CHALLENGE_HTML }, { status: 200, body: '{"x":1}' }])
    const r = await atlasCall("DistributionService", "GetDistributionEditions", "nfl", {}, d)
    expect(r).toEqual({ ok: true, data: { x: 1 }, attempts: 3 })
    expect(d.slept).toEqual([11, 13])
  })
  it("gives up after the challenge schedule with 'HTTP 403' in the error", async () => {
    const d = deps([{ status: 403, body: CHALLENGE_HTML }])
    const r = await atlasCall("DistributionService", "GetDistributionEditions", "nfl", {}, d)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(403)
    expect(r.error).toContain("HTTP 403")
    expect(r.attempts).toBe(4)
  })
  it("does not retry a Connect 404, and reports its code", async () => {
    const d = deps([{ status: 404, body: '{"code":"not_found","message":"distribution not found"}' }])
    const r = await atlasCall("DistributionService", "GetDistribution", "laliga", {}, d)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.attempts).toBe(1)
    expect(r.error).toContain("HTTP 404")
    expect(r.error).toContain("not_found: distribution not found")
  })
  it("retries a 503 once, then fails with the status", async () => {
    const d = deps([{ status: 503, body: "{}" }])
    const r = await atlasCall("DistributionService", "SearchDistributions", "nfl", {}, d)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.attempts).toBe(2)
    expect(r.error).toContain("HTTP 503")
  })
  it("a 200 that is not JSON is a failure, not an empty answer", async () => {
    const d = deps([{ status: 200, body: "<html>" }])
    const r = await atlasCall("DistributionService", "SearchDistributions", "nfl", {}, d)
    expect(r.ok).toBe(false)
  })
})

describe("walks are all-or-nothing — a partial list or pool is never returned", () => {
  const page = (ids: string[], total: number) => ({
    status: 200,
    body: JSON.stringify({
      distributions: ids.map((id) => ({ ...LALIGA_235, id, uuid: `u-${id}` })),
      pagination: { totalCount: String(total) },
    }),
  })
  it("searchAllDistributions walks offsets to totalCount", async () => {
    const d = deps([page(["1", "2"], 3), page(["3"], 3)])
    const r = await searchAllDistributions("disney", d, { pageLimit: 2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dists.map((x) => x.id)).toEqual(["1", "2", "3"])
    expect(d.sent.map((s) => (s.body as { offset: number }).offset)).toEqual([0, 2])
  })
  it("a failed second page fails the walk — the first page is not returned as the catalog", async () => {
    const d = deps([page(["1", "2"], 3), { status: 404, body: '{"code":"not_found"}' }])
    const r = await searchAllDistributions("disney", d, { pageLimit: 2 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("HTTP 404")
  })
  it("fetchDistributionEditionIds pages a 3-edition pool and de-duplicates", async () => {
    const ed = (ids: string[], total: number) => ({
      status: 200,
      body: JSON.stringify({ editions: ids.map((editionId) => ({ editionId })), totalCount: String(total) }),
    })
    const d = deps([ed(["10", "11"], 3), ed(["11"], 3)])
    const r = await fetchDistributionEditionIds("nfl", "7148", d, { pageLimit: 2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.editionIds).toEqual(["10", "11"])
    expect((d.sent[0].body as { distributionId: string }).distributionId).toBe("7148")
  })
  it("a pool page short of totalCount fails rather than returning a partial pool", async () => {
    const d = deps([
      { status: 200, body: JSON.stringify({ editions: [{ editionId: "10" }], totalCount: "3" }) },
      { status: 200, body: JSON.stringify({ editions: [], totalCount: "3" }) },
    ])
    const r = await fetchDistributionEditionIds("nfl", "7148", d, { pageLimit: 1 })
    expect(r.ok).toBe(false)
  })
  it("a pool row with no editionId fails the walk (a missing edition would re-weight the EV)", async () => {
    const d = deps([{ status: 200, body: JSON.stringify({ editions: [{ editionId: "10" }, { remainingCount: "1" }], totalCount: "2" }) }])
    const r = await fetchDistributionEditionIds("nfl", "7148", d)
    expect(r.ok).toBe(false)
  })
})

describe("parseOffsetCursor — a leftover Studio cursor restarts and says so", () => {
  it("reads an offset", () => {
    expect(parseOffsetCursor("80")).toEqual({ offset: 80, reset: null })
    expect(parseOffsetCursor(null)).toEqual({ offset: 0, reset: null })
  })
  it("an opaque Studio cursor is not an offset", () => {
    const r = parseOffsetCursor("YXJyYXljb25uZWN0aW9uOjM5")
    expect(r.offset).toBe(0)
    expect(r.reset).toMatch(/restarted at 0/)
  })
})

describe("the three supply-weighted writers no longer read Studio GraphQL", () => {
  const root = process.cwd()
  for (const fn of ["compute-allday-pack-ev", "compute-golazos-pack-ev", "compute-pinnacle-pack-ev"]) {
    it(`${fn} reads Atlas, not studio-platform`, () => {
      const src = readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8")
      const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
      expect(code).not.toMatch(/studio-platform\.dapperlabs\.com/)
      expect(code).not.toMatch(/searchDistributions\(/)
      expect(code).toMatch(/from "\.\.\/_shared\/atlas-distributions\.ts"/)
    })
  }
  it("Golazos does not prune or re-stamp a pool it did not re-read (Atlas has no laliga pool)", () => {
    const src = readFileSync(path.join(root, "supabase/functions/compute-golazos-pack-ev/index.ts"), "utf8")
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
    expect(code).not.toMatch(/\.delete\(\)/)
    expect(code).not.toMatch(/last_refreshed_at:\s*runStamp/)
    expect(code).not.toMatch(/GetDistributionEditions|fetchDistributionEditionIds/)
  })
})
