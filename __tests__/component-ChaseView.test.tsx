// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor, screen } from "@testing-library/react"

// ChaseView — three states, never two: a failed read must not render as
// "No buyable pack still holds…" (an empty state that CONCLUDES).

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import ChaseView from "@/components/packs/ChaseView"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stub(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })))
}

const row = {
  distId: "8903", title: "Rookie Year Royalty Pack", imageUrl: null, tier: "legendary",
  remaining: 1, original: 3, unopened: 18, totalPacks: 719,
  per100Now: 100 / 18, per100Launch: 300 / 719, vsLaunch: (100 / 18) / (300 / 719),
  buyable: true, asOf: new Date().toISOString(),
}

describe("ChaseView", () => {
  it("renders a row with density, launch comparison and a dist link", async () => {
    stub(200, { rows: [row], total: 1, refuted: 0 })
    render(<ChaseView collection="nba-top-shot" accent="var(--rpc-red)" />)
    await waitFor(() => expect(screen.getByText("Rookie Year Royalty Pack")).toBeTruthy())
    expect(screen.getByText("5.6")).toBeTruthy()
    expect(screen.getByText("13× launch rate")).toBeTruthy()
    expect(screen.getByText("Rookie Year Royalty Pack").getAttribute("href")).toBe("/nba-top-shot/pack/dist/8903")
    expect(document.body.textContent).not.toMatch(/5\.6\s*%/)
  })

  it("a failed read says it failed and does NOT conclude there is no chase left", async () => {
    stub(503, { error: "x" })
    render(<ChaseView collection="nba-top-shot" accent="var(--rpc-red)" />)
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/No (buyable|sealed) pack still holds/)
  })

  it("an ok empty read says nothing matched", async () => {
    stub(200, { rows: [], total: 0, refuted: 0 })
    render(<ChaseView collection="nba-top-shot" accent="var(--rpc-red)" />)
    await waitFor(() => expect(document.body.textContent).toMatch(/No buyable pack still holds a Legendary/))
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

describe("ChaseView controls", () => {
  it("tier, sort and buyable toggles change the request; Try again re-reads", async () => {
    const urls: string[] = []
    let fail = true
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(u)
      if (fail) { fail = false; return new Response("{}", { status: 500 }) }
      return new Response(JSON.stringify({ rows: [], total: 0, refuted: 0 }), { status: 200 })
    }))
    render(<ChaseView collection="nba-top-shot" accent="var(--rpc-red)" />)
    await waitFor(() => screen.getByText("Try again"))
    screen.getByText("Try again").click()
    await waitFor(() => expect(urls.length).toBe(2))
    screen.getByText("Rare").click()
    await waitFor(() => expect(urls.at(-1)).toContain("tier=rare"))
    screen.getByText("Most left").click()
    await waitFor(() => expect(urls.at(-1)).toContain("sort=remaining"))
    screen.getByText("Buyable only").click()
    await waitFor(() => expect(urls.at(-1)).not.toContain("buyableOnly"))
    await waitFor(() => expect(document.body.textContent).toMatch(/No sealed pack still holds a Rare/))
  })
})
