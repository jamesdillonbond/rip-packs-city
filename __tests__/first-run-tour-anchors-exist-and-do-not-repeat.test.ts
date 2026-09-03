import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// The first-run tour runs on the DASHBOARD and points at elements by
// `data-tour-anchor`. Two defects, one each on consecutive nights:
//   • 2026-09-02: step 2 was anchored to "collection-switcher", which lives on
//     collection pages — on the dashboard the step was centred over nothing.
//   • 2026-09-03: the fix re-anchored it to "saved-wallets-card", the SAME box
//     step 3 spotlights, so the tour sat on one box for two steps.
// Read off the source: every anchor a step names must be minted by the
// dashboard tree (DashboardClient or a component it mounts — the concierge
// launcher lives in SupportChat), and two consecutive steps must not name the
// same one.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8")

const TOUR = read("components/onboarding/FirstRunTour.tsx")
const DASHBOARD_TREE = [
  "app/dashboard/DashboardClient.tsx",
  "components/SupportChat.tsx",
].map(read).join("\n")

/** Anchors in step order, as written in STEPS (`anchor: "…"` only). */
function stepAnchors(): string[] {
  const start = TOUR.indexOf("const STEPS")
  const end = TOUR.indexOf("]", TOUR.indexOf("\n]", start))
  const body = TOUR.slice(start, end)
  return Array.from(body.matchAll(/^\s*anchor:\s*"([^"]+)"/gm)).map((m) => m[1])
}

describe("FirstRunTour anchors", () => {
  const anchors = stepAnchors()

  it("inspected the steps (not-vacuous)", () => {
    expect(anchors.length).toBeGreaterThanOrEqual(4)
  })

  it("every anchored step names an element the dashboard tree mints", () => {
    const missing = anchors.filter((a) => !DASHBOARD_TREE.includes(`data-tour-anchor="${a}"`))
    expect(missing, "a step anchored to an element that is not on the dashboard is centred over nothing").toEqual([])
  })

  it("no two consecutive steps spotlight the same element", () => {
    const repeats = anchors.filter((a, i) => i > 0 && anchors[i - 1] === a)
    expect(repeats).toEqual([])
  })

  it("POSITIVE CONTROL — the parser sees the sniper anchor", () => {
    expect(anchors).toContain("sniper-nav-link")
  })
})
