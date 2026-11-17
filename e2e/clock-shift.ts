import { expect, type Page } from "playwright/test"

// Shift the BROWSER's wall clock before any page script runs, so hydration
// happens at a different instant than the server render did.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// e2e/healthy-page.ts says of itself that its #418 detection is "BROAD but
// PROBABILISTIC": a clock-dependent hydration mismatch fires only when a value
// crosses a boundary between the moment the ISR snapshot was rendered and the
// moment the browser hydrates. That was measured, not assumed — /insights/top-sales
// threw #418 on one sweep and passed 40 minutes later.
//
// ⚠ AND THE PROBABILITY IS WORSE THAN "SOMETIMES", which is what this file is
// for. Measured 2026-08-27 on the defect that prompted it: after
// /insights/underpriced-serials was fixed, the monitor went green twice — and
// NEITHER run exercised the risky branch, because the caption it renders only
// appears when the listings spine is >4h stale and the ingest had been healthy
// all night (successes at 04:13Z, 07:13Z, 10:13Z). **Waiting for a green run to
// mean something is waiting for an unrelated pipeline to break.**
//
// Shifting the client clock makes the two renders disagree ON PURPOSE, so the
// class becomes DETERMINISTIC instead of data-dependent. A page whose first
// client render does not read the clock is unaffected by any shift; a page whose
// render does read it mismatches immediately.
//
// ⭐ IT IS ALSO THE ONLY CHECK ON `hydration-safe:` MARKERS.
// __tests__/insights-client-dates-are-hydration-safe-guard.test.ts (Rule C) bans
// unmarked wall-clock reads in insights client files, and its escape is an inline
// marker whose reason is the AUTHOR'S ASSERTION that the call cannot run before
// mount. No static check can verify that claim. This can: if a "post-mount only"
// call actually runs during the first render, the shifted clock reds the page.
export const CLOCK_SHIFT_MS = 7 * 60 * 60 * 1000 // 7h — crosses every hour/day boundary this app renders

export async function armClockShift(page: Page, shiftMs: number = CLOCK_SHIFT_MS): Promise<void> {
  // addInitScript runs before ANY page script in every frame, so React hydrates
  // against the shifted clock rather than being corrected after the fact.
  await page.addInitScript((shift: number) => {
    const RealDate = Date
    const shifted = new Proxy(RealDate, {
      get(target, prop, receiver) {
        // Only `now` moves. Date.parse / Date.UTC / prototype methods must keep
        // working: a shim that broke them would fail every page for a reason
        // that has nothing to do with hydration.
        if (prop === "now") return () => target.now() + shift
        return Reflect.get(target, prop, receiver)
      },
      construct(target, args) {
        // `new Date()` (no args) is the other wall-clock read. `new Date(iso)`
        // must stay exact — it is the deterministic form the guards permit.
        return args.length === 0
          ? Reflect.construct(target, [target.now() + shift])
          : Reflect.construct(target, args)
      },
    })
    ;(globalThis as unknown as { Date: DateConstructor }).Date = shifted as unknown as DateConstructor
    ;(globalThis as unknown as { __RPC_CLOCK_SHIFT_MS?: number }).__RPC_CLOCK_SHIFT_MS = shift
  }, shiftMs)
}

/**
 * Prove the shift is actually in effect in the page under test.
 *
 * ⚠ REQUIRED, not belt-and-braces. If `addInitScript` silently failed to apply,
 * every assertion in the clock spec would pass — a green monitor measuring
 * nothing, which is the exact failure mode this repo keeps paying for. This is
 * the "assert what the guard inspected" rule applied to a browser.
 */
export async function assertClockShiftArmed(page: Page, shiftMs: number = CLOCK_SHIFT_MS): Promise<void> {
  const probe = await page.evaluate(() => ({
    flag: (globalThis as unknown as { __RPC_CLOCK_SHIFT_MS?: number }).__RPC_CLOCK_SHIFT_MS ?? null,
    now: Date.now(),
    bareCtor: new Date().getTime(),
    parsed: Date.parse("2026-08-27T00:00:00.000Z"),
    utc: Date.UTC(2026, 7, 27),
    fromIso: new Date("2026-08-27T00:00:00.000Z").getTime(),
  }))
  expect(probe.flag, "the clock-shift init script did not run — this spec would be measuring nothing").toBe(shiftMs)

  const ahead = probe.now - Date.now()
  expect(
    Math.abs(ahead - shiftMs) < 120_000,
    `page clock is ${Math.round(ahead / 1000)}s ahead of the runner, expected ~${Math.round(shiftMs / 1000)}s`,
  ).toBe(true)
  expect(Math.abs(probe.bareCtor - probe.now) < 5_000, "`new Date()` did not pick up the shift").toBe(true)

  // The deterministic forms must be untouched, or a red page tells you nothing.
  expect(probe.parsed, "Date.parse must be unaffected by the shim").toBe(Date.parse("2026-08-27T00:00:00.000Z"))
  expect(probe.utc, "Date.UTC must be unaffected by the shim").toBe(Date.UTC(2026, 7, 27))
  expect(probe.fromIso, "new Date(iso) must be unaffected by the shim").toBe(
    Date.parse("2026-08-27T00:00:00.000Z"),
  )
}
