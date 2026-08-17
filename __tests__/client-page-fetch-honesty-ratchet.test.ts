import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isClientSource } from "./helpers/client-directive"
import { join, relative, sep } from "node:path"

// RATCHET on the client half of "a failed read must not render as an answer".
//
// ── WHAT WAS MEASURED (2026-08-15) ─────────────────────────────────────────
// `lib/analytics/fetch-json.ts` exists precisely for this layer, and its own
// header names the defect: a `.catch` in a useEffect collapsing a network
// failure, a 5xx, an unparseable body and a successful-but-empty result into one
// indistinguishable `null`, which the render layer then states as a conclusion
// ("No recent whale trades.", "No alerts yet.").
//
// Its adoption on the surface it was written for is ZERO:
//
//   * 35 `"use client"` page.tsx files call `fetch(` directly
//   * 149 fetch call sites and 168 catch sites across them
//   * 0 of them import `fetchJson`
//
// The existing protection is three source guards over HAND-PICKED sites. That is
// an allowlist for a class two orders of magnitude larger, and CLAUDE.md already
// records the shape: a per-file allowlist for a class with dozens of members is
// theatre. This freezes the debt instead.
//
// ── WHY A RATCHET, NOT A BAN ───────────────────────────────────────────────
// Converting 35 pages (the four largest are 1,300-2,500 lines) is a real
// project, and several are actively edited by concurrent sessions. A ban would
// ship a 35-entry allowlist. The ratchet costs nothing today and forces every
// NEW client page through the helper, where the honest-failure branch is
// centralised and tested.
//
// ⚠ PASSING MEANS THE BLIND SPOT DID NOT GROW. It does NOT mean these 35 files
// are correct — they are unmeasured by both coverage gates (`app/**/page.tsx`
// matches neither include), and the honesty defects found on
// `[collection]/analytics` and `/alerts` came out of exactly this population.
//
// ⚠ THE WAY TO FIND THE NEXT DEFECT HERE IS TO SWEEP THE EMPTY-STATE COPY, NOT
// THE FETCH CODE. `/alerts` was found that way: every claim on it is about the
// reader's OWN account, so "No alerts yet. Create one above." invited a
// DUPLICATE of an alert they already had. The fetch code looks fine; the copy is
// what is false.
//
// ── ADJACENT, DELIBERATELY NOT GATED HERE ──────────────────────────────────
// 53 client components under `components/**` also fetch without the helper.
// They are left to a separate decision because the component gate DOES measure
// them, so they are not a blind spot in the same way — a bad branch there is at
// least visible in a coverage number.

const APP_DIR = join(process.cwd(), "app")

/**
 * The ceiling. Lower it when you convert a page to `fetchJson`; NEVER raise it.
 * 35 when this landed.
 */
// 35 → 34 on 2026-08-15: app/dashboard/notifications/page.tsx moved onto
// fetchJson. It was carrying `.then(r => r.json())` — the raw-parse shape the
// sibling BAN is supposed to forbid — and the ban's regex required parentheses
// around the arrow parameter, so it read a population of ZERO while that site
// stood outside it. Both were fixed together.
/* 33 -> 32: `disney-pinnacle/sniper`'s body moved to `PinnacleSniperClient.tsx`, so it is
 * no longer a `page.tsx` calling fetch directly — it is now measured by the component gate
 * and covered by `__tests__/component-PinnacleSniperClient.test.tsx`.
 *
 * ⚠ Re-derived from THIS FILE'S OWN no-slack assertion, not chosen. A ratchet is a COUNT of
 * a shared population, so on a concurrent-session collision both "take mine" and "take
 * theirs" are silently wrong — the only correct value is the one the failing assertion
 * names. (That collision has already happened once on the sibling client-page ratchet,
 * where two sessions each subtracted only their own conversions.) */
/* 27 -> 24: `dashboard/history`, `panini-blockchain/overview` and `panini-blockchain/sniper`
 * each moved their body into a `*Client.tsx`, so all three are now measured by the component
 * gate and covered by `__tests__/component-PaniniAndHistoryClients.test.tsx`.
 *
 * ⚠ Re-derived from the no-slack assertion again, and this time it caught a data loss rather
 * than a collision: a mutation harness of mine truncated THIS FILE to zero bytes, and vitest
 * reported it as "No test suite found" — which reads like a config problem, not like the
 * ratchet having been destroyed. Restoring from HEAD and re-reading the assertion's own
 * message is what produced 24; a remembered number would have been unverifiable. */
