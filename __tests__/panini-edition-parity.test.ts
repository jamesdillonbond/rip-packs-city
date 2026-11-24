import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { paniniCardNumber, paniniParallelFamily, paniniPrintingLadder, fetchPaniniPrintings, type PaniniPrintingRow } from "@/lib/panini/edition-printings"
import { paniniInsightChips, fetchPaniniChipFacts } from "@/lib/panini/edition-insight-chips"

// 2026-11-23 Panini parity pass: the edition page's Parallel Printings ladder and Featured in Insights chips.
// Rows below are real panini_editions rows read 11-23 (Damian Lillard, products 1587 and 1602; Lionel Messi 2332).

const r = (external_id: string, set_name: string, mint_cap: number): PaniniPrintingRow => ({ external_id, set_name, mint_cap, thumbnail_url: null })

const lillard1587 = [
  r("packcard-1587_290604_7623942_116", "BC 2021-22 Prizm Base", 1000),
  r("packcard-1587_290612_7625511_7", "BC 2021-22 Prizm Prizmatic", 500),
  r("packcard-1587_305574_7860243_116", "BC 2021-22 Prizm Base Prizms Blue Wave", 499),
  r("packcard-1587_290605_7861893_116", "BC 2021-22 Prizm Base Prizms Silver", 149),
  r("packcard-1587_290607_7860573_116", "BC 2021-22 Prizm Base Prizms Gold", 10),
  r("packcard-1587_320741_8241911_116", "BC 2021-22 Prizm Base Prizms White Sparkle", 8),
]
const lillard1602 = [
  r("packcard-1602_292173_7662075_118", "Base", 1699),
  r("packcard-1602_292199_8000444_118", "Base Holo", 99),
  r("packcard-1602_292182_8001044_118", "Base Blue", 59),
  r("packcard-1602_292266_7657897_9", "Elite Dominators", 99),
  r("packcard-1602_292272_8003724_9", "Elite Dominators Holo", 49),
  r("packcard-1602_292332_7657952_9", "Raining 3s", 99),
]
const messi2332 = [
  r("packcard-2332_1_1_10", "Base Prizms Silver", 259),
  r("packcard-2332_2_2_10", "Base Prizms Gold", 10),
  r("packcard-2332_3_3_10", "Base Preferred Prizms Genesis", 34),
  r("packcard-2332_4_4_10", "National Landmarks", 49),
  r("packcard-2332_5_5_10", "National Landmarks Prizms Gold", 10),
  r("packcard-2332_6_6_10", "National Pride", 25),
  r("packcard-2332_7_7_10", "Color Blast", 25),
]

describe("paniniCardNumber", () => {
  it("reads the last segment of a packcard key, and nothing else", () => {
    expect(paniniCardNumber("packcard-1587_290607_7860573_116")).toBe("116")
    expect(paniniCardNumber("packcard-1587_290607")).toBeNull()
    expect(paniniCardNumber("A.0x1234.5")).toBeNull()
  })
})

describe("paniniParallelFamily", () => {
  it("splits on Prizms / Preferred Prizms / Choice Prizms", () => {
    const none = new Set<string>()
    expect(paniniParallelFamily("BC 2021-22 Prizm Base Prizms Gold", none)).toBe("BC 2021-22 Prizm Base")
    expect(paniniParallelFamily("Base Preferred Prizms Genesis", none)).toBe("Base")
    expect(paniniParallelFamily("Base Choice Prizms Zebra", none)).toBe("Base")
  })
  it("folds '<card> <colour>' only into a sibling named exactly '<card>'", () => {
    expect(paniniParallelFamily("Base Holo", new Set(["Base", "Base Holo"]))).toBe("Base")
    expect(paniniParallelFamily("National Pride", new Set(["National Landmarks", "National Pride"]))).toBe("National Pride")
  })
})

describe("paniniPrintingLadder", () => {
  it("lists every printing of the card, most copies first, the base keeping its own name", () => {
    const l = paniniPrintingLadder("packcard-1587_290607_7860573_116", lillard1587)
    expect(l.map((p) => p.label)).toEqual(["BC 2021-22 Prizm Base", "Prizms Blue Wave", "Prizms Silver", "Prizms Gold", "Prizms White Sparkle"])
    expect(l.find((p) => p.isSelf)?.label).toBe("Prizms Gold")
    // A different card number in the same product is not a printing.
    expect(l.some((p) => p.setName === "BC 2021-22 Prizm Prizmatic")).toBe(false)
  })
  it("never joins two different cards that share a number (Raining 3s #9 ≠ Elite Dominators #9)", () => {
    expect(paniniPrintingLadder("packcard-1602_292332_7657952_9", lillard1602)).toEqual([])
    const ed = paniniPrintingLadder("packcard-1602_292272_8003724_9", lillard1602)
    expect(ed.map((p) => p.setName)).toEqual(["Elite Dominators", "Elite Dominators Holo"])
    expect(paniniPrintingLadder("packcard-1602_292182_8001044_118", lillard1602).map((p) => p.label)).toEqual(["Base", "Holo", "Blue"])
  })
  it("keeps inserts out of the base ladder, and inserts with their own parallels", () => {
    const base = paniniPrintingLadder("packcard-2332_1_1_10", messi2332)
    expect(base.map((p) => p.setName).sort()).toEqual(["Base Preferred Prizms Genesis", "Base Prizms Gold", "Base Prizms Silver"])
    expect(paniniPrintingLadder("packcard-2332_4_4_10", messi2332).map((p) => p.setName)).toEqual(["National Landmarks", "National Landmarks Prizms Gold"])
    expect(paniniPrintingLadder("packcard-2332_7_7_10", messi2332)).toEqual([])
  })
})

