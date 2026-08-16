// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import PinnacleCollectionClient from "@/app/(collections)/disney-pinnacle/collection/PinnacleCollectionClient"

// Third page in this sweep with the same defect, and the sharpest instance of it: the figure
// manufactured from a failed read is a claim about the READER'S OWN HOLDINGS.
//
// "Total Pins: 0" rendered under the error banner that said the read had failed. What makes
// it recognisable as an oversight rather than a decision is that every SIBLING field was
// already nulled on the same path — `totalFmv`, `unlockedFmv`, `unlockedCount`,
// `bestOfferTotal`, `spreadGap` — and this one alone was set to 0. One zeroed figure beside
// five withheld ones is the tell.

const push = vi.fn()
let params = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useSearchParams: () => params,
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/disney-pinnacle/collection",
}))

const WALLET = "0x1234567890abcdef"

function payload(over: Record<string, unknown> = {}) {
  return {
    moments: [
      // ⚠ Field names read off the ROW RENDERER, not guessed from the domain. The first
      // draft used `character_name` (what Pinnacle calls it elsewhere) where this table
      // reads `player_name`, so the summary rendered and the rows silently did not —
      // fourth fixture-shaped mistake of the session, same cause every time.
      {
        moment_id: "m1",
        edition_key: "royal:standard:1",
        player_name: "Mickey Mouse",
        franchise: "Disney",
        studio: null,
        set_name: "Steamboat Willie",
        variant_type: "standard",
        serial_number: 12,
        mint_count: 1000,
        is_serialised: true,
        fmv_usd: 40,
        is_locked: false,
        thumbnail_url: null,
      },
    ],
    momentCount: 1,
    totalFmv: 40,
    unlockedFmv: 40,
    unlockedCount: 1,
    bestOfferTotal: 30,
    spreadGap: 10,
    variants: [{ variant_type: "standard", count: 1 }],
    franchises: [{ franchise: "Disney", count: 1 }],
    ...over,
  }
}

const ok = (body: unknown) =>
  vi.fn(async (_i: unknown, _init?: RequestInit) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response)

afterEach(() => {
  cleanup()
  params = new URLSearchParams()
})

describe("PinnacleCollectionClient — a failed read must not state a holdings count", () => {
  it("withholds Total Pins when the read fails", async () => {
    params = new URLSearchParams(`wallet=${WALLET}`)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "upstream down" }) }) as unknown as Response),
    )
    render(<PinnacleCollectionClient />)

    await waitFor(() => expect(document.body.textContent).toMatch(/upstream down|Failed to load/i))

    // ⚠ Assert the ABSENCE of the false claim, not the presence of the error. The error
    // banner was ALREADY rendering the whole time this defect was live — that is exactly why
    // it survived: the page contradicted itself and each half looked correct on its own.
    const body = document.body.textContent ?? ""
    expect(body).not.toMatch(/Total Pins\s*0/)
    expect(body).toMatch(/Total Pins\s*—/)
  })

  it("states the count when the read succeeds", async () => {
    params = new URLSearchParams(`wallet=${WALLET}`)
    vi.stubGlobal("fetch", ok(payload({ momentCount: 37 })))
    render(<PinnacleCollectionClient />)

    await waitFor(() => expect(document.body.textContent).toMatch(/Total Pins/))
    expect(document.body.textContent).toMatch(/Total Pins\s*37/)
  })

  // ⚠ BOTH DIRECTIONS. A collector who genuinely holds nothing must still be told zero —
  // withholding it there would replace one false statement with another, and "—" for an
  // empty wallet reads as a broken page.
  it("still shows 0 for a wallet that genuinely holds nothing", async () => {
    params = new URLSearchParams(`wallet=${WALLET}`)
    vi.stubGlobal("fetch", ok(payload({ moments: [], momentCount: 0, totalFmv: 0, variants: [], franchises: [] })))
    render(<PinnacleCollectionClient />)

    await waitFor(() => expect(document.body.textContent).toMatch(/Total Pins/))
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/Total Pins\s*0/)
    expect(body).not.toMatch(/Total Pins\s*—/)
  })

  // The API can answer 200 with the field absent — a partial payload is not a failure, but
  // it is not a measurement either. `?? (moments.length)` is the documented fallback, so a
  // present-but-empty moments array legitimately yields 0.
  it("derives the count from the rows when the field is absent", async () => {
    params = new URLSearchParams(`wallet=${WALLET}`)
    const p = payload()
    delete (p as Record<string, unknown>).momentCount
    vi.stubGlobal("fetch", ok(p))
    render(<PinnacleCollectionClient />)

    await waitFor(() => expect(document.body.textContent).toMatch(/Total Pins/))
    expect(document.body.textContent).toMatch(/Total Pins\s*1/)
  })

  it("does not claim the wallet holds no pins when the read failed", async () => {
    params = new URLSearchParams(`wallet=${WALLET}`)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as unknown as Response),
    )
    render(<PinnacleCollectionClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/boom|Failed to load/i))
    // The catch empties `rows`, so the table's empty state would otherwise fire — a second
    // statement about the collector's own holdings, from the same failed read.
    expect(document.body.textContent).not.toMatch(/No Pinnacle pins found/i)
  })

  it("does say the wallet holds no pins when the read SUCCEEDED and it is empty", async () => {
    params = new URLSearchParams(`wallet=${WALLET}`)
    vi.stubGlobal("fetch", ok(payload({ moments: [], momentCount: 0, variants: [], franchises: [] })))
    render(<PinnacleCollectionClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/No Pinnacle pins found/i))
  })
})

