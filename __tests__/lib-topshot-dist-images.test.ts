import { describe, it, expect, vi } from "vitest"
import { fillMissingDistImages, originalImageUrl, PACKNFT_MEDIA_BASE } from "@/lib/packs/topshot-dist-images"

// lib/packs/topshot-dist-images — fills Top Shot pack_distributions.image_url
// from the pack NFT's media redirect. Shapes below are the ones observed live
// 2026-09-25 (dist 8825 → pack 278176444597001).

const REDIRECT_8825 =
  "https://asset-preview.nbatopshot.com/cdn-cgi/image/width=256,format=jpeg,quality=85/distributions/production-1790179502796-WNBATS_Team_Leaderboard_Reward_Pack_POR.png"
const ORIGINAL_8825 =
  "https://asset-preview.nbatopshot.com/distributions/production-1790179502796-WNBATS_Team_Leaderboard_Reward_Pack_POR.png"

describe("originalImageUrl", () => {
  it("strips Cloudflare's resize segment to the stored original", () => {
    expect(originalImageUrl(REDIRECT_8825)).toBe(ORIGINAL_8825)
  })
  it("keeps an already-original Top Shot asset URL, incl. the GCS bucket some dists redirect to", () => {
    const gcs = "https://storage.googleapis.com/assets-nbatopshot/distributions/production-1786051730514-WNBATS_Set_Reward_Pack_RIB_Origins.png"
    expect(originalImageUrl(gcs)).toBe(gcs)
    expect(originalImageUrl(ORIGINAL_8825)).toBe(ORIGINAL_8825)
  })
  it("refuses anything that is not Top Shot's own asset host — never store a URL we do not recognise", () => {
    expect(originalImageUrl("https://evil.example/x.png")).toBeNull()
    expect(originalImageUrl("http://asset-preview.nbatopshot.com/x.png")).toBeNull()
    expect(originalImageUrl("https://storage.googleapis.com/other-bucket/x.png")).toBeNull()
    expect(originalImageUrl(null)).toBeNull()
    expect(originalImageUrl("")).toBeNull()
  })
})

// A per-table supabase stub: pack_distributions reads answer `dists`,
// pack_purchases reads answer `packs[dist_id]`, updates are captured.
function makeDb(o: {
  dists?: Array<{ id: string; dist_id: string }>
  distError?: { message: string } | null
  packs?: Record<string, string | null>
  ripPacks?: Record<string, string | null>
  packError?: { message: string } | null
  updateResult?: { data: unknown; error: { message: string } | null }
}) {
  const updates: Array<{ patch: Record<string, unknown>; eqs: Array<[string, unknown]>; isNull: string[] }> = []
  const db = {
    updates,
    from(table: string) {
      const state: { eqs: Array<[string, unknown]>; isNull: string[]; patch: Record<string, unknown> | null } = { eqs: [], isNull: [], patch: null }
      const q: any = {
        select: (cols: string) => {
          if (state.patch && cols === "id") {
            updates.push({ patch: state.patch, eqs: state.eqs, isNull: state.isNull })
            return Promise.resolve(o.updateResult ?? { data: [{ id: "x" }], error: null })
          }
          return q
        },
        eq: (c: string, v: unknown) => { state.eqs.push([c, v]); return q },
        is: (c: string, v: unknown) => { if (v === null) state.isNull.push(c); return q },
        order: () => q,
        update: (patch: Record<string, unknown>) => { state.patch = patch; return q },
        limit: () => {
          if (table === "pack_distributions") {
            return Promise.resolve(o.distError ? { data: null, error: o.distError } : { data: o.dists ?? [], error: null })
          }
          if (o.packError) return Promise.resolve({ data: null, error: o.packError })
          const dist = state.eqs.find(([c]) => c === "pack_dist_id" || c === "dist_id")?.[1] as string
          const id = table === "pack_rips" ? o.ripPacks?.[dist] : o.packs?.[dist]
          return Promise.resolve({ data: id ? [{ pack_nft_id: id }] : [], error: null })
        },
      }
      return q
    },
  }
  return db
}

function res(status: number, location?: string) {
  return { status, headers: { get: (h: string) => (h.toLowerCase() === "location" ? location ?? null : null) } } as unknown as Response
}

