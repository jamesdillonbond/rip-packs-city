import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { lookupLegacyEdition, UUID_RE } from "@/lib/edition/legacy-redirect"

// ⚠ WHY THIS FILE EXISTS, given that a guard already covers this module.
//
// `lib/edition/legacy-redirect.ts` was EXTRACTED from `app/edition/[id]/page.tsx`
// precisely so its ok-flag contract could be driven by a test — the page had
// collapsed a failed read into `notFound()`, handing a hard 404 for an edition
// that exists to the one audience least likely to retry (legacy inbound links,
// old shares, and anything a crawler already indexed under the flat URL).
//
// The extraction landed. The behavioural test never followed. Measured
// 2026-08-20 the module sat at **0.0% statements / 0.0% branches**, and the only
// test that named it — `server-pages-error-vs-absent-guard.test.ts` — reads it as
// SOURCE TEXT (`read("lib", "edition", "legacy-redirect.ts")`) and never calls it.
// That is `server-page-data-access-ratchet`'s own lesson landing on the file it
// was written about: "the comment is not the check; moving the code somewhere a
// test can drive it is."
//
// ⚠ AND A SOURCE GUARD STRUCTURALLY CANNOT CLOSE THIS ONE. It reads the literal
// `return { target: null, ok: false }` and confirms the line is present. It
// cannot see whether that line is ever REACHED — and reaching it is the entire
// question, because supabase-js **returns** errors rather than throwing, so the
// `error` binding is the only evidence a read failed. A destructure that
// silently stopped taking `error` would keep every line the guard reads and
// answer `ok: true` on a timeout. That is the exact mechanism behind this
// repo's most productive defect class. So: the guard stays (it catches the
// page-side regression this file cannot see), and this file drives the module.
//
// Both directions are pinned deliberately. A fix that answered `ok: false` for
// a genuine miss would mean no bad legacy URL ever 404s again — the mirror-image
// defect, and the one a careless "make failures loud" pass would introduce.

/**
 * Minimal stand-in for the one supabase-js chain this module builds:
 *   db.from(…).select(…).eq(…).maybeSingle()
 *
 * Deliberately NOT the shared mutable builder from `route-harness`. That helper
 * returns a single mutable singleton from every call, which cannot model
 * per-table behaviour — irrelevant here (one table, one chain) but the local
 * stub also lets each case assert the exact arguments the module passed.
 */
function makeDb(result: { data: unknown; error: { message: string } | null }) {
  const calls = { from: [] as string[], select: [] as string[], eq: [] as Array<[string, string]> }
  const chain = {
    select(cols: string) {
      calls.select.push(cols)
      return chain
    },
    eq(col: string, val: string) {
      calls.eq.push([col, val])
      return chain
    },
    async maybeSingle() {
      return result
    },
  }
  return {
    calls,
    db: {
      from(table: string) {
        calls.from.push(table)
        return chain
      },
    },
  }
}

const ID = "3f2c1b0a-1111-2222-3333-444455556666"

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe("lookupLegacyEdition — the three states, driven rather than read", () => {
  it("a FAILED read answers ok:false, so the page can throw instead of 404ing a real edition", async () => {
    const { db } = makeDb({ data: null, error: { message: "canceling statement due to statement timeout" } })

    const result = await lookupLegacyEdition(ID, db)

    // ⚠ The whole point. `ok` must be false — asserting only `target === null`
    // would pass identically on the defect, because a genuine miss also has a
    // null target. The failure is INDISTINGUISHABLE from the miss on `target`
    // alone; `ok` is the only thing that separates them.
    expect(result.ok, "a failed read must never report ok:true").toBe(false)
    expect(result.target).toBeNull()
  })

  it("a failed read is not silent — the message reaches the log", async () => {
    const { db } = makeDb({ data: null, error: { message: "pool exhausted" } })

    await lookupLegacyEdition(ID, db)

    // An alert whose output is silence is unfalsifiable. This route returns a
    // retryable error boundary to the user and nothing else, so the log line is
    // the only trace an operator gets that the redirect is failing at all.
    expect(errorSpy).toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("pool exhausted")
  })

  it("a GENUINE miss answers ok:true, so a bad legacy URL still 404s", async () => {
    const { db } = makeDb({ data: null, error: null })

    const result = await lookupLegacyEdition(ID, db)

    // ⚠ The mirror-image defect. If this ever became ok:false, no bad legacy URL
    // would 404 again — every typo'd uuid would render the retryable error
    // boundary and every crawler would keep retrying it forever.
    expect(result.ok, "we asked and got an answer; that is not a failure").toBe(true)
    expect(result.target).toBeNull()
  })

  it("resolves a real row to its canonical (external_id, collection slug) pair", async () => {
    const { db, calls } = makeDb({
      data: { external_id: "12345", collections: { slug: "nba_top_shot" } },
      error: null,
    })

    const result = await lookupLegacyEdition(ID, db)

    expect(result).toEqual({ target: { externalId: "12345", collectionDbSlug: "nba_top_shot" }, ok: true })
    // The lookup must key on the uuid it was handed, against `editions`. A
    // chain that silently queried something else would still satisfy the
    // return-shape assertions above off the stub's canned row.
    expect(calls.from).toEqual(["editions"])
    expect(calls.eq).toEqual([["id", ID]])
    // The join is load-bearing: the collection slug comes from `collections`,
    // and an `!inner` join is what makes a slug-less edition a miss rather than
    // a half-built redirect target.
    expect(calls.select[0]).toContain("collections!inner(slug)")
  })
})