/* 24 -> 22: `admin/analytics` and `admin/listing-retry-queue` moved their bodies into
 * `AdminAnalyticsClient.tsx` / `ListingRetryQueueClient.tsx`, so both are now measured by the
 * component gate and covered by `__tests__/component-AdminAnalyticsAndRetryQueue.test.tsx`.
 * The conversion found a live defect: the retry queue's rows table rendered "No rows for this
 * filter" on a FAILED read — the queue reported as CLEAR out of our own outage, on the one
 * screen an operator uses to decide whether the drain is working. */
/* 22 -> 20: `[collection]/packs/simulator/[distId]` and `dashboard/api-keys` moved into
 * `PackSimulatorClient.tsx` / `ApiKeysClient.tsx`, covered by
 * `__tests__/component-SimulatorAndApiKeys.test.tsx`. The simulator carried a live defect —
 * on any failed read it rendered "Drop pool not indexed — usually because it's sold out and
 * being secondary-traded", a specific factual claim about the collector's pack manufactured
 * from our own outage, and a terminal one (it says the simulator will never work here, so
 * they leave rather than retry). api-keys was already clean; that half is coverage. */
/* 20 -> 18: `admin/rewards` and `nba/fast-break` moved into `AdminRewardsClient.tsx` /
 * `FastBreakClient.tsx`, covered by `__tests__/component-RewardsConsoleAndFastBreak.test.tsx`.
 * Both carried a fabricated ZERO: the rewards console published "Outstanding liability 0"
 * from `num()` coercing an absent value, and fast-break published "0.00 FP" as the Total
 * Projected directly above its own "couldn't load the optimizer" line. */
/* 18 -> 16: `dashboard/packs` and `[collection]/overview` moved into
 * `PackHistoryClient.tsx` / `CollectionOverviewClient.tsx`, covered by
 * `__tests__/component-PackHistoryAndOverviewClients.test.tsx`. NEITHER carried a new defect
 * — both were already hardened — so this pair is coverage, recorded so nobody re-sweeps
 * them. The overview's three-way sales claim (read failed / no rows / no NAMEABLE rows) was
 * pinned only by source greps until now. */
/* 16 -> 14: `dashboard/alerts` and `[collection]/profile/[username]` moved into
 * `DashboardAlertsClient.tsx` / `CollectionProfileClient.tsx`, covered by
 * `__tests__/component-DashboardAlertsAndCollectionProfile.test.tsx`. Both were already
 * hardened; this is coverage. Both carry a claim about the READER'S OWN ACCOUNT, which is
 * the worst version of the failed-read class — the reader is the one person who knows it is
 * wrong, and it is actionable. */
/* 14 -> 13: `[collection]/sets` moved into `CollectionSetsClient.tsx`, covered by
 * `__tests__/component-CollectionSetsClient.test.tsx`. Already clean on the failed-read
 * sweep; what the conversion buys is that the FOUR-WAY per-collection endpoint switch, the
 * retryable-vs-fatal split (deep-audit D3) and the `[object Object]` guard on the error
 * banner are now driven rather than grepped. */
/* 13 -> 12: `/alerts` moved into `AlertsClient.tsx`, covered by
 * `__tests__/component-AlertsClient.test.tsx`. Already clean — and unusually thoroughly:
 * failure is tracked PER LEG (channels / subscriptions / FMV alerts), because every empty
 * state on that page is a claim about the READER'S OWN account and one shared flag would
 * blank all three whenever any one hiccuped. The three legs are now driven independently,
 * which is the only way to prove they really are independent. */
/* 12 -> 11: `admin/allow-list` moved into `AdminAllowListClient.tsx`, covered by
 * `__tests__/component-AdminAllowListClient.test.tsx`. The conversion found TWO live
 * defects on the screen that gates who gets into the product: a failed read rendered
 * "Nothing in this view." (no signups waiting, from our own outage), and an action response
 * carrying no `row` wrote `undefined` into state and WHITE-SCREENED the console right after
 * reporting success. */
