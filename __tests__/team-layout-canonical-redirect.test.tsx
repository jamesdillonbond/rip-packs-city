// @vitest-environment node
//
// __tests__/team-layout-canonical-redirect.test.tsx
//
// Guards the 2026-08-01 fix for the EMPTY Golazos team page.
//
// get_team_detail carries a diacritic-stripping FALLBACK lane, so
// /laliga-golazos/team/atletico-de-madrid RESOLVES to "Atlético de Madrid" and
// the page rendered — but the six section RPCs (get_team_players,
// _top_editions, _activity, _sets, _squeeze, _checklist) match only
// regexp_replace(lower(trim(team_name)),'[^a-z0-9]+','-','g') and have no such
// lane, so every one returned 0 rows against that slug. Measured live:
//   players 0 / editions 0 / activity 0 / sets 0   (fallback slug)
//   players 28 / editions 24 / activity 40 / sets 14 (canonical slug)
// The segment layout now canonicalises with a permanent redirect, which also
// gives the hub ONE indexable URL.

import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.mock factories are hoisted, so the spies must live in vi.hoisted().
const h = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }),
  permanentRedirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  fetchEntityDetailRaw: vi.fn(),
}))
const { notFound, permanentRedirect, fetchEntityDetailRaw } = h

vi.mock("next/navigation", () => ({
  notFound: h.notFound,
  permanentRedirect: h.permanentRedirect,
}))
vi.mock("@/lib/entity-detail-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entity-detail-gate")>("@/lib/entity-detail-gate")
  return { ...actual, fetchEntityDetailRaw: h.fetchEntityDetailRaw }
})

import TeamSegmentLayout from "@/app/(collections)/[collection]/team/[slug]/layout"

function run(collection: string, slug: string) {
  return TeamSegmentLayout({ children: null, params: Promise.resolve({ collection, slug }) })
}

beforeEach(() => {
  notFound.mockClear()
  permanentRedirect.mockClear()
  fetchEntityDetailRaw.mockReset()
})

describe("team segment layout — canonical slug redirect", () => {
  it("308s the diacritic-stripped slug to the canonical one", async () => {
    fetchEntityDetailRaw.mockResolvedValue({ data: { team_name: "Atlético de Madrid" }, error: null })
    await expect(run("laliga-golazos", "atletico-de-madrid")).rejects.toThrow(
      "NEXT_REDIRECT:/laliga-golazos/team/atl-tico-de-madrid",
    )
    expect(permanentRedirect).toHaveBeenCalledOnce()
  })

  it("does NOT redirect when the slug is already canonical (no loop)", async () => {
    fetchEntityDetailRaw.mockResolvedValue({ data: { team_name: "Atlético de Madrid" }, error: null })
    await run("laliga-golazos", "atl-tico-de-madrid")
    expect(permanentRedirect).not.toHaveBeenCalled()
    expect(notFound).not.toHaveBeenCalled()
  })

  it("leaves an unaccented team alone", async () => {
    fetchEntityDetailRaw.mockResolvedValue({ data: { team_name: "Portland Trail Blazers" }, error: null })
    await run("nba-top-shot", "portland-trail-blazers")
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("404s a slug that resolves to nothing", async () => {
    fetchEntityDetailRaw.mockResolvedValue({ data: null, error: null })
    await expect(run("laliga-golazos", "not-a-team")).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("FAILS OPEN on an RPC error — never 404s or redirects a real team on a blip", async () => {
    fetchEntityDetailRaw.mockResolvedValue({ data: null, error: { message: "statement timeout" } })
    await run("laliga-golazos", "atletico-de-madrid")
    expect(notFound).not.toHaveBeenCalled()
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("FAILS OPEN when the RPC throws", async () => {
    fetchEntityDetailRaw.mockRejectedValue(new Error("pool timeout"))
    await run("laliga-golazos", "atletico-de-madrid")
    expect(notFound).not.toHaveBeenCalled()
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("does not redirect when team_name is missing", async () => {
    fetchEntityDetailRaw.mockResolvedValue({ data: { team_name: null }, error: null })
    await run("laliga-golazos", "whatever")
    expect(permanentRedirect).not.toHaveBeenCalled()
  })
})
