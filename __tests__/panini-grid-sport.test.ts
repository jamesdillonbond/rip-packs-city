import { describe, it, expect, afterEach } from "vitest"
import { appliedSportOf, sameSport, sportParamOf, PANINI_FILTER_CACHE, clearFilterCacheInPage } from "../scripts/panini-grid-sport.mjs"

// The REAL shape, copied from the residential runner's panini-ops-capture.jsonl (2026-11-22 2:14 PM
// PT): applied_filters lives in the GraphQL QUERY TEXT and `variables` is empty.
const realBody = (af: string) =>
  JSON.stringify({
    operationName: "products",
    variables: {},
    query: `query products {\n  products(\n    attribute_code: []\n    category_id: -2\n    current_page: 1\n    page_size: 30\n    applied_filters: "${af}"\n    is_store: true\n  ) {\n    items { psku }\n  }\n}`,
  })

describe("appliedSportOf — the sport a Panini grid request actually applied (2026-11-22)", () => {
  it("reads the sport out of applied_filters in the QUERY TEXT, URL-decoded", () => {
    expect(appliedSportOf(realBody("marketplace-nfts?sport=Soccer&p=4"))).toBe("Soccer")
    expect(appliedSportOf(realBody("marketplace-nfts?sport=Womens%20Soccer&p=1"))).toBe("Womens Soccer")
    expect(appliedSportOf(realBody("marketplace-nfts?p=3&sport=Womens+Basketball"))).toBe("Womens Basketball")
  })

  it("also reads a JSON-field applied_filters, should Panini move it into variables", () => {
    const body = JSON.stringify({ operationName: "products", variables: { applied_filters: "marketplace-nfts?sport=WWE&p=1" }, query: "query products { x }" })
    expect(appliedSportOf(body)).toBe("WWE")
  })

  it("names the 2 PM PT mismatch: the 'Womens Soccer' pass whose requests applied Basketball", () => {
    const applied = appliedSportOf(realBody("marketplace-nfts?sport=Basketball&p=1"))
    expect(applied).toBe("Basketball")
    expect(sameSport(applied, "Womens Soccer")).toBe(false)
  })

  it("returns null when the body names no sport — the loop's sport is then the fallback", () => {
    expect(appliedSportOf(realBody("marketplace-nfts?p=1"))).toBeNull()
    expect(appliedSportOf(JSON.stringify({ variables: {}, query: "query filters { x }" }))).toBeNull()
    expect(appliedSportOf("not json")).toBeNull()
    expect(appliedSportOf("")).toBeNull()
  })

  it("compares sports ignoring case and spacing, never matching an empty value", () => {
    expect(sameSport("WOMENS SOCCER", "Womens  Soccer")).toBe(true)
    expect(sameSport("Soccer", "Womens Soccer")).toBe(false)
    expect(sameSport("", "")).toBe(false)
    expect(sameSport(null, "Soccer")).toBe(false)
  })
})

describe("sportParamOf — where the page actually landed", () => {
  it("reads the sport of a page URL, so a redirect to Basketball is visible", () => {
    expect(sportParamOf("https://nft.paniniamerica.net/marketplace/nfts.html?sport=Womens%20Soccer")).toBe("Womens Soccer")
    expect(sportParamOf("https://nft.paniniamerica.net/marketplace/nfts.html?sport=Basketball#x")).toBe("Basketball")
    expect(sportParamOf("https://nft.paniniamerica.net/marketplace/nfts.html")).toBeNull()
    expect(sportParamOf(undefined)).toBeNull()
  })
})

describe("clearFilterCacheInPage — clears ONLY Panini's persisted filter metadata", () => {
  const g = globalThis as Record<string, unknown>
  const saved = { localStorage: g.localStorage, indexedDB: g.indexedDB }
  afterEach(() => { g.localStorage = saved.localStorage; g.indexedDB = saved.indexedDB })

  function fakeBrowser(databases: string[] | null) {
    const ls = new Map<string, string>([
      ["filter_timestamp", "1"], ["pack_filter_timestamp", "2"], ["sig-ses", "keep"], ["@appkit/connection_status", "keep"],
    ])
    g.localStorage = {
      getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
      removeItem: (k: string) => { ls.delete(k) },
    }
    const idb = new Map<string, string>([["reduxPersist:Filters", "stale"], ["persist:root", "keep"], ["reduxPersist:App", "keep"]])
    const opened: string[] = []
    g.indexedDB = {
      ...(databases ? { databases: async () => databases.map((name) => ({ name })) } : {}),
      open: (name: string) => {
        opened.push(name)
        const req: Record<string, unknown> = {}
        queueMicrotask(() => {
          const tx: Record<string, unknown> = {
            objectStore: () => ({ delete: (k: string) => { idb.delete(k) } }),
          }
          req.result = {
            objectStoreNames: ["keyvaluepairs"],
            transaction: () => { queueMicrotask(() => (tx.oncomplete as () => void)?.()); return tx },
            close: () => {},
          }
          ;(req.onsuccess as () => void)?.()
        })
        return req
      },
    }
    return { ls, idb, opened }
  }

  it("removes the two timestamps and reduxPersist:Filters, and nothing else", async () => {
    const b = fakeBrowser(["localforage", "keyval-store"])
    const out = await clearFilterCacheInPage(PANINI_FILTER_CACHE)
    expect(out.error).toBeNull()
    expect([...b.ls.keys()].sort()).toEqual(["@appkit/connection_status", "sig-ses"])
    expect([...b.idb.keys()].sort()).toEqual(["persist:root", "reduxPersist:App"])
  })

  it("never creates the localforage database when it is absent", async () => {
    const b = fakeBrowser(["keyval-store"])
    await clearFilterCacheInPage(PANINI_FILTER_CACHE)
    expect(b.opened).toEqual([])
    expect(b.idb.has("reduxPersist:Filters")).toBe(true)
  })
})
