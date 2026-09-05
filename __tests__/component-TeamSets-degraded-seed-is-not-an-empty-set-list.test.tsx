// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import TeamSets, { type SetRow } from "@/components/entity/TeamSets"

// ─────────────────────────────────────────────────────────────────────────────
// TeamSets — the SEED'S PROVENANCE, the canon's fifth layer.
//
// `initial` arrives as `[]` from BOTH "this team has no sets" and
// "`get_team_sets` failed": `sectionRows` degrades a failed decorative RPC to an
// empty array by policy and DROPPED `ok` on the floor. The component then said
// "No sets yet." — a claim about the catalogue built from a timeout.
//
// ⚠ HONEST SCOPE, because I nearly overstated this. On the team page the section
// was gated `teamSets.length > 0`, so a failed read OMITTED it and that copy was
// never actually published to a reader. The defect was LATENT, not live. What
// made it worth fixing anyway is that the gate was load-bearing for honesty BY
// ACCIDENT — drop it to "always show the section" and the false claim ships —
// and that a silently vanishing section tells a reader nothing. The page now
// renders the section when the read FAILED too, so this copy is reachable and
// does real work.
//
// ⛔ The sibling `squeeze` section is deliberately NOT changed: it renders under
// `squeeze.length > 0` and has no concluding copy, so a failed read omits it.
// Omission understates, which is the safe direction.
// ─────────────────────────────────────────────────────────────────────────────

const ROW: SetRow = {
  set_slug: "base-set",
  set_name: "Base Set",
  editions: 12,
  cheapest_entry_usd: 4.2,
  owned: null,
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  // No wallet in localStorage → the mount effect returns before fetching, so
  // these cases measure the SEED, which is the thing under test.
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TeamSets", () => {
  it("🚨 a DEGRADED seed does not claim the team has no sets", async () => {
    render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="trail-blazers" initial={[]} initialOk={false} />)
    // The load-bearing assertion is the ABSENCE of the false claim.
    expect(screen.queryByText(/No sets yet/i)).toBeNull()
    // ...and it uses the SHARED wording, so a future section cannot invent its own.
    expect(screen.getByText(/Sets couldn't be loaded/i)).toBeTruthy()
  })

  it("a MEASURED empty still says the team has no sets", async () => {
    // The no-change control. Without it, deleting the claim unconditionally
    // would pass the case above while making the honest case worse — and the
    // helper's own header warns that a section which says "unavailable" when it
    // is merely quiet is the same defect pointed the other way.
    render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="trail-blazers" initial={[]} initialOk />)
    expect(screen.getByText(/No sets yet/i)).toBeTruthy()
    expect(screen.queryByText(/couldn't be loaded/i)).toBeNull()
  })

  it("rows render regardless of the seed's ok flag", async () => {
    // A degraded flag must never suppress rows we actually have.
    render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="trail-blazers" initial={[ROW]} initialOk={false} />)
    expect(screen.getByText("Base Set")).toBeTruthy()
    expect(screen.queryByText(/couldn't be loaded/i)).toBeNull()
  })

  it("omitting initialOk defaults to ok — a missing prop cannot mark a healthy section degraded", async () => {
    render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="trail-blazers" initial={[]} />)
    expect(screen.getByText(/No sets yet/i)).toBeTruthy()
  })

  it("a SUCCESSFUL client refetch clears a degraded seed", async () => {
    // The refetch proves the read works, so the warning must not sit next to a
    // list the component just loaded — even when that answer is empty.
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => "0x0123456789abcdef", setItem: () => {}, removeItem: () => {}, clear: () => {} },
    })
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })))
    render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="trail-blazers" initial={[]} initialOk={false} />)
    await waitFor(() => expect(screen.queryByText(/couldn't be loaded/i)).toBeNull())
    expect(screen.getByText(/No sets yet/i)).toBeTruthy()
  })

  it("a FAILED client refetch leaves the degraded seed reported", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => "0x0123456789abcdef", setItem: () => {}, removeItem: () => {}, clear: () => {} },
    })
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => null })))
    render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="trail-blazers" initial={[]} initialOk={false} />)
    await waitFor(() => expect(screen.getByText(/couldn't be loaded/i)).toBeTruthy())
    expect(screen.queryByText(/No sets yet/i)).toBeNull()
  })
})
