import { describe, it, expect, vi, afterEach } from "vitest"
import { resolveMomentId } from "@/lib/moment/resolve-moment-id"

// Drives `/moment/[id]`'s only data read, which lived inline in the layout until
// 2026-08-17 and was therefore measured by NEITHER coverage gate.
//
// ⚠ THE CONTRACT IS FAIL-OPEN ON AN SEO SURFACE. `/moment/[id]` is indexed. If
// an unreadable answer resolved as "no such moment", the layout would call
// notFound() on a moment that exists and invite Google to drop a live URL — a
// failed read published as a fact about our catalogue. The layout's comment
// asserted this; nothing checked it, because nothing could reach the code.
//
// ⚠ AND THE TWO FAILURE SHAPES ARE NOT SYMMETRIC. supabase-js RETURNS
// `{ data: null, error }` for a statement timeout rather than throwing, so a
// try/catch alone leaves the branch that actually fires in production
// unhandled. Both are driven below, and the returned-error one is the important
// case precisely because it is the one a catch cannot see.

const ok = (data: unknown) => ({ rpc: async () => ({ data, error: null }) })
const returnsError = (message: string) => ({ rpc: async () => ({ data: null, error: { message } }) })
const throws = (message: string) => ({
  rpc: async () => {
    throw new Error(message)
  },
})

describe("resolveMomentId", () => {
  it("resolves TRUE for a row the rpc actually returned", async () => {
    expect(await resolveMomentId("123", ok([{ id: "123" }]))).toEqual({ resolves: true, degraded: false })
  })

  it("resolves FALSE only on a SUCCESSFUL read that found nothing", async () => {
    // The one case that may 404. `degraded: false` is the load-bearing half —
    // it is what makes the false a finding rather than a fallback.
    expect(await resolveMomentId("nope", ok([]))).toEqual({ resolves: false, degraded: false })
  })

  it("fails OPEN when supabase RETURNS an error (the shape a catch cannot see)", async () => {
    const r = await resolveMomentId("123", returnsError("canceling statement due to statement timeout"))
    // ⚠ Assert the ABSENCE of the false claim first: a timeout must never be
    // able to produce the 404 branch.
    expect(r.resolves).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain("statement timeout")
  })

  it("fails OPEN when the call THROWS", async () => {
    const r = await resolveMomentId("123", throws("socket hang up"))
    expect(r.resolves).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain("socket hang up")
  })

  it("never reports degraded and not-resolving together — that pair is the defect", async () => {
    // The whole point of three states: "we could not tell" must never arrive
    // wearing the costume of "it does not exist". Stated as the forbidden
    // COMBINATION so it holds however the branches are refactored.
    for (const client of [returnsError("boom"), throws("boom"), ok([]), ok([{ id: 1 }]), ok(null)]) {
      const r = await resolveMomentId("x", client)
      expect(r.degraded && !r.resolves, JSON.stringify(r)).toBe(false)
    }
  })

  it("treats a non-array truthy payload as resolving, and null as not", async () => {
    // resolve_moment_id has returned both a SETOF and a scalar over its life;
    // the layout's original `Array.isArray(data) ? data.length > 0 : data != null`
    // is preserved here so a shape change upstream cannot silently 404 a moment.
    expect((await resolveMomentId("x", ok({ id: "x" }))).resolves).toBe(true)
    expect((await resolveMomentId("x", ok(null))).resolves).toBe(false)
  })
})


// ⚠ THE SLOW CASE, added 2026-08-22. Every case above drives a read that RETURNS
// something; a read that merely HANGS returns neither data nor error, so none of
// them could observe it — and a hang is exactly what took four collections'
// /overview pages down that day ("Timed out acquiring connection from connection
// pool", logged at HTTP 200 because the streaming shell answers instantly).
describe("a HANGING read degrades instead of hanging the page", () => {
  afterEach(() => vi.useRealTimers())

  it("gives up on the budget and reports degraded", async () => {
    vi.useFakeTimers()
    const hanging = { rpc: () => new Promise<never>(() => {}) } as never
    const p = resolveMomentId("abc", hanging)
    await vi.advanceTimersByTimeAsync(8_000)
    const r = await p
    // `resolves: true` is the deliberate fail-OPEN here — see the module: a
    // degraded lookup must not 404 a moment that exists.
    expect(r).toMatchObject({ resolves: true, degraded: true })
    expect(r.reason).toMatch(/read exceeded 8000ms/)
    expect(r.reason).not.toMatch(/insights\//)
  })

  it("does NOT fire the budget on a read that answers in time", async () => {
    vi.useFakeTimers()
    const fast = { rpc: async () => ({ data: [{ id: "x" }], error: null }) } as never
    const p = resolveMomentId("abc", fast)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await p).toEqual({ resolves: true, degraded: false })
  })
})

