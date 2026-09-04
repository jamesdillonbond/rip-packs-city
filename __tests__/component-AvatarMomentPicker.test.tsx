// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import AvatarMomentPicker, { momentLabel, AVATAR_PICKER_LIMIT } from "@/components/profile/AvatarMomentPicker"

// Pick your avatar from a Moment you already own — the answer to "how should we
// take this input from users", rather than validating typed URLs harder.
//
// The assertions that matter are about HONESTY and about the picked value
// flowing into the SAME field a typed URL uses.

const MOMENTS = [
  { id: "1", player_name: "Damian Lillard", set_name: "Archive", serial_number: 7, image_url: "https://cdn/a.png" },
  { id: "2", player_name: null, character_name: "Mickey", set_name: "Cosmic", serial_number: null, image_url: "https://cdn/b.png" },
  { id: "3", player_name: "No Art", set_name: "X", serial_number: 1, image_url: null },
]

function installFetch(res: { ok?: boolean; body?: unknown; throws?: boolean } = {}) {
  const fn = vi.fn(async (_input: unknown, _init?: RequestInit) => {
    if (res.throws) throw new TypeError("network")
    return {
      ok: res.ok ?? true,
      status: res.ok === false ? 500 : 200,
      json: async () => res.body ?? { moments: MOMENTS },
    } as Response
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

beforeEach(() => installFetch())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("picking", () => {
  it("hands back the moment's image URL", async () => {
    const onPick = vi.fn()
    render(<AvatarMomentPicker onPick={onPick} onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByTestId("avatar-picker-tile").length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByTestId("avatar-picker-tile")[0])
    expect(onPick).toHaveBeenCalledWith("https://cdn/a.png")
  })

  it("omits moments with no artwork rather than offering a blank tile", async () => {
    render(<AvatarMomentPicker onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByTestId("avatar-picker-tile").length).toBe(2))
    expect(document.body.textContent).not.toContain("No Art")
  })

  it("labels a Pinnacle pin by character when there is no player", async () => {
    // Pinnacle rows carry character_name and a null player_name; falling back
    // to "Moment" for all of them would make the grid unreadable.
    expect(momentLabel(MOMENTS[1] as never)).toBe("Mickey")
    expect(momentLabel(MOMENTS[0] as never)).toBe("Damian Lillard")
  })

  it("asks for a bounded page", async () => {
    const fn = installFetch()
    render(<AvatarMomentPicker onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(fn).toHaveBeenCalled())
    expect(String(fn.mock.calls[0][0])).toContain(`limit=${AVATAR_PICKER_LIMIT}`)
  })
})

describe("a failed read is never reported as owning nothing", () => {
  // The most repeated defect class in this repo, and the stakes are the same
  // here as everywhere: a claim about the collector's OWN holdings,
  // manufactured out of our outage.
  it("says WE could not load it on a non-2xx", async () => {
    installFetch({ ok: false })
    render(<AvatarMomentPicker onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId("avatar-picker-failed")).toBeTruthy())
    expect(screen.queryByTestId("avatar-picker-empty")).toBeNull()
    expect(screen.getByTestId("avatar-picker-failed").textContent).toMatch(/problem on our side/i)
  })

  it("says the same on a THROWN fetch, not just a non-2xx", async () => {
    // fetch rejects on a network failure rather than resolving non-ok, so the
    // two need separate coverage — the offline case is the one usually missed.
    installFetch({ throws: true })
    render(<AvatarMomentPicker onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId("avatar-picker-failed")).toBeTruthy())
    expect(screen.queryByTestId("avatar-picker-empty")).toBeNull()
  })

  it("DOES report a genuine zero as a zero", async () => {
    // The mirror assertion. A fix that turned every empty state into "couldn't
    // load" would only move the dishonesty.
    installFetch({ body: { moments: [] } })
    render(<AvatarMomentPicker onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId("avatar-picker-empty")).toBeTruthy())
    expect(screen.queryByTestId("avatar-picker-failed")).toBeNull()
  })

  it("shows neither state while still loading", async () => {
    // Otherwise the empty state flashes before the rows land, which reads as
    // "you own nothing" for a moment on every open.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})))
    render(<AvatarMomentPicker onPick={() => {}} onClose={() => {}} />)
    expect(screen.queryByTestId("avatar-picker-empty")).toBeNull()
    expect(screen.queryByTestId("avatar-picker-failed")).toBeNull()
    expect(document.body.textContent).toMatch(/Loading your Moments/i)
  })
})

describe("keyboard", () => {
  // The picker is a role="dialog" that, until 2026-09-03, only closed by mouse.
  // It shares lib/hooks/useModalA11y with every other dialog now: Escape closes,
  // focus lands inside on open.
  it("Escape closes the picker", async () => {
    const onClose = vi.fn()
    render(<AvatarMomentPicker onPick={() => {}} onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId("avatar-picker-tile").length).toBeGreaterThan(0))
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("moves focus into the dialog on open", async () => {
    render(<AvatarMomentPicker onPick={() => {}} onClose={() => {}} />)
    const dialog = screen.getByTestId("avatar-moment-picker")
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })
})
