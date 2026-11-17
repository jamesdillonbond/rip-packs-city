// 2026-11-07 — /<collection>/pack/<id> for an id RPC has NO record of rendered
// the NotFoundCard at HTTP 200 while its metadata said "Pack #<id> — Pack #<id>",
// `index, follow`, a self-canonical URL and a share card — an unbounded,
// indexable id space (the seo-unresolvable-slug class). The three answers the
// metadata must keep apart:
//   known pack      → indexable, real title
//   unknown pack    → NOT_FOUND_METADATA (absent: index:false, follow:false)
//   failed read     → unavailable (index:false, follow:TRUE — a transient must
//                     not de-index a real pack as absent)
import { describe, it, expect, vi, beforeEach } from "vitest"

const state: { lifecycle: unknown; ok: boolean; probeOk: boolean } = { lifecycle: null, ok: true, probeOk: true }
vi.mock("@/lib/pack-detail/lifecycle", () => ({
  fetchLifecycle: async () => ({ lifecycle: state.lifecycle, ok: state.ok }),
  isKnownDistId: async () => ({ known: false, ok: state.probeOk }),
}))

type Robots = { index?: boolean; follow?: boolean }
async function meta() {
  const { generateMetadata } = await import("@/app/(collections)/[collection]/pack/[id]/page")
  return (await generateMetadata({
    params: Promise.resolve({ collection: "nba-top-shot", id: "no-such-pack" }),
  } as never)) as { title?: unknown; robots?: Robots; alternates?: unknown; openGraph?: unknown }
}

describe("/<collection>/pack/<id> metadata keeps absent, unavailable and known apart", () => {
  beforeEach(() => {
    state.lifecycle = null
    state.ok = true
    state.probeOk = true
  })

  // 2026-11-07 review: the BODY treats a failed distribution-id probe as
  // could-not-read (UnavailableCard); the head said "absent, nofollow" over it.
  it("an unknown lifecycle whose dist-id probe FAILED is unavailable in the head too, never absent", async () => {
    state.probeOk = false
    const m = await meta()
    expect(m.robots).toMatchObject({ index: false, follow: true })
    expect(JSON.stringify(m.title)).toMatch(/Unavailable/)
  })

  it("an unknown pack is ABSENT: not indexable, no canonical, no share card, no doubled title", async () => {
    const m = await meta()
    expect(m.robots).toMatchObject({ index: false, follow: false })
    expect(m.alternates).toBeUndefined()
    expect(m.openGraph).toBeUndefined()
    expect(JSON.stringify(m.title)).not.toMatch(/Pack #no-such-pack — Pack #no-such-pack/)
  })

  it("a FAILED read is UNAVAILABLE, not absent: index:false but follow:true", async () => {
    state.ok = false
    const m = await meta()
    expect(m.robots).toMatchObject({ index: false, follow: true })
  })

  it("a known pack stays indexable with its own title and canonical", async () => {
    state.lifecycle = {
      status: "sealed",
      pack_name: "Base Set Pack",
      stats: { total_cost_basis: 9, currency: "USD" },
      distribution: { title: "Base Set (Series 2026)", retail_price_usd: 9 },
    }
    const m = await meta()
    expect(m.robots).toBeUndefined()
    expect(JSON.stringify(m.title)).toMatch(/Base Set \(Series 2026\)/)
    expect(m.alternates).toBeDefined()
  })
})
