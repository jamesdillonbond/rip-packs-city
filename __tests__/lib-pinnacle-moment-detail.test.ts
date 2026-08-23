import { describe, it, expect, vi, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { load, isLegacyKey, decodeId } from "@/lib/pinnacle/moment-detail"

// The read behind /pinnacle/moment/[id] — the shareable Pinnacle pin URL.
//
// ⚠ THIRTEEN QUERY SITES, SIX IN ONE Promise.all, AND NONE OF IT WAS REACHABLE
// UNTIL IT WAS EXTRACTED: it lived in a `page.tsx`, which neither coverage gate
// measures. The honesty properties below were pinned only by source greps that
// prove a string is present, never that the branch resolves the way its comment
// claims — and one of them did not.

const RENDER = "OEV1-SWHM-KYLO-S5"

interface TableScript {
  data?: unknown
  error?: { message: string } | null
  count?: number | null
}

/**
 * A supabase stub whose `from()` closes over ITS OWN table.
 *
 * ⚠ Not an optional nicety: `load` builds six chains inside one `Promise.all`,
 * so every `from()` is called synchronously before any of them settles. A stub
 * that records the table in a shared `let` resolves all six as whatever table
 * came LAST — and the tests then fail against correct code, which reads like a
 * bug in the route.
 */
function makeDb(tables: Record<string, TableScript | TableScript[]>, rpc: TableScript = {}) {
  const seq: Record<string, number> = {}
  const seen: string[] = []
  const take = (t: string): TableScript => {
    const f = tables[t]
    if (Array.isArray(f)) {
      const i = seq[t] ?? 0
      seq[t] = i + 1
      return f[Math.min(i, f.length - 1)] ?? {}
    }
    return f ?? {}
  }
  const build = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "in", "not", "order", "limit"]) b[m] = () => b
    const settle = () => {
      const r = take(table)
      return {
        data: r.data ?? null,
        error: r.error ?? null,
        count: r.count ?? null,
      }
    }
    b.maybeSingle = async () => settle()
    b.single = async () => settle()
    b.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(settle()).then(onF, onR)
    return b
  }
  return {
    seen,
    db: {
      from: (table: string) => {
        seen.push(table)
        return build(table)
      },
      rpc: async () => ({ data: rpc.data ?? null, error: rpc.error ?? null }),
    },
  }
}

const CATALOG_ROW = {
  render_id: RENDER,
  edition_id: "2156",
  character_name: "Kylo Ren",
  set_name: "Star Wars",
  variant: "Standard",
  total_minted: 500,
  fmv_usd: 42,
  floor_ask: 50,
}

/** The five reads beyond the catalog row, all succeeding with nothing. */
function quietTail() {
  return {
    pinnacle_sales: { data: [] },
    wallet_moments_cache: { count: 3 },
    pinnacle_scarcity_board: { data: null },
    pinnacle_fmv_history: { data: [] },
    pinnacle_serial_fmv_multipliers: { data: [] },
    wallet_usernames: { data: [] },
  }
}

describe("decodeId / isLegacyKey", () => {
  it("a render_id never contains ':' and a legacy set key always does", () => {
    // The discriminator between the two URL shapes this page serves. Getting it
    // backwards routes a real pin at the disambiguation page and vice versa.
    expect(isLegacyKey(RENDER)).toBe(false)
    expect(isLegacyKey("STAR-OEV1-SWHM:Digital Display:1")).toBe(true)
  })

  it("survives a malformed percent-escape rather than throwing", () => {
    // `id` comes straight off the URL. decodeURIComponent("%E0%A4%A") throws,
    // and an uncaught throw here is a 500 on a shareable link.
    expect(decodeId("%E0%A4%A")).toBe("%E0%A4%A")
    expect(decodeId("STAR%3ADigital%20Display%3A1")).toBe("STAR:Digital Display:1")
  })
})

