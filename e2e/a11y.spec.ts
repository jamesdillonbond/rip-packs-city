import { appendFileSync } from "node:fs"
import { test, expect } from "playwright/test"
import AxeBuilder from "@axe-core/playwright"

// Accessibility audit (platform review 2026-10-11, C10): axe-core over five
// anon-public routes, run by the `a11y-audit` job in
// .github/workflows/e2e-smoke.yml against SMOKE_BASE_URL (production by
// default), on the 6h schedule and on dispatch.
//
// ⚠ NON-BLOCKING BY DESIGN. The job runs this spec under `continue-on-error`,
// so a failure here is REPORTED (step log, job summary via a11y-summary.md,
// uploaded artifact) and never reds the workflow. A brand-new red gate on a
// surface nobody has measured helps nobody. Promote it to blocking only once a
// scheduled run reads zero serious/critical on every route.
//
// Severity policy: `serious` and `critical` violations FAIL the test; `minor`
// and `moderate` are printed and attached but never fail. Impact is axe's own
// classification per rule (e.g. color-contrast and button-name are serious,
// region/landmark rules are moderate).

const ROUTES = ["/", "/insights", "/insights/squeeze", "/nba-top-shot/overview", "/legal/fmv-methodology"]
const BLOCKING = new Set(["serious", "critical"])
const SUMMARY = "a11y-summary.md"

// Same settle as e2e/healthy-page.ts: `load` fires before a streaming App
// Router page has finished rendering, and axe must read the hydrated DOM.
const SETTLE_MS = 1_500

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number]

function describeViolation(v: Violation): string {
  const targets = v.nodes
    .slice(0, 3)
    .map((n) => (Array.isArray(n.target) ? n.target.join(" ") : String(n.target)))
    .join(" | ")
  return `${v.impact ?? "unknown"} · ${v.id} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}): ${v.help} — ${targets}`
}

for (const path of ROUTES) {
  test(`axe: ${path}`, async ({ page }) => {
    const resp = await page.goto(path, { waitUntil: "domcontentloaded" })
    expect(resp, `no HTTP response for ${path}`).toBeTruthy()
    expect(resp!.status(), `${path} returned HTTP ${resp!.status()}`).toBeLessThan(400)
    await page.waitForLoadState("load").catch(() => {})
    await page.waitForTimeout(SETTLE_MS)

    const results = await new AxeBuilder({ page }).analyze()
    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""))
    const advisory = results.violations.filter((v) => !BLOCKING.has(v.impact ?? ""))

    // Everything is PRINTED, whatever the verdict: the advisory tier is the
    // backlog, and a green run that said nothing would hide it.
    const lines = [
      `### ${path} — ${blocking.length} blocking (serious/critical), ${advisory.length} advisory, ${results.passes.length} rules passed`,
      ...blocking.map((v) => `- ❌ ${describeViolation(v)}`),
      ...advisory.map((v) => `- ⚠ ${describeViolation(v)}`),
      "",
    ]
    console.log(lines.join("\n"))
    appendFileSync(SUMMARY, lines.join("\n") + "\n")
    await test.info().attach(`axe-${path.replace(/[^a-z0-9]+/gi, "_") || "root"}.json`, {
      body: JSON.stringify({ path, violations: results.violations, incomplete: results.incomplete }, null, 2),
      contentType: "application/json",
    })

    expect(
      blocking.map(describeViolation),
      `${path} has ${blocking.length} serious/critical axe violation(s)`,
    ).toEqual([])
  })
}
