import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * #204 design half (2026-10-21): a Panini set page is ONE product's set (a `sets` row), not a set
 * NAME several products share. "Base Prizms Blue" is a set in the 2026 World Cup catalog (499
 * editions), 2022-23 Prizm Basketball (97) and the 2022 World Cup (6); the old page listed LeBron
 * James in a World Cup set. The falsifier #204 named: a product page whose editions, sales, tier
 * mix and totals all carry ONE editions.set_id. The DB half (get_set_detail / get_set_editions
 * resolution, canonical slugs) is pinned in supabase/tests/get_set_detail.sql; this file pins the
 * readers that must FOLLOW the set id, and the links into the product pages.
 */

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { paniniProductSetSlug } from "@/lib/panini/set-page-slug"
import { fetchPaniniProductSetSales } from "@/lib/panini/set-sales"
import { fetchPaniniEditionSetSlug } from "@/lib/panini/edition-set-slug"
import { fetchFullTierMix } from "@/lib/set-detail/tier-mix"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function rpcDb(result: { data: unknown; error: { message: string } | null } | Error) {
  const calls: Array<{ fn: string; args: unknown }> = []
  return {
    calls,
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args })
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    },
  }
}

describe("paniniProductSetSlug — the bridge's own sets.external_id key, minus 'panini-'", () => {
  it("the 2026 World Cup catalog (2332) has no product prefix; every other product does", () => {
    expect(paniniProductSetSlug(2332, "Base Prizms Blue")).toBe("base-prizms-blue")
    expect(paniniProductSetSlug(1819, "Base Prizms Blue")).toBe("p1819-base-prizms-blue")
  })
  it("trims edge dashes as the bridge's btrim does (the 8 live keys whose name ends in punctuation)", () => {
    // Live: panini-p2237-ka-vroom ("Ka-Vroom!"), panini-p1814-t-minus-3-2-1 ("T-Minus 3...2...1...").
    expect(paniniProductSetSlug(2237, "Ka-Vroom!")).toBe("p2237-ka-vroom")
    expect(paniniProductSetSlug(1814, "T-Minus 3...2...1...")).toBe("p1814-t-minus-3-2-1")
    expect(paniniProductSetSlug(1661, "  Lumber Inc. ")).toBe("p1661-lumber-inc")
  })
  it("no product or no name is no link — never a guessed URL", () => {
    expect(paniniProductSetSlug(null, "Base")).toBeNull()
    expect(paniniProductSetSlug(0, "Base")).toBeNull()
    expect(paniniProductSetSlug(1819, "   ")).toBeNull()
    expect(paniniProductSetSlug(1819, "!!!")).toBeNull()
  })
})

describe("fetchPaniniProductSetSales — one sets row's sales", () => {
  it("asks by set id, not by set name", async () => {
    const db = rpcDb({ data: { top: [], recent: [], editions: 97, editions_read: 90, window_30d: { sales: 22, editions_traded: 16 } }, error: null })
    const out = await fetchPaniniProductSetSales("set-uuid", db)
    expect(db.calls[0]).toEqual({ fn: "panini_product_set_sales", args: { p_set_id: "set-uuid", p_limit: 10 } })
    expect(out?.editions).toBe(97)
  })
  it("a failed read is null — never 'no sales'", async () => {
    expect(await fetchPaniniProductSetSales("x", rpcDb({ data: null, error: { message: "57014" } }))).toBeNull()
    expect(await fetchPaniniProductSetSales("x", rpcDb(new Error("fetch failed")))).toBeNull()
  })
})

describe("fetchPaniniEditionSetSlug — the edition's OWN product's set page", () => {
  it("returns the RPC's canonical slug", async () => {
    const db = rpcDb({ data: "p1819-base-prizms-blue", error: null })
    expect(await fetchPaniniEditionSetSlug("packcard-1819_1", db)).toEqual({ slug: "p1819-base-prizms-blue", ok: true })
    expect(db.calls[0]).toEqual({ fn: "panini_edition_set_slug", args: { p_edition_external_id: "packcard-1819_1" } })
  })
  it("an error, a throw or a malformed answer is ok:false — the page then links nothing", async () => {
    expect(await fetchPaniniEditionSetSlug("e", rpcDb({ data: null, error: { message: "boom" } }))).toEqual({ slug: null, ok: false })
    expect(await fetchPaniniEditionSetSlug("e", rpcDb(new Error("fetch failed")))).toEqual({ slug: null, ok: false })
    expect(await fetchPaniniEditionSetSlug("e", rpcDb({ data: { slug: "x" }, error: null }))).toEqual({ slug: null, ok: false })
  })
})

