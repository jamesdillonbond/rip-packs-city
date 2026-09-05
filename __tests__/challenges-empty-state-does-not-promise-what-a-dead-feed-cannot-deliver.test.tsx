// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderToString } from "react-dom/server"

// ─────────────────────────────────────────────────────────────────────────────
// /[collection]/challenges — the empty state must not make a promise the INGEST
// cannot keep.
//
// The page already separated "the read failed" from "there are genuinely none",
// and both of those are claims about the READ. Neither can see the third state:
// the read SUCCEEDS against a healthy table, returns zero active challenges, and
// the thing that FEEDS that table is dead.
//
//   • `ingest-topshot-challenges` has answered HTTP 530 on every run since
//     2026-08-29 (`public-api.nbatopshot.com`, decommissioned). Last OK day
//     2026-08-28.
//   • The only writers that can ADD a challenge are `upsert_challenge_from_gql`
//     (fed by that ingest) and a manual `upsert_challenge` — enumerated over
//     `pg_proc`, because nothing in the repo writes the table directly.
//   • The table still LOOKS fresh: all 31 rows carry an `updated_at` inside 7
//     days, because `refresh_challenge_costs` re-prices them on its own cadence.
//     **Freshness of the ROWS is not freshness of the FEED.**
//
// So the old copy — "When Top Shot runs a Set-Locking or Crafting Challenge,
// it'll show up here" — was a forward-looking claim that had been false for
// eight days. The canon calls this an empty state that CONCLUDES rather than
// reports.
//
// ⚠ ASSERTED BY SSR, not by a mount. This is a server component and the copy is
// server-rendered; a jsdom mount would be testing something the reader never
// sees. CLAUDE.md records that two OPPOSITE mutations pass every client test
// when the assertion runs after hydration.
// ─────────────────────────────────────────────────────────────────────────────

const fetchActiveChallenges = vi.fn()
const fetchChallengeFeed = vi.fn()

vi.mock("@/lib/challenges/hub-fetchers", () => ({
  fetchActiveChallenges: (...a: unknown[]) => fetchActiveChallenges(...a),
  fetchChallengeFeed: (...a: unknown[]) => fetchChallengeFeed(...a),
}))
vi.mock("next/link", () => ({
  default: ({ children }: { children?: React.ReactNode }) => children,
}))

async function renderPage(): Promise<string> {
  const mod = await import("@/app/(collections)/[collection]/challenges/page")
  const Page = mod.default as (p: { params: Promise<{ collection: string }> }) => Promise<React.ReactElement>
  const el = await Page({ params: Promise.resolve({ collection: "nba-top-shot" }) })
  return renderToString(el)
}

/** The sentence that must not survive a dead feed. */
const PROMISE = /it&#x27;ll show up here|it’ll show up here|ll show up here/

beforeEach(() => {
  vi.resetModules()
  // ⚠ resetModules does NOT clear call history — the "probe is not taken" case
  // read 3 calls left over from the cases above and failed for the wrong reason.
  fetchActiveChallenges.mockReset()
  fetchChallengeFeed.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
  fetchActiveChallenges.mockResolvedValue({ challenges: [], ok: true })
})
afterEach(() => vi.restoreAllMocks())

describe("challenges empty state", () => {
  it("🚨 a STALE feed does NOT promise that a new challenge will show up here", async () => {
    fetchChallengeFeed.mockResolvedValue({ state: "stale", lastOkDay: "2026-08-28" })
    const html = await renderPage()
    // The load-bearing assertion is the ABSENCE of the false claim, not the
    // presence of a warning — CLAUDE.md names asserting the presence of an
    // error message as the weaker, vacuous-prone form.
    expect(html).not.toMatch(PROMISE)
    // ...and it says WHY, with the date, so the reader can act on it.
    expect(html).toContain("2026-08-28")
    expect(html).toMatch(/feed is behind/)
  })

  it("a CURRENT feed keeps the promise — it is true then", async () => {
    // The no-change control. Without it, deleting the promise unconditionally
    // would pass the case above while making the healthy page worse.
    fetchChallengeFeed.mockResolvedValue({ state: "current", lastOkDay: "2026-09-05" })
    const html = await renderPage()
    expect(html).toMatch(PROMISE)
    expect(html).not.toMatch(/feed is behind/)
  })

  it("an UNKNOWN feed states the fact and makes NO promise either way", async () => {
    // A failed freshness read must neither keep the promise nor allege
    // staleness. Omission understates, which is the safe direction.
    fetchChallengeFeed.mockResolvedValue({ state: "unknown", lastOkDay: null })
    const html = await renderPage()
    expect(html).not.toMatch(PROMISE)
    expect(html).not.toMatch(/feed is behind/)
    expect(html).toMatch(/No active challenges are being tracked right now/)
  })

  it("a FAILED read still says 'couldn't load' — and never claims there are none", async () => {
    // The pre-existing branch, pinned so this change cannot regress it.
    fetchActiveChallenges.mockResolvedValue({ challenges: [], ok: false })
    const html = await renderPage()
    expect(html).toMatch(/Couldn&#x27;t load challenges|Couldn’t load challenges/)
    expect(html).not.toMatch(/No active challenges are being tracked/)
    expect(html).not.toMatch(PROMISE)
  })

  it("the freshness probe is NOT taken when there are challenges to show", async () => {
    // A page that HAS challenges makes no promise about future ones, so the
    // read would be taken for a caption nobody sees.
    fetchActiveChallenges.mockResolvedValue({
      challenges: [{ challengeId: "c1", slug: "s", name: "N", challengeType: "set_locking", endsAt: null, rewardKind: null, rewardLabel: null, totalRewardAllocation: null, completedCount: null, totalRequired: 1, missingCount: 0, completionPct: null, costToComplete: null, rewardValue: null, netEv: null, worthIt: null }],
      ok: true,
    })
    await renderPage()
    expect(fetchChallengeFeed).not.toHaveBeenCalled()
  })
})