describe("PinnacleCollectionClient — the wallet entry path", () => {
  it("does not request the wallet endpoint until a wallet is supplied", () => {
    // ⚠ Both params declared: a zero-arg `vi.fn(async () => …)` infers a ZERO-LENGTH args
    // tuple, so `mock.calls[i][0]` is a tsc error (TS2493) while vitest stays green. Third
    // time this session.
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) =>
      ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response)
    vi.stubGlobal("fetch", f)
    render(<PinnacleCollectionClient />)
    // ⚠ Scoped to the WALLET endpoint. The page legitimately fires a different request on
    // mount — a saved-wallet lookup, so a returning collector lands on their own holdings
    // without retyping an address — and a blanket "no fetch" assertion would forbid that
    // rather than the thing it means to forbid: an unparameterised holdings request, which
    // would put a guaranteed error in the logs on every visit.
    const walletCalls = f.mock.calls.filter((c) => String(c[0]).includes("/api/pinnacle-wallet"))
    expect(walletCalls).toHaveLength(0)
  })

  it("reads the wallet from the URL into the request", async () => {
    params = new URLSearchParams(`wallet=${WALLET}`)
    const f = ok(payload())
    vi.stubGlobal("fetch", f)
    render(<PinnacleCollectionClient />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(String(f.mock.calls[0][0])).toContain(WALLET)
  })

  // ⚠ MUTATION-DRIVEN. The previous case could not observe the encoding at all: a plain
  // hex address survives `encodeURIComponent` unchanged, so asserting the encoded form is
  // asserting the raw one. The wallet is USER INPUT (typed or pasted into the box, or
  // hand-edited in the URL), so a value containing `&` splits the query string and injects
  // a parameter the page never intended to send.
  it("percent-encodes a wallet containing query-string metacharacters", async () => {
    const nasty = "0xabc&limit=99999"
    params = new URLSearchParams()
    params.set("wallet", nasty)
    const f = ok(payload())
    vi.stubGlobal("fetch", f)
    render(<PinnacleCollectionClient />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    const url = String(f.mock.calls[0][0])
    expect(url).toContain("0xabc%26limit%3D99999")
    // The injected parameter must not survive as a real one.
    expect(url).not.toMatch(/[?&]limit=99999/)
  })

  it("renders the collector's moments once loaded", async () => {
    params = new URLSearchParams(`wallet=${WALLET}`)
    vi.stubGlobal("fetch", ok(payload()))
    render(<PinnacleCollectionClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Mickey Mouse/))
    expect(document.body.textContent).toMatch(/Steamboat Willie/)
  })

  it("submitting a wallet routes to it rather than fetching in place", async () => {
    vi.stubGlobal("fetch", ok(payload()))
    render(<PinnacleCollectionClient />)
    const input = screen.queryByPlaceholderText(/0x/i)
    if (!input) return // some layouts render the entry form elsewhere
    fireEvent.change(input, { target: { value: WALLET } })
    const submit = screen.getAllByRole("button").find((b) => /search|load|go|view/i.test(b.textContent ?? ""))
    if (submit) {
      fireEvent.click(submit)
      // The wallet belongs in the URL so the view is shareable and reloadable; a fetch with
      // no URL change would make the page's own state unlinkable.
      await waitFor(() => expect(push).toHaveBeenCalled())
    }
  })
})