/** A thenable query stub: every builder method returns itself; awaiting it yields `res`. */
function q(res: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b
  b.then = (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok)
  return b
}

describe("fetchPaniniPrintings", () => {
  it("a failed sibling read is ok:false (renders nothing), never a one-card ladder", async () => {
    let n = 0
    const db = { from: () => (n++ === 0 ? q({ data: [{ product_set_id: 1587, player_name: "Damian Lillard" }], error: null }) : q({ data: null, error: { message: "timeout" } })) }
    expect(await fetchPaniniPrintings("packcard-1587_290607_7860573_116", db)).toEqual({ ok: false, printings: [] })
  })
  it("a failed FMV read keeps the ladder with no prices — never $0", async () => {
    const tables: Record<string, { data: unknown; error: unknown }> = {
      panini_editions: { data: [{ product_set_id: 1587, player_name: "Damian Lillard" }], error: null },
      editions: { data: lillard1587.map((x, i) => ({ id: `e${i}`, external_id: x.external_id })), error: null },
      edition_fmv_current: { data: null, error: { message: "x" } },
    }
    let pe = 0
    const db = { from: (t: string) => (t === "panini_editions" ? q(pe++ === 0 ? tables.panini_editions : { data: lillard1587, error: null }) : q(tables[t])) }
    const res = await fetchPaniniPrintings("packcard-1587_290607_7860573_116", db)
    expect(res.ok).toBe(true)
    expect(res.printings).toHaveLength(5)
    expect(res.printings.every((p) => p.fmvUsd === null)).toBe(true)
  })
  it("never renders panini_editions' RELATIVE art path (404 on the page); uses the shared row's absolute URL", async () => {
    const rel = lillard1587.map((x) => ({ ...x, thumbnail_url: "pack/68/thumbnail/116A.png" }))
    let pe = 0
    const db = {
      from: (t: string) => {
        if (t === "panini_editions") return q(pe++ === 0 ? { data: [{ product_set_id: 1587, player_name: "Damian Lillard" }], error: null } : { data: rel, error: null })
        if (t === "editions") return q({ data: rel.map((x, i) => ({ id: `e${i}`, external_id: x.external_id, thumbnail_url: i === 0 ? "https://assets.paniniamerica.net/catalog/product/pack/68/thumbnail/116A.png" : null })), error: null })
        return q({ data: [], error: null })
      },
    }
    const res = await fetchPaniniPrintings("packcard-1587_290607_7860573_116", db)
    expect(res.printings.find((p) => p.externalId === lillard1587[0].external_id)?.thumbnailUrl).toMatch(/^https:\/\//)
    expect(res.printings.every((p) => p.thumbnailUrl === null || /^https:\/\//.test(p.thumbnailUrl))).toBe(true)
  })
})

describe("paniniInsightChips", () => {
  it("earns no chip from nothing — a failed read is not a fact", () => {
    expect(paniniInsightChips({ dealPct: null, stillInPacks: null, floorChangePct: null, bidPctOfAsk: null })).toEqual([])
  })
  it("states each fact and links its board", () => {
    const c = paniniInsightChips({ dealPct: 31.4, stillInPacks: 12, floorChangePct: -22.2, bidPctOfAsk: 64 })
    expect(c.map((x) => x.href)).toEqual(["/insights/deals", "/insights/panini-squeeze", "/insights/panini-squeeze?tab=movers", "/insights/panini-squeeze?tab=spread"])
    expect(c[1].label).toContain("At least 12 still sealed")
    expect(c[2].label).toBe("Floor down 22% in 7 days →")
  })
  it("a small move is no chip; a huge rise reads as a multiple, not +499,900 %", () => {
    expect(paniniInsightChips({ dealPct: null, stillInPacks: 0, floorChangePct: 4, bidPctOfAsk: null })).toEqual([])
    expect(paniniInsightChips({ dealPct: null, stillInPacks: null, floorChangePct: 499900, bidPctOfAsk: null })[0].label).toBe("Floor 5,000× in 7 days →")
  })
})

describe("fetchPaniniChipFacts", () => {
  it("drops a floor move whose 7-day window is incomplete, and a failed read", async () => {
    const db = {
      from: (t: string) => {
        if (t === "mv_panini_floor_movers") return q({ data: [{ change_pct: 50, window_complete: false }], error: null })
        if (t === "mv_panini_offer_spread") return q({ data: null, error: { message: "boom" } })
        if (t === "panini_squeeze_board") return q({ data: [{ still_in_packs: 7 }], error: null })
        return q({ data: [], error: null })
      },
    }
    expect(await fetchPaniniChipFacts("packcard-2332_1_1_10", db)).toEqual({ dealPct: null, stillInPacks: 7, floorChangePct: null, bidPctOfAsk: null })
  })
})

describe("wiring", () => {
  const root = process.cwd()
  it("the edition page renders both Panini sections only on Panini", () => {
    const page = readFileSync(join(root, "app/(collections)/[collection]/edition/[slug]/page.tsx"), "utf8")
    expect(page).toMatch(/isPanini && detail\.external_id && \(\s*<Suspense fallback=\{null\}>\s*<PaniniPrintingsSection/)
    expect(page).toMatch(/isPanini && detail\.external_id && \(\s*<Suspense fallback=\{null\}>\s*<PaniniInsightChips/)
  })
  it("the Panini boards honour the ?tab= deep links the chips use", () => {
    const tabs = readFileSync(join(root, "app/insights/panini-squeeze/PaniniBoardsTabs.tsx"), "utf8")
    expect(tabs).toContain(`new URLSearchParams(window.location.search).get("tab")`)
    expect(tabs).toContain("useSyncExternalStore(noopSubscribe, readLinkedTab")
    expect(tabs).toMatch(/k: "movers"/)
    expect(tabs).toMatch(/k: "spread"/)
  })
})
