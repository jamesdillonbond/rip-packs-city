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
// in both themes (the ONE accepted exception was retired 2026-10-24), and `select-name` to zero — so
// those two rules are now BLOCKING. Every other serious/critical rule is still
// PRINTED but does not fail the run, EXCEPT `nested-interactive` and
// `aria-conditional-attr`: the #196 row-interactivity pattern, redesigned 10-18
// (disclosure buttons), read 0 on the Sniper and Collection routes in both themes on
// production (run 39180539821) and were GATED the same evening.
// Move a rule into GATED once it reads zero; never move one out to make a run green.
//
// ✅ NO EXCLUSIONS since 2026-10-24. The one this file carried — white text on a
// #E03A2F fill, plus the login `.rpc-live-pill` — was retired with the exception
// itself: labelled red fills now use --rpc-red-fill (#D93529, white 4.68:1), pinned
// by __tests__/red-fill-contrast.test.ts. Do not re-add a signature carve-out; fix
// the fill.

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
  // The set tracker itself (added 10-20). Bare /sets is the "no wallet loaded"
  // prompt (253 elements) — kept above, it is a real page — but until this route
  // the tracker's 272 set cards (4,464 elements) had never been audited.
  "/nba-top-shot/sets?wallet=0xbd94cade097e50ac",
  // 2026-10-24 (CX/UI pass): routes a wider 162-template axe sweep found failing
  // OUTSIDE this list (light-theme contrast, an unlabelled select) — fixed, then
  // re-read clean on production in both themes before being added here.
  "/help",
  "/insights/parallel-premiums",
  "/insights/candy-mlb",
  "/insights/market",
  "/nba-top-shot/challenges",
  "/disney-pinnacle/sniper",
  "/candy-mlb/packs",
  "/blog",
  // 2026-10-24 (third batch): the red-fill retirement's own surfaces — team chips
  // (readableFill), Panini's segmented control, a market-pulse window tab, and the
  // login live pill — each read 0 violations on production in both themes first.
  "/teams",
  "/insights/panini-squeeze",
  "/insights/market-pulse",
  "/login",
  // 2026-10-25 (fourth batch): the collection share card (the most-viewed page type
  // for real visitors after the Top Shot tabs), the edition and player pages, the
  // market-cap and pack-reality boards, and the newly public /analytics hub — each
  // read 0 serious/critical on production in both themes after that day's fixes
  // (red-text fallback spelling, the share card's dimmed closed-market date).
  "/share/0xbd94cade097e50ac",
  "/nba-top-shot/edition/48%3A1652",
  "/nba-top-shot/player/damian-lillard",
  "/insights/market-cap",
  "/insights/pack-reality",
  "/analytics",
]
const THEMES = ["dark", "light"] as const
const SERIOUS = new Set(["serious", "critical"])
const GATED = new Set(["color-contrast", "select-name", "nested-interactive", "aria-conditional-attr", "scrollable-region-focusable"])
// ⚠ PHONE-WIDTH PASS (2026-10-25). `scrollable-region-focusable` only fires where a
// table is wider than its box — at 390 px, not at this file's 1280 px default. It
// read 16 + 4 + 1 unreachable scrollers on production at phone width while every
// desktop run here was green. So each route is re-read at PHONE_VIEWPORT for the
// rules in PHONE_RULES, and a hit fails the run (the rule is GATED above: it read 0
// at phone width on every route in both themes after lib/a11y/scroll-region.ts
// landed). Only these rules run there, so it adds seconds, not a second audit.
const PHONE_VIEWPORT = { width: 390, height: 844 }
const PHONE_RULES = ["scrollable-region-focusable"]
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

// ⚠ A DATA ROUTE MUST SHOW ITS CONTENT BEFORE IT CAN PASS. An audit of a
// loading or error state is a check that did not run, and it read as a 3 s green
// on /nba-top-shot/packs for as long as the route has been listed (its "296
// elements, 0 table rows, 45 rules passed" is that state — reproduced locally
// with the data unreachable). Waited for, then asserted. Every route that renders
// data is listed; the minimums sit well under what production showed on 10-20
// (packs 500 rows, collection 365, squeeze 200, analytics 55, rookies 61,
// market 50, sets 272 cards), so a thin market day does not red the gate.
// Unlisted: static pages, and the Sniper, whose default board can honestly
// hold a handful of deals (4 on 10-20).
const READY: Record<string, { selector: string; min: number; what: string }> = {
  "/nba-top-shot/packs": { selector: "tbody > tr", min: 25, what: "table rows" },
  "/nba-top-shot/collection?wallet=0xbd94cade097e50ac": { selector: "tbody > tr", min: 25, what: "table rows" },
  "/insights/squeeze": { selector: "tbody > tr", min: 10, what: "table rows" },
  "/insights/rookies": { selector: "tbody > tr", min: 10, what: "table rows" },
  "/nba-top-shot/market": { selector: "tbody > tr", min: 10, what: "table rows" },
  "/nba-top-shot/analytics": { selector: "tbody > tr", min: 10, what: "table rows" },
  "/nba-top-shot/sets?wallet=0xbd94cade097e50ac": { selector: "text=/total sets/i", min: 1, what: "set-tracker summaries" },
}
const READY_WAIT_MS = 20_000

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