const BASE = { collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd", maxRows: 200, deadlineMs: Date.now() + 60_000 }

describe("fillMissingDistImages", () => {
  it("follows the pack's media redirect WITHOUT downloading, and writes the original fill-only", async () => {
    const db = makeDb({ dists: [{ id: "r1", dist_id: "8825" }], packs: { "8825": "278176444597001" } })
    const f = vi.fn(async () => res(302, REDIRECT_8825))
    const r = await fillMissingDistImages({ ...BASE, db, fetchImpl: f as unknown as typeof fetch })

    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = (f.mock.calls[0] as unknown) as [string, RequestInit]
    expect(url).toBe(`${PACKNFT_MEDIA_BASE}/278176444597001/media/image?format=jpeg&width=256`)
    expect(init.redirect).toBe("manual")
    expect(init.signal).toBeInstanceOf(AbortSignal)

    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].patch.image_url).toBe(ORIGINAL_8825)
    expect(db.updates[0].eqs).toContainEqual(["id", "r1"])
    expect(db.updates[0].isNull).toContain("image_url")
    expect(r).toMatchObject({ ok: true, complete: true, imageless: 1, filled: 1, no_pack: 0, no_image: 0 })
  })

  it("falls back to an OPENED pack when the dist has no purchase (a dist discovered from rips alone)", async () => {
    const db = makeDb({ dists: [{ id: "r1", dist_id: "8870" }], packs: {}, ripPacks: { "8870": "999" } })
    const f = vi.fn(async () => res(302, REDIRECT_8825))
    const r = await fillMissingDistImages({ ...BASE, db, fetchImpl: f as unknown as typeof fetch })
    expect(((f.mock.calls[0] as unknown) as [string])[0]).toBe(`${PACKNFT_MEDIA_BASE}/999/media/image?format=jpeg&width=256`)
    expect(r).toMatchObject({ ok: true, filled: 1, no_pack: 0 })
  })

  it("a 404 is no_image and a dist with no known pack is no_pack — both left NULL, never guessed", async () => {
    const db = makeDb({ dists: [{ id: "r1", dist_id: "1" }, { id: "r2", dist_id: "2" }], packs: { "1": "111" } })
    const f = vi.fn(async () => res(404))
    const r = await fillMissingDistImages({ ...BASE, db, fetchImpl: f as unknown as typeof fetch })
    expect(f).toHaveBeenCalledTimes(1)
    expect(db.updates).toHaveLength(0)
    expect(r).toMatchObject({ ok: true, filled: 0, no_image: 1, no_pack: 1 })
  })

  it("a response that is neither a redirect nor a 404 FAILS the pass (a surprise is not an absence)", async () => {
    const db = makeDb({ dists: [{ id: "r1", dist_id: "1" }], packs: { "1": "111" } })
    const r = await fillMissingDistImages({ ...BASE, db, fetchImpl: (async () => res(500)) as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/HTTP 500/)
    expect(r.fetch_errors).toBe(1)
    expect(db.updates).toHaveLength(0)
  })

  it("an unrecognised redirect target fails the pass and writes nothing", async () => {
    const db = makeDb({ dists: [{ id: "r1", dist_id: "1" }], packs: { "1": "111" } })
    const r = await fillMissingDistImages({ ...BASE, db, fetchImpl: (async () => res(302, "https://evil.example/x.png")) as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unrecognised/)
    expect(db.updates).toHaveLength(0)
  })

  it("a thrown fetch (timeout) fails the pass and moves on to the next dist", async () => {
    const db = makeDb({ dists: [{ id: "r1", dist_id: "1" }, { id: "r2", dist_id: "2" }], packs: { "1": "111", "2": "222" } })
    let n = 0
    const f = (async () => { if (n++ === 0) throw new Error("The operation was aborted due to timeout"); return res(302, REDIRECT_8825) }) as unknown as typeof fetch
    const r = await fillMissingDistImages({ ...BASE, db, fetchImpl: f })
    expect(r).toMatchObject({ ok: false, fetch_errors: 1, filled: 1 })
    expect(r.error).toMatch(/timeout/)
  })

  it("the filled count is what the UPDATE returned — a concurrent writer that got there first counts 0", async () => {
    const db = makeDb({ dists: [{ id: "r1", dist_id: "1" }], packs: { "1": "111" }, updateResult: { data: [], error: null } })
    const r = await fillMissingDistImages({ ...BASE, db, fetchImpl: (async () => res(302, REDIRECT_8825)) as unknown as typeof fetch })
    expect(r).toMatchObject({ ok: true, filled: 0 })
  })

  it("a write error, a pack-lookup error and a read error each fail the pass", async () => {
    const f = (async () => res(302, REDIRECT_8825)) as unknown as typeof fetch
    const w = await fillMissingDistImages({ ...BASE, fetchImpl: f, db: makeDb({ dists: [{ id: "r1", dist_id: "1" }], packs: { "1": "111" }, updateResult: { data: null, error: { message: "permission denied" } } }) })
    expect(w).toMatchObject({ ok: false, write_errors: 1, filled: 0 })
    expect(w.error).toMatch(/permission denied/)

    const p = await fillMissingDistImages({ ...BASE, fetchImpl: f, db: makeDb({ dists: [{ id: "r1", dist_id: "1" }], packError: { message: "timeout" } }) })
    expect(p.ok).toBe(false)
    expect(p.error).toMatch(/pack lookup failed/)

    const g = vi.fn(f)
    const d = await fillMissingDistImages({ ...BASE, fetchImpl: g as unknown as typeof fetch, db: makeDb({ distError: { message: "db down" } }) })
    expect(d).toMatchObject({ ok: false, imageless: 0 })
    expect(g).not.toHaveBeenCalled()
  })

  it("stops at the deadline with complete=false, and reports an over-cap population as incomplete", async () => {
    const f = vi.fn(async () => res(302, REDIRECT_8825))
    const late = await fillMissingDistImages({ ...BASE, deadlineMs: Date.now() - 1, fetchImpl: f as unknown as typeof fetch, db: makeDb({ dists: [{ id: "r1", dist_id: "1" }], packs: { "1": "111" } }) })
    expect(late).toMatchObject({ ok: true, complete: false, filled: 0 })
    expect(f).not.toHaveBeenCalled()

    const capped = await fillMissingDistImages({ ...BASE, maxRows: 1, fetchImpl: f as unknown as typeof fetch, db: makeDb({ dists: [{ id: "r1", dist_id: "1" }, { id: "r2", dist_id: "2" }], packs: { "1": "111", "2": "222" } }) })
    expect(capped).toMatchObject({ complete: false, imageless: 1, filled: 1 })
  })

  it("nothing imageless is a clean, complete, zero-row pass", async () => {
    const f = vi.fn()
    const r = await fillMissingDistImages({ ...BASE, fetchImpl: f as unknown as typeof fetch, db: makeDb({ dists: [] }) })
    expect(r).toMatchObject({ ok: true, complete: true, imageless: 0, filled: 0 })
    expect(f).not.toHaveBeenCalled()
  })
})
