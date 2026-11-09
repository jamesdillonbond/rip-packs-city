import { describe, it, expect } from "vitest"
import { closesAtLabel, countdownText } from "@/components/profile/ChallengeCountdown"

// Dame Time closes at midnight PT, 2026-11-09T08:00:00Z (2026-11-08).
const END = "2026-11-09T08:00:00Z"

describe("countdownText", () => {
  it("hours, minutes, seconds with zero-padding", () => {
    expect(countdownText(END, Date.parse("2026-11-09T02:47:51Z"))).toBe("5h 12m 09s")
  })
  it("days once it is that far", () => {
    expect(countdownText(END, Date.parse("2026-11-07T03:55:00Z"))).toBe("2d 4h 05m")
  })
  it("minutes alone under an hour", () => {
    expect(countdownText(END, Date.parse("2026-11-09T07:14:51Z"))).toBe("45m 09s")
  })
  it("⛔ at or past the end it is null (Closed), never a negative or a frozen 0s", () => {
    expect(countdownText(END, Date.parse(END))).toBeNull()
    expect(countdownText(END, Date.parse(END) + 5000)).toBeNull()
  })
  it("no end, or an unparsable one, is null", () => {
    expect(countdownText(null, 0)).toBeNull()
    expect(countdownText("not a date", 0)).toBeNull()
  })
})

describe("closesAtLabel", () => {
  it("midnight PT reads as tonight on the evening before", () => {
    expect(closesAtLabel(END, Date.parse("2026-11-09T02:47:00Z"))).toBe("midnight PT tonight")
  })
  it("names the day when it is not tonight", () => {
    expect(closesAtLabel(END, Date.parse("2026-11-07T20:00:00Z"))).toBe("midnight PT, end of Nov 8")
  })
})
