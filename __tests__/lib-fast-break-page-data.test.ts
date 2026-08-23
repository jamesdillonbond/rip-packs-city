import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchActiveRun, fetchSlate } from "@/lib/fast-break/page-data"
import { fetchPinnedWallet } from "@/lib/wallet/pinned-wallet"

// The reads behind /[collection]/fast-break and /[collection]/road-to-the-ring.
//
// ⚠ THREE CLAIMS-FROM-FAILURE ON ONE PAGE, none of which checked its error, and
// all in a `page.tsx` that neither coverage gate measures. The wallet one was
// COPY-PASTED verbatim into the road-to-the-ring page, carrying the defect with
// it — the same way the 23505 batch-insert bug reached five sales indexers and
// the "Loading the live board…" copy reached fifteen OG cards.

const NBA = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function tableDb(result: { data?: unknown; error?: { message: string } }) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b
  const settle = () => ({ data: result.data ?? null, error: result.error ?? null })
  b.maybeSingle = async () => settle()
  b.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(settle()).then(onF, onR)
  return { from: () => b }
}

const RUN = {
  id: "r1",
  name: "Fast Break 12",
  lineup_size: 3,
  has_captain: true,
  start_date: "2026-08-01",
  end_date: "2026-08-08",
}

describe("fetchActiveRun", () => {
  afterEach(() => vi.restoreAllMocks())

  it("a FAILED read reports ok:false — the page must not say there is no run", async () => {
    // ⚠ THE DEFECT. `const { data: run } = await …` with no error check, and
    // the page renders a null run as "No active Fast Break run — We'll surface
    // the next run here as soon as Top Shot opens it." Shown DURING a live run,
    // that tells a collector the game is off when it is on, and the copy
    // explicitly promises we would have said otherwise. The strongest form of
    // this class: the false claim comes with a guarantee attached.
    vi.spyOn(console, "log").mockImplementation(() => {})
    const db = tableDb({ error: { message: "canceling statement due to statement timeout" } })
    expect(await fetchActiveRun(db)).toEqual({ run: null, ok: false })
  })

  it("genuinely between runs is ok:true — the no-run card is right for that", async () => {
    // Top Shot really is between runs most of the time; suppressing the card
    // would leave the page blank in its NORMAL state. Both directions or the
    // fix just relocates the dishonesty.
    const db = tableDb({ data: null })
    expect(await fetchActiveRun(db)).toEqual({ run: null, ok: true })
  })

  it("returns the active run", async () => {
    expect(await fetchActiveRun(tableDb({ data: RUN }))).toEqual({ run: RUN, ok: true })
  })
})

describe("fetchSlate", () => {
  afterEach(() => vi.restoreAllMocks())

  it("a FAILED read reports ok:false rather than an empty night", async () => {
    // An empty slate is a real answer — the NBA does not play every night — so
    // a failed read borrowing it is indistinguishable from a quiet Tuesday, on
    // a page whose whole subject is tonight.
    vi.spyOn(console, "log").mockImplementation(() => {})
    const db = tableDb({ error: { message: "boom" } })
    expect(await fetchSlate("2026-08-16", db)).toEqual({ games: [], ok: false })
  })

  it("a genuinely empty night is ok:true", async () => {
    expect(await fetchSlate("2026-08-16", tableDb({ data: [] }))).toEqual({ games: [], ok: true })
  })

  it("maps the row shape the client expects", async () => {
    const db = tableDb({
      data: [{ id: "g1", home_team_abbr: "POR", away_team_abbr: "LAL", tipoff_at: "2026-08-16T02:00:00Z", status: "scheduled" }],
    })
    const { games } = await fetchSlate("2026-08-16", db)
    expect(games).toEqual([
      { gameId: "g1", homeTeam: "POR", awayTeam: "LAL", tipoffAt: "2026-08-16T02:00:00Z", status: "scheduled" },
    ])
  })

  it("a missing tipoff becomes null, not undefined", async () => {
    // The client renders a tip time; `undefined` and `null` diverge in JSON
    // serialization across the server/client boundary.
    const db = tableDb({ data: [{ id: "g1", home_team_abbr: "POR", away_team_abbr: "LAL", status: "tbd" }] })
    expect((await fetchSlate("2026-08-16", db)).games[0].tipoffAt).toBeNull()
  })
})

