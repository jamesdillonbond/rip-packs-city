// @vitest-environment jsdom
//
// /my-teams "Players you follow" (2026-10-31). A FAILED read must not say "follow a
// player" to someone who follows several; the list links each player's hub.
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import FollowedPlayers from "@/components/entity/FollowedPlayers"
import { fetchFollowedPlayers } from "@/lib/fan-teams/followed-players"

afterEach(cleanup)

describe("FollowedPlayers", () => {
  it("lists followed players linking /players/<slug>", () => {
    const { container } = render(<FollowedPlayers ok players={[
      { slug: "nikola-jokic", name: "Nikola Jokić", collection: null },
      { slug: "stitch", name: "Stitch", collection: "disney-pinnacle" },
    ]} />)
    expect(container.querySelector('a[href="/players/nikola-jokic"]')?.textContent).toContain("Nikola Jokić")
    // a Pinnacle character (no cross-collection hub) links its collection page
    expect(container.querySelector('a[href="/disney-pinnacle/character/stitch"]')?.textContent).toContain("Stitch")
    // 2026-10-31 (Trevor): Pinnacle follows are CHARACTERS, under their own heading
    expect(container.textContent).toMatch(/Players you follow/)
    expect(container.textContent).toMatch(/Characters you follow/)
  })
  it("a failed read says so and does not invite them to follow", () => {
    const { container } = render(<FollowedPlayers ok={false} players={[]} />)
    expect(container.textContent).toMatch(/couldn.t be loaded/i)
    expect(container.textContent).not.toMatch(/Follow a player/)
  })
  it("none yet -> how to follow", () => {
    const { container } = render(<FollowedPlayers ok players={[]} />)
    expect(container.textContent).toMatch(/Follow a player/)
  })
  it("only characters followed -> no 'Players you follow' heading", () => {
    const { container } = render(<FollowedPlayers ok players={[{ slug: "goofy", name: "Goofy", collection: "disney-pinnacle" }]} />)
    expect(container.textContent).toMatch(/Characters you follow/)
    expect(container.textContent).not.toMatch(/Players you follow/)
  })
})

describe("fetchFollowedPlayers", () => {
  const session = (res: { data: unknown; error: unknown }) => ({
    from: () => ({ select: () => ({ order: () => ({ order: () => ({ limit: async () => res }) }) }) }),
  })
  it("ok:false on a read error (never an empty list as 'none')", async () => {
    expect(await fetchFollowedPlayers(session({ data: null, error: { message: "x" } }))).toEqual({ players: [], ok: false })
  })
  it("maps rows", async () => {
    expect(await fetchFollowedPlayers(session({ data: [{ player_slug: "a-b", display_name: "A B", collection_slug: "" }, { player_slug: "c", display_name: "C", collection_slug: "disney-pinnacle" }], error: null }))).toEqual({ players: [{ slug: "a-b", name: "A B", collection: null }, { slug: "c", name: "C", collection: "disney-pinnacle" }], ok: true })
  })
})
