import { describe, it, expect } from "vitest"
import { fetchHubRows, fetchLinkRows } from "@/lib/entity/popular-on-collection-fetchers"

// Drives the two reads behind the /overview internal-link block. They lived
// inside an async SERVER component until 2026-08-17, which put them outside the
// server-page ratchet (it walked `page.tsx` only) and outside any drivable
// gate — jsdom cannot render an async server component, so the file's ~29%
// component-gate number was nominal, not real coverage.
//
// ⚠ THE CONTRACT IS THAT "EMPTY" AND "FAILED" STAY SEPARABLE. This block cannot
// lie in words — on failure the section returns null and disappears — so the
// defect was never a false sentence. It was that a statement timeout became an
// empty list with NO TRACE, silently deleting the crawl path the component
// exists to provide from a page that still returns 200. `ok` is what makes that
// falsifiable, and these cases exist to keep it honest.

const okRes = (data: unknown) => ({ data, error: null })
const errRes = (message: string) => ({ data: null, error: { message } })

/** Chainable stub: every builder method returns `this`, awaiting yields `res`. */
function client(res: Record<string, unknown>, onTable?: (t: string) => void) {
  return {
    from(table: string) {
      onTable?.(table)
      const r = res[table] ?? okRes([])
      const builder: Record<string, unknown> = {}
      for (const m of ["select", "eq", "order", "limit", "not", "or"]) {
        builder[m] = () => builder
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(r).then(resolve)
      return builder
    },
  }
}
const throwingClient = (message: string) => ({
  from() {
    throw new Error(message)
  },
})

describe("fetchHubRows", () => {
  it("returns rows with ok:true on a successful read", async () => {
    const r = await fetchHubRows(
      "nba-top-shot",
      client({
        editions: okRes([{ set_name: "Base Set", player_name: "Dame", team_name: "Blazers" }]),
        collection_series: okRes([{ display_label: "Series 4" }]),
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.data.editions).toHaveLength(1)
    expect(r.data.series).toHaveLength(1)
  })

  it("a genuinely empty catalogue is ok:true — NOT an outage", async () => {
    // The half that makes `ok` mean something. Without it, a fetcher could pass
    // the failure cases by reporting ok:false for everything.
    const r = await fetchHubRows("nba-top-shot", client({ editions: okRes([]), collection_series: okRes([]) }))
    expect(r).toEqual({ data: { editions: [], series: [] }, ok: true })
  })

  it("a RETURNED error is ok:false — the shape a try/catch cannot see", async () => {
    const r = await fetchHubRows(
      "nba-top-shot",
      client({ editions: errRes("canceling statement due to statement timeout"), collection_series: okRes([]) }),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("statement timeout")
    expect(r.data).toEqual({ editions: [], series: [] })
  })

  it("EITHER query failing makes the whole result ok:false", async () => {
    // ⚠ A partial hub set used to render as a complete one. The series read
    // failing alone is the case a single-error check would miss.
    const r = await fetchHubRows(
      "nba-top-shot",
      client({ editions: okRes([{ set_name: "Base Set" }]), collection_series: errRes("series read died") }),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("series read died")
  })

  it("a THROW is ok:false, not an empty catalogue", async () => {
    const r = await fetchHubRows("nba-top-shot", throwingClient("socket hang up") as never)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("socket hang up")
  })

  it("an unknown collection is ok:TRUE — absence of a uuid is not an outage", async () => {
    const r = await fetchHubRows("not-a-collection", client({}))
    expect(r).toEqual({ data: { editions: [], series: [] }, ok: true })
  })
})

describe("fetchLinkRows", () => {
  it("reads editions for a standard collection and pinnacle_editions for Pinnacle", async () => {
    const standard: string[] = []
    await fetchLinkRows("nba-top-shot", client({ editions: okRes([]) }, (t) => standard.push(t)))
    expect(standard).toEqual(["editions"])

    const pinnacle: string[] = []
    await fetchLinkRows("disney-pinnacle", client({ pinnacle_editions: okRes([]) }, (t) => pinnacle.push(t)))
    expect(pinnacle).toEqual(["pinnacle_editions"])
  })

  it("a genuinely empty result is ok:true", async () => {
    expect(await fetchLinkRows("nba-top-shot", client({ editions: okRes([]) }))).toEqual({ data: [], ok: true })
  })

  it("a RETURNED error is ok:false on both the standard and the Pinnacle path", async () => {
    const std = await fetchLinkRows("nba-top-shot", client({ editions: errRes("boom") }))
    expect(std).toEqual({ data: [], ok: false, reason: "boom" })
    const pin = await fetchLinkRows("disney-pinnacle", client({ pinnacle_editions: errRes("pin boom") }))
    expect(pin).toEqual({ data: [], ok: false, reason: "pin boom" })
  })

  it("a THROW is ok:false", async () => {
    const r = await fetchLinkRows("nba-top-shot", throwingClient("hang up") as never)
    expect(r.ok).toBe(false)
  })

  it("never reports ok:false together with rows — that pair is meaningless", async () => {
    // Stated as the forbidden combination so it survives a refactor of the
    // branches: a failed read must not also hand back data to render.
    for (const c of [
      client({ editions: errRes("x") }),
      client({ editions: okRes([{ external_id: "1" }]) }),
      throwingClient("y") as never,
    ]) {
      const r = await fetchLinkRows("nba-top-shot", c)
      expect(!r.ok && r.data.length > 0, JSON.stringify(r)).toBe(false)
    }
  })
})
