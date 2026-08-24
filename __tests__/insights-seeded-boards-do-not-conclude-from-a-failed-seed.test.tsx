import { describe, it, expect } from "vitest"
import type React from "react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import PackDropsBoardClient from "@/app/insights/pack-drops/PackDropsBoardClient"
import SetCompletersBoardClient from "@/app/insights/set-completers/SetCompletersBoardClient"
import UnderpricedSerialsBoardClient from "@/app/insights/underpriced-serials/UnderpricedSerialsBoardClient"
import SerialPremiumsBoardClient from "@/app/insights/serial-premiums/SerialPremiumsBoardClient"
import NewCollectorsBoardClient from "@/app/insights/new-collectors/NewCollectorsBoardClient"
import { EMPTY_BOARD } from "@/lib/new-collectors-board"

// The FIFTH honesty layer: a SERVER-SEEDED PROP.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// CLAUDE.md's honesty table has four layers and one helper each. A server-seeded
// prop is a fifth the table does not cover: `initial={rows}` arrives as `[]` on a
// failed read carrying NO PROVENANCE, so a component that correctly distinguishes
// failure for its OWN fetch still CONCLUDES on the seed. Two were found on
// 2026-08-23 (the edition page's FMV chart, the team page's editions grid). These
// are the next two, found 2026-08-24 by sweeping `app/insights/**` for seeded
// props with no failure companion.
//
//   pack-drops     "No live re-pack drops to score right now. Check back when the
//                   next Vaultopolis drop lists."   ← a claim about the MARKET
//   new-collectors "No data in this window."        ← a claim about the DATA
//
// ⚠ THE PAGE-LEVEL BANNER IS NOT A FIX, AND BOTH PAGES ALREADY HAD ONE. Each
// renders `<DegradedDataNotice summary={summarizeDegraded([boardStatus(…, ok)])} />`
// and then hands the board the unlabelled `[]`. So on a failed read the page
// showed a notice saying the data is degraded directly above a board stating
// confidently that there is none. That is the documented "fix per PANEL, not per
// page" shape: a page with one honest error branch is not an honest page.
//
// ⚠ NEITHER CLIENT REFETCHES ON MOUNT — measured, not assumed. pack-drops says
// "only refetch on explicit refresh"; new-collectors says "the already-loaded
// window locally — no refetch". So the sentence does not self-correct: it stands
// until the reader presses Refresh, and on new-collectors there is no Refresh.
// And pack-drops exists to put its scored drops into the RAW SERVER HTML for
// crawlers, so the failed-read sentence is exactly what a crawler takes away.
//
// ── WHY SSR, AND WHY A NO-CHANGE CONTROL ────────────────────────────────────
// 🚨 Asserted against `renderToString`, following the FmvHistoryChart precedent:
// where a component DOES have a mount effect, it corrects the state before jsdom
// looks, and mutation there showed that BOTH `useState(false)` and the mirror
// image `useState(true)` left every client test passing. The difference survives
// only in server-rendered HTML — which on an ISR route is cached and served for
// the whole revalidate window.
//
// Every failure case is paired with a NO-CHANGE CONTROL asserting the genuinely
// empty board STILL says its original sentence. Without that, deleting the empty
// state entirely would satisfy the failure assertions — and a guard that can be
// passed by removing the feature is not a guard.

