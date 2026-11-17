// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// 2026-11-15: fmv_alerts had zero rows ever and nothing recorded whether the edition
// page's "Watch this edition" was opened. Open, sign-in-needed and saved are events now.
const tracked: { feature: string; meta: any }[] = []
vi.mock("@/lib/telemetry/track", () => ({ track: (feature: string, meta: unknown) => tracked.push({ feature, meta }) }))

import WatchEditionButton from "@/components/alerts/WatchEditionButton"

const props = { editionKey: "1:2", collectionId: "cid", playerName: "LeBron", setName: "Base" }
let status = 200
let redirected = false
beforeEach(() => {
  tracked.length = 0
  status = 200
  redirected = false
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 300, status, redirected, json: async () => ({}) }) as any))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function openAndSave(container: HTMLElement) {
  fireEvent.click(container.querySelector("button")!)
  fireEvent.change(container.querySelector("input")!, { target: { value: "5" } })
  const save = Array.from(container.querySelectorAll("button")).find((b) => /set alert|save/i.test(b.textContent ?? ""))!
  fireEvent.click(save)
}

describe("WatchEditionButton telemetry", () => {
  it("records the open, then a save", async () => {
    const { container } = render(<WatchEditionButton {...props} />)
    openAndSave(container)
    expect(tracked[0]).toEqual({ feature: "watch-edition-open", meta: { collection: "cid" } })
    await waitFor(() => expect(tracked).toContainEqual({ feature: "watch-edition-saved", meta: { collection: "cid", type: "price_below" } }))
  })
  it("a signed-out save records sign-in-needed, never saved", async () => {
    status = 405
    redirected = true
    const { container } = render(<WatchEditionButton {...props} />)
    openAndSave(container)
    await waitFor(() => expect(tracked.map((t) => t.feature)).toContain("watch-edition-signin-needed"))
    expect(tracked.map((t) => t.feature)).not.toContain("watch-edition-saved")
  })
})
