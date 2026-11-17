// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// The shareable trophy-case page.
//
// This URL is meant to be pasted into a Discord or a DM, so the failure mode
// that matters is the one this repo keeps paying for: a transient read failure
// rendering as a claim about the collector. Here that claim would be "this
// person has no trophies" on the page they just shared to show off their
// trophies.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/components/RpcLogo", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/ShareProfileButtons", () => ({
  default: ({ trophyCount, surface, referrerId }: { trophyCount?: number; surface?: string; referrerId?: string | null }) => (
    <div data-testid="share-buttons" data-count={String(trophyCount)} data-surface={String(surface)} data-ref={String(referrerId ?? "")} />
  ),
}))
vi.mock("@/components/TrophySlab", () => ({
  default: ({ slab }: any) => <div data-testid="slab">{slab?.player_name ?? "slab"}</div>,
}))

import TrophyCaseShareClient from "@/app/profile/[username]/trophy-case/TrophyCaseShareClient"

const trophy = (id: string, player: string) => ({ moment_id: id, player_name: player })

const base = {
  username: "trevor",
  displayName: "Trevor",
  accentColor: null,
  trophies: [] as Array<Record<string, unknown>>,
  readFailed: false,
}

afterEach(cleanup)

describe("TrophyCaseShareClient", () => {
  it("renders the pinned Moments", () => {
    render(
      <TrophyCaseShareClient
        {...base}
        trophies={[trophy("m1", "Damian Lillard"), trophy("m2", "Anfernee Simons")]}
      />,
    )
    expect(screen.getAllByTestId("slab")).toHaveLength(2)
    expect(screen.getByText("Damian Lillard")).toBeTruthy()
  })

  it("says WE could not load it when the read failed", () => {
    const { container } = render(<TrophyCaseShareClient {...base} readFailed />)
    expect(container.textContent).toMatch(/Couldn’t load this trophy case/i)
    expect(container.textContent).not.toMatch(/No trophies pinned yet/i)
  })

  it("still says NO TROPHIES for a genuinely empty case", () => {
    // The mirror. Over-correcting would make every new collector's page look
    // broken instead of new.
    const { container } = render(<TrophyCaseShareClient {...base} />)
    expect(container.textContent).toMatch(/No trophies pinned yet/i)
    expect(container.textContent).not.toMatch(/Couldn’t load/i)
  })

  it("caps at six slots even if handed more", () => {
    render(
      <TrophyCaseShareClient
        {...base}
        trophies={Array.from({ length: 9 }, (_, i) => trophy(`m${i}`, `P${i}`))}
      />,
    )
    expect(screen.getAllByTestId("slab")).toHaveLength(6)
  })

  it("drops rows with no moment_id rather than rendering an empty slab", () => {
    render(<TrophyCaseShareClient {...base} trophies={[trophy("m1", "Dame"), { slot: 2 }]} />)
    expect(screen.getAllByTestId("slab")).toHaveLength(1)
  })

  it("tells the share buttons how many trophies are up", () => {
    // So the tweet can claim a full case only when it is one.
    render(<TrophyCaseShareClient {...base} trophies={[trophy("m1", "A"), trophy("m2", "B")]} />)
    expect(screen.getByTestId("share-buttons").getAttribute("data-count")).toBe("2")
  })

  it("shares ITSELF — the trophy-case surface, not the profile (2026-09-02 QA #3)", () => {
    render(<TrophyCaseShareClient {...base} trophies={[trophy("m1", "A")]} />)
    expect(screen.getByTestId("share-buttons").getAttribute("data-surface")).toBe("trophy-case")
  })

  it("renders NO share buttons when the read failed — a case we could not read is not shareable", () => {
    // Was: share buttons rendered with trophyCount 0. A tweet about a case we
    // failed to read would claim something about it either way.
    render(<TrophyCaseShareClient {...base} readFailed />)
    expect(screen.queryByTestId("share-buttons")).toBeNull()
    expect(screen.queryByText(/\b0 trophy/i)).toBeNull()
  })

  // Re-QA 2026-09-03 (qa0903b, a fresh handle with nothing pinned): the page
  // offered SHARE ON X for an empty case and told the OWNER to "build your
  // own". Nothing to share until something is pinned; the owner is sent to
  // pin, the visitor is invited to build.
  it("renders no share buttons for an empty case", () => {
    render(<TrophyCaseShareClient {...base} />)
    expect(screen.queryByTestId("share-buttons")).toBeNull()
    expect(screen.getByText(/No trophies pinned yet/i)).toBeTruthy()
  })

  it("links back to the full profile", () => {
    const { container } = render(<TrophyCaseShareClient {...base} />)
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/profile/trevor")
  })

  it("URL-encodes the handle in its links", () => {
    const { container } = render(<TrophyCaseShareClient {...base} username="a b" />)
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs.some((h) => h?.includes("a%20b"))).toBe(true)
  })
})

// 2026-09-02 (QA #3): a share from this page carries the viewer's id as &ref=,
// read from /api/profile/me — and a failed read leaves it null rather than
// inventing one.
describe("TrophyCaseShareClient — the viewer's ref", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("passes the signed-in viewer's id to the share buttons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ user: { id: "u-77" } }) })))
    render(<TrophyCaseShareClient {...base} trophies={[trophy("m1", "A")]} />)
    await waitFor(() => expect(screen.getByTestId("share-buttons").getAttribute("data-ref")).toBe("u-77"))
  })

  it("leaves the ref empty when the read fails or the viewer is anonymous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    render(<TrophyCaseShareClient {...base} trophies={[trophy("m1", "A")]} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByTestId("share-buttons").getAttribute("data-ref")).toBe("")
  })
})

describe("TrophyCaseShareClient — owner vs visitor copy", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends the OWNER of an empty case to pin, and labels the CTA as editing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ user: { id: "u-1", username: "Trevor" } }) })))
    const { container } = render(<TrophyCaseShareClient {...base} />)
    await waitFor(() => expect(container.querySelector("[data-owner-empty-cta]")).not.toBeNull())
    expect(container.querySelector("[data-owner-empty-cta]")?.getAttribute("href")).toBe("/dashboard")
    expect(container.textContent).toMatch(/EDIT YOUR TROPHY CASE/)
    expect(container.textContent).not.toMatch(/BUILD YOUR OWN/)
  })

  it("keeps the visitor copy for anyone else — including a viewer whose Top Shot name is not a handle", async () => {
    // /api/profile/me ships username: null for a signed-in collector with no
    // handle (and the Top Shot name separately as topshot_username); that
    // viewer is NOT the owner of anyone's page.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ user: { id: "u-2", username: null, topshot_username: "trevor" } }) })))
    const { container } = render(<TrophyCaseShareClient {...base} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector("[data-owner-empty-cta]")).toBeNull()
    expect(container.textContent).toMatch(/BUILD YOUR OWN TROPHY CASE/)
  })
})
