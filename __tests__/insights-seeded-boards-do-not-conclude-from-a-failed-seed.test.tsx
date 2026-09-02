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

// ── pack-sniper: the SAME class, on TWO pages, one of which already had the
// page-level banner this file's header says is not a fix ────────────────────
//
// Found 2026-08-24 by sweeping SEEDED PROPS for a provenance companion across
// all of `app/` rather than just `app/insights` — 25 pages seed a board, and
// two lacked provenance entirely.
//
// `PackSniperClient` seeds `deals` from `initialDeals`, starts `loading` false
// and `error` null (that one is ONLY ever set by its own fetch), so a failed
// seed fell straight through to:
//
//   "No sealed packs match your filters … Check back as new packs get listed."
//
// — a claim about the MARKET. ⚠ `/insights/pack-sniper` ALREADY rendered
// `<DegradedDataNotice>` above it, so on a failed read the page showed a notice
// saying the data is degraded directly above a board confidently reporting an
// empty market. Exactly the shape the header above describes for pack-drops and
// new-collectors, on a page a previous pass had already "hardened".
//
// ⚠ WHY THIS SURVIVED, and why the assertion has to be SSR: this client DOES
// refetch on mount (`showHighVariance` defaults true, so the first-run skip does
// not apply), so a human sees the sentence corrected almost immediately. It
// lives in the RAW SERVER HTML — which is the entire reason the board is seeded
// (crawlability) and is ISR-cached for `revalidate = 300`. A jsdom test would
// have shown it self-correcting and reported no defect.
const readPage = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8")

/** Minimal VALID Deal — the row renderer dereferences camelCase fields. */
const seedDeal = {
  distId: "5048",
  title: "Test Pack",
  tier: "common",
  imageUrl: "",
  slots: 3,
  lowestAsk: 10,
  grossEV: 20,
  liveValueRatio: 2,
  discountPct: 50,
  fmvCoveragePct: 100,
  evSnapshottedAt: null,
  editionCount: 3,
  depletionPct: null,
  highVariance: false,
  highVarianceReasons: [],
  buyUrl: "https://example.test/buy",
  dapperUrl: "https://example.test/dapper",
  detailHref: "/nba-top-shot/pack/dist/5048",
  simulatorHref: "/nba-top-shot/packs/simulator/5048",
  askChangedAt: null,
}

describe("pack-sniper does not conclude about the market from a failed seed", () => {
  it("SSR: a failed seed says it couldn't load, NOT that no packs match", async () => {
    const { renderToString } = await import("react-dom/server")
    const PackSniperClient = (await import("@/app/insights/pack-sniper/PackSniperClient")).default
    const html = renderToString(
      <PackSniperClient initialDeals={[]} initialFetchedAt={null} initialFailed />,
    )
    // Assert the ABSENCE of the false claim — asserting only that the degraded
    // sentence appears would pass a board printing BOTH.
    expect(html).not.toMatch(/No sealed packs match your filters/)
    expect(html).toMatch(/couldn.{1,8}t be loaded right now/i)
  })

  it("SSR NO-CHANGE CONTROL: a genuinely empty board still says no packs match", async () => {
    const { renderToString } = await import("react-dom/server")
    const PackSniperClient = (await import("@/app/insights/pack-sniper/PackSniperClient")).default
    const html = renderToString(
      <PackSniperClient
        initialDeals={[]}
        initialFetchedAt="2026-08-24T00:00:00Z"
        initialFailed={false}
      />,
    )
    // Without this, deleting the empty state entirely would satisfy the case
    // above — and a guard passable by removing the feature is not a guard.
    expect(html).toMatch(/No sealed packs match your filters/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded right now/i)
  })

  it("SSR: a failed seed does not suppress rows it DID manage to seed", async () => {
    // The degraded branch is gated on `deals.length === 0`, so a partial seed
    // still renders. Pinned because "show the error instead" is the tempting
    // over-correction, and it would hide real data.
    const { renderToString } = await import("react-dom/server")
    const PackSniperClient = (await import("@/app/insights/pack-sniper/PackSniperClient")).default
    const html = renderToString(
      <PackSniperClient
        initialDeals={[seedDeal as never]}
        initialFetchedAt={null}
        initialFailed
      />,
    )
    expect(html).not.toMatch(/couldn.{1,8}t be loaded right now/i)
  })

  it("BOTH pack-sniper pages pass initialFailed derived from the read's ok", () => {
    // The collection twin renders the same client from the same helper and had
    // NEITHER the flag nor a budget — it sat outside app/insights, which is
    // where every sweep of this class had stopped.
    for (const page of [
      ["app", "insights", "pack-sniper", "page.tsx"],
      ["app", "(collections)", "[collection]", "pack-sniper", "page.tsx"],
    ]) {
      const src = readPage(...page)
      expect(src, `${page.join("/")} must tell the board whether the seed failed`).toMatch(
        /initialFailed=\{!ok\}/,
      )
      expect(src, `${page.join("/")} must derive ok from its own read`).toMatch(/\bok\b/)
    }
  })
})

