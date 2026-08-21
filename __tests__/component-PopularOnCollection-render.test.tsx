// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, within } from "@testing-library/react"

// ── PopularOnCollection: the RENDER half, which nothing drove ────────────────
//
// ⚠ THIS FILE EXISTS BECAUSE A RECORDED PREMISE WENT STALE. Both sibling suites
// open by asserting the component's body is untestable — "it CANNOT be rendered
// in jsdom", "the module references supabaseAdmin at import time" — and so both
// test only the exported `distinctSlugLinks` helper, twice, with near-identical
// cases. The component sat at 31.5% st / 7.7% fn under a gate it was inside.
//
// Both halves of that premise stopped being true on 2026-08-17, when the two
// reads were lifted into lib/entity/popular-on-collection-fetchers. The module
// no longer touches supabaseAdmin, and an async server component whose data
// arrives through an injectable module renders under jsdom by simply AWAITING
// it: `render(await PopularOnCollection({ collection }))`. Measured, not
// assumed — this file is the measurement.
//
// What that unlocks is not coverage for its own sake. The component carries the
// repo's honesty contract for this surface, spelled out in its own header: a
// failed read and an empty catalogue BOTH render nothing, deliberately, because
// an anonymous crawler has no use for a degraded notice — and the console.warn
// is the only thing keeping the two distinguishable. Nothing could check that
// while the body was unreachable. An SEO regression whose output is silence is
// the sub-class CLAUDE.md rates worst.

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}))

const fetchers = vi.hoisted(() => ({
  hubs: vi.fn(),
  links: vi.fn(),
}))
vi.mock("@/lib/entity/popular-on-collection-fetchers", () => ({
  fetchHubRows: fetchers.hubs,
  fetchLinkRows: fetchers.links,
}))

import PopularOnCollection from "@/components/entity/PopularOnCollection"

type HubRows = { editions: Array<Record<string, unknown>>; series: Array<Record<string, unknown>> }

const NO_HUBS: HubRows = { editions: [], series: [] }

function seedHubs(data: HubRows = NO_HUBS, ok = true, reason?: string) {
  fetchers.hubs.mockResolvedValue({ data, ok, reason })
}
function seedLinks(data: Array<Record<string, unknown>> = [], ok = true, reason?: string) {
  fetchers.links.mockResolvedValue({ data, ok, reason })
}

/** Await the async server component, then render its element tree. */
async function renderBlock(collection: string) {
  const el = await PopularOnCollection({ collection })
  if (el === null) return { el, container: null as HTMLElement | null }
  const { container } = render(el as any)
  return { el, container }
}

/** Every href the block rendered, in document order. */
function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "")
}

beforeEach(() => {
  seedHubs()
  seedLinks()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("PopularOnCollection — when the block renders nothing at all", () => {
  it("returns null for an unknown collection, without reading anything", async () => {
    const { el } = await renderBlock("pokemon-cards")
    expect(el).toBeNull()
    // The guard is upstream of both reads — a bad slug must not cost a query.
    expect(fetchers.links).not.toHaveBeenCalled()
    expect(fetchers.hubs).not.toHaveBeenCalled()
  })

  it("returns null when the reads SUCCEED and the catalogue is genuinely empty — and logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { el } = await renderBlock("nba-top-shot")
    expect(el).toBeNull()
    // The silence is the point: an empty catalogue is not an incident.
    expect(warn).not.toHaveBeenCalled()
  })

  it("ALSO returns null when both reads FAIL — but logs each one with its reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    seedLinks([], false, "canceling statement due to statement timeout")
    seedHubs(NO_HUBS, false, "upstream request timeout")

    const { el } = await renderBlock("nba-top-shot")

    // ⚠ THE RENDERED OUTPUT IS IDENTICAL TO THE HEALTHY-BUT-EMPTY CASE ABOVE.
    // That is the deliberate design, so the log is the ONLY place the two stay
    // distinguishable — assert the DISTINCTION, not merely that a warn fired.
    expect(el).toBeNull()
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages).toHaveLength(2)
    expect(messages.some((m) => m.includes("links read failed") && m.includes("statement timeout"))).toBe(true)
    expect(messages.some((m) => m.includes("hubs read failed") && m.includes("upstream request timeout"))).toBe(true)
    // The collection has to be in there or the log can't be triaged.
    expect(messages.every((m) => m.includes("nba-top-shot"))).toBe(true)
  })

  it("warns for the failed leg only when the other leg succeeded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    seedLinks([{ external_id: "e1", player_name: "Damian Lillard", set_name: "Base Set" }])
    seedHubs(NO_HUBS, false, "boom")

    const { container } = await renderBlock("nba-top-shot")

    // A partial failure still renders what it has — losing the working half
    // would turn one failed query into a fully deleted crawl path.
    expect(hrefs(container!)).toContain("/nba-top-shot/edition/e1")
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("hubs read failed")
  })
})