describe("pack-drops does not conclude about the market from a failed seed", () => {
  it("SSR: a failed seed says it couldn't load, NOT that there are no drops", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(
      <PackDropsBoardClient initialDrops={[]} initialFetchedAt={null} initialFailed />,
    )
    // ⚠ Assert the ABSENCE of the false claim. Asserting only that the degraded
    // sentence appears would pass a board printing BOTH.
    expect(html).not.toMatch(/No live re-pack drops to score right now/)
    expect(html).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR NO-CHANGE CONTROL: a genuinely empty board still says there are no drops", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(
      <PackDropsBoardClient initialDrops={[]} initialFetchedAt="2026-08-24T00:00:00Z" initialFailed={false} />,
    )
    expect(html).toMatch(/No live re-pack drops to score right now/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/i)
  })

  // ⛔ DELETED — "a failed seed that nonetheless has rows". The intent was good
  // (the degraded copy belongs to the EMPTY branch only, and suppressing real
  // rows would be a different defect wearing the fix's clothes) but the STATE IS
  // UNREACHABLE: the page's failure fallback is `[]`, so initialFailed and a
  // non-empty seed cannot co-occur. Keeping it meant hand-building a ScoredDrop
  // fixture to exercise a case production cannot produce — and the fixture was
  // wrong (no `rows`), which is how it announced itself. A test that needs an
  // impossible fixture is testing the fixture. The property it wanted is already
  // structural: `sectionEmptyCopy` is called INSIDE the `drops.length === 0`
  // branch, so a non-empty board cannot reach it.
})

describe("new-collectors does not conclude about the data from a failed seed", () => {
  it("SSR: a failed seed does not promise a refresh that will never happen", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(
      <NewCollectorsBoardClient initialBoard={EMPTY_BOARD} initialFetchedAt={null} initialFailed />,
    )
    // ⚠ RETARGETED after the SSR output corrected me. I first guarded the gateway
    // panels' "No data in this window." — but on a failed read the page hands over
    // EMPTY_BOARD, so `hasData` is false and the WHOLE board collapses before those
    // panels render. That change was unreachable. The branch a failed read actually
    // reaches is this one, and its copy was the impossible-claim shape: nothing is
    // refreshing, there is no refetch on this page, and "check back shortly"
    // promises a recovery the component cannot deliver.
    expect(html).not.toMatch(/The board is refreshing/)
    expect(html).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR NO-CHANGE CONTROL: a genuinely empty board still says it is refreshing", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(
      <NewCollectorsBoardClient
        initialBoard={EMPTY_BOARD}
        initialFetchedAt="2026-08-24T00:00:00Z"
        initialFailed={false}
      />,
    )
    expect(html).toMatch(/The board is refreshing/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/i)
  })
})

