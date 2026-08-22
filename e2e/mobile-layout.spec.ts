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

  test("navigation controls have a 44px effective hit box", async ({ page }) => {
    // MEASURED 2026-08-22: the collection tab bar was 35px, the switcher pills
    // 30px, the theme toggle 30x30 and the anon Sign-in pill 20x60 — all under
    // §9 / WCAG 2.5.5, all on navigation, where a mis-tap costs a page load.
    //
    // ⚠ Two different fixes landed, so this measures the PROPERTY rather than
    // either implementation: the tab bar GREW to 44px, while the small chrome
    // controls kept their deliberate size and got `.rpc-tap44`, an invisible
    // ::after. The effective box is the union of the element and that overlay.
    //
    // ⚠ THIS USED TO HIT-TEST THE FOUR EXTREMES OF THE AREA, AND THAT WAS THE
    // WRONG ASSERTION — it went red on production and green locally on the same
    // code. One switcher pill ("✨Pinnacle") had the point 6px above it owned by
    // some other chrome that the credential-less local build does not render.
    // Whether an unrelated element paints over a control's margin is not a
    // property this monitor can hold, and a monitor that cries wolf stops being
    // read. What IS the product's promise is that the control OWNS a 44px box;
    // the centre check below still catches anything covering the control itself.
    await page.goto("/nba-top-shot/collection", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)

    const result = await page.evaluate(() => {
      const inside = (el: Element, hit: Element | null) =>
        !!hit && (hit === el || el.contains(hit) || hit.contains(el))
      const small: string[] = []
      const covered: string[] = []
      let checked = 0
      for (const el of Array.from(document.querySelectorAll(".rpc-coll-tab, .rpc-tap44"))) {
        const b = el.getBoundingClientRect()
        if (b.width === 0 || b.height === 0) continue
        checked++
        const label =
          (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 20) ||
          el.getAttribute("aria-label") ||
          el.tagName
        // `.rpc-tap44`'s ::after is sized in px, so the used values come back as
        // px strings; a control without one yields "auto"/"" and falls back to
        // its own box, which is correct for the grown-box fix.
        const after = getComputedStyle(el, "::after")
        const w = Math.max(b.width, parseFloat(after.width) || 0)
        const h = Math.max(b.height, parseFloat(after.height) || 0)
        if (w < 44 || h < 44) small.push(`${label} ${Math.round(w)}x${Math.round(h)}`)
        // ⚠ elementFromPoint returns null OUTSIDE the viewport, and both the tab
        // bar and the switcher row are overflow-x:auto — skip what is scrolled
        // out of view rather than reading it as covered.
        const cx = b.left + b.width / 2
        const cy = b.top + b.height / 2
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue
        if (!inside(el, document.elementFromPoint(cx, cy))) covered.push(label)
      }
      return { small, covered, checked, tap44: document.querySelectorAll(".rpc-tap44").length }
    })

    // Not vacuous: a selector that stops matching must FAIL, not pass quietly.
    expect(result.checked, "no navigation controls matched the selectors").toBeGreaterThanOrEqual(6)
    // ⚠ AND the two fixes are counted SEPARATELY. Removing `.rpc-tap44` from a
    // control does not make it fail the size check — it drops out of the
    // selector entirely, and the seven tabs alone keep `checked` above its
    // floor. Without this line the overlay half of the fix could be deleted
    // with the test still green. Five switcher pills are the stable minimum on
    // this route (the theme toggle and the anon Sign-in pill add two more).
    expect(result.tap44, ".rpc-tap44 controls present").toBeGreaterThanOrEqual(5)
    expect(result.small, "navigation controls whose effective hit box is under 44px").toEqual([])
    expect(result.covered, "navigation controls whose own centre is covered by something else").toEqual([])
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

    // ⚠ THIS ASSERTS PRESENCE RATHER THAN SKIPPING, and the change was made
    // 2026-08-22 after watching a run report "4 skipped" with no way to tell
    // from the CI tail WHICH tests skipped. A skip inside a 97-test monitor is
    // invisible, so `test.skip(band === null)` would have turned "the band
    // stopped rendering entirely" — a worse regression than it being too tall —
    // into a silent non-result. That is the guard-measuring-nothing shape.
    //
    // A fresh Playwright context has empty localStorage and no session, which
    // are the band's only two self-removal conditions, so on THIS route it must
    // render. The one legitimate absence is the documented kill switch
    // (NEXT_PUBLIC_WALLET_BAND=off). If that is ever set, delete this test with
    // the band rather than softening it back to a skip.
    expect(
      band,
      "wallet band absent on /nba-top-shot/collection for a fresh anonymous context — " +
        "either it stopped rendering, or NEXT_PUBLIC_WALLET_BAND=off was set",
    ).not.toBeNull()

    expect(band!.h, `wallet band is ${band!.h}px tall at ${PHONE.width}px`).toBeLessThanOrEqual(160)
    // …and the 52px input inside it is the reason the band has any height at all.
    expect(band!.formH).toBeGreaterThanOrEqual(44)
  })
})