describe("fetchPinnedWallet", () => {
  afterEach(() => vi.restoreAllMocks())

  it("a FAILED read is ok:false, distinct from having pinned no wallet", async () => {
    // ⚠ Both pages render a null wallet as ConnectWalletCard — "connect a Top
    // Shot wallet" — so a failed read told a collector who HAS pinned one to go
    // do it again. Third surface in one sweep to make a false claim about the
    // reader's own account.
    vi.spyOn(console, "log").mockImplementation(() => {})
    const db = tableDb({ error: { message: "boom" } })
    expect(await fetchPinnedWallet("u1", NBA, db)).toEqual({ wallet: null, ok: false })
  })

  it("no pinned wallet is ok:true — the connect card is the point for that reader", async () => {
    expect(await fetchPinnedWallet("u1", NBA, tableDb({ data: null }))).toEqual({
      wallet: null,
      ok: true,
    })
  })

  it("a MALFORMED stored address is ok:true with no wallet, not a failure", async () => {
    // ⚠ We asked and got an answer; the answer just is not usable. Reporting it
    // as a failed read would show "couldn't load" forever to someone whose row
    // is genuinely bad, and passing it through would thread a non-address into
    // a downstream Cadence call.
    for (const bad of ["not-an-address", "0x123", "", "0xZZZZZZZZZZZZZZZZ"]) {
      expect(await fetchPinnedWallet("u1", NBA, tableDb({ data: { wallet_addr: bad } }))).toEqual({
        wallet: null,
        ok: true,
      })
    }
  })

  it("lower-cases a valid address", async () => {
    const db = tableDb({ data: { wallet_addr: "0xBD94CADE097E50AC" } })
    expect(await fetchPinnedWallet("u1", NBA, db)).toEqual({
      wallet: "0xbd94cade097e50ac",
      ok: true,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDS — a read that HANGS must reach the same `ok: false` as one that errors.
//
// ⚠ Both fetchers already returned `ok: false` on an error, and the page already
// renders that distinction. Neither was reachable from the failure DB saturation
// actually produces: **a read that is merely SLOW errors nowhere**, so the page
// waits on a streaming shell that Vercel logs as a 200.
//
// ⚠ `fetchActiveRun` is the one that matters most. Its false state is
// "No active Fast Break run — we'll surface the next run here as soon as Top Shot
// opens it": a claim about TOP SHOT'S SCHEDULE, made during a live run, whose copy
// explicitly promises we would say otherwise.
// ─────────────────────────────────────────────────────────────────────────────

/** A `fast_break_runs` / `nba_games` chain whose terminal call never settles. */
function hangingTableDb() {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b
  b.maybeSingle = () => new Promise(() => {})
  b.then = () => new Promise(() => {})
  return { from: () => b }
}

describe("bounds — a hung read is not a quiet night", () => {
  it("fetchActiveRun reports ok:false rather than hanging", async () => {
    const res = await fetchActiveRun(hangingTableDb())

    expect(res.ok, "an overrun read must report FAILURE").toBe(false)
    // ⚠ The absence of the false claim: `{ run: null, ok: true }` is the state
    // that renders "No active Fast Break run" as a fact about Top Shot.
    expect(res.run === null && res.ok === true).toBe(false)
  }, 20_000)

  it("fetchSlate reports ok:false rather than hanging", async () => {
    const res = await fetchSlate("2026-08-22", hangingTableDb())

    expect(res.ok).toBe(false)
    expect(res.games.length === 0 && res.ok === true, "must not imply there are no games").toBe(
      false,
    )
  }, 20_000)

  it("CONTROL — a read inside the budget still resolves normally", async () => {
    const db = tableDb({ data: { id: "r1", name: "Run", lineup_size: 5, has_captain: true, start_date: null, end_date: null } })
    const res = await fetchActiveRun(db)

    expect(res.ok).toBe(true)
    expect(res.run?.id).toBe("r1")
  })

  it("CONTROL — a genuine between-runs answer is still ok:true", async () => {
    // The page's normal off-season state, which the bound must not swallow.
    const res = await fetchActiveRun(tableDb({ data: null }))

    expect(res).toEqual({ run: null, ok: true })
  })
})