describe("load — a failed read is never an absent pin", () => {
  afterEach(() => vi.restoreAllMocks())

  it("a failed CATALOG read reports ok:false, not a 404", async () => {
    // ⚠ The page answers `notFound()` on a null pin. Before `ok` existed, a
    // statement timeout told a collector who had just posted the link that
    // their pin does not exist, and handed a crawler a hard 404 for a real
    // page.
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { db } = makeDb({
      pinnacle_catalog: { error: { message: "canceling statement due to statement timeout" } },
    })
    expect(await load(RENDER, db)).toEqual({ data: null, ok: false })
  })

  it("a GENUINELY absent pin is ok:true with null data — it must still 404", async () => {
    // The mirror-image defect: if this reported ok:false, every unknown id
    // would render "unavailable" instead of not-found, and no bad URL would
    // ever 404 again.
    const { db } = makeDb({ pinnacle_catalog: { data: null }, wallet_moments_cache: { data: null } })
    expect(await load(RENDER, db)).toEqual({ data: null, ok: true })
  })

  it("a failed LEGACY-key read reports ok:false", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { db } = makeDb({ pinnacle_catalog: { error: { message: "boom" } } })
    const r = await load("STAR-OEV1-SWHM:Digital Display:1", db)
    expect(r).toEqual({ data: null, ok: false })
  })

  it("a legacy key with matches returns the disambiguation list, not one arbitrary pin", async () => {
    // The whole reason the legacy shape has its own branch: several renders
    // shared one set-level key, and silently showing one character's price is
    // the defect the disambiguation page exists to prevent.
    const renders = [
      { render_id: "A", character_name: "Kylo", fmv_usd: 90 },
      { render_id: "B", character_name: "Rey", fmv_usd: 10 },
    ]
    const { db } = makeDb({ pinnacle_catalog: { data: renders } })
    const r = await load("STAR-OEV1-SWHM:Digital Display:1", db)
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ kind: "legacy", renders })
  })

  it("a failed NUMERIC resolve is ok:false — a sentinel, not a miss", async () => {
    // ⚠ The subtlest of the three. A numeric id that maps to no render is a
    // real answer (null); a resolve we could not perform is not. Collapsing
    // them 404s every edition_id / moment-NFT link during a blip.
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { db } = makeDb({
      // catalog: miss, then the numeric resolve is attempted against it
      pinnacle_catalog: [{ data: null }, { error: { message: "boom" } }],
    })
    expect(await load("2156", db)).toEqual({ data: null, ok: false })
  })

  it("a numeric id that maps to NO render is a real miss (ok:true)", async () => {
    const { db } = makeDb({
      pinnacle_catalog: [{ data: null }, { data: null }],
      wallet_moments_cache: { data: null },
    })
    expect(await load("111050675472028", db)).toEqual({ data: null, ok: true })
  })

  it("resolves a numeric id onto its canonical render and re-reads the catalog", async () => {
    const { db, seen } = makeDb({
      pinnacle_catalog: [{ data: null }, { data: CATALOG_ROW }],
      ...quietTail(),
    })
    const r = await load("2156", db)
    expect(r.ok).toBe(true)
    expect((r.data as { ed: { render_id: string } }).ed.render_id).toBe(RENDER)
    // The edition_id space is checked before the on-chain moment id, so a
    // 3-digit id never fans out to wmc unnecessarily.
    expect(seen).not.toContain("wallet_moments_cache_unused")
  })
})