function describeViolation(v: Violation, nodes: AxeNode[] = v.nodes): string {
  const targets = nodes
    .slice(0, 3)
    .map((n) => (Array.isArray(n.target) ? n.target.join(" ") : String(n.target)))
    .join(" | ")
  return `${v.impact ?? "unknown"} · ${v.id} (${nodes.length} node${nodes.length === 1 ? "" : "s"}): ${v.help} — ${targets}`
}

// A gated contrast failure must be fixable from the LOG. A bare selector
// (".border", the 10-20 Sniper case) is not, and the evidence otherwise sits in
// an artifact of tens to hundreds of MB. So each failing node's colours, ratio
// and opening HTML are printed too (first 3 nodes).
function contrastDetail(v: Violation, nodes: AxeNode[]): string[] {
  if (v.id !== "color-contrast") return []
  return nodes.slice(0, 3).map((n) => {
    const d = (n.any?.[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string; fontSize?: string }
    return `    ↳ ${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1 (needs ${d.expectedContrastRatio}, ${d.fontSize}) — ${n.html.slice(0, 160)}`
  })
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

    const ready = READY[path]
    if (ready) {
      await page.locator(ready.selector).nth(ready.min - 1).waitFor({ timeout: READY_WAIT_MS }).catch(() => {})
    }

    // What axe is about to read — printed for every route, so an audit of a
    // loading state shows up as a tiny element count instead of a fast green.
    const dom = await page.evaluate(() => ({
      elements: document.getElementsByTagName("*").length,
      rows: document.querySelectorAll("tbody > tr").length,
    }))
    const scope = `${dom.elements} elements, ${dom.rows} table rows (≤25 per table audited)`
    const shown = ready ? await page.locator(ready.selector).count() : 0
    if (ready && shown < ready.min) {
      const line = `### ${path} [${theme}] — ❌ not audited: ${scope}; ${shown} ${ready.what}, this route must show ≥${ready.min} (a loading or error state is not the page)\n`
      console.log(line)
      appendFileSync(SUMMARY, line + "\n")
      throw new Error(`${url}: only ${shown} ${ready.what} after ${READY_WAIT_MS / 1000}s (need ≥${ready.min}) — the audit would read a loading or error state`)
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
    for (const v of results.violations) {
      const nodes = v.nodes
      if (!nodes.length) continue
      if (SERIOUS.has(v.impact ?? "") && GATED.has(v.id)) gated.push([describeViolation(v, nodes), ...contrastDetail(v, nodes)].join("\n"))
      else if (SERIOUS.has(v.impact ?? "")) reported.push(describeViolation(v, nodes))
      else advisory.push(describeViolation(v, nodes))
    }

    // Everything is PRINTED, whatever the verdict: the reported and advisory tiers are
    // the backlog, and a green run that said nothing would hide it.
    const lines = [
      `### ${path} [${theme}] (${scope}) — ${gated.length} gated, ${reported.length} reported (serious, not gated), ${advisory.length} advisory, ${results.passes.length} rules passed`,
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

    await page.setViewportSize(PHONE_VIEWPORT)
    await page.waitForTimeout(SETTLE_MS)
    const phone = await within(AXE_BUDGET_MS, new AxeBuilder({ page }).withRules(PHONE_RULES).exclude(ROW_SCOPE_EXCLUDE).analyze())
    if (phone === "timeout") throw new Error(`${url}: phone-width axe pass did not finish in ${AXE_BUDGET_MS / 1000}s`)
    const phoneGated = phone.violations.filter((v) => v.nodes.length && SERIOUS.has(v.impact ?? "") && GATED.has(v.id))
      .map((v) => `[${PHONE_VIEWPORT.width}px] ${describeViolation(v, v.nodes)}`)
    const phoneLine = `#### ${path} [${theme}] at ${PHONE_VIEWPORT.width}px — ${phoneGated.length} gated (${PHONE_RULES.join(", ")})${phoneGated.map((d) => `\n- ❌ ${d}`).join("")}\n`
    console.log(phoneLine)
    appendFileSync(SUMMARY, phoneLine + "\n")
    gated.push(...phoneGated)

    expect(gated, `${url} has ${gated.length} gated axe violation(s) (${[...GATED].join(" / ")})`).toEqual([])
  })
}
