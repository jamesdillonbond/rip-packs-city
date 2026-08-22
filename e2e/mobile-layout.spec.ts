import { test, expect } from "playwright/test"

// ─────────────────────────────────────────────────────────────────────────────
// Mobile LAYOUT monitor — the class no other gate in this repo can see.
//
// components/WalletSearchBand.tsx shipped rendering 350px tall on a phone
// against the ~100px its own header comment specified, and survived four weeks
// with tsc, eslint, both coverage gates and every guard green. The reason is
// structural: the MARKUP was correct. vitest+jsdom returns a zero box for
// every element, so no unit test can observe a height; coverage sees whether a
// line RAN, not what it measured. Only a real browser at a real viewport can.
//
// Same posture as smoke.spec.ts: a scheduled MONITOR against the deployed site
// (SMOKE_BASE_URL), not a pull_request gate — a live hiccup must never block a
// merge.
//
// ⚠ EVERY ASSERTION HERE IS A BAN AT POPULATION ZERO, measured 2026-08-22, and
// that is deliberate. There are 86 distinct controls under the 44px floor on
// these routes (filed: docs/overnight/inbox/2026-08-22T1836Z-86-mobile-tap-
// targets-under-44px-and-the-instrument-that-found-them.md). Asserting those
// would make this monitor permanently red, which this repo has already recorded
// as indistinguishable from broken at a glance. Only properties that are
// CURRENTLY TRUE are pinned, so red here always means a regression.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = { width: 390, height: 844 }

// Public routes measured clean (overflow 0) at both 390px and 320px on
// 2026-08-22. Keep this list to public pages — a redirect to /login measures
// the login page, not the page named.
//
// ⚠ `/[collection]/overview` is deliberately ABSENT, and must not be "restored".
// The 2026-08-22 13:15Z scheduled run failed with `page.goto: Timeout 30000ms`
// on FOUR collections' /overview plus /insights/underpriced-serials — inside the
// documented 01:00-19:00Z degraded band — while the 07:16Z and 18:58Z runs were
// clean. That is a SLOWNESS signal, `smoke.spec.ts` already reports it, and a
// navigation timeout here would surface as a LAYOUT alarm. A monitor that cries
// wolf stops being read. The overview page shares this layout's chrome with the
// three collection routes below, so dropping it costs no layout coverage.
const ROUTES = [
  "/",
  "/insights",
  "/nba-top-shot/collection",
  "/nba-top-shot/market",
  "/nba-top-shot/sniper",
]

test.describe("mobile layout", () => {
  test.use({ viewport: PHONE })

  for (const path of ROUTES) {
    test(`${path} does not scroll horizontally at ${PHONE.width}px`, async ({ page }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" })
      // Fonts and late-mounting client blocks both change widths; settle before
      // measuring rather than racing the first paint.
      // ⚠ CAPPED. A page with a polling client block never reaches networkidle,
      // and an uncapped wait costs the default navigation timeout PER ROUTE —
      // measured 32s each against a local build, which would have pushed this
      // monitor's job past its 10-minute budget while looking like a slow site.
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1500)

      const { overflow, widest } = await page.evaluate((vw) => {
        const de = document.documentElement
        // An ancestor that legitimately scrolls or clips (a wide table, the
        // marquee ticker) is a design decision, not a defect.
        const contained = (el: Element) => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX
            if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true
          }
          return false
        }
        let widest: { tag: string; cls: string; right: number } | null = null
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const b = el.getBoundingClientRect()
          if (b.width === 0 || b.height === 0) continue
          if (b.right <= vw + 1) continue
          if (contained(el)) continue
          if (!widest || b.right > widest.right) {
            widest = {
              tag: el.tagName.toLowerCase(),
              cls: String((el as HTMLElement).className || "").slice(0, 60),
              right: Math.round(b.right),
            }
          }
        }
        return { overflow: de.scrollWidth - de.clientWidth, widest }
      }, PHONE.width)

      expect(
        overflow,
        `${path} overflows by ${overflow}px` +
          (widest ? ` — widest uncontained box: <${widest.tag} class="${widest.cls}"> ends at ${widest.right}px` : ""),
      ).toBe(0)
    })
  }

  test("the bottom nav's tap targets clear 44px in BOTH axes", async ({ page }) => {
    // MEASURED before the 2026-08-22 fix: 37x32 / 32x32 / 26x32 / 32x32 / 58x32,
    // inside a bar that was already 60px tall — `padding: 0` meant each tab hugged
    // its 18px glyph, and 28px of the bar looked tappable but was not.
    await page.goto("/nba-top-shot/collection", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)

    const tabs = await page.evaluate(() => {
      const nav = document.querySelector(".rpc-mobile-nav")
      if (!nav) return null
      return Array.from(nav.children)
        .filter((c) => c.tagName === "A" || c.tagName === "BUTTON")
        .map((c) => {
          const b = c.getBoundingClientRect()
          return {
            label: (c.textContent || "").trim().replace(/\s+/g, " ").slice(0, 20),
            w: Math.round(b.width),
            h: Math.round(b.height),
          }
        })
    })

    // Positive control: an empty nav must FAIL, not pass quietly. A selector that
    // stops matching is the "guard silently measuring nothing" shape.
    expect(tabs, ".rpc-mobile-nav rendered no tab elements").not.toBeNull()
    expect(tabs!.length).toBeGreaterThanOrEqual(5)

    const tooSmall = tabs!.filter((t) => t.w < 44 || t.h < 44)
    expect(
      tooSmall.map((t) => `${t.label} ${t.w}x${t.h}`),
      "bottom-nav tabs under the 44px floor",
    ).toEqual([])
  })

  test("the wallet band stays one band, not a hero", async ({ page }) => {
    // The original defect: an inline `flex: "1 1 300px"` on the input wrapper.
    // flex-basis sizes the MAIN axis, and the band's max-width:640px rule flips
    // that axis to HEIGHT, so the width-basis became a 300px height — and an
    // inline style is the one declaration a media query cannot override.
    // Measured 350px before, 102px after. The threshold is deliberately loose:
    // this is a "did it become a hero again" check, not a pixel pin.
    // /collection, not /overview — see the note on ROUTES above. The band mounts
    // from the (collections) LAYOUT, so every tab under it carries one.
    await page.goto("/nba-top-shot/collection", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)

    const band = await page.evaluate(() => {
      const el = document.querySelector("[data-rpc-wallet-band]")
      if (!el) return null
      const b = el.getBoundingClientRect()
      const form = el.querySelector("form")
      return {
        h: Math.round(b.height),
        formH: form ? Math.round(form.getBoundingClientRect().height) : null,
      }
    })

    // The band removes itself for a visitor whose wallet is already known and
    // for a signed-in one. A fresh monitor context is neither, but if it is ever
    // legitimately absent there is nothing to measure — skip rather than invent
    // a pass, and say which happened.
    test.skip(band === null, "wallet band not rendered on this run")

    expect(band!.h, `wallet band is ${band!.h}px tall at ${PHONE.width}px`).toBeLessThanOrEqual(160)
    // …and the 52px input inside it is the reason the band has any height at all.
    expect(band!.formH).toBeGreaterThanOrEqual(44)
  })
})
