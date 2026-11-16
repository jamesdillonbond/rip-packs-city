// @vitest-environment jsdom
//
// "Fill with my top 6" (2026-11-16): propose → confirm → pin, with every outcome
// spoken in a toast and the case reloaded afterwards. A failed read never reads
// as "nothing to pin"; a declined confirm writes nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

const tracked: string[] = []
vi.mock("@/lib/telemetry/track", () => ({ track: (f: string) => tracked.push(f) }))

import FillTop6Button from "@/components/profile/FillTop6Button"

const pick = { slot: 1, player_name: "LeBron James", set_name: "S1 Base", serial_number: 12, fmv: 4.5 }
let responses: Array<{ ok: boolean; status?: number; body: unknown } | "throw">
let bodies: any[]

beforeEach(() => {
  tracked.length = 0
  bodies = []
  responses = []
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body))
    const r = responses.shift()
    if (r === "throw" || !r) throw new Error("net")
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 503), json: async () => r.body } as any
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setup() {
  const toast = vi.fn()
  const done = vi.fn(async () => {})
  const r = render(<FillTop6Button onToast={toast} onDone={done} />)
  fireEvent.click(r.getByTestId("fill-top-6"))
  return { toast, done }
}

describe("FillTop6Button", () => {
  it("proposes, confirms, pins, says how many, and reloads the case", async () => {
    responses = [{ ok: true, body: { picks: [pick], short: 5 } }, { ok: true, body: { pinned: 1 } }]
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { toast, done } = setup()
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(bodies).toEqual([{ confirm: false }, { confirm: true }])
    expect(confirm.mock.calls[0][0]).toContain("Slot 1: LeBron James · S1 Base #12")
    expect(toast).toHaveBeenCalledWith("Pinned 1 to your trophy case", "success")
    expect(tracked).toEqual(["main-fill-click", "main-fill-pinned"])
  })

  it("a declined confirm writes nothing", async () => {
    responses = [{ ok: true, body: { picks: [pick], short: 5 } }]
    vi.spyOn(window, "confirm").mockReturnValue(false)
    const { toast, done } = setup()
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(bodies).toEqual([{ confirm: false }])
    expect(toast).not.toHaveBeenCalled()
    expect(tracked).toContain("main-fill-declined")
  })

  it("a failed proposal read says so — never 'nothing to pin'", async () => {
    responses = [{ ok: false, status: 503, body: { error: "Couldn't read your collection right now — try again in a moment." } }]
    const { toast, done } = setup()
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(toast).toHaveBeenCalledWith("Couldn't read your collection right now — try again in a moment.", "info")
    expect(toast.mock.calls[0][0]).not.toMatch(/No priced moments/)
  })

  it("an ok read with no picks says there is nothing priced yet", async () => {
    responses = [{ ok: true, body: { picks: [], short: 6 } }]
    const { toast } = setup()
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast.mock.calls[0][0]).toMatch(/No priced moments to pin yet/)
  })

  it("a failed write and a network error are both spoken, and the case still reloads", async () => {
    responses = [{ ok: true, body: { picks: [pick], short: 5 } }, { ok: false, status: 503, body: {} }]
    vi.spyOn(window, "confirm").mockReturnValue(true)
    let s = setup()
    await waitFor(() => expect(s.done).toHaveBeenCalled())
    expect(s.toast).toHaveBeenCalledWith("Couldn't fill your case right now — try again.", "info")
    cleanup()
    responses = ["throw"]
    s = setup()
    await waitFor(() => expect(s.done).toHaveBeenCalled())
    expect(s.toast).toHaveBeenCalledWith("Couldn't reach the server — try again.", "info")
  })

  it("zero rows pinned is not reported as success", async () => {
    responses = [{ ok: true, body: { picks: [pick], short: 5 } }, { ok: true, body: { pinned: 0 } }]
    vi.spyOn(window, "confirm").mockReturnValue(true)
    const { toast, done } = setup()
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(toast.mock.calls[0][1]).toBe("info")
    expect(toast.mock.calls[0][0]).toMatch(/Nothing was pinned/)
  })
})