describe("load — the six tail reads", () => {
  it("a failed HOLDER COUNT carries null, NOT a manufactured zero", async () => {
    // ⚠ THE DEFECT THIS EXTRACTION FOUND. It was
    // `Number(holdersRes.count ?? 0)`. supabase-js RETURNS errors rather than
    // throwing, so a 57014 leaves `count` null and the `??` published a hard
    // **0** under "Tracked holders — in RPC wallet cache": a claim about OUR
    // OWN data manufactured from OUR OWN outage, on a page collectors share.
    const { db } = makeDb({
      pinnacle_catalog: { data: CATALOG_ROW },
      ...quietTail(),
      wallet_moments_cache: { error: { message: "canceling statement due to statement timeout" } },
    })
    const r = await load(RENDER, db)
    expect(r.ok, "one failed tail read must not 404 the pin").toBe(true)
    expect((r.data as { holders: number | null }).holders).toBeNull()
  })

  it("a genuinely-zero holder count STAYS 0 — that is an answer", async () => {
    // The other direction, and the one a blanket `null` would break: a pin
    // nobody in the wallet cache holds legitimately reads 0, and rendering
    // an em-dash there would hide a real fact.
    const { db } = makeDb({
      pinnacle_catalog: { data: CATALOG_ROW },
      ...quietTail(),
      wallet_moments_cache: { count: 0 },
    })
    expect((await load(RENDER, db)).data).toMatchObject({ holders: 0 })
  })

  it("a failed sales / history / scarcity read degrades rather than 404ing", async () => {
    // These five are DECORATION relative to the pin's identity: the page omits
    // the section or renders an em-dash, which understates — the safe
    // direction. Escalating any of them to ok:false would 404 a real pin over
    // a missing chart.
    const { db } = makeDb({
      pinnacle_catalog: { data: CATALOG_ROW },
      ...quietTail(),
      pinnacle_sales: { error: { message: "boom" } },
      pinnacle_fmv_history: { error: { message: "boom" } },
      pinnacle_scarcity_board: { error: { message: "boom" } },
    })
    const r = await load(RENDER, db)
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({
      kind: "render",
      sales: [],
      fmvHistory: [],
      variant_avg_mint: null,
      scarcity_pct: null,
    })
  })

  it("a failed USERNAME lookup leaves raw addresses rather than dropping the sales", async () => {
    // Explicitly decoration: the buyer/seller columns fall back to truncated
    // 0x… addresses. Dropping the sale rows instead would delete real market
    // history over a cosmetic lookup.
    const sales = [{ sale_price_usd: 5, sold_at: "2026-01-01", serial_number: 7, buyer_address: "0xAB", seller_address: "0xCD" }]
    const { db } = makeDb({
      pinnacle_catalog: { data: CATALOG_ROW },
      ...quietTail(),
      pinnacle_sales: { data: sales },
      wallet_usernames: { error: { message: "boom" } },
    })
    const r = await load(RENDER, db)
    expect(r.data).toMatchObject({ sales, nameByAddr: {} })
  })

  it("a failed siblings RPC becomes an empty ladder, never a crash", async () => {
    // `get_pinnacle_variant_siblings` returns null on failure, and the page
    // reads `siblings.length` unguarded.
    const { db } = makeDb(
      { pinnacle_catalog: { data: CATALOG_ROW }, ...quietTail() },
      { error: { message: "boom" } },
    )
    expect((await load(RENDER, db)).data).toMatchObject({ siblings: [] })
  })

  it("a siblings RPC that returns a single OBJECT is discarded, not spread", async () => {
    // ⚠ The case above does NOT exercise the Array.isArray guard — dropping it
    // for `?? []` passes, because a failed rpc yields null and `null ?? []` is
    // also []. The guard only earns its keep on a non-null non-array, which is
    // exactly what `.rpc()` returns if the function is ever redefined to yield
    // one row or a jsonb blob instead of a set. Without it that object reaches
    // `siblings.length` (undefined) and `siblings.map` (a TypeError) — a 500 on
    // a public page from a DB-side change no deploy accompanies.
    const { db } = makeDb(
      { pinnacle_catalog: { data: CATALOG_ROW }, ...quietTail() },
      { data: { render_id: "A", is_self: false } },
    )
    expect((await load(RENDER, db)).data).toMatchObject({ siblings: [] })
  })

  it("the holder count branches on the ERROR, not on the value", () => {
    // ⚠ A DELIBERATE SOURCE ASSERTION, because the two implementations are
    // indistinguishable in every state the client produces. supabase-js reads
    // `count` off the Content-Range header, and an error response carries none
    // — so `count == null` and `error != null` coincide today, and a fixture
    // separating them would assert a state production cannot reach (the
    // impossible-fixture trap).
    //
    // The error-branch is still the form to keep, and this is what stops a
    // future edit "simplifying" it back: the rule this repo keeps paying for is
    // CHECK THE ERROR, NEVER JUST THE VALUE. A value-branch is correct only
    // while the transport happens to null the count on failure — the same
    // reasoning that made `?? 0` look safe right up until it published a zero.
    const src = readFileSync(
      join(process.cwd(), "lib", "pinnacle", "moment-detail.ts"),
      "utf8",
    )
    expect(src).toContain("holders: holdersRes.error ? null :")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOUND — one deadline for the whole `load()`, and a hang is never a 404.
//
// ⚠ `load()` is a CHAIN, not a fan-out: catalog read → (numeric resolve, up to
// two more reads) → catalog re-read → a six-way `Promise.all` → a usernames
// read. Per-read budgets would let a saturated DB spend the budget six times
// over, so the bound would MULTIPLY the worst case it exists to cap. These
// assertions pin the shared deadline, not merely that some timeout exists.
//
// 🚨 The property that matters most is which failure a hang becomes. This module
// already separates `{ data: null, ok: true }` — an ANSWER, "no such pin", which
// the page is entitled to 404 on — from `{ data: null, ok: false }`. A read we
// could not finish must never become the first one, on a URL collectors share.
// ─────────────────────────────────────────────────────────────────────────────

/** Every table read never settles. */
function hangingDb() {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "not", "in", "order", "limit"]) b[m] = () => b
  b.maybeSingle = () => new Promise(() => {})
  b.then = () => new Promise(() => {})
  return { from: () => b, rpc: () => b }
}

/** Resolves each read after `perReadMs`, so a chain actually SPENDS the budget. */
function slowDb(perReadMs: number, script: TableScript = { data: null, error: null }) {
  const settle = () => new Promise((r) => setTimeout(() => r({ ...script }), perReadMs))
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "not", "in", "order", "limit"]) b[m] = () => b
  b.maybeSingle = () => settle()
  b.then = (onF?: (v: unknown) => unknown) => settle().then(onF)
  return { from: () => b, rpc: () => b }
}