/* 11 -> 10: `admin/flowty-analytics` moved into `FlowtyAnalyticsClient.tsx`, covered by
 * `__tests__/component-FlowtyAnalyticsClient.test.tsx`. The conversion found a live defect
 * of a shape not previously recorded here: a failed read rendering not as an EMPTY answer
 * but as the WRONG one. A failed refresh left every chart, KPI tile and leaderboard showing
 * the PREVIOUS filter's numbers under the newly-selected filter's label. */
/* 10 -> 8: `admin/feedback` and `[collection]/market` moved into `AdminFeedbackClient.tsx` /
 * `MarketClient.tsx`, covered by `__tests__/component-AdminFeedbackClient.test.tsx` and
 * `__tests__/component-MarketClient.test.tsx`. Feedback carried the SAME defect for the
 * third time in this workstream — a failed read rendering "No feedback in this view.", a
 * triage console reporting an empty queue out of our own outage. Market was already the
 * shape to copy (a strict `loading : error : empty` ladder) and is pinned as such. */
/* 8 -> 7: `[collection]/collection` moved into `CollectionTabClient.tsx`, covered by
 * `__tests__/component-CollectionTabClient.test.tsx`. No new defect — the RENDERING of this
 * page's claims already lives in `CollectionMomentTable` / `PortfolioSummary`, which the
 * component gate measures. What was unmeasured is the ORCHESTRATION, and that is where the
 * honesty property lives: a failed read leaves `hasSearched` FALSE, so the table renders its
 * pre-search state plus an error banner rather than "this wallet holds nothing". */
/* 7 -> 6: `[collection]/analytics` moved into `CollectionAnalyticsClient.tsx`, covered by
 * `__tests__/component-CollectionAnalyticsClient.test.tsx`. ⚠ THE CONVERSION FOUND A LIVE
 * DEFECT ON THE PAGE THIS FILE CALLS THE MOST HARDENED IN THE REPO — and it is deep-audit
 * D12's own defect, one derivation lower. `thinVolumeEcosystem` reads
 * `marketData?.totals?.totalSales ?? 0`, so a failed market read rendered "Thin-volume
 * ecosystem — most metrics are directional only.": a claim about the MARKET manufactured
 * from OUR outage, and an actionable one. D12 added `marketFailed` for the KPI band directly
 * above it and this derived notice was never gated on it. */
/* ⚠ 6 -> 8 (2026-08-16): AN INCREASE, AND NOT BACKSLIDING — nothing regressed
 * and nothing was un-converted. The DETECTOR was undercounting: it decided
 * "is this a client file?" from a truncated prefix (the first 3 LINES) with an anchored pattern, so a page whose
 * `"use client"` sits behind a header comment classified as a SERVER file and
 * never entered the population. Detection now goes through
 * `__tests__/helpers/client-directive.ts`, which skips whitespace and comments
 * and checks the first STATEMENT. Measurement expanding is the one legitimate
 * reason a ratchet number moves the wrong way (same precedent as widening the
 * coverage-gate `include`). THE RULE IS UNCHANGED — down only from here.
 * ⚠ RE-DERIVED from the failing no-slack assertion after a rebase collision
 * with a concurrent session's conversions: neither side's number was right. */
/* 8 -> 7: `/dashboard` moved into `DashboardClient.tsx`, covered by
 * `__tests__/component-DashboardClient.test.tsx` (132 tests). NO new defect — every honesty
 * branch on that page already carried a comment naming the incident that produced it
 * (`meFailed`, `statsFailed` and the 2026-08-05 false-$0 on a 19,213-moment wallet, the hero
 * picker's `loadFailed`, the trophy-removal rollback). What none of them had was a TEST.
 * Re-derived from this file's own no-slack assertion after a rebase; see the sibling gate
 * ratchet for why the number moved differently than a local measurement suggested. */
/* 7 -> 5: the auth funnel batch — `app/login`, `app/early-access` and
 * `app/auth/confirm` moved into `*Client.tsx`. Two of the three fetch directly
 * (`/api/profile/touch`, `/api/wallet-search`, `/api/early-access/submit`) and
 * none of them can adopt `fetchJson`, which is why the SPLIT rather than the
 * helper is what closes them: `lib/analytics/fetch-json` returns board-shaped
 * data for a dashboard, whereas these three need the raw status to distinguish
 * outcomes that must never merge — a magic-link deny-list 403 from a transient
 * 5xx, a duplicate signup from a rejected one, a failed on-chain probe from a
 * genuine zero.
 *
 * ⚠ THE THIRD OF THOSE IS NOW A TEST RATHER THAN A CONVENTION. The on-chain
 * nudge would have warned "this wallet shows 0 Top Shot moments" out of a 503,
 * because the stale-result guard protecting it was a tautology — see the
 * sibling gate ratchet for the mechanism. `fetchJson` would not have caught it;
 * only rendering the component against a failing fixture did. */
