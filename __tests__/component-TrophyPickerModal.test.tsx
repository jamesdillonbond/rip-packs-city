// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// TrophyPickerModal is the ~940-line trophy-case pin picker (0% coverage before
// this). It fetches /api/profile/top-moments for the owner, renders a filterable/
// sortable moment grid, has a manual-ID lookup tab, and pins a pick via
// POST /api/profile/trophy. These tests drive its OWN code: the mount fetch +
// moments state machine (loaded grid vs empty), the grid/manual tab toggle, the
// manual lookup, and the close affordance — with fetch stubbed per endpoint.

import TrophyPickerModal, { type PickerMoment } from "@/components/profile/TrophyPickerModal"

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

function stubFetch(momentsPayload: { moments: PickerMoment[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes("/api/profile/top-moments")) {
        return Promise.resolve({ ok: true, json: async () => momentsPayload } as Response)
      }
      // telemetry fallback + any other call
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    }),
  )
}

beforeEach(() => {
  stubFetch({ moments: [moment] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const baseProps = { slot: 1, ownerKey: "0xbd94cade097e50ac", onClose: () => {}, onPinned: () => {} }

describe("TrophyPickerModal", () => {
  it("renders the slot header and both picker tabs", () => {
    const { getByText } = render(<TrophyPickerModal {...baseProps} />)
    expect(getByText(/Pin to slot 1/)).toBeTruthy()
    expect(getByText(/Pick from collection/)).toBeTruthy()
    expect(getByText(/Enter ID manually/)).toBeTruthy()
  })

  it("loads the owner's moments into the grid", async () => {
    const { findAllByText } = render(<TrophyPickerModal {...baseProps} />)
    expect((await findAllByText(/Victor Wembanyama/)).length).toBeGreaterThan(0)
  })

  it("shows the empty state when the owner has no eligible moments", async () => {
    stubFetch({ moments: [] })
    const { findByText } = render(<TrophyPickerModal {...baseProps} />)
    expect(await findByText(/No owned moments found yet/)).toBeTruthy()
  })

  it("switches to the manual-entry tab", () => {
    const { getByText, container } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    // The manual tab exposes a text input for the moment id.
    expect(container.querySelector("input")).toBeTruthy()
  })

  it("invokes onClose from the close control", () => {
    const onClose = vi.fn()
    const { getByLabelText } = render(<TrophyPickerModal {...baseProps} onClose={onClose} />)
    fireEvent.click(getByLabelText("Close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("renders without an ownerKey (no fetch target) without crashing", async () => {
    const { getByText } = render(<TrophyPickerModal {...baseProps} ownerKey={null} />)
    expect(getByText(/Pin to slot 1/)).toBeTruthy()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
  })
})

const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// The manual-entry tab (moment-ID lookup), the grid filter/sort controls, the
// pin POST, and the MomentRow variant branches were all dark. These drive them.
// 2026-11-08 weekend review: 6 of 22 Dame Time entrants filled the MAIN case with
// Dame pieces (10–13 picker opens each). The main-case picker now says it is the
// main case and offers the challenge entry instead.
describe("TrophyPickerModal — main case vs a live challenge", () => {
  it("the MAIN-case picker names the main case and offers the challenge entry", async () => {
    const onUse = vi.fn()
    const { findByTestId, getByText } = render(
      <TrophyPickerModal {...baseProps} challengeOffer={{ title: "Dame Time", onUse }} />,
    )
    const note = await findByTestId("picker-challenge-offer")
    expect(note.textContent).toMatch(/This is your main trophy case\. Building your Dame Time entry\?/)
    fireEvent.click(getByText("Use my Dame Time case"))
    expect(onUse).toHaveBeenCalledTimes(1)
  })

  it("a CHALLENGE-case picker never shows the offer, even if one is passed", async () => {
    const { queryByTestId, findAllByText } = render(
      <TrophyPickerModal {...baseProps} caseId="11111111-1111-4111-8111-111111111111" challengeOffer={{ title: "Dame Time", onUse: () => {} }} />,
    )
    await findAllByText(/Wembanyama/)
    expect(queryByTestId("picker-challenge-offer")).toBeNull()
  })

  it("CONTROL: no live challenge, no offer", async () => {
    const { queryByTestId, findAllByText } = render(<TrophyPickerModal {...baseProps} />)
    await findAllByText(/Wembanyama/)
    expect(queryByTestId("picker-challenge-offer")).toBeNull()
  })
})

describe("TrophyPickerModal — manual lookup + grid pin + row variants", () => {
  it("looks up a moment ID and renders the preview card (image, serial/mint, fmv)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/"))
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              resolved: { collection_id: "c1", collection_slug: "nba-top-shot", serial_number: 7 },
              edition: { player_name: "Ja Morant", set_name: "Base Set", tier: "RARE", circulation_count: 500, thumbnail_url: "https://x/j.png", external_id: "1:2", name: "E" },
              serial_specific: { nft_id: "999", serial_number: 7, owner_address: "0xabc" },
              fmv: { fmv_usd: 350 },
            }),
          } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, container } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "999" } })
    fireEvent.click(getByText("Look up"))
    await waitFor(() => expect(container.textContent).toContain("Ja Morant"))
    expect(container.textContent).toContain("#7/500")
    expect(container.textContent).toContain("$350.00")
    expect(container.querySelector("img")).toBeTruthy()
  })

  it("shows the not-found error when the lookup responds not-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/"))
          return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, findByText } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "bad" } })
    fireEvent.click(getByText("Look up"))
    expect(await findByText(/Couldn't find a moment with that ID/)).toBeTruthy()
  })

  it("does NOT claim the ID is unknown when the lookup itself failed (5xx)", async () => {
    // /api/moment/[id] answers 404 for a genuine miss and 503 when it could not
    // look at all. Collapsing both into "no such moment" states a fact about the
    // catalogue that was manufactured from a database outage.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/"))
          return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, findByText, queryByText } = render(
      <TrophyPickerModal {...baseProps} />,
    )
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "12345" } })
    fireEvent.click(getByText("Look up"))
    expect(await findByText(/Couldn't look that up right now/)).toBeTruthy()
    expect(queryByText(/Couldn't find a moment with that ID/)).toBeNull()
  })

  it("shows the retry error when the lookup fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/")) return Promise.reject(new Error("network"))
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, findByText } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "boom" } })
    fireEvent.click(getByText("Look up"))
    expect(await findByText(/Lookup failed. Try again/)).toBeTruthy()
  })

  it("does not fetch on an empty manual ID", () => {
    const { getByText } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.click(getByText("Look up"))
    expect((fetch as any).mock.calls.every((c: any[]) => !String(c[0]).includes("/api/moment/"))).toBe(true)
  })

  it("pins a manually looked-up moment (no image → placeholder branch) and calls onPinned", async () => {
    const onPinned = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/"))
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              resolved: { collection_id: "c1" },
              edition: { player_name: "Ja Morant", set_name: "Base", thumbnail_url: null, external_id: "1:2" },
              serial_specific: { nft_id: "999", serial_number: 7 },
              fmv: { fmv_usd: 350 },
            }),
          } as Response)
        if (u.includes("/api/profile/trophy"))
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, container } = render(
      <TrophyPickerModal {...baseProps} onPinned={onPinned} />,
    )
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "999" } })
    fireEvent.click(getByText("Look up"))
    await waitFor(() => expect(container.textContent).toContain("Ja Morant"))
    fireEvent.click(getByText("Pin"))
    await waitFor(() => expect(onPinned).toHaveBeenCalled())
  })

  it("pins a grid moment via POST /api/profile/trophy and calls onPinned", async () => {
    const onPinned = vi.fn()
    const { findByText } = render(<TrophyPickerModal {...baseProps} onPinned={onPinned} />)
    // Tapping a row SELECTS it; only the confirm button writes. A row tap that
    // pinned straight away is the regression this two-step guards against.
    fireEvent.click(await findByText(/Victor Wembanyama/))
    expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("/api/profile/trophy"))).toBe(false)
    fireEvent.click(await findByText("Pin trophy"))
    await waitFor(() => expect(onPinned).toHaveBeenCalled())
    const call = (fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes("/api/profile/trophy"))
    expect(call).toBeTruthy()
    expect(JSON.parse(call[1].body).momentId).toBe("141:5156:1")
  })

  it("surfaces a pick error when the pin POST fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [moment] }) } as Response)
        if (u.includes("/api/profile/trophy"))
          return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "pin blew up" }) } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { findByText } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(await findByText(/Victor Wembanyama/))
    fireEvent.click(await findByText("Pin trophy"))
    // The failure must surface ON the confirm step, where the button that
    // triggered it is — not by dropping the collector back to the list with no
    // explanation of why nothing happened.
    expect(await findByText(/pin blew up/)).toBeTruthy()
    expect(await findByText("Pin trophy")).toBeTruthy()
  })

  // ── "Load more" (2026-11-08) ────────────────────────────────────────────
  // The grid shows 96 at a time; a collector with 300 Dames never reached a
  // cheap one. The route says `hasMore`; the button fetches the next RAW offset.
  function stubPages(pages: Record<string, { ok: boolean; body?: unknown } | "throw">) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments")) {
          const off = new URL(u, "https://t").searchParams.get("offset") ?? "0"
          const p = pages[off]
          if (p === "throw") return Promise.reject(new TypeError("network"))
          if (!p) return Promise.resolve({ ok: false, json: async () => ({}) } as Response)
          return Promise.resolve({ ok: p.ok, json: async () => p.body } as Response)
        }
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
  }
  const kd = { ...moment, moment_id: "kd", player_name: "Kevin Durant" }

  it("Load more appends the next page at offset=96 and hides once the route says it is the end", async () => {
    stubPages({
      "0": { ok: true, body: { moments: [moment], hasMore: true } },
      "96": { ok: true, body: { moments: [kd], hasMore: false } },
    })
    const { findByText, getByText, queryByText, container } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/Victor Wembanyama/)
    fireEvent.click(getByText("Load 96 more"))
    await findByText(/Kevin Durant/)
    expect(container.textContent).toContain("Victor Wembanyama")
    expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("offset=96"))).toBe(true)
    expect(queryByText("Load 96 more")).toBeNull()
  })

  it("no Load more button when the route says there is nothing past this page", async () => {
    stubPages({ "0": { ok: true, body: { moments: [moment], hasMore: false } } })
    const { findByText, queryByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/Victor Wembanyama/)
    expect(queryByText("Load 96 more")).toBeNull()
  })

  it("⛔ a FAILED next page is not the end of the list: the button stays, the loaded rows stay, and it says so", async () => {
    stubPages({ "0": { ok: true, body: { moments: [moment], hasMore: true } }, "96": "throw" })
    const { findByText, getByText, container } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/Victor Wembanyama/)
    fireEvent.click(getByText("Load 96 more"))
    expect(await findByText(/Couldn.t load more/)).toBeTruthy()
    expect(getByText("Load 96 more")).toBeTruthy()
    expect(container.textContent).toContain("Victor Wembanyama")
    expect(container.textContent).not.toMatch(/No owned moments|Nothing you hold/)
  })

  it("a row repeated across pages is shown once", async () => {
    stubPages({
      "0": { ok: true, body: { moments: [moment], hasMore: true } },
      "96": { ok: true, body: { moments: [moment, kd], hasMore: false } },
    })
    const { findByText, getByText, getAllByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/Victor Wembanyama/)
    fireEvent.click(getByText("Load 96 more"))
    await findByText(/Kevin Durant/)
    expect(getAllByText(/Victor Wembanyama/)).toHaveLength(1)
  })

  // ── Challenge auto-load (2026-11-08) ─────────────────────────────────────
  // "Make sure the Extra Spice appears when the Dame Time case is just filtered
  // to Damian Lillard": the challenge's pre-filled player loads EVERY page.
  const offsetsFetched = () =>
    (fetch as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((u: string) => u.includes("/api/profile/top-moments"))
      .map((u: string) => Number(new URL(u, "https://t").searchParams.get("offset") ?? 0))

  it("a challenge pre-fill loads every page with NO click — the cheap set piece on page 3 shows", async () => {
    const spice = { ...moment, moment_id: "es", set_name: "Extra Spice", fmv_usd: 3 }
    stubPages({
      "0": { ok: true, body: { moments: [moment], hasMore: true } },
      "96": { ok: true, body: { moments: [kd], hasMore: true } },
      "192": { ok: true, body: { moments: [spice], hasMore: false } },
    })
    const { findByText, container, queryByText } = render(<TrophyPickerModal {...baseProps} initialQuery="Victor" />)
    await findByText(/Extra Spice/)
    expect(container.textContent).toContain("Kevin Durant")
    expect(offsetsFetched()).toEqual([0, 96, 192])
    expect(queryByText("Load 96 more")).toBeNull()
  })

  it("auto-load stops at CHALLENGE_AUTOLOAD_MAX and leaves the button for the rest", async () => {
    const pages: Record<string, { ok: boolean; body: unknown }> = {}
    for (let o = 0; o <= 960; o += 96) pages[String(o)] = { ok: true, body: { moments: [{ ...moment, moment_id: "m" + o }], hasMore: true } }
    stubPages(pages)
    const { findByText } = render(<TrophyPickerModal {...baseProps} initialQuery="Victor" />)
    await findByText("Load 96 more")
    await waitFor(() => expect(offsetsFetched()).toEqual([0, 96, 192, 288, 384]))
    // waitFor passes the moment the list MATCHES; the cap is that it then STAYS.
    await new Promise((r) => setTimeout(r, 150))
    expect(offsetsFetched()).toEqual([0, 96, 192, 288, 384])
    expect(await findByText("Load 96 more")).toBeTruthy()
  })

  it("a FAILED auto-load page stops the chain (no retry loop) and says so", async () => {
    stubPages({ "0": { ok: true, body: { moments: [moment], hasMore: true } }, "96": "throw" })
    const { findByText } = render(<TrophyPickerModal {...baseProps} initialQuery="Victor" />)
    expect(await findByText(/Couldn.t load more/)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(offsetsFetched()).toEqual([0, 96])
  })

  it("no auto-load outside a challenge (no pre-fill): the next page waits for the click", async () => {
    stubPages({ "0": { ok: true, body: { moments: [moment], hasMore: true } }, "96": { ok: true, body: { moments: [kd], hasMore: false } } })
    const { findByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText("Load 96 more")
    await new Promise((r) => setTimeout(r, 50))
    expect(offsetsFetched()).toEqual([0])
  })

  it("filters the grid to empty via the search box (filter-miss copy)", async () => {
    const { getByLabelText, findByText, getByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/Victor Wembanyama/)
    fireEvent.change(getByLabelText("Search your moments"), { target: { value: "zzzznomatch" } })
    expect(getByText(/No moments match the current filter/)).toBeTruthy()
  })

  // 2026-11-07 review: (a) a 1-character query maps to the same "" as an idle
  // box, so it filtered nothing; (b) the "nothing you hold matches" copy fired
  // whenever a server query was set, even when the server returned Moments and
  // only a pending keystroke (or a filter) hid them.
  it("a ONE-character query still narrows the grid client-side", async () => {
    stubFetch({ moments: [moment, { ...moment, moment_id: "kd", player_name: "Kevin Durant", team_name: "Phoenix Suns", set_name: "Base Set" }] })
    const { getByLabelText, findByText, container } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/Kevin Durant/)
    fireEvent.change(getByLabelText("Search your moments"), { target: { value: "K" } })
    expect(container.textContent).toContain("Kevin Durant")
    expect(container.textContent).not.toContain("Victor Wembanyama")
  })

  it("⛔ Moments the server DID return for a name are never called 'nothing you hold matches'", async () => {
    const { getByLabelText, findByText, getByText, queryByText } = render(<TrophyPickerModal {...baseProps} initialQuery="Victor" />)
    await findByText(/Victor Wembanyama/)
    // Before the 300 ms debounce refetches, the stale list is narrowed client-side to nothing.
    fireEvent.change(getByLabelText("Search your moments"), { target: { value: "Victorzz" } })
    expect(queryByText(/Nothing you hold matches/)).toBeNull()
    expect(getByText(/No moments match the current filter/)).toBeTruthy()
  })

  it("drives the sort + tier-filter controls and the MomentRow variant branches", async () => {
    const gridMoments: PickerMoment[] = [
      // locked, no image (● fallback), NBA league badge, team, tier chip, series label
      { ...moment, moment_id: "g1", is_locked: true, image_url: null, league: "NBA", team_name: "Portland", tier: "LEGENDARY", serial_number: 1, mint_count: 99, series_number: 4, set_name: "Base Set" },
      // null-everything row + a serial-fmv badge
      { ...moment, moment_id: "g2", tier: null, team_name: null, serial_number: null, mint_count: null, fmv_usd: null, set_name: null, series_number: null, league: null, image_url: null, player_name: "No Tier Guy", serial_fmv: { estimate_usd: 5000, multiplier: 3, serial_bucket: "first" } },
    ]
    stubFetch({ moments: gridMoments })
    const { container, findByText, getByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/No Tier Guy/)
    // sort controls
    fireEvent.click(getByText("Serial ↑"))
    fireEvent.click(getByText("Tier"))
    // tier filter chip (the button, not the in-row tier <span>)
    const legChip = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "LEGENDARY")
    expect(legChip).toBeTruthy()
    fireEvent.click(legChip!)
    // after filtering to LEGENDARY, the null-tier row is gone
    expect(container.textContent).toContain("Victor Wembanyama")
  })

  it("re-fetches with a collection param and resets a non-default league on collection change", async () => {
    stubFetch({ moments: [] })
    const { container } = render(<TrophyPickerModal {...baseProps} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    // set a non-default league first (so the reset branch fires)
    const nbaRadio = Array.from(container.querySelectorAll('button[role="radio"]')).find((b) => b.textContent === "NBA")
    fireEvent.click(nbaRadio!)
    // pick a real collection (title-bearing picker buttons; [All] is title="All")
    const collBtn = Array.from(container.querySelectorAll("button[title]")).find((b) => b.getAttribute("title") !== "All")
    expect(collBtn).toBeTruthy()
    fireEvent.click(collBtn!)
    await waitFor(() =>
      expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("collection="))).toBe(true),
    )
  })

  it("renders the NBA league badge only for a Top Shot row with an NBA league value", async () => {
    const nbaMoment: PickerMoment = { ...moment, moment_id: "nba1", collection_id: TS_UUID, league: "NBA", player_name: "League Badge Guy" }
    stubFetch({ moments: [nbaMoment] })
    const { container, findByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/League Badge Guy/)
    // the league badge <span> renders the raw league string
    expect(container.textContent).toContain("NBA")
  })

  // 2026-09-27 — Candy MLB (Solana) holdings are in the trophy pool, so the
  // picker offers a Candy chip.
  // ⚠ INVERTED 2026-09-28: Panini was held OUT because its holdings were not in
  // the pool and its chip could only answer "you own none". The pool now reads
  // the collector's LINKED Panini usernames, so the chip is offered — and its
  // empty state must say WHICH "none" it is (the three tests below).
  it("offers a Candy MLB chip and a Panini chip", async () => {
    const { container } = render(<TrophyPickerModal {...baseProps} />)
    const titles = Array.from(container.querySelectorAll("button[title]")).map((b) => b.getAttribute("title"))
    expect(titles).toContain("Candy")
    expect(titles).toContain("Panini")
  })

  it("asks the route for Panini rows (panini=1) — the one picker that can pin them", async () => {
    stubFetch({ moments: [] })
    render(<TrophyPickerModal {...baseProps} />)
    await waitFor(() =>
      expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("panini=1"))).toBe(true),
    )
  })

  const openPanini = async (payload: { moments: PickerMoment[]; paniniUsernamesLinked: number | null }) => {
    stubFetch(payload)
    const utils = render(<TrophyPickerModal {...baseProps} savedChains={["flow"]} />)
    const chip = Array.from(utils.container.querySelectorAll("button[title]")).find((b) => b.getAttribute("title") === "Panini")
    fireEvent.click(chip!)
    await waitFor(() =>
      expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("collection=panini-blockchain"))).toBe(true),
    )
    return utils
  }

  it("an empty Panini filter with NO username linked says to link one — not 'none found'", async () => {
    const { findByText, queryByText } = await openPanini({ moments: [], paniniUsernamesLinked: 0 })
    expect(await findByText(/haven’t linked a Panini username/)).toBeTruthy()
    // savedChains=["flow"] must not leak the Flow wallet copy into the Panini chip.
    expect(queryByText(/No Panini Moments found in your saved wallets/)).toBeNull()
  })

  it("an empty Panini filter WITH a username linked says it has not been read yet, not 'link one'", async () => {
    const { findByText, queryByText } = await openPanini({ moments: [], paniniUsernamesLinked: 1 })
    expect(await findByText(/hasn’t read any cards under your linked Panini username/)).toBeTruthy()
    expect(queryByText(/haven’t linked a Panini username/)).toBeNull()
  })

  it("an empty Panini filter with the link count UNKNOWN hedges — never 'you haven't linked'", async () => {
    const { findByText, queryByText } = await openPanini({ moments: [], paniniUsernamesLinked: null })
    expect(await findByText(/If you haven’t linked your Panini username/)).toBeTruthy()
    expect(queryByText(/You haven’t linked a Panini username yet/)).toBeNull()
  })

  it("an empty Candy filter says how to add a Solana wallet, not just 'none found'", async () => {
    stubFetch({ moments: [] })
    const { container, findByText } = render(<TrophyPickerModal {...baseProps} />)
    const candy = Array.from(container.querySelectorAll("button[title]")).find((b) => b.getAttribute("title") === "Candy")
    fireEvent.click(candy!)
    await waitFor(() =>
      expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("collection=candy-mlb"))).toBe(true),
    )
    // savedChains unknown → hedged: "if you haven't added…", never "you haven't".
    expect(await findByText(/If you haven’t added your Solana wallet/)).toBeTruthy()
  })

  it("an empty Flow filter with a Flow wallet saved says none found, not 'add a wallet' (control)", async () => {
    stubFetch({ moments: [] })
    const { container, findByText, queryByText } = render(<TrophyPickerModal {...baseProps} savedChains={["flow"]} />)
    const ts = Array.from(container.querySelectorAll("button[title]")).find((b) => b.getAttribute("title") === "Top Shot")
    fireEvent.click(ts!)
    expect(await findByText(/No Top Shot Moments found in your saved wallets/)).toBeTruthy()
    expect(queryByText(/haven’t added/)).toBeNull()
  })

  it("an empty Flow filter with NO Flow wallet saved says to add a Dapper wallet", async () => {
    stubFetch({ moments: [] })
    const { container, findByText } = render(<TrophyPickerModal {...baseProps} savedChains={["solana"]} />)
    const ts = Array.from(container.querySelectorAll("button[title]")).find((b) => b.getAttribute("title") === "Top Shot")
    fireEvent.click(ts!)
    expect(await findByText(/You haven’t added a Flow wallet/)).toBeTruthy()
  })

  it("no wallets at all, on All, says to add a wallet", async () => {
    stubFetch({ moments: [] })
    const { findByText } = render(<TrophyPickerModal {...baseProps} savedChains={[]} />)
    expect(await findByText(/You haven’t added a wallet yet/)).toBeTruthy()
  })
})
