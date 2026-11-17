// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

// 2026-11-15: a share click is recorded as a usage event. The rewards earn the buttons
// also fire has written nothing since ~10-04, so without this a share is invisible and
// "nobody shared" reads the same as "no click was recorded".
const tracked: { feature: string; meta: unknown }[] = []
vi.mock("@/lib/telemetry/track", () => ({ track: (feature: string, meta: unknown) => tracked.push({ feature, meta }) }))

import ShareProfileButtons from "@/components/profile/ShareProfileButtons"

beforeEach(() => {
  tracked.length = 0
  vi.stubGlobal("open", vi.fn())
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true })
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("share-click usage event", () => {
  it("Share on X records medium x with the surface and challenge", () => {
    render(<ShareProfileButtons username="rrx69" surface="trophy-case" challenge={{ slug: "dame-time", title: "Dame Time" }} />)
    fireEvent.click(screen.getByRole("button", { name: "Share on X" }))
    expect(tracked).toContainEqual({ feature: "share-click", meta: { medium: "x", surface: "trophy-case", challenge: "dame-time" } })
  })
  it("Copy link records medium copy; a plain profile share carries no challenge", async () => {
    render(<ShareProfileButtons username="rrx69" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    await waitFor(() => expect(tracked).toContainEqual({ feature: "share-click", meta: { medium: "copy", surface: "profile", challenge: null } }))
  })
})
