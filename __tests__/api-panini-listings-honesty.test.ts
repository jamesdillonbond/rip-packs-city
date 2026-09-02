import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Honesty properties of GET /api/panini/listings. Siblings:
//   api-panini-listings.test.ts       — the 502 shape
//   api-panini-listings-deep.test.ts  — the shaping/cache legs
// This file pins the two claims the route PUBLISHES about the market, which the
// other two do not assert at all.
//
// ── 1. `count` was a capped page length published as a book size ────────────
// The route asks OpenSea for `?limit=50` and published `count: listings.length`.
// The sniper header renders that as "N listings". On any collection with more
// than 50 live asks the page therefore stated the cap as a census — the row-count
// failure family documented in lib/insights/board-meta.ts, where the same shape
// had six OG cards publishing "3 sales this week" against 30,592.
//
// `count` is KEPT (the page reads it); `truncated` is added beside it so the
// reader can be told the number is a FLOOR.
//
// ⚠ `floor_eth` is deliberately NOT hedged. The upstream endpoint is `/best`,
// which orders by lowest price, so the minimum over a truncated page is still
// the collection floor. Only the COUNT degrades under truncation, and marking
// the floor uncertain too would be its own false claim.
//
// ── 2. the 502 published the upstream error message ─────────────────────────
// The body was `{ error: "Failed to fetch listings", detail: message }` where
// `message` is whatever was thrown — OpenSea's own wording, or a raw Node fetch
// failure. Same class as the `/api/pack-listings` leak that was publishing Dapper
// Studio's phrasing: the leaked text is not always ours or Postgres's.
//
// ⚠ This route is NOT covered by either shared leak guard, and that is the
// transferable part. `__tests__/helpers/driver-message-leak.ts` enumerates five
// spellings, all keyed on the `error:` field; this leak sat in a SIBLING key
// (`detail`), so both guards ran green over it. A repo-wide sweep found ~20 more
// sites in the same shape across ~15 files — filed rather than swept here,
// because widening the shared helper reddens all of them at once.

let fetchImpl: (url: string) => any
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => fetchImpl(url)))
}
async function loadGET() {
  vi.resetModules()
  return (await import("@/app/api/panini/listings/route")).GET
}

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body })
const notOk = (status: number) => ({ ok: false, status, json: async () => ({}) })

/** One OpenSea order priced at `eth`. */
const order = (i: number, eth: number) => ({
  order_hash: `0xhash${i}`,
  price: { current: { value: String(BigInt(Math.round(eth * 1e18))), decimals: 18 } },
  maker: { address: `0xseller${i}` },
  protocol_data: { parameters: { offer: [{ token: "0xtoken", identifierOrCriteria: String(i) }] } },
  listing_time: 1_700_000_000 + i,
})

function router(opts: { listings?: any[]; listingsStatus?: number }) {
  return (url: string) => {
    if (url.includes("/listings/collection/")) {
      return opts.listingsStatus && opts.listingsStatus !== 200
        ? notOk(opts.listingsStatus)
        : ok({ listings: opts.listings ?? [] })
    }
    // CoinGecko + per-NFT metadata are both non-critical legs here.
    return notOk(404)
  }
}

beforeEach(() => installFetch())
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/panini/listings — a capped page is not a book size", () => {
  it("a SHORT page is complete: truncated=false", async () => {
    fetchImpl = router({ listings: [order(1, 1), order(2, 2), order(3, 3)] })
    const body = await (await (await loadGET())()).json()

    expect(body.count).toBe(3)
    expect(body.returned_rows).toBe(3)
    expect(body.truncated).toBe(false)
  })

  it("a page that FILLS the 50-cap is a floor: truncated=true", async () => {
    // The cap is the defect's whole mechanism — at exactly 50 the route cannot
    // know whether the 51st listing exists, so it must not claim 50 is the total.
    fetchImpl = router({ listings: Array.from({ length: 50 }, (_, i) => order(i, i + 1)) })
    const body = await (await (await loadGET())()).json()

    expect(body.count).toBe(50)
    expect(body.truncated).toBe(true)
  })

  it("an EMPTY book is still an honest answer, not a truncation", async () => {
    fetchImpl = router({ listings: [] })
    const body = await (await (await loadGET())()).json()

    expect(body.count).toBe(0)
    expect(body.truncated).toBe(false)
    // Zero listings is a real market fact; the page renders its empty state from
    // this and must keep being allowed to.
    expect(body.floor_eth).toBeNull()
  })

  it("the floor is the cheapest listing and is NOT withheld when truncated", async () => {
    // `/best` is price-ordered, so a truncated page still contains the floor.
    // Withholding it would trade one false claim for a missing true one.
    fetchImpl = router({
      listings: Array.from({ length: 50 }, (_, i) => order(i, i + 1)),
    })
    const body = await (await (await loadGET())()).json()

    expect(body.truncated).toBe(true)
    expect(body.floor_eth).toBeCloseTo(1, 6)
  })

  it("the request really asks for the limit that `truncated` compares against", async () => {
    // Guards the guard: if the URL cap and the comparison constant drift apart,
    // `truncated` reads false on exactly the requests that WERE truncated, and
    // every assertion above still passes.
    const seen: string[] = []
    fetchImpl = (url: string) => {
      seen.push(url)
      return router({ listings: [] })(url)
    }
    await (await loadGET())()

    const listingsUrl = seen.find((u) => u.includes("/listings/collection/"))
    expect(listingsUrl).toBeDefined()
    expect(listingsUrl).toContain("limit=50")
  })
})