// ── cross-collection (the WHALE MAP), found 2026-09-02 ──────────────────────
//
// The sixth board of this class, and it was missed by the 2026-08-24 sweep for a
// reason worth stating: that sweep's own write-up records the correct predicate
// ("server pages that KNOW `ok` and seed a client component without passing it")
// and this page satisfies it exactly — it computes `ok` from THREE reads, renders
// the degraded banner from that very `ok`, and then hands the client `initial`
// alone.
//
// ⚠ TWO conclusive sentences, not one, and they are about different things:
//   "No wallets found."   ← a claim about the COHORT
//   "No overlap data."    ← a claim about the SET OVERLAP table
// Both are reachable from a failed read, because `fetchInitial` returns
// `wallets: cohortRes.data ?? []` and `ts_set_overlap: setOverlapRes.data ?? []`
// on every path including the budget-overrun catch.
//
// ⚠ AND IT DOES NOT SELF-CORRECT. The client's effect returns early on its first
// run while `sort` is the default "moments" (`if (isFirstRun.current) { … if
// (sort === "moments") return }`), so there is NO mount refetch: the sentences
// stand for the whole visit unless the reader changes the sort. The page's stated
// purpose is putting the cohort tables into the raw server HTML for crawlers.
describe("cross-collection does not conclude about the cohort from a failed seed", () => {
  const seed = (rows: { wallets: unknown[]; overlap: unknown[] }) =>
    ({
      meta: { fetched_at: "2026-09-02T00:00:00Z" },
      stats: null,
      wallets: rows.wallets,
      ts_set_overlap: rows.overlap,
    }) as never

  it("SSR: a failed seed says it couldn't load, NOT that there are no wallets or no overlap", async () => {
    const { renderToString } = await import("react-dom/server")
    const CrossCollectionBoardClient = (
      await import("@/app/insights/cross-collection/CrossCollectionBoardClient")
    ).default
    const html = renderToString(
      <CrossCollectionBoardClient initial={seed({ wallets: [], overlap: [] })} initialFailed />,
    )
    // ⚠ Assert the ABSENCE of each false claim. Asserting only that the degraded
    // sentence appears would pass a board printing BOTH.
    expect(html).not.toMatch(/No wallets found/)
    expect(html).not.toMatch(/No overlap data/)
    expect(html).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR NO-CHANGE CONTROL: a genuinely empty board still says both original sentences", async () => {
    // Without this, deleting the empty states outright would satisfy the
    // assertions above — a guard that can be passed by removing the feature is
    // not a guard.
    const { renderToString } = await import("react-dom/server")
    const CrossCollectionBoardClient = (
      await import("@/app/insights/cross-collection/CrossCollectionBoardClient")
    ).default
    const html = renderToString(
      <CrossCollectionBoardClient
        initial={seed({ wallets: [], overlap: [] })}
        initialFailed={false}
      />,
    )
    expect(html).toMatch(/No wallets found/)
    expect(html).toMatch(/No overlap data/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("the page passes initialFailed derived from its own read's ok", () => {
    const src = readPage("app", "insights", "cross-collection", "page.tsx")
    expect(src, "the whale map must tell the board whether the seed failed").toMatch(
      /initialFailed=\{!ok\}/,
    )
    // …and the `ok` it passes must still be the one derived from all three legs,
    // not a constant someone wired in to satisfy the line above.
    expect(src).toMatch(/ok:\s*errors\.length === 0/)
  })
})

// ── three more, all found by the same predicate on 2026-09-02 ───────────────
//
// `parallel-premiums`, `rookie-board` and `top-sales` each compute `ok`, render
// the degraded banner from it, and then hand the client the unlabelled `[]`.
// ⚠ All three empty sentences blame the FILTERS — "No parallels match these
// filters.", "No rookie editions match those filters.", "No sales match those
// filters." — which is the actionable sub-class: a reader who believes it widens
// filters that were never the problem.
//
// ⚠ NONE of the three self-corrects, measured from the code rather than assumed:
//   parallel-premiums  effect returns early on `firstRender`
//   rookie-board       `const rows = initialRows` — no state, no effect at all
//   top-sales          its own header: "the default view never refetches on mount"
describe("three more seeded boards do not blame the filters for a failed seed", () => {
  it("SSR parallel-premiums: a failed seed says it couldn't load, not that nothing matches", async () => {
    const { renderToString } = await import("react-dom/server")
    const C = (await import("@/app/insights/parallel-premiums/ParallelPremiumsBoardClient")).default
    const html = renderToString(
      <C initialRows={[]} initialFetchedAt="2026-09-02T00:00:00Z" initialFailed />,
    )
    expect(html).not.toMatch(/No parallels match these filters/)
    // This board already owned the right sentence for its OWN refetch; the fix
    // was seeding that state from the server read instead of always `false`.
    expect(html).toMatch(/Couldn.{1,8}t load these filters just now/i)
  })

  it("SSR parallel-premiums NO-CHANGE CONTROL: a genuinely empty board still blames the filters", async () => {
    const { renderToString } = await import("react-dom/server")
    const C = (await import("@/app/insights/parallel-premiums/ParallelPremiumsBoardClient")).default
    const html = renderToString(
      <C initialRows={[]} initialFetchedAt="2026-09-02T00:00:00Z" initialFailed={false} />,
    )
    expect(html).toMatch(/No parallels match these filters/)
    expect(html).not.toMatch(/Couldn.{1,8}t load these filters just now/i)
  })

  it("SSR rookie-board: a failed seed says it couldn't load, not that nothing matches", async () => {
    const { renderToString } = await import("react-dom/server")
    const C = (await import("@/app/insights/rookie-board/RookieBoardClient")).default
    const html = renderToString(
      <C initialRows={[]} initialFetchedAt="2026-09-02T00:00:00Z" initialFailed />,
    )
    expect(html).not.toMatch(/No rookie editions match those filters/)
    expect(html).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR rookie-board NO-CHANGE CONTROL: a genuinely empty board still blames the filters", async () => {
    const { renderToString } = await import("react-dom/server")
    const C = (await import("@/app/insights/rookie-board/RookieBoardClient")).default
    const html = renderToString(
      <C initialRows={[]} initialFetchedAt="2026-09-02T00:00:00Z" initialFailed={false} />,
    )
    expect(html).toMatch(/No rookie editions match those filters/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR top-sales: a failed seed says it couldn't load, not that nothing matches", async () => {
    const { renderToString } = await import("react-dom/server")
    const C = (await import("@/app/insights/top-sales/TopSalesBoardClient")).default
    const html = renderToString(
      <C initialRows={[]} initialFetchedAt="2026-09-02T00:00:00Z" initialFailed />,
    )
    expect(html).not.toMatch(/No sales match those filters/)
    expect(html).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("SSR top-sales NO-CHANGE CONTROL: a genuinely empty board still blames the filters", async () => {
    const { renderToString } = await import("react-dom/server")
    const C = (await import("@/app/insights/top-sales/TopSalesBoardClient")).default
    const html = renderToString(
      <C initialRows={[]} initialFetchedAt="2026-09-02T00:00:00Z" initialFailed={false} />,
    )
    expect(html).toMatch(/No sales match those filters/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("all three pages pass initialFailed derived from their own read's ok", () => {
    for (const board of ["parallel-premiums", "rookie-board", "top-sales"]) {
      const src = readPage("app", "insights", board, "page.tsx")
      expect(src, `${board} must tell its board whether the seed failed`).toMatch(
        /initialFailed=\{!ok\}/,
      )
      // …and `ok` must still come from the read, not be a literal wired in to
      // satisfy the line above.
      expect(src, `${board} must derive ok from its own read`).toMatch(/\bok\b/)
      expect(src, `${board} must not hardcode ok`).not.toMatch(/const ok = (true|false)/)
    }
  })
})
