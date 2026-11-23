import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// 2026-11-22 (review of the portfolio rework 7fa4dfc84 / eefb11849): the single-number rework kept the
// pack note under Portfolio FMV only and dropped the dashboard's "as of Nh ago" with the breakdown captions.
// So Total Assets silently left sealed packs out while their read was in flight or failed, the profile's
// share button could tweet that Moments-only figure as the whole portfolio, and a cache hours old read as
// current. Source pins: each surface must keep saying what its number leaves out.
const dash = readFileSync("app/dashboard/DashboardClient.tsx", "utf8")
const profile = readFileSync("app/profile/[username]/ProfileClient.tsx", "utf8")

function tile(src: string, label: string): string {
  const at = src.indexOf(`label="${label}"`)
  expect(at, `StatTile ${label} not found`).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf("/>", at))
}

describe("portfolio totals say what they leave out", () => {
  it("dashboard Total Assets carries the sealed-pack note", () => {
    expect(tile(dash, "Total Assets")).toMatch(/caption=\{walletTotalCaption\(heldPacks, heldPacksFailed/)
  })

  it("dashboard Portfolio FMV carries the pack note AND the cache age", () => {
    const t = tile(dash, "Portfolio FMV")
    expect(t).toMatch(/walletTotalCaption\(heldPacks, heldPacksFailed/)
    expect(t).toMatch(/cacheAgeHours != null \? `as of \$\{Math\.round\(cacheAgeHours\)\}h ago`/)
    expect(dash).toMatch(/const cacheAgeHours = useMemo\(/)
  })

  it("profile Total Assets shows the pack note, and the tweet waits for the pack read", () => {
    expect(profile).toMatch(/const packsSettledOk = !heldPacksFailed && heldPacks != null/)
    expect(profile).toMatch(/fmv=\{packsSettledOk \? portfolioTotal : null\} moments=\{packsSettledOk \? totalAssets : null\}/)
    const after = profile.slice(profile.indexOf(">TOTAL ASSETS<"))
    expect(after.slice(0, 600)).toMatch(/\{assetsNote && \(/)
  })
})