// ── The other three, found by widening the same sweep to every server page ──
// ⚠ The widening is why there are five and not two. The first pass looked only at
// boards with no `initialDegraded` prop, which missed the ones whose PAGE has an
// `ok` and simply drops it on the floor. The population that matters is "server
// pages that KNOW ok and seed a client without passing it" — derived from the
// tree, never a list.
//
// ⓘ Four of the nine candidates that sweep surfaced were correctly REJECTED
// rather than "fixed": pack-sniper, parallel-premiums, rookie-board and top-sales
// all say "… match those filters", which is a claim about the FILTER the reader
// just set, not about what the platform knows; market-pulse renders nothing at
// all when empty and so makes no claim. Widening a guard until every candidate
// passes is how a correct surface gets made incorrect — the register already
// records one "fix" that would have done exactly that.
describe("three more boards, same class, found by widening the sweep", () => {
  const ssr = async (el: React.ReactElement) => {
    const { renderToString } = await import("react-dom/server")
    return renderToString(el)
  }

  it("SSR: set-completers does not claim there is no completion data", async () => {
    const html = await ssr(
      <SetCompletersBoardClient
        initialBoard={{ rows: [] } as never}
        initialFetchedAt="2026-08-24T00:00:00Z"
        initialFailed
      />,
    )
    expect(html).not.toMatch(/No completion data available yet/)
    expect(html).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR NO-CHANGE CONTROL: a genuinely empty set-completers still says so", async () => {
    const html = await ssr(
      <SetCompletersBoardClient
        initialBoard={{ rows: [] } as never}
        initialFetchedAt="2026-08-24T00:00:00Z"
        initialFailed={false}
      />,
    )
    expect(html).toMatch(/No completion data available yet/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR: underpriced-serials does not claim the market has nothing underpriced", async () => {
    const html = await ssr(
      <UnderpricedSerialsBoardClient initialRows={[]} initialFetchedAt={null} initialFailed />,
    )
    expect(html).not.toMatch(/No underpriced headline serials right now/)
    expect(html).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR NO-CHANGE CONTROL: a genuinely empty underpriced board still says so", async () => {
    const html = await ssr(
      <UnderpricedSerialsBoardClient
        initialRows={[]}
        initialFetchedAt="2026-08-24T00:00:00Z"
        initialFailed={false}
      />,
    )
    expect(html).toMatch(/No underpriced headline serials right now/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR: serial-premiums does not claim the window had no qualifying sales", async () => {
    const html = await ssr(
      <SerialPremiumsBoardClient initialRows={[]} initialFetchedAt={null} initialFailed />,
    )
    expect(html).not.toMatch(/No qualifying .{0,24}sales in this window/)
    expect(html).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR NO-CHANGE CONTROL: a genuinely empty serial-premiums window still says so", async () => {
    const html = await ssr(
      <SerialPremiumsBoardClient
        initialRows={[]}
        initialFetchedAt="2026-08-24T00:00:00Z"
        initialFailed={false}
      />,
    )
    expect(html).toMatch(/No qualifying .{0,24}sales in this window/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/i)
  })
})


describe("the WIRING, which a component test cannot see", () => {
  // ⚠ Mutation on the 2026-08-23 pair showed that deleting `initialFailed` from
  // the CALL SITE left every one of the component's own tests passing. The prop
  // being supported is not the same as the page supplying it.
  const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8")

  it("pack-drops/page.tsx tells the board whether the SEED read failed", () => {
    const src = read("app", "insights", "pack-drops", "page.tsx")
    const at = src.indexOf("<PackDropsBoardClient")
    expect(at, "the page must render PackDropsBoardClient").toBeGreaterThan(-1)
    const call = src.slice(at, at + 400)
    expect(call, "the board must be told whether the seed failed").toContain("initialFailed=")
    // ⚠ DERIVED, not a literal — `initialFailed={false}` would pass a presence check
    // and reinstate the entire defect.
    expect(call, "initialFailed must be derived from the read's ok").toMatch(/initialFailed=\{!ok\}/)
  })

  it("new-collectors/page.tsx tells the board whether the SEED read failed", () => {
    const src = read("app", "insights", "new-collectors", "page.tsx")
    const at = src.indexOf("<NewCollectorsBoardClient")
    expect(at, "the page must render NewCollectorsBoardClient").toBeGreaterThan(-1)
    const call = src.slice(at, at + 400)
    expect(call, "the board must be told whether the seed failed").toContain("initialFailed=")
    expect(call, "initialFailed must be derived from the read's ok").toMatch(/initialFailed=\{!ok\}/)
  })

  it.each([
    ["set-completers", "SetCompletersBoardClient"],
    ["underpriced-serials", "UnderpricedSerialsBoardClient"],
    ["serial-premiums", "SerialPremiumsBoardClient"],
  ])("%s/page.tsx tells the board whether the SEED read failed", (dir, component) => {
    const src = read("app", "insights", dir, "page.tsx")
    const at = src.indexOf("<" + component)
    expect(at, "the page must render " + component).toBeGreaterThan(-1)
    const call = src.slice(at, at + 400)
    expect(call, "the board must be told whether the seed failed").toContain("initialFailed=")
    expect(call, "initialFailed must be derived from the read's ok").toMatch(/initialFailed=\{!ok\}/)
  })


  it("both pages still destructure `ok` from the fetch, so the derivation has a source", () => {
    // Guards the other half: `{!ok}` is only honest while `ok` comes from the read.
    for (const page of [
      ["app", "insights", "pack-drops", "page.tsx"],
      ["app", "insights", "new-collectors", "page.tsx"],
    ]) {
      // ⚠ No `s` flag — the tsconfig target rejects it. `[\s\S]` is the portable
      // spelling and these destructurings span lines.
      expect(read(...page), `${page.join("/")} must read ok from fetchBoardForPage`).toMatch(
        /const \{[\s\S]*?\bok\b[\s\S]*?\} = await fetchBoardForPage/,
      )
    }
  })
})
