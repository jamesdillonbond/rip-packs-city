// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"

// The extra-trophy-cases surfaces (2026-11-06): the owner's dashboard panel, the
// public profile block and the challenge board. The pins that matter:
//   · a FAILED read never renders as "no cases" / "no entries yet";
//   · each case's writes carry ITS caseId (never an unscoped main-case write);
//   · the Dame Time picker opens pre-searched for the challenge's player.

vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({ useBadgeTaxonomy: () => ({}), lookupBadge: () => null }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))
const picker = vi.fn()
vi.mock("@/components/profile/TrophyPickerModal", () => ({
  default: (p: any) => {
    picker(p)
    return (
      <div data-testid="picker">
        <button onClick={() => p.onPinned()}>fake-pin</button>
        <button onClick={() => p.onClose()}>fake-close</button>
      </div>
    )
  },
}))

import TrophyCasesPanel, { slotsOf } from "@/components/profile/TrophyCasesPanel"
import PublicTrophyCases from "@/components/profile/PublicTrophyCases"
import ChallengeBoardClient from "@/app/trophy-challenges/[slug]/ChallengeBoardClient"

const CASE = "11111111-1111-4111-8111-111111111111"
const slab = (slot: number, extra: any = {}) => ({
  id: slot,
  slot,
  moment_id: "m" + slot,
  edition_id: null,
  player_name: "Damian Lillard",
  set_name: "Base",
  serial_number: 7,
  circulation_count: 100,
  tier: "RARE",
  thumbnail_url: null,
  video_url: null,
  fmv: 10,
  fmv_confidence: null,
  badges: [],
  note: null,
  collection_id: "c",
  collection_slug: "nba_top_shot",
  collection_display_name: "NBA Top Shot",
  play_description: null,
  team_name: null,
  series: null,
  pinned_at: null,
  acquired_price: null,
  acquisition_method: null,
  ...extra,
})
const DAME = {
  id: "ch1",
  slug: "dame-time",
  title: "Dame Time",
  tagline: "Show off your Dame.",
  description: "Damian Lillard only.",
  rules: { player_names: ["Damian Lillard"] },
  ends_at: null,
  is_active: true,
}

type Call = { url: string; init?: any }
let calls: Call[] = []
let routes: Record<string, () => any> = {}
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body })
const fail = (status = 503) => ({ ok: false, status, json: async () => ({ error: "x", code: "timeout" }) })

