// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render, cleanup } from "@testing-library/react"

// The published accuracy gate on /legal/fmv-methodology#accuracy (platform
// review 2026-10-11, M4): components/legal/FmvAccuracyTable.tsx.
//
// The two claims that matter, both phrased as ABSENCES:
//   * a FAILED read renders "unavailable" in every share cell and a notice that
//     names the failure as ours — and no "%" anywhere, so no number can be read
//     off a failed read;
//   * a precompute SENTINEL (999 / -1) in an otherwise-successful read renders
//     "unavailable" for that row only, while measured siblings keep their label;
//     a measured 0.0 renders "<1%", never "0%".
// Plus two SOURCE pins that keep the pointer honest: the methodology page carries
// the `#accuracy` anchor the homepage TRUST band links to, and the TRUST copy
// claims nothing about anyone else.

import FmvAccuracyTable from "@/components/legal/FmvAccuracyTable"
import { ACCURACY_METRIC_COLLECTIONS, buildAccuracyRows, LEG_FAILED_SENTINEL, NO_DENOMINATOR_SENTINEL } from "@/lib/fmv-accuracy/fetchers"

afterEach(() => cleanup())

const AT = "2026-10-12T01:48:00.187Z"
const NOW = Date.parse("2026-10-12T04:00:00Z")

const shareCells = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[1].textContent)

describe("FmvAccuracyTable — a failed read", () => {
  it("renders 'unavailable' for every collection, a notice, and NO percentage anywhere", () => {
    const { container } = render(
      <FmvAccuracyTable result={{ ok: false, rows: null, error: "canceling statement due to statement timeout" }} />
    )
    expect(container.querySelector('[data-state="read-failed"]')).not.toBeNull()
    const cells = shareCells(container)
    expect(cells).toHaveLength(ACCURACY_METRIC_COLLECTIONS.length)
    for (const c of cells) expect(c).toBe("unavailable")
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/\d\s*%/)
    expect(text).not.toContain("0%")
    expect(text).toMatch(/could not be read/)
    expect(text).toMatch(/unknown rather than zero/)
    // The driver message is NOT printed on a public page.
    expect(text).not.toContain("statement timeout")
  })
})

describe("FmvAccuracyTable — a successful read with sentinels among real values", () => {
  const RAW = [
    { metric: "topshot_fmv_high_med_share_pct", value: 56.5, computed_at: AT },
    { metric: "allday_fmv_high_med_share_pct", value: 26.9, computed_at: AT },
    { metric: "pinnacle_fmv_high_med_share_pct", value: 31.9, computed_at: "2026-10-12T03:55:00Z" },
    { metric: "golazos_fmv_high_med_share_pct", value: 0.2, computed_at: AT },
    { metric: "ufc_fmv_high_med_share_pct", value: 0.0, computed_at: AT },
    { metric: "candy_fmv_high_med_share_pct", value: LEG_FAILED_SENTINEL, computed_at: AT },
  ]
  const rows = buildAccuracyRows(RAW, NOW)

  it("labels measured shares as whole percents, sub-1 % as '<1%', and the sentinel as 'unavailable'", () => {
    const { container } = render(<FmvAccuracyTable result={{ ok: true, rows, error: null }} />)
    expect(container.querySelector('[data-state="ok"]')).not.toBeNull()
    const byId = (id: string) => container.querySelector(`tr[data-collection="${id}"]`)!
    expect(byId("nba-top-shot").querySelectorAll("td")[1].textContent).toBe("57%")
    expect(byId("nfl-all-day").querySelectorAll("td")[1].textContent).toBe("27%")
    expect(byId("laliga-golazos").querySelectorAll("td")[1].textContent).toBe("<1%")
    expect(byId("ufc").querySelectorAll("td")[1].textContent).toBe("<1%")
    expect(byId("candy-mlb").querySelectorAll("td")[1].textContent).toBe("unavailable")
    expect(byId("candy-mlb").getAttribute("data-basis")).toBe("leg_failed")
    // The footnote explains the sentinel row, by name.
    expect(container.textContent).toMatch(/Candy MLB: the measuring job failed/)
    // and a bare 0% appears nowhere
    expect(container.textContent).not.toContain("0%")
  })

  it("shows the as-of time in UTC and marks a reading older than 48 h stale", () => {
    const { container } = render(<FmvAccuracyTable result={{ ok: true, rows, error: null }} />)
    const asOf = container.querySelector('tr[data-collection="nba-top-shot"]')!.querySelectorAll("td")[2].textContent
    expect(asOf).toBe("2026-10-12 01:48 UTC")
    // staleness is decided by the fetcher's clock, injected here
    const later = render(
      <FmvAccuracyTable result={{ ok: true, rows: buildAccuracyRows(RAW, Date.parse("2026-10-15T00:00:00Z")), error: null }} />
    )
    const stale = later.container.querySelector('tr[data-collection="nba-top-shot"]')!.querySelectorAll("td")[2].textContent
    expect(stale).toContain("(stale)")
  })

  it("the -1 sentinel and a missing row are 'unavailable' with their own footnotes", () => {
    const r2 = buildAccuracyRows([
      { metric: "ufc_fmv_high_med_share_pct", value: NO_DENOMINATOR_SENTINEL, computed_at: AT },
    ], NOW)
    const { container } = render(<FmvAccuracyTable result={{ ok: true, rows: r2, error: null }} />)
    const cells = shareCells(container)
    for (const c of cells) expect(c).toBe("unavailable")
    expect(container.textContent).toMatch(/UFC Strike: no priced editions in the window/)
    expect(container.textContent).toMatch(/NBA Top Shot: no reading published yet/)
    // the sentinel itself is never printed as a value (the as-of date legitimately contains "-1")
    for (const c of cells) expect(c).not.toMatch(/-1/)
    expect(container.textContent).not.toMatch(/-1%/)
  })
})

describe("the pointer from the homepage TRUST band lands on the table", () => {
  const page = readFileSync(join(process.cwd(), "app/legal/fmv-methodology/page.tsx"), "utf8")
  const home = readFileSync(join(process.cwd(), "components/HomePageMarketing.tsx"), "utf8")

  it("the methodology page carries the #accuracy anchor and renders the table from the fetcher", () => {
    expect(page).toMatch(/id="accuracy"/)
    expect(page).toMatch(/fetchFmvAccuracyGate\(\)/)
    expect(page).toMatch(/<FmvAccuracyTable result=\{accuracy\}/)
    // The page must NOT hold a client of its own (server-page data-access ratchet).
    expect(page).not.toMatch(/from ["']@\/lib\/supabase["']/)
  })

  it("the TRUST band links to /legal/fmv-methodology#accuracy and claims nothing about anyone else", () => {
    expect(home).toContain('href: "/legal/fmv-methodology#accuracy"')
    const trustBlock = home.slice(home.indexOf("const TRUST"), home.indexOf("];", home.indexOf("const TRUST")))
    expect(trustBlock).not.toMatch(/more accurate|most accurate|better than|beats?\b|than any|only platform|#1\b/i)
  })
})
