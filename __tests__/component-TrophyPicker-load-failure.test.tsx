// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import TrophyPickerModal, { type PickerMoment } from "@/components/profile/TrophyPickerModal"

// ⚠ THE PICKER TOLD A COLLECTOR THEY OWN NO MOMENTS, OUT OF A FAILED READ.
// The loader was
//
//     .then((r) => (r.ok ? r.json() : null))
//     .then((d) => setMoments((d?.moments as PickerMoment[]) ?? []))
//     .catch(() => setMoments([]))
//
// so a 503 and a genuinely-empty collection both landed on `[]`, and the grid
// renders that as "No owned moments found yet — try the manual tab if you know
// the moment ID."
//
// That is the account-level variant of the failure-renders-as-data class, and
// the worst kind of it: the claim is about the reader's OWN holdings, and it is
// ACTIONABLE — the manual-tab suggestion beside it sends them off to type an id
// for a Moment we merely failed to fetch.
//
// ⚠ The file's own header ALREADY documents a different instance of this exact
// class (the PICKER_LIMIT search-scope cap producing "No moments match the
// current filter" about someone's real collection). One was found and written
// up; the one two lines above it in the same effect was not. **A comment
// identifying a class is not a sweep of it.**

const moment: PickerMoment = {
  moment_id: "141:5156:1",
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  collection_slug: "nba-top-shot",
  wallet_address: "0xbd94cade097e50ac",
  player_name: "Victor Wembanyama",
  set_name: "Base Set",
  team_name: "San Antonio Spurs",
  tier: "LEGENDARY",
  serial_number: 1,
  mint_count: 2999,
  fmv_usd: 1200,
  image_url: "https://example.com/m.png",
  is_locked: false,
  series_number: 4,
  edition_key: "141:5156",
  league: "nba",
}

type MomentsHandler = () => Promise<Response> | Response | never

function stubFetch(moments: MomentsHandler) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, _init?: RequestInit) => {
      void _init
      if (String(url).includes("/api/profile/top-moments")) return moments()
      return { ok: true, json: async () => ({}) } as Response
    }),
  )
}

const props = { slot: 1, ownerKey: "0xbd94cade097e50ac", onClose: () => {}, onPinned: () => {} }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TrophyPickerModal — a failed read is not an empty collection", () => {
  it("a NON-2XX read says WE could not load, not that you own nothing", async () => {
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }) as Response)
    const { findByText, queryByText } = render(<TrophyPickerModal {...props} />)

    expect(await findByText(/couldn.t load your moments/i)).toBeTruthy()
    // ⚠ The assertion that matters is the ABSENCE of the false claim, not the
    // presence of an error message — the two used to render from one branch, so
    // "an error is mentioned somewhere" would have passed on the defect.
    expect(queryByText(/no owned moments found yet/i)).toBeNull()
    // ...and it must not send them to the manual tab for a Moment we failed to
    // fetch, which is what made this actionable rather than merely wrong.
    expect(queryByText(/try the manual tab/i)).toBeNull()
  })

  it("a THROWN fetch is handled the same way", async () => {
    // `fetch` rejects on a network failure rather than resolving non-ok, and
    // the original `.catch` set `[]` — the same false claim by a second route.
    stubFetch(() => {
      throw new TypeError("Failed to fetch")
    })
    const { findByText, queryByText } = render(<TrophyPickerModal {...props} />)

    expect(await findByText(/couldn.t load your moments/i)).toBeTruthy()
    expect(queryByText(/no owned moments found yet/i)).toBeNull()
  })

  it("a GENUINELY empty collection still says so — the honest claim survives", async () => {
    // The mirror-image defect. A new collector really does own nothing, and the
    // manual-tab hint is the right next step for THEM; routing that into
    // "couldn't load" would hide a true answer behind a false apology.
    stubFetch(() => ({ ok: true, json: async () => ({ moments: [] }) }) as Response)
    const { findByText, queryByText } = render(<TrophyPickerModal {...props} />)

    expect(await findByText(/no owned moments found yet/i)).toBeTruthy()
    expect(queryByText(/couldn.t load your moments/i)).toBeNull()
  })

  it("a successful read renders the grid and no notice", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ moments: [moment] }) }) as Response)
    const { findAllByText, queryByText } = render(<TrophyPickerModal {...props} />)

    expect((await findAllByText(/Victor Wembanyama/)).length).toBeGreaterThan(0)
    expect(queryByText(/couldn.t load your moments/i)).toBeNull()
    expect(queryByText(/no owned moments found yet/i)).toBeNull()
  })

  it("the failure flag CLEARS on a refetch, so a recovered read is not stuck", async () => {
    // The effect re-runs on every filter change. A flag that survived would pin
    // the notice permanently after one blip, which is the cry-wolf outcome
    // board-status.ts warns about — a permanent notice is its own false claim.
    let fail = true
    stubFetch(() =>
      fail
        ? (({ ok: false, status: 503, json: async () => ({}) }) as Response)
        : (({ ok: true, json: async () => ({ moments: [moment] }) }) as Response),
    )
    const { findByText, findAllByText, rerender, queryByText } = render(<TrophyPickerModal {...props} />)
    expect(await findByText(/couldn.t load your moments/i)).toBeTruthy()

    fail = false
    // A changed ownerKey re-runs the load effect, the same as a filter change.
    rerender(<TrophyPickerModal {...props} ownerKey="0xb5053ef95e702657" />)

    // ⚠ WAIT FOR THE RECOVERED GRID FIRST, then assert the notice is gone.
    // A bare `waitFor(notice is null)` is VACUOUS here and passed with the
    // reset removed: the effect sets `moments` back to null on re-run, so the
    // spinner branch wins for a tick and the notice is legitimately absent
    // during it — the assertion resolves in that window, before the data
    // lands, and never observes the state it is about. Two conditions that are
    // individually true at DIFFERENT moments do not prove they are ever true
    // together; pin the ORDER when state arrives asynchronously.
    expect((await findAllByText(/Victor Wembanyama/)).length).toBeGreaterThan(0)
    expect(queryByText(/couldn.t load your moments/i)).toBeNull()
  })
})