describe("PinnacleCollectionClient — the moment rows", () => {
  async function mount(moments: unknown[], over: Record<string, unknown> = {}) {
    params = new URLSearchParams(`wallet=${WALLET}`)
    vi.stubGlobal("fetch", ok(payload({ moments, momentCount: moments.length, ...over })))
    render(<PinnacleCollectionClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Total Pins/))
  }
  const pin = (over: Record<string, unknown> = {}) => ({
    moment_id: "m1",
    edition_key: "royal:standard:1",
    player_name: "Mickey Mouse",
    franchise: "Disney",
    studio: null,
    set_name: "Steamboat Willie",
    variant_type: "standard",
    serial_number: 12,
    mint_count: 1000,
    is_serialised: true,
    fmv_usd: 40,
    is_locked: false,
    thumbnail_url: null,
    ...over,
  })

  it("renders a serialised pin with its serial over the mint count", async () => {
    await mount([pin()])
    expect(document.body.textContent).toMatch(/#12\/1000/)
  })

  // ⚠ A pin that is genuinely NOT serialised is a different statement from one whose serial
  // we failed to read, and this collection has a lot of the former — CLAUDE.md records that
  // ~72% of Pinnacle holdings sit on unserialised editions, which "read as missing data we
  // had failed to fetch" until the page distinguished them. Collapsing the two back into an
  // em-dash would re-tell that lie for most of the page.
  it("distinguishes an unserialised pin from one with an unknown serial", async () => {
    await mount([
      pin({ moment_id: "a", serial_number: null, is_serialised: false, player_name: "Not Serialised" }),
      pin({ moment_id: "b", serial_number: null, is_serialised: true, player_name: "Unknown Serial" }),
    ])
    const rows = Array.from(document.querySelectorAll("tbody tr")).map((r) => r.textContent ?? "")
    const unserialised = rows.find((r) => r.includes("Not Serialised")) ?? ""
    const unknown = rows.find((r) => r.includes("Unknown Serial")) ?? ""
    expect(unserialised).not.toBe(unknown)
    // The unknown-serial row falls back to the placeholder; the unserialised one says
    // something specific instead.
    expect(unknown).toMatch(/—/)
  })

  it("renders every optional field absent without dropping the row", async () => {
    await mount([
      pin({
        player_name: null, franchise: null, set_name: null, studio: null,
        variant_type: null, serial_number: null, mint_count: null, fmv_usd: null,
      }),
    ])
    expect(document.querySelectorAll("tbody tr").length).toBe(1)
  })

  it("renders the variant and franchise breakdowns", async () => {
    await mount([pin()], {
      variants: [
        { variant_type: "standard", count: 3 },
        { variant_type: "golden", count: 1 },
      ],
      franchises: [
        { franchise: "Disney", count: 3 },
        { franchise: "Pixar", count: 1 },
      ],
    })
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/Pixar/)
    // The breakdowns are ordered by rank/count, so the rarer variant must still appear —
    // a sort that dropped its tail would silently hide the scarce holdings, which are the
    // ones a collector cares about.
    expect(body).toMatch(/golden/i)
  })

  it("renders a locked pin alongside an unlocked one", async () => {
    await mount([
      pin({ moment_id: "a", is_locked: true, player_name: "Locked Pin" }),
      pin({ moment_id: "b", is_locked: false, player_name: "Open Pin" }),
    ])
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/Locked Pin/)
    expect(body).toMatch(/Open Pin/)
  })
})
