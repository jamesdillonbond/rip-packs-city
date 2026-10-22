import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * #206 (2026-10-21): Step 5e floored Top Shot parallels at ASK_ONLY from topshot_parallel_asks
 * with NO age test. That table's only writer was unscheduled 09-08 (its GraphQL host is dead), so
 * every row is frozen at 2026-08-27 — and 614 parallels' CURRENT price was a 55-day-old ask × 0.90
 * ($197,853). The property: Step 5e admits only an ask its daily sweep re-observed recently.
 * (A source fact: the step's candidates are one SQL string run through query_sql.)
 */
const src = readFileSync(join(process.cwd(), "app/api/fmv-recalc/route.ts"), "utf8")
const step = src.slice(src.indexOf("// ── Step 5e:"), src.indexOf("// ── Step 5d:"))

describe("fmv-recalc Step 5e — only a recently-swept parallel ask is a live ask", () => {
  it("the step exists and reads topshot_parallel_asks (guards the slice)", () => {
    expect(step.length).toBeGreaterThan(500)
    expect(step).toContain("JOIN topshot_parallel_asks ta ON ta.external_id = e.external_id")
  })
  it("its candidate query gates on the ask's sweep age", () => {
    expect(step).toContain("AND ta.updated_at > now() - interval '${PARALLEL_ASK_MAX_AGE_HOURS} hours'")
  })
  it("the window is two daily sweeps, not a week-old ask passed off as live", () => {
    const m = /const PARALLEL_ASK_MAX_AGE_HOURS = (\d+)/.exec(src)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(48)
  })
})

// #206 (f), 2026-10-21: /moment/52193764 showed "Top Shot ask $915.00" five days after that $915
// listing sold. The moment page now dates the edition floor exactly as the edition page does.
describe("moment page — the edition floor ask carries its age", () => {
  const page = readFileSync(join(process.cwd(), "app/moment/[id]/page.tsx"), "utf8")
  it("stamps only the value the timestamp describes (highOffer.low_ask), via the shared helper", () => {
    expect(page).toContain("const askFromOffers = !isCandyColl && highOffer?.low_ask != null")
    expect(page).toContain("askAgeStamp(askVerifiedAt(highOffer), highOffer?.low_ask, collectionSlugUrl)")
    expect(page).toContain('data-testid="moment-ask-age"')
  })
})
