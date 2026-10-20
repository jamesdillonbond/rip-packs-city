import { appendFileSync } from "node:fs"
import { test, expect } from "playwright/test"
import AxeBuilder from "@axe-core/playwright"

// Accessibility audit (platform review 2026-10-11, C10; promoted 2026-10-18): axe-core
// over anon-public routes in BOTH themes, run by the `a11y-audit` job in
// .github/workflows/e2e-smoke.yml against SMOKE_BASE_URL (production by default), on
// the 6h schedule and on dispatch.
//
// ⭐ PROMOTED TO A GATE 2026-10-18. The 10-17/18 work (known-issues #194,
// docs/reference/text-colour-system.md) took `color-contrast` to ZERO on every route
// in both themes apart from ONE accepted exception, and `select-name` to zero — so
// those two rules are now BLOCKING. Every other serious/critical rule is still
// PRINTED but does not fail the run, EXCEPT `nested-interactive` and
// `aria-conditional-attr`: the #196 row-interactivity pattern, redesigned 10-18
// (disclosure buttons), read 0 on the Sniper and Collection routes in both themes on
// production (run 39180539821) and were GATED the same evening.
// Move a rule into GATED once it reads zero; never move one out to make a run green.
//
// ⛔ THE ONE EXCLUSION is the accepted pre-launch exception (roadmap-status "Brand
// red on small text"): white text on a #E03A2F fill, plus the login `.rpc-live-pill`
// (the same white-on-red, read mid-flicker by its CRT animation). It is matched by
// SIGNATURE (colours / selector), never by route — a new contrast failure anywhere
// else still fails.

const ROUTES = [
  "/",
  "/insights",
  "/insights/squeeze",
  "/insights/rookies",
  "/nba-top-shot/overview",
  "/nba-top-shot/market",
  "/nba-top-shot/packs",
  "/nba-top-shot/analytics",
  "/nba-top-shot/sets",
  "/nfl-all-day/overview",
  "/legal/fmv-methodology",
  // #196's two surfaces (added 10-18): the Sniper's rows and a populated Collection
  // tab (the wallet the unit tests use) — the only routes where `nested-interactive`
  // and `aria-conditional-attr` ever fired. Without them those rules read zero by
  // not looking.
  "/nba-top-shot/sniper",
  "/nba-top-shot/collection?wallet=0xbd94cade097e50ac",
]
const THEMES = ["dark", "light"] as const
const SERIOUS = new Set(["serious", "critical"])
const GATED = new Set(["color-contrast", "select-name", "nested-interactive", "aria-conditional-attr"])
const SUMMARY = "a11y-summary.md"

// Same settle as e2e/healthy-page.ts: `load` fires before a streaming App
// Router page has finished rendering, and axe must read the hydrated DOM.
const SETTLE_MS = 1_500

// ⚠ WAIT FOR THE DATA, NOT A CLOCK (2026-10-20). Until this date the audit ran
// 1.5 s after `load`, which on a client-fetched page is BEFORE its data renders.
// /nba-top-shot/packs passed every run in 3.1 s INCLUDING axe — impossible on the
// rendered page (30,590 elements, 500 rows; axe takes 107–124 s on it, measured
// locally against captured production responses). The gate had been auditing a
// loading state. On 10-20 the 700 KB /api/packs response began landing inside
// the 1.5 s window and axe never finished. So: wait for the network to go quiet
// (capped — a page that polls never does), then settle.
const NETWORK_IDLE_CAP_MS = 15_000

// ⚠ ROW SCOPE. A long table's rows are one template repeated, so axe audits the
// first 25 rows of every <tbody> and skips the rest: packs 124 s → ~20 s with
// 343 table nodes still contrast-checked. The cost, stated: a defect that only a
// row PAST 25 can show (a chip colour for a tier that first appears in row 40)
// is not seen. Auditing 25 rows beats the zero this gate was really auditing.
const ROW_SCOPE_EXCLUDE = "tbody > tr:nth-child(n+26)"

// ⚠ A ROUTE WHOSE CONTENT IS A TABLE MUST SHOW ITS ROWS BEFORE IT CAN PASS. An
// audit of a loading or error state is a check that did not run, and it read
// as a 3 s green on /nba-top-shot/packs for as long as the route has been listed
// (its "296 elements, 0 table rows, 45 rules passed" is that state — reproduced
// locally with the data unreachable). Waited for, then asserted.
const MIN_TABLE_ROWS: Record<string, number> = {
  "/nba-top-shot/packs": 25,
}
const ROWS_WAIT_MS = 20_000

// ⚠ AXE GETS A BUDGET OF ITS OWN. Before 10-20 an axe run that never finished
// hit the TEST timeout inside `frame.evaluate` and wrote NOTHING to
// a11y-summary.md — the route was simply absent from the summary. Now the
// overrun is a NAMED failure in the summary, with the DOM size measured BEFORE
// axe started (axe runs on the page's main thread, so a probe sent while it is
// still running blocks behind it and proves nothing). It still FAILS — a route
// axe cannot audit is not a passing route.
const AXE_BUDGET_MS = 45_000
const TEST_TIMEOUT_MS = 90_000

function within<T>(ms: number, p: Promise<T>): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))])
}

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number]
type AxeNode = Violation["nodes"][number]