describe("GET /api/panini/listings — the 502 does not publish upstream text", () => {
  it("omits the thrown message from the body", async () => {
    fetchImpl = router({ listingsStatus: 503 })
    const res = await (await loadGET())()
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.error).toBe("Failed to fetch listings")
    // The old field, and the old value.
    expect(body).not.toHaveProperty("detail")
    expect(JSON.stringify(body)).not.toContain("OpenSea listings API 503")
    // Nothing else smuggles it either.
    expect(JSON.stringify(body)).not.toMatch(/\b503\b/)
  })

  it("keeps 502 rather than flattening to 500", async () => {
    // The status is load-bearing: it says the failure is UPSTREAM, which is what
    // tells an operator whether WE broke. Routing this through `apiErrorResponse`
    // would classify it `internal` and lose that — the same 502→500 flattening
    // recorded as a regression when the leak class was swept mechanically.
    fetchImpl = router({ listingsStatus: 429 })
    const res = await (await loadGET())()
    expect(res.status).toBe(502)
  })

  it("the error response is not cacheable", async () => {
    // The success path sets `public, max-age=60`; a cacheable 502 would pin a
    // momentary upstream blip into a sustained outage.
    fetchImpl = router({ listingsStatus: 503 })
    const res = await (await loadGET())()
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("neither /api/panini route reintroduces the sibling-key leak", () => {
    // A SOURCE assertion, because no type forbids this: a string in a response
    // body type-checks perfectly, so `tsc` can never catch the regression. Both
    // routes are checked together — they had the identical defect, and a fix that
    // lands on one is exactly how the other survives.
    for (const route of ["listings", "market-stats"]) {
      const src = readFileSync(
        join(process.cwd(), "app", "api", "panini", route, "route.ts"),
        "utf8",
      )
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n")

      expect(src, `${route} must not publish a caught message`).not.toMatch(
        /\b(detail|details|reason|hint)\s*:\s*(?:message|msg|err|e)\b/,
      )
      expect(src, `${route} must not inline-ternary a caught message into the body`).not.toMatch(
        /\b(detail|details|reason|hint)\s*:\s*[A-Za-z_$][\w$]*\s+instanceof\s+Error\s*\?/,
      )
    }
  })
})

// ── 3. a missing key was reported as an upstream outage ─────────────────────
// Both /api/panini routes read `process.env.OPENSEA_API_KEY ?? ""` — a SOFT
// failure. OpenSea API v2 rejects an unauthenticated request, so an unset key
// 401s every call, lands in the same catch as a real outage, and returns the
// same `upstream_unavailable` 502. Confirmed 2026-09-02 with Trevor: the key is
// NOT set in Vercel, so this is the live behaviour, not a hypothetical.
//
// ⚠ The 502 is load-bearing precisely because it claims the failure is UPSTREAM
// (see the test above). That makes the misattribution worse than a generic
// error: it actively points an operator away from the one thing they can fix.
//
// ⚠ And nothing could have caught it. The route logs at `info`, which never
// reaches Vercel's runtime ERROR groups, and it sits behind the auth wall
// (`x-matched-path: /login`), so it cannot be probed from outside either. The
// misconfiguration was invisible from every instrument this project owns.
//
// The response shape stays exactly as pinned above; only the LOG gains a
// cause line, at error level, which self-extinguishes once the secret is set.
describe("GET /api/panini/listings — a missing key is ours, not OpenSea's", () => {
  const KEY = "OPENSEA_API_KEY"
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env[KEY]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  })

  it("names the unset key at error level when the call fails", async () => {
    delete process.env[KEY]
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    fetchImpl = router({ listingsStatus: 401 })

    const res = await (await loadGET())()
    expect(res.status).toBe(502)

    const said = spy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(said).toContain(KEY)
    expect(said).toMatch(/not an OpenSea outage/)
    spy.mockRestore()
  })

  it("stays silent about the key when one is configured", async () => {
    // The whole point is that it self-extinguishes. A guard that keeps shouting
    // after the fix is a guard operators learn to ignore.
    process.env[KEY] = "a-configured-key"
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    fetchImpl = router({ listingsStatus: 503 })

    const res = await (await loadGET())()
    expect(res.status).toBe(502)

    const said = spy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(said).not.toContain(KEY)
    spy.mockRestore()
  })

  it("both /api/panini routes carry the attribution guard", () => {
    // A SOURCE assertion for the same reason as the sibling-key check above:
    // the two routes had the identical defect, and a fix that lands on only one
    // is exactly how the other survives.
    for (const route of ["listings", "market-stats"]) {
      const src = readFileSync(
        join(process.cwd(), "app", "api", "panini", route, "route.ts"),
        "utf8",
      )
      expect(src, `${route} must distinguish an unset key from an outage`).toMatch(
        /if\s*\(\s*!apiKey\s*\)\s*\{[\s\S]{0,400}?console\.error/,
      )
    }
  })
})