const BUDGET = 5

function pageFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) pageFiles(full, out)
    else if (entry === "page.tsx") out.push(full)
  }
  return out
}

/** Client pages that fetch over HTTP without routing through the helper. */
function unhelpedClientPages(): string[] {
  return pageFiles(APP_DIR)
    .filter((f) => {
      const src = readFileSync(f, "utf8")
      if (!isClientSource(src)) return false
      // `fetch(` rather than a bare `fetch` so `prefetch`/`refetch` identifiers
      // and prose in comments do not enrol a page that never makes a request.
      if (!/\bfetch\(/.test(src)) return false
      return !src.includes("fetchJson")
    })
    .map((f) => relative(process.cwd(), f).split(sep).join("/"))
    .sort()
}

describe("client-page fetch-honesty ratchet", () => {
  const pages = unhelpedClientPages()

  it("is not vacuous: the walk finds page.tsx files and the detector discriminates", () => {
    // ⚠ THE WALK, NOT THE POPULATION. This asserted `pages.length > 10` and went
    // RED at exactly 10 — the guard punishing its own success, the identical
    // failure the sibling gate ratchet already paid for. A not-vacuous check has
    // to be satisfiable at a population of ZERO, because zero is the goal.
    expect(pageFiles(APP_DIR).length, "the enumerator must find page.tsx files at all").toBeGreaterThan(20)

    // The detector must actually discriminate: a server page, and a client page
    // that already routes through the helper, must both stay out of the set.
    const all = pageFiles(APP_DIR).map((f) => relative(process.cwd(), f).split(sep).join("/"))
    expect(all.length).toBeGreaterThan(pages.length)

    // The four largest are named so a rename cannot quietly drop them — but only
    // while they are still unconverted client pages. Converting one is the point
    // of this ratchet, so the check reads their current state rather than
    // asserting a population that is meant to shrink.
    for (const p of [
      "app/dashboard/page.tsx",
      "app/(collections)/[collection]/sniper/page.tsx",
      "app/(collections)/[collection]/analytics/page.tsx",
      "app/(collections)/[collection]/collection/page.tsx",
    ]) {
      if (!existsSync(p)) continue
      const src = readFileSync(p, "utf8")
      const stillUnconverted =
        isClientSource(src) &&
        /\bfetch\(/.test(src) &&
        !src.includes("fetchJson")
      if (stillUnconverted) expect(pages, `${p} must still be counted`).toContain(p)
    }
  })

  it("the helper it points at actually exists and reports failure as data", async () => {
    // Guards the guard: if `fetchJson` were deleted or renamed, every page would
    // trivially satisfy "does not import fetchJson" and the ratchet would keep
    // passing while pointing at nothing.
    const { fetchJson } = await import("@/lib/analytics/fetch-json")
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch
      const res = await fetchJson("/api/whatever")
      expect(res.ok).toBe(false)
      expect(res.json).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it(`no more than ${BUDGET} client pages fetch without lib/analytics/fetch-json`, () => {
    expect(
      pages.length,
      `Client pages fetching without fetchJson grew to ${pages.length} (budget ${BUDGET}).\n` +
        `A new client page must use fetchJson from "@/lib/analytics/fetch-json", whose\n` +
        `\`ok\` answers "did the READ succeed" — never "were there rows". Branch the\n` +
        `empty state on \`ok\`, or a timeout renders as a claim about the market or\n` +
        `about the reader's own account.\n\n` +
        pages.join("\n"),
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("the budget is not left slack above the real number", () => {
    // A ratchet with headroom silently licenses the next N additions — the
    // compounding failure the component gate already paid for with a ~13-point
    // unguarded branch buffer. Lower BUDGET in the same commit that converts a
    // page.
    expect(
      BUDGET - pages.length,
      `BUDGET is ${BUDGET} but only ${pages.length} pages qualify — lower BUDGET to ${pages.length}.`,
    ).toBeLessThanOrEqual(0)
  })
})