describe("lookupLegacyEdition — a row that cannot produce a canonical path is a MISS, not a failure", () => {
  // Documented deliberately in the module: "we asked and got an answer, and
  // there is no canonical path to redirect to. Reporting it as a failure would
  // make an un-redirectable edition retry forever behind an error boundary."
  // Both halves are pinned because either one alone leaves the other free to
  // regress to ok:false.

  it("a row with no external_id", async () => {
    const { db } = makeDb({ data: { external_id: null, collections: { slug: "nba_top_shot" } }, error: null })

    expect(await lookupLegacyEdition(ID, db)).toEqual({ target: null, ok: true })
  })

  it("a row with no collection slug", async () => {
    const { db } = makeDb({ data: { external_id: "12345", collections: null }, error: null })

    expect(await lookupLegacyEdition(ID, db)).toEqual({ target: null, ok: true })
  })

  it("an empty-string external_id is a miss, not a redirect to /<collection>/edition/", async () => {
    // `!externalId` catches this today. Pinned because the obvious "tighten the
    // check" refactor to `externalId == null` would build a redirect target
    // whose path ends in a bare slash.
    const { db } = makeDb({ data: { external_id: "", collections: { slug: "nba_top_shot" } }, error: null })

    expect(await lookupLegacyEdition(ID, db)).toEqual({ target: null, ok: true })
  })
})

describe("UUID_RE — the page's only gate before it touches the DB", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(UUID_RE.test(ID)).toBe(true)
    expect(UUID_RE.test(ID.toUpperCase())).toBe(true)
  })

  it("rejects the shapes a legacy URL actually arrives in", () => {
    // The page 404s on a non-match without reading the DB, so a regression here
    // is a free DB round-trip on every crawler probe of a junk URL.
    for (const bad of [
      "",
      "not-a-uuid",
      "12345",
      ID.slice(0, -1), // one char short
      `${ID}7`, // one char long
      `${ID.slice(0, 8)}_${ID.slice(9)}`, // wrong separator
      "3f2c1b0g-1111-2222-3333-444455556666", // 'g' is not hex
    ]) {
      expect(UUID_RE.test(bad), `must reject ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it("is not sticky — a shared regex with /g would alternate pass/fail across calls", () => {
    // `UUID_RE` is a module-level const shared by every request. A `/g` flag
    // would carry `lastIndex` between calls and 404 every OTHER valid legacy
    // link, intermittently, which is close to undiagnosable in production.
    expect(UUID_RE.global).toBe(false)
    expect(UUID_RE.test(ID)).toBe(true)
    expect(UUID_RE.test(ID)).toBe(true)
  })
})


// ⚠ THE SLOW CASE, added 2026-08-22 alongside the budget. This function had an
// `if (error)` branch and NO catch, so a hang had nowhere to land — and the
// budget REJECTS, so adding it without a catch would have replaced a slow page
// with a thrown error boundary. Both halves shipped together; this pins that.
describe("a HANGING lookup degrades instead of throwing", () => {
  afterEach(() => vi.useRealTimers())

  const hangingDb = () => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "maybeSingle"]) b[m] = () => b
    b.then = () => new Promise(() => {})
    return { from: () => b }
  }

  it("returns ok:false rather than rejecting", async () => {
    vi.useFakeTimers()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = lookupLegacyEdition("some-id", hangingDb() as any)
    await vi.advanceTimersByTimeAsync(8_000)
    // Assert the ABSENCE of a rejection, not merely the presence of a shape:
    // an unbounded version of this would leave the promise pending forever.
    await expect(p).resolves.toEqual({ target: null, ok: false })
  })
})
