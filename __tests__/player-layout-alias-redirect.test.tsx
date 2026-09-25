// @vitest-environment node
//
// __tests__/player-layout-alias-redirect.test.tsx
//
// Guards the 2026-09-25 Steph Curry merge (#137 a). "Stephen Curry" was a second
// players row; it was merged into "Steph Curry" and registered as an ALIAS in
// public.player_name_aliases. Without this, /nba-top-shot/player/stephen-curry —
// a URL collectors and search engines already hold — became a 404. The layout
// now answers 308 to the canonical page, ONLY for a slug that does not resolve
// on its own and that the alias table names — and a FAILED alias read throws to
// the retryable error boundary rather than 404ing a URL that may be real.

import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }),
  permanentRedirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  entityResolves: vi.fn(),
  resolvePlayerAlias: vi.fn(),
}))
const { notFound, permanentRedirect, entityResolves, resolvePlayerAlias } = h

vi.mock("next/navigation", () => ({
  notFound: h.notFound,
  permanentRedirect: h.permanentRedirect,
}))
vi.mock("@/lib/entity-detail-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entity-detail-gate")>("@/lib/entity-detail-gate")
  return { ...actual, entityResolves: h.entityResolves, resolvePlayerAlias: h.resolvePlayerAlias }
})

import PlayerSegmentLayout from "@/app/(collections)/[collection]/player/[slug]/layout"

function run(collection: string, slug: string) {
  return PlayerSegmentLayout({ children: null, params: Promise.resolve({ collection, slug }) })
}

beforeEach(() => {
  notFound.mockClear()
  permanentRedirect.mockClear()
  entityResolves.mockReset()
  resolvePlayerAlias.mockReset()
})

describe("player segment layout — alias redirect", () => {
  it("308s an alias slug to its canonical player", async () => {
    entityResolves.mockResolvedValue(false)
    resolvePlayerAlias.mockResolvedValue({ ok: true, target: "steph-curry" })
    await expect(run("nba-top-shot", "stephen-curry")).rejects.toThrow(
      "NEXT_REDIRECT:/nba-top-shot/player/steph-curry",
    )
    expect(resolvePlayerAlias).toHaveBeenCalledWith(expect.any(String), "stephen-curry")
    expect(notFound).not.toHaveBeenCalled()
  })

  it("never consults the alias table for a slug that resolves on its own", async () => {
    entityResolves.mockResolvedValue(true)
    await run("nba-top-shot", "steph-curry")
    expect(resolvePlayerAlias).not.toHaveBeenCalled()
    expect(permanentRedirect).not.toHaveBeenCalled()
    expect(notFound).not.toHaveBeenCalled()
  })

  it("still 404s a slug that is neither a player nor an alias", async () => {
    entityResolves.mockResolvedValue(false)
    resolvePlayerAlias.mockResolvedValue({ ok: true, target: null })
    await expect(run("nba-top-shot", "not-a-player")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("does not redirect to itself (no loop)", async () => {
    entityResolves.mockResolvedValue(false)
    resolvePlayerAlias.mockResolvedValue({ ok: true, target: "ghost" })
    await expect(run("nba-top-shot", "ghost")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("a FAILED alias read throws (retryable) — never a 404 for a URL that may be real", async () => {
    entityResolves.mockResolvedValue(false)
    resolvePlayerAlias.mockResolvedValue({ ok: false })
    await expect(run("nba-top-shot", "stephen-curry")).rejects.toThrow(/alias lookup unavailable/)
    expect(notFound).not.toHaveBeenCalled()
    expect(permanentRedirect).not.toHaveBeenCalled()
  })
})