/** The accepted white-on-#E03A2F exception, by signature. */
export function isAcceptedException(v: Pick<Violation, "id">, n: Pick<AxeNode, "target" | "any">): boolean {
  if (v.id !== "color-contrast") return false
  const target = (Array.isArray(n.target) ? n.target.join(" ") : String(n.target))
  if (target.includes("rpc-live-pill")) return true
  const d = (n.any?.[0]?.data ?? {}) as { fgColor?: string; bgColor?: string }
  const fg = String(d.fgColor ?? "").toLowerCase(), bg = String(d.bgColor ?? "").toLowerCase()
  return bg === "#e03a2f" && /^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/.test(fg)
}

function describeViolation(v: Violation, nodes: AxeNode[] = v.nodes): string {
  const targets = nodes
    .slice(0, 3)
    .map((n) => (Array.isArray(n.target) ? n.target.join(" ") : String(n.target)))
    .join(" | ")
  return `${v.impact ?? "unknown"} · ${v.id} (${nodes.length} node${nodes.length === 1 ? "" : "s"}): ${v.help} — ${targets}`
}

for (const path of ROUTES) for (const theme of THEMES) {
  test(`axe: ${path} [${theme}]`, async ({ page }) => {
    test.setTimeout(TEST_TIMEOUT_MS)
    const url = theme === "light" ? `${path}${path.includes("?") ? "&" : "?"}theme=light` : path
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" })
    expect(resp, `no HTTP response for ${url}`).toBeTruthy()
    expect(resp!.status(), `${url} returned HTTP ${resp!.status()}`).toBeLessThan(400)
    await page.waitForLoadState("load").catch(() => {})
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_CAP_MS }).catch(() => {})
    await page.waitForTimeout(SETTLE_MS)

    const minRows = MIN_TABLE_ROWS[path] ?? 0
    if (minRows > 0) {
      await page.locator(`tbody > tr:nth-child(${minRows})`).first().waitFor({ timeout: ROWS_WAIT_MS }).catch(() => {})
    }

    // What axe is about to read — printed for every route, so an audit of a
    // loading state shows up as a tiny element count instead of a fast green.
    const dom = await page.evaluate(() => ({
      elements: document.getElementsByTagName("*").length,
      rows: document.querySelectorAll("tbody > tr").length,
    }))
    const scope = `${dom.elements} elements, ${dom.rows} table rows (≤25 per table audited)`
    if (dom.rows < minRows) {
      const line = `### ${path} [${theme}] — ❌ not audited: ${scope}; this route must show ≥${minRows} rows (a loading or error state is not the page)\n`
      console.log(line)
      appendFileSync(SUMMARY, line + "\n")
      throw new Error(`${url}: only ${dom.rows} table rows after ${ROWS_WAIT_MS / 1000}s (need ≥${minRows}) — the audit would read a loading or error state`)
    }

    const t0 = Date.now()
    const outcome = await within(AXE_BUDGET_MS, new AxeBuilder({ page }).exclude(ROW_SCOPE_EXCLUDE).analyze())
    if (outcome === "timeout") {
      const line = `### ${path} [${theme}] — ❌ axe did not finish in ${AXE_BUDGET_MS / 1000}s on ${scope}\n`
      console.log(line)
      appendFileSync(SUMMARY, line + "\n")
      throw new Error(`${url}: axe did not finish in ${AXE_BUDGET_MS / 1000}s (${Date.now() - t0}ms) on ${scope}`)
    }
    const results = outcome
    const gated: string[] = [], reported: string[] = [], advisory: string[] = []
    let excepted = 0
    for (const v of results.violations) {
      const nodes = v.nodes.filter((n) => !isAcceptedException(v, n))
      excepted += v.nodes.length - nodes.length
      if (!nodes.length) continue
      if (SERIOUS.has(v.impact ?? "") && GATED.has(v.id)) gated.push(describeViolation(v, nodes))
      else if (SERIOUS.has(v.impact ?? "")) reported.push(describeViolation(v, nodes))
      else advisory.push(describeViolation(v, nodes))
    }

    // Everything is PRINTED, whatever the verdict: the reported and advisory tiers are
    // the backlog, and a green run that said nothing would hide it.
    const lines = [
      `### ${path} [${theme}] (${scope}) — ${gated.length} gated, ${reported.length} reported (serious, not gated), ${advisory.length} advisory, ${excepted} accepted-exception node(s), ${results.passes.length} rules passed`,
      ...gated.map((d) => `- ❌ ${d}`),
      ...reported.map((d) => `- ⚠ ${d}`),
      ...advisory.map((d) => `- · ${d}`),
      "",
    ]
    console.log(lines.join("\n"))
    appendFileSync(SUMMARY, lines.join("\n") + "\n")
    await test.info().attach(`axe-${(path + "-" + theme).replace(/[^a-z0-9]+/gi, "_")}.json`, {
      body: JSON.stringify({ path, theme, violations: results.violations, incomplete: results.incomplete }, null, 2),
      contentType: "application/json",
    })

    expect(gated, `${url} has ${gated.length} gated axe violation(s) (${[...GATED].join(" / ")})`).toEqual([])
  })
}
