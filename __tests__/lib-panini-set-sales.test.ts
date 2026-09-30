import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Panini set-page sales (2026-09-30): panini_set_sales over panini_sales. Stated as the ABSENCE
 * of the false claims — a failed or malformed read is never "no sales", a row without a price is
 * never $0 — each with a control.
 */

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { parsePaniniSetSales, fetchPaniniSetSales } from "@/lib/panini/set-sales"

// Live shape, measured 2026-09-30 on "Base Prizms Silver" (trimmed).
const LIVE = {
  top: [{ sku: "packcard-2332_486967_12675075_10__10_259", sold_at: "2026-09-12T00:13:01+00:00", set_name: "Base Prizms Silver", amount_usd: 6000, player_name: "Lionel Messi", edition_external_id: "packcard-2332_486967_12675075_10" }],
  recent: [{ sku: "packcard-2120_413399_11204852_172__27_424", sold_at: "2026-09-29T05:33:01+00:00", set_name: "Base Prizms Silver", amount_usd: 69, player_name: "Victor Wembanyama", edition_external_id: "packcard-2120_413399_11204852_172" }],
  editions: 612,
  window_30d: { sales: 3563, median_usd: 2.0, volume_usd: 20995.0, editions_traded: 403 },
  editions_read: 53,
}

function rpcDb(res: { data: unknown; error: unknown } | Error) {
  const calls: { fn: string; args: unknown }[] = []
  return {
    calls,
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args })
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res)
    },
  }
}

describe("parsePaniniSetSales", () => {
  it("parses the live shape, with serial and print run from the sku", () => {
    const p = parsePaniniSetSales(LIVE)!
    expect(p.editions).toBe(612)
    expect(p.editionsRead).toBe(53)
    expect(p.window30d).toEqual({ sales: 3563, volumeUsd: 20995, medianUsd: 2, editionsTraded: 403 })
    expect(p.top[0]).toMatchObject({ editionKey: "packcard-2332_486967_12675075_10", playerName: "Lionel Messi", serial: 10, mintCap: 259, amountUsd: 6000 })
  })

  it("a payload missing its counts, window or lists is rejected (null), never read as zero sales", () => {
    const without = (k: string) => { const o: Record<string, unknown> = { ...LIVE }; delete o[k]; return o }
    for (const bad of [null, {}, without("editions"), without("editions_read"), without("window_30d"), without("top"), without("recent"),
      { ...LIVE, window_30d: { ...LIVE.window_30d, sales: null } }]) {
      expect(parsePaniniSetSales(bad)).toBeNull()
    }
  })

  it("a row missing its price, date or edition is dropped — never shown as $0", () => {
    const p = parsePaniniSetSales({ ...LIVE, top: [...LIVE.top, { ...LIVE.top[0], amount_usd: null }, { ...LIVE.top[0], sold_at: null }, { ...LIVE.top[0], edition_external_id: "" }] })!
    expect(p.top).toHaveLength(1)
    expect(p.top.every((s) => s.amountUsd > 0)).toBe(true)
  })

  it("control: a genuinely empty set parses as empty lists, distinct from a failed read", () => {
    const p = parsePaniniSetSales({ ...LIVE, top: [], recent: [], window_30d: { sales: 0, volume_usd: 0, median_usd: null, editions_traded: 0 } })
    expect(p).not.toBeNull()
    expect(p!.top).toEqual([])
    expect(p!.window30d.medianUsd).toBeNull()
  })
})

describe("fetchPaniniSetSales", () => {
  it("asks for the set's names and parses the answer", async () => {
    const db = rpcDb({ data: LIVE, error: null })
    const out = await fetchPaniniSetSales(["Base Prizms Silver"], db)
    expect(db.calls[0]).toEqual({ fn: "panini_set_sales", args: { p_set_names: ["Base Prizms Silver"], p_limit: 10 } })
    expect(out?.editions).toBe(612)
  })

  it("an RPC error or a thrown read is null — never 'no sales'", async () => {
    expect(await fetchPaniniSetSales(["Base"], rpcDb({ data: null, error: { message: "57014" } }))).toBeNull()
    expect(await fetchPaniniSetSales(["Base"], rpcDb(new Error("fetch failed")))).toBeNull()
  })
})

describe("the set page's Panini sales section (source facts)", () => {
  const set = readFileSync(join(process.cwd(), "app/(collections)/[collection]/set/[slug]/page.tsx"), "utf8")
  it("Panini renders its own Sales section; the shared activity feed stays off for Panini", () => {
    expect(set).toContain("const paniniSalesP: Promise<PaniniSetSales | null> | null = isPanini ? fetchPaniniSetSales(setNames) : null")
    expect(set).toMatch(/\{isPanini && \(\s*<Section title="Sales">\s*<PaniniSetSalesBody collection=\{collection\} res=\{paniniSales\} \/>/)
    expect(set).toContain("const wantsActivity = !isPinnacleUrlSlug(collection) && !isPanini")
  })
})