describe("PopularOnCollection — edition tiles", () => {
  it("links a standard collection on external_id and labels it with the player", async () => {
    seedLinks([{ external_id: "abc 123", player_name: "Damian Lillard", set_name: "Base Set" }])
    const { container } = await renderBlock("nba-top-shot")
    // The id is URL-encoded — an unencoded space produces a 404 link.
    expect(hrefs(container!)).toContain("/nba-top-shot/edition/abc%20123")
    expect(container!.textContent).toContain("Damian Lillard")
    expect(container!.textContent).toContain("Base Set")
  })

  it("labels a TEAM moment (no player) as '<team> <play>' rather than dropping it", async () => {
    seedLinks([{ external_id: "e2", player_name: null, team_name: "Chicago Bulls", play_type: "Reel", set_name: "Season Rewind" }])
    const { container } = await renderBlock("nba-top-shot")
    expect(container!.textContent).toContain("Chicago Bulls Reel")
  })

  it("omits the sub-line entirely when set_name is null", async () => {
    seedLinks([{ external_id: "e3", player_name: "Solo", set_name: null }])
    const { container } = await renderBlock("nba-top-shot")
    const tile = container!.querySelector('a[href="/nba-top-shot/edition/e3"]')!
    expect(tile.textContent).toBe("Solo")
    expect(tile.children).toHaveLength(1)
  })

  it("links Disney Pinnacle on `id` (a text key) and labels it with character_name", async () => {
    seedLinks([{ id: "pin-7", character_name: "Mickey Mouse", set_name: "Pin Set" }])
    const { container } = await renderBlock("disney-pinnacle")
    // ⚠ Pinnacle editions live in a different table with text ids, and the
    // edition page resolves them on pe.id — an external_id href would 404.
    expect(hrefs(container!)).toContain("/disney-pinnacle/edition/pin-7")
    expect(container!.textContent).toContain("Mickey Mouse")
  })
})

describe("PopularOnCollection — hub rows", () => {
  const FULL_HUBS: HubRows = {
    editions: [
      { set_name: "Base Set", player_name: "Damian Lillard", team_name: "Portland Trail Blazers" },
      { set_name: "Base Set", player_name: "damian lillard", team_name: "Team LeBron" },
    ],
    series: [{ display_label: "Series 5" }],
  }

  it("renders one pill row per non-empty group, deduped and slugified", async () => {
    seedHubs(FULL_HUBS)
    const { container } = await renderBlock("nba-top-shot")
    const all = hrefs(container!)
    expect(all).toContain("/nba-top-shot/set/base-set")
    expect(all).toContain("/nba-top-shot/player/damian-lillard")
    expect(all).toContain("/nba-top-shot/series/series-5")
    // "damian lillard" collapses into the first spelling.
    expect(all.filter((h) => h.includes("/player/"))).toHaveLength(1)
    for (const label of ["Sets", "Players", "Teams", "Series"]) {
      expect(container!.textContent).toContain(label)
    }
  })

  it("drops exhibition rosters from the TEAMS row only", async () => {
    seedHubs(FULL_HUBS)
    const { container } = await renderBlock("nba-top-shot")
    const teamHrefs = hrefs(container!).filter((h) => h.includes("/team/"))
    expect(teamHrefs).toEqual(["/nba-top-shot/team/portland-trail-blazers"])
  })

  it("omits a group's heading entirely when it has no links (UFC Strike has no teams)", async () => {
    seedHubs({ editions: [{ set_name: "Fight Night", player_name: "Jon Jones", team_name: null }], series: [] })
    const { container } = await renderBlock("ufc")
    expect(container!.textContent).toContain("Sets")
    expect(container!.textContent).not.toContain("Teams")
    expect(container!.textContent).not.toContain("Series")
  })

  it("skips the hub read for Disney Pinnacle by design, keeping only the edition fan-out", async () => {
    seedLinks([{ id: "pin-7", character_name: "Mickey Mouse", set_name: "Pin Set" }])
    const { container } = await renderBlock("disney-pinnacle")
    // Pinnacle set/player/team/series hubs are not in the sitemap, so linking
    // them would manufacture crawl waste. The read must not even be attempted.
    expect(fetchers.hubs).not.toHaveBeenCalled()
    expect(hrefs(container!).some((h) => /\/(set|player|team|series)\//.test(h))).toBe(false)
  })
})

describe("PopularOnCollection — the section frame", () => {
  it("names the collection and carries the public /insights link", async () => {
    seedLinks([{ external_id: "e1", player_name: "Damian Lillard", set_name: "Base Set" }])
    const { container } = await renderBlock("nba-top-shot")
    const section = container!.querySelector("section")!
    expect(within(section as HTMLElement).getByText(/Explore the NBA Top Shot catalog/)).toBeTruthy()
    // /insights is anon-public; every other prominent link on /overview points
    // at an auth-gated tab, which is the whole reason this block exists.
    expect(hrefs(container!)).toContain("/insights")
  })

  it("renders on hubs ALONE when the edition read came back empty", async () => {
    seedHubs({ editions: [{ set_name: "Base Set" }], series: [] })
    const { container } = await renderBlock("nba-top-shot")
    expect(container).not.toBeNull()
    expect(hrefs(container!)).toContain("/nba-top-shot/set/base-set")
  })
})