// ── The edition-grain 301 (2026-09-06, Search Console) ─────────────────────
//
// /moment/<edition uuid> duplicated the edition page under ~11,000 URLs. The
// redirect has to be decided in the LAYOUT (pre-flush) to be a real 308 — in
// the page it degraded to a 200 + meta refresh, measured live. These pin the
// helper the layout calls: it only ever produces a target for the resolver's
// own `kind = 'edition'`, it fails OPEN (null) on every failed or empty read,
// and it never redirects a serial-grain moment.
import { editionGrainRedirectTarget } from "@/lib/moment/resolve-moment-id"

const editionRow = (over: Record<string, unknown> = {}) => [
  {
    kind: "edition",
    moment_id: null,
    edition_id: "1d24f53d-a3aa-49dd-9606-38bd87ba1153",
    serial_number: null,
    collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    collection_slug: "nba_top_shot",
    ...over,
  },
]
const editions = (result: { data: unknown; error: { message: string } | null } | "throw") => ({
  from: (table: string) => {
    expect(table).toBe("editions")
    return {
      select: (cols: string) => {
        expect(cols).toBe("external_id")
        return {
          eq: (col: string, val: string) => {
            expect(col).toBe("id")
            expect(val).toBe("1d24f53d-a3aa-49dd-9606-38bd87ba1153")
            return {
              maybeSingle: async () => {
                if (result === "throw") throw new Error("socket hang up")
                return result
              },
            }
          },
        }
      },
    }
  },
})

describe("resolveMomentId carries the resolver's edition-grain verdict", () => {
  it("attaches `edition` for kind = 'edition' with its id and collection slug", async () => {
    const r = await resolveMomentId("1d24f53d-a3aa-49dd-9606-38bd87ba1153", ok(editionRow()))
    expect(r).toEqual({
      resolves: true,
      degraded: false,
      edition: { editionId: "1d24f53d-a3aa-49dd-9606-38bd87ba1153", collectionSlug: "nba_top_shot" },
    })
  })

  it("attaches nothing for a serial-grain moment, a Pinnacle edition, a miss, or a degraded read", async () => {
    expect((await resolveMomentId("123", ok(editionRow({ kind: "moment", moment_id: "123", serial_number: 7 })))).edition).toBeUndefined()
    expect((await resolveMomentId("x", ok(editionRow({ kind: "pinnacle_edition" })))).edition).toBeUndefined()
    expect((await resolveMomentId("x", ok([]))).edition).toBeUndefined()
    expect((await resolveMomentId("x", returnsError("timeout"))).edition).toBeUndefined()
    expect((await resolveMomentId("x", throws("boom"))).edition).toBeUndefined()
  })
})

describe("editionGrainRedirectTarget", () => {
  const id = "1d24f53d-a3aa-49dd-9606-38bd87ba1153"
  const resolved = { resolves: true, degraded: false, edition: { editionId: id, collectionSlug: "nba_top_shot" } }

  it("returns the canonical edition path for an edition-grain resolution", async () => {
    const t = await editionGrainRedirectTarget(id, resolved, editions({ data: { external_id: "99:3372" }, error: null }))
    expect(t).toBe("/nba-top-shot/edition/99%3A3372")
  })

  it("never redirects a resolution with no edition-grain verdict (a serial moment)", async () => {
    let touched = false
    const client = { from: () => { touched = true; throw new Error("must not read") } }
    expect(await editionGrainRedirectTarget("123", { resolves: true, degraded: false }, client as never)).toBeNull()
    expect(touched).toBe(false)
  })

  it("fails OPEN — null, never a guessed slug and never a throw — on a returned error, an empty row, a non-string external_id, or a throw", async () => {
    expect(await editionGrainRedirectTarget(id, resolved, editions({ data: null, error: { message: "statement timeout" } }))).toBeNull()
    expect(await editionGrainRedirectTarget(id, resolved, editions({ data: null, error: null }))).toBeNull()
    expect(await editionGrainRedirectTarget(id, resolved, editions("throw"))).toBeNull()
    // A null external_id falls back to the edition uuid in the slug, which is a
    // real route for the edition page — still a redirect, never /moment/self.
    expect(await editionGrainRedirectTarget(id, resolved, editions({ data: { external_id: null }, error: null }))).toBe(`/nba-top-shot/edition/${id}`)
  })

  it("returns null when the canonical is the URL itself (no resolvable collection slug)", async () => {
    const r = { ...resolved, edition: { editionId: id, collectionSlug: "not_a_collection" } }
    expect(await editionGrainRedirectTarget(id, r, editions({ data: { external_id: "1:1" }, error: null }))).toBeNull()
  })
})
