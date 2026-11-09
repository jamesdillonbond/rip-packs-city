// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import ChallengeCountdown from "@/components/profile/ChallengeCountdown"

// Dame Time closes at midnight PT (2026-11-09T08:00:00Z). The countdown only
// SAYS so; the server is the gate.
const END = "2026-11-09T08:00:00Z"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ChallengeCountdown", () => {
  it("full banner: time left and the PT deadline", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-09T02:47:51Z") })
    render(<ChallengeCountdown endsAt={END} />)
    expect(screen.getByText("5h 12m 09s")).toBeTruthy()
    expect(screen.getByText(/midnight PT tonight — no entries after that/)).toBeTruthy()
  })

  it("compact line for a dashboard row", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-09T07:14:51Z") })
    render(<ChallengeCountdown endsAt={END} compact />)
    expect(screen.getByText("Closes in 45m 09s")).toBeTruthy()
  })

  it("⛔ past the end it says closed, in both forms", () => {
    vi.useFakeTimers({ now: Date.parse(END) + 1000 })
    const { unmount } = render(<ChallengeCountdown endsAt={END} />)
    expect(screen.getByText(/Entries closed/)).toBeTruthy()
    unmount()
    render(<ChallengeCountdown endsAt={END} compact />)
    expect(screen.getByText(/Closed — no more entries/)).toBeTruthy()
  })

  it("renders nothing with no end or an unparsable one", () => {
    const a = render(<ChallengeCountdown endsAt={null} />)
    expect(a.container.innerHTML).toBe("")
    a.unmount()
    const b = render(<ChallengeCountdown endsAt="not a date" />)
    expect(b.container.innerHTML).toBe("")
  })
})