describe("load — bounded as a whole, and a hang is not a missing pin", () => {
  it("a hung catalog read reports ok:false, never a 404", async () => {
    const res = await load(RENDER, hangingDb())

    expect(res.ok, "an overrun read must report FAILURE").toBe(false)
    expect(res.data).toBeNull()
    // ⚠ The absence of the false claim. `{ data: null, ok: true }` is the state
    // the page renders as "this pin does not exist".
    expect(res.data === null && res.ok === true).toBe(false)
  }, 25_000)

  it("a chain whose reads SPEND the budget still fails — the deadline is shared", async () => {
    // ⚠ MUTATION-CHECKED. `RENDER` is not numeric, so this is catalog-read →
    // (no resolve) → six-way bundle. At 5s a read against an 8s shared budget the
    // bundle is cut; give each read its own 8s and the whole thing completes and
    // this assertion reds — which is the property, not merely "a timeout exists".
    const res = await load(RENDER, slowDb(5_000, { data: { render_id: RENDER }, error: null }))

    expect(res.ok).toBe(false)
    expect(res.data).toBeNull()
  }, 30_000)

  it("CONTROL — a read inside the budget still resolves, and an absent pin is still ok:true", async () => {
    // Without this, a bound that failed unconditionally would satisfy both
    // assertions above while `load` had stopped working entirely — and it also
    // pins the branch the bound must NOT swallow: we asked, and there is no
    // such pin.
    const { db } = makeDb({ pinnacle_catalog: { data: null, error: null } })
    const res = await load(RENDER, db)

    expect(res).toEqual({ data: null, ok: true })
  })
})
