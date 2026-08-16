import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
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
const USE_CLIENT = /^\s*["']use client["']/

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
const BUDGET = 18

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
      if (!USE_CLIENT.test(src.split("\n").slice(0, 3).join("\n"))) return false
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

  it("is not vacuous: it finds client pages that fetch directly", () => {
    expect(pages.length).toBeGreaterThan(10)
    // The four largest, named so a rename cannot quietly drop them from the set.
    for (const p of [
      "app/dashboard/page.tsx",
      "app/(collections)/[collection]/sniper/page.tsx",
      "app/(collections)/[collection]/analytics/page.tsx",
      "app/(collections)/[collection]/collection/page.tsx",
    ]) {
      expect(pages, `${p} must still be counted`).toContain(p)
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
