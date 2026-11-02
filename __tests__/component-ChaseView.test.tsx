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