beforeEach(() => {
  calls = []
  picker.mockClear()
  routes = {}
  ;(globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    const key = Object.keys(routes).find((k) => url.startsWith(k) && (!init?.method || k.includes(init.method) || !k.includes(" ")))
    const exact = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`] ?? (key ? routes[key] : undefined)
    if (!exact) throw new Error("no route " + url)
    return exact()
  })
  vi.spyOn(window, "confirm").mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("slotsOf", () => {
  it("places slabs by their OWN slot, not array position", () => {
    const cells = slotsOf([slab(4) as any, slab(1) as any])
    expect(cells[0]?.slot).toBe(1)
    expect(cells[3]?.slot).toBe(4)
    expect(cells[1]).toBeNull()
  })
})

describe("TrophyCasesPanel (owner dashboard)", () => {
  it("⚠ a failed read says it couldn't load — never the empty 'create a case' state", async () => {
    routes["GET /api/profile/trophy-cases"] = () => fail()
    render(<TrophyCasesPanel ownerKey={null} savedChains={null} onToast={() => {}} />)
    expect(await screen.findByText(/Couldn.t load your other trophy cases/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/New case name/)).toBeNull()
  })

  it("offers an open challenge you haven't entered, and Enter posts its slug", async () => {
    routes["GET /api/profile/trophy-cases"] = () => ok({ cases: [], challenges: [DAME] })
    routes["POST /api/profile/trophy-cases"] = () => ok({ case: { id: CASE } })
    const toast = vi.fn()
    render(<TrophyCasesPanel ownerKey={null} savedChains={null} onToast={toast} />)
    fireEvent.click(await screen.findByText("Enter"))
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Entered Dame Time", "success"))
    const post = calls.find((c) => c.init?.method === "POST")!
    expect(JSON.parse(post.init.body)).toEqual({ challengeSlug: "dame-time" })
  })

  it("does not offer a challenge already entered; a null challenge list offers nothing", async () => {
    routes["GET /api/profile/trophy-cases"] = () =>
      ok({ cases: [{ id: CASE, name: "Dame Time", created_at: "", completed_at: null, challenge: DAME, slabs: [] }], challenges: [DAME] })
    render(<TrophyCasesPanel ownerKey={null} savedChains={null} onToast={() => {}} />)
    expect(await screen.findByText(/Challenge entry/)).toBeTruthy()
    expect(screen.queryByText("Enter")).toBeNull()
  })

  it("every write from a case carries THAT case's id", async () => {
    routes["GET /api/profile/trophy-cases"] = () =>
      ok({
        cases: [{ id: CASE, name: "Dame Time", created_at: "", completed_at: null, challenge: DAME, slabs: [slab(1)] }],
        challenges: [],
      })
    routes["DELETE /api/profile/trophy"] = () => ok({ ok: true })
    routes["DELETE /api/profile/trophy-cases"] = () => ok({ ok: true })
    render(<TrophyCasesPanel ownerKey={null} savedChains={null} onToast={() => {}} />)
    await screen.findByText("1 / 6")

    // Empty slot 2 → picker opens for THIS case, pre-searched for Dame.
    fireEvent.click(screen.getAllByText(/PIN A MOMENT/)[0])
    await screen.findByTestId("picker")
    const p = picker.mock.calls.at(-1)![0]
    expect(p.caseId).toBe(CASE)
    expect(p.initialQuery).toBe("Damian Lillard")
    expect(p.pinnedMomentIds).toEqual(["m1"])
    fireEvent.click(screen.getByText("fake-pin"))
    await waitFor(() => expect(screen.queryByTestId("picker")).toBeNull())

    // Delete the case → body names it.
    fireEvent.click(screen.getByText("Delete"))
    await waitFor(() => expect(calls.some((c) => c.init?.method === "DELETE" && c.url === "/api/profile/trophy-cases")).toBe(true))
    const del = calls.find((c) => c.init?.method === "DELETE" && c.url === "/api/profile/trophy-cases")!
    expect(JSON.parse(del.init.body)).toEqual({ caseId: CASE })
  })

  it("a challenge entry says it is SAVED (no name box, no save step) — Trevor 11-06: 'It should auto save as you create it'", async () => {
    routes["GET /api/profile/trophy-cases"] = () =>
      ok({ cases: [{ id: CASE, name: "Dame Time", created_at: "", completed_at: null, challenge: DAME, slabs: [slab(1), slab(2)] }], challenges: [] })
    render(<TrophyCasesPanel ownerKey={null} savedChains={null} onToast={() => {}} />)
    expect(await screen.findByText(/Entry saved · 2 of 6 on the board/)).toBeTruthy()
    // No bare name input under the case; no Rename for a challenge case.
    expect(screen.queryByPlaceholderText(/New case name/)).toBeNull()
    expect(screen.queryByText("Rename")).toBeNull()
    expect(screen.getByText(/Start another case/)).toBeTruthy()
  })

  it("an empty challenge entry says each pick saves itself", async () => {
    routes["GET /api/profile/trophy-cases"] = () =>
      ok({ cases: [{ id: CASE, name: "Dame Time", created_at: "", completed_at: null, challenge: DAME, slabs: [] }], challenges: [] })
    render(<TrophyCasesPanel ownerKey={null} savedChains={null} onToast={() => {}} />)
    expect(await screen.findByText(/each pick saves itself/)).toBeTruthy()
  })

  it("creates and renames a named case; a server refusal is toasted, not swallowed", async () => {
    routes["GET /api/profile/trophy-cases"] = () =>
      ok({ cases: [{ id: CASE, name: "Rookies", created_at: "", completed_at: null, challenge: null, slabs: [] }], challenges: [] })
    routes["POST /api/profile/trophy-cases"] = () => ({ ok: false, status: 409, json: async () => ({ error: "You can have up to 10 extra trophy cases." }) })
    routes["PATCH /api/profile/trophy-cases"] = () => ok({ case: { id: CASE, name: "Rooks" } })
    const toast = vi.fn()
    render(<TrophyCasesPanel ownerKey={null} savedChains={null} onToast={toast} />)
    // 2026-11-06: the name box is behind a "Start another case" button, so it
    // never reads as the save step for the case above it.
    fireEvent.click(await screen.findByText(/Start another case/))
    fireEvent.change(await screen.findByPlaceholderText(/New case name/), { target: { value: "Bigs" } })
    fireEvent.click(screen.getByText("New case"))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("up to 10"), "info"))

    fireEvent.click(screen.getByText("Rename"))
    fireEvent.change(screen.getByLabelText("Trophy case name"), { target: { value: "Rooks" } })
    fireEvent.click(screen.getByText("Save"))
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Case renamed", "success"))
    const patch = calls.find((c) => c.init?.method === "PATCH")!
    expect(JSON.parse(patch.init.body)).toEqual({ caseId: CASE, name: "Rooks" })
  })

  it("a network failure on a write is reported", async () => {
    routes["GET /api/profile/trophy-cases"] = () => ok({ cases: [], challenges: [DAME] })
    routes["POST /api/profile/trophy-cases"] = () => {
      throw new Error("offline")
    }
    const toast = vi.fn()
    render(<TrophyCasesPanel ownerKey={null} savedChains={null} onToast={toast} />)
    fireEvent.click(await screen.findByText("Enter"))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Couldn.t reach/), "info"))
  })
})

describe("PublicTrophyCases (profile)", () => {
  it("renders only cases with pins, with a link to the challenge board", async () => {
    routes["GET /api/public/trophy-cases"] = () =>
      ok({
        cases: [
          { id: CASE, name: "Dame Time", challenge: DAME, slabs: [slab(2)] },
          { id: "empty", name: "Draft", challenge: null, slabs: [] },
        ],
      })
    render(<PublicTrophyCases username="trev" />)
    expect(await screen.findByText("Dame Time")).toBeTruthy()
    expect(screen.queryByText("Draft")).toBeNull()
    expect(calls[0].url).toBe("/api/public/trophy-cases?username=trev")
  })

  it("⚠ a failed read says so rather than rendering as 'no extra cases'", async () => {
    routes["GET /api/public/trophy-cases"] = () => fail()
    render(<PublicTrophyCases username="trev" />)
    expect(await screen.findByText(/Couldn.t load this collector/)).toBeTruthy()
  })
})

describe("ChallengeBoardClient", () => {
  const board = (entries: any[]) =>
    ok({ challenge: { ...DAME }, entry_count: entries.length, entries, is_open: true })

  it("renders entries with their owner links", async () => {
    routes["GET /api/public/trophy-challenges/dame-time"] = () =>
      board([{ case_id: CASE, username: "trev", slab_count: 1, completed_at: null, slabs: [slab(1)] }])
    render(<ChallengeBoardClient slug="dame-time" />)
    expect(await screen.findByText("@trev")).toBeTruthy()
    expect(screen.getByText(/Enter from your dashboard/)).toBeTruthy()
  })

  it("a genuinely empty board invites the first entry", async () => {
    routes["GET /api/public/trophy-challenges/dame-time"] = () => board([])
    render(<ChallengeBoardClient slug="dame-time" />)
    expect(await screen.findByText(/No entries yet — be the first/)).toBeTruthy()
  })

  it("⚠ a failed read is NEVER 'no entries yet'", async () => {
    routes["GET /api/public/trophy-challenges/dame-time"] = () => fail()
    render(<ChallengeBoardClient slug="dame-time" />)
    expect(await screen.findByText(/Couldn.t load this challenge/)).toBeTruthy()
    expect(screen.queryByText(/No entries yet/)).toBeNull()
  })

  it("an unknown challenge says so", async () => {
    routes["GET /api/public/trophy-challenges/nope"] = () => ({ ok: false, status: 404, json: async () => ({}) })
    render(<ChallengeBoardClient slug="nope" />)
    expect(await screen.findByText(/no trophy challenge here/)).toBeTruthy()
  })

  it("a closed challenge shows closed, with no entry CTA", async () => {
    routes["GET /api/public/trophy-challenges/dame-time"] = () =>
      ok({ challenge: { ...DAME }, entry_count: 0, entries: [], is_open: false })
    render(<ChallengeBoardClient slug="dame-time" />)
    expect(await screen.findByText(/This challenge has closed/)).toBeTruthy()
    expect(screen.queryByText(/Enter from your dashboard/)).toBeNull()
  })
})
