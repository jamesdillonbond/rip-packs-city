// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import PlayersGridPaginated, { type PlayerTile } from "@/components/entity/PlayersGridPaginated"

// IMAGE-WEIGHT MITIGATION GUARD (2026-07-25).
//
// When a player has no `headshot_url` these ~200px tiles fall back to
// `portrait_thumbnail`, which for Top Shot is a full-resolution IPFS master —
// measured live at 397 KB–3.44 MB, and /nba-top-shot/team/memphis-grizzlies falls
// back for 53 of them (the bulk of that page's ~27 MB of media). There is no
// resizable upstream to prefer here: PlayerTile carries no rep_nft_id and the IPFS
// gateways ignore ?width=. So the available mitigations are layout reservation and
// deferral, and dropping them silently restores the blank-tile flash plus a burst
// of dozens of multi-megabyte fetches.
afterEach(cleanup)

const tile = (over: Partial<PlayerTile> = {}): PlayerTile => ({
  name: "Jaren Jackson Jr.",
  player_slug: "jaren-jackson-jr",
  headshot_url: null,
  jersey_number: 13,
  position: "F",
  edition_count: 12,
  total_circulation: 5000,
  fmv_total_usd: 100,
  portrait_thumbnail: "https://ipfs.dapperlabs.com/ipfs/QmPORTRAIT",
  ...over,
})

function mount(items: PlayerTile[]) {
  return render(
    <PlayersGridPaginated
      collectionUrlSlug="nba-top-shot"
      fetchUrl="/api/entity/team-players?slug=x"
      initial={items}
      pageSize={24}
      isFranchise={false}
    />,
  )
}

describe("PlayersGridPaginated image weight", () => {
  it("reserves layout with intrinsic dimensions on the portrait fallback", () => {
    const { container } = mount([tile()])
    const img = container.querySelector("img")!
    expect(img.getAttribute("width")).toBe("200")
    expect(img.getAttribute("height")).toBe("200")
  })

  it("defers and async-decodes so dozens of masters are not fetched at once", () => {
    const { container } = mount([tile()])
    const img = container.querySelector("img")!
    expect(img.getAttribute("loading")).toBe("lazy")
    expect(img.getAttribute("decoding")).toBe("async")
  })

  it("routes the IPFS portrait through the same-origin proxy", () => {
    const { container } = mount([tile()])
    expect(container.querySelector("img")!.getAttribute("src")).toBe(
      "/api/public/ipfs-media/QmPORTRAIT",
    )
  })

  it("still prefers a real headshot over the portrait master when present", () => {
    const { container } = mount([tile({ headshot_url: "https://cdn.example/head.png" })])
    const img = container.querySelector("img")!
    expect(img.getAttribute("src")).toBe("https://cdn.example/head.png")
    // The mitigations apply to the headshot path too.
    expect(img.getAttribute("loading")).toBe("lazy")
    expect(img.getAttribute("width")).toBe("200")
  })

  it("applies the mitigations to every tile, not just the first", () => {
    const { container } = mount([
      tile(),
      tile({ name: "Ty Jerome", player_slug: "ty-jerome" }),
      tile({ name: "Cedric Coward", player_slug: "cedric-coward" }),
    ])
    const imgs = [...container.querySelectorAll("img")]
    expect(imgs).toHaveLength(3)
    for (const i of imgs) {
      expect(i.getAttribute("loading")).toBe("lazy")
      expect(i.getAttribute("width")).toBe("200")
      expect(i.getAttribute("height")).toBe("200")
    }
  })
})
