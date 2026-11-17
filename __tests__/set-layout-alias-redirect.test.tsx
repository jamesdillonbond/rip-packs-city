// @vitest-environment node
//
// __tests__/set-layout-alias-redirect.test.tsx
//
// Guards the 2026-09-25 unaccented-set-slug fix. sets_summary.set_slug collapses
// an accent to a dash ("Ídolos" -> "-dolos", "ElClásico" -> "elcl-sico"), so
// /laliga-golazos/set/idolos 404'd while the team route accepted both spellings.
// The layout now answers 308 to the canonical page via get_set_alias_target,
// ONLY for a slug that does not resolve on its own — and a FAILED alias read
// throws to the retryable error boundary rather than 404ing a URL that may be real.

import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }),
  permanentRedirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  entityResolves: vi.fn(),
  resolveSetAlias: vi.fn(),
}))
const { notFound, permanentRedirect, entityResolves, resolveSetAlias } = h

vi.mock("next/navigation", () => ({
  notFound: h.notFound,
  permanentRedirect: h.permanentRedirect,
}))
vi.mock("@/lib/entity-detail-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entity-detail-gate")>("@/lib/entity-detail-gate")
  return { ...actual, entityResolves: h.entityResolves, resolveSetAlias: h.resolveSetAlias }
})

import SetSegmentLayout from "@/app/(collections)/[collection]/set/[slug]/layout"

function run(collection: string, slug: string) {
  return SetSegmentLayout({ children: null, params: Promise.resolve({ collection, slug }) })
}

beforeEach(() => {
  notFound.mockClear()
  permanentRedirect.mockClear()
  entityResolves.mockReset()
  resolveSetAlias.mockReset()
})

describe("set segment layout — unaccented alias redirect", () => {
  it("308s the unaccented slug to the canonical set", async () => {
    entityResolves.mockResolvedValue(false)
    resolveSetAlias.mockResolvedValue({ ok: true, target: "-dolos" })
    await expect(run("laliga-golazos", "idolos")).rejects.toThrow(
      "NEXT_REDIRECT:/laliga-golazos/set/-dolos",
    )
    expect(resolveSetAlias).toHaveBeenCalledWith(expect.any(String), "idolos")
    expect(notFound).not.toHaveBeenCalled()
  })

  it("never consults the alias table for a slug that resolves on its own", async () => {
    entityResolves.mockResolvedValue(true)
    await run("laliga-golazos", "-dolos")
    expect(resolveSetAlias).not.toHaveBeenCalled()
    expect(permanentRedirect).not.toHaveBeenCalled()
    expect(notFound).not.toHaveBeenCalled()
  })

  it("still 404s a slug that is neither a set nor an alias", async () => {
    entityResolves.mockResolvedValue(false)
    resolveSetAlias.mockResolvedValue({ ok: true, target: null })
    await expect(run("laliga-golazos", "not-a-set")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("does not redirect to itself (no loop)", async () => {
    entityResolves.mockResolvedValue(false)
    resolveSetAlias.mockResolvedValue({ ok: true, target: "ghost" })
    await expect(run("laliga-golazos", "ghost")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("a FAILED alias read throws (retryable) — never a 404 for a URL that may be real", async () => {
    entityResolves.mockResolvedValue(false)
    resolveSetAlias.mockResolvedValue({ ok: false })
    await expect(run("laliga-golazos", "idolos")).rejects.toThrow(/alias lookup unavailable/)
    expect(notFound).not.toHaveBeenCalled()
    expect(permanentRedirect).not.toHaveBeenCalled()
  })
})