describe("fetchFullTierMix — a product page's bar counts ONE set id", () => {
  function db() {
    const eqs: Array<[string, unknown]> = []
    const b: Record<string, unknown> = {}
    for (const m of ["select", "in", "not", "order"]) b[m] = () => b
    b.eq = (k: string, v: unknown) => (eqs.push([k, v]), b)
    b.range = () => Promise.resolve({ data: [{ tier: "RARE" }], error: null })
    return { eqs, db: { from: () => b } }
  }
  it("with a set id the read is filtered on it", async () => {
    const d = db()
    const r = await fetchFullTierMix("coll", ["Base Prizms Blue"], d.db, "set-uuid")
    expect(r.ok).toBe(true)
    expect(d.eqs).toContainEqual(["set_id", "set-uuid"])
  })
  it("CONTROL: without one it is the name-keyed read it always was", async () => {
    const d = db()
    await fetchFullTierMix("coll", ["Base Prizms Blue"], d.db)
    expect(d.eqs.map(([k]) => k)).toEqual(["collection_id"])
  })
})

describe("the readers follow the set id (source facts)", () => {
  const page = read("app/(collections)/[collection]/set/[slug]/page.tsx")
  const layout = read("app/(collections)/[collection]/set/[slug]/layout.tsx")
  const edition = read("app/(collections)/[collection]/edition/[slug]/page.tsx")
  const tab = read("components/collection/PaniniSetProgress.tsx")
  it("set page: sales and tier mix take the product's set id", () => {
    expect(page).toContain("const productSetId = isPanini && detail.set_id ? detail.set_id : null")
    expect(page).toContain("(productSetId ? fetchPaniniProductSetSales(productSetId) : fetchPaniniSetSales(setNames))")
    expect(page).toContain("fetchFullTierMix(coll.id, setNames, undefined, productSetId)")
  })
  it("set page: the other products are LINKED, and the name-keyed market cap is withheld on a shared-name product page", () => {
    expect(page).toContain('data-testid="set-related-products"')
    expect(page).toContain("const showMarketCap = !(productSetId && related.length > 0)")
    expect(page).toMatch(/\{showMarketCap && \(\s*<Suspense fallback=\{null\}>\s*<MarketCapTile/)
    // The combined view's banner links each product too.
    expect(page).toMatch(/detail\.underlying_sets\.map\(\(u, i\) => \([\s\S]{0,200}<ProductLink collection=\{collection\} product=\{u\} \/>/)
  })
  it("layout: a non-canonical product key 308s to get_set_detail's canonical_slug, outside any try", () => {
    expect(layout).toContain('if (collection === "panini-blockchain") {')
    expect(layout).toContain("permanentRedirect(`/${collection}/set/${encodeURIComponent(canonical)}`)")
    // NEXT_REDIRECT is a throw: the redirect must not sit inside the helper's try/catch.
    const helper = layout.slice(layout.indexOf("async function paniniCanonicalSetSlug"))
    expect(helper).not.toContain("permanentRedirect")
  })
  it("edition page: a Panini edition links its OWN product's set, and never falls back to the name slug", () => {
    expect(edition).toContain("const setSlugForLink = isPanini ? (paniniSetSlug.ok ? paniniSetSlug.slug : null) : detail.set_slug")
    expect(edition).toContain("set_slug: setSlugForLink")
  })
  it("Sets tab: each row links its product's set page", () => {
    expect(tab).toContain("<SetNameCell productSetId={data.product?.setId ?? null} setName={s.setName} />")
    expect(tab).toContain("paniniProductSetSlug(productSetId, setName)")
  })
})
