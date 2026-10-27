import { describe, it, expect } from "vitest"
import { pinnacleAlertAsk, PINNACLE_ALERT_FLOOR_STALE_HOURS } from "@/lib/alerts/pinnacle-ask"

// The TS twin of the Disney Pinnacle arm of dispatch_triggered_fmv_alerts (2026-10-26). The alerts
// page previews "currently triggered" with this; the cron fires with the SQL. The two must apply the
// same rule, so the SQL pin (supabase/tests/dispatch_triggered_fmv_alerts.sql) carries the same cases.
const NOW = Date.parse("2026-10-26T20:00:00Z")
const fresh = new Date(NOW - 2 * 3_600_000).toISOString()

describe("pinnacleAlertAsk", () => {
  it("returns the render floor when the floor map is fresh and the pin has an FMV", () => {
    expect(pinnacleAlertAsk({ fmv_usd: "40", floor_ask: "30", floor_ask_updated_at: fresh }, NOW)).toBe(30)
  })
  it("no FMV -> no ask (edition_live_ask's rule)", () => {
    expect(pinnacleAlertAsk({ fmv_usd: null, floor_ask: 30, floor_ask_updated_at: fresh }, NOW)).toBeNull()
    expect(pinnacleAlertAsk({ fmv_usd: 0, floor_ask: 30, floor_ask_updated_at: fresh }, NOW)).toBeNull()
  })
  it("an ask over 3x FMV is disconnected — no ask", () => {
    expect(pinnacleAlertAsk({ fmv_usd: 40, floor_ask: 121, floor_ask_updated_at: fresh }, NOW)).toBeNull()
    expect(pinnacleAlertAsk({ fmv_usd: 40, floor_ask: 120, floor_ask_updated_at: fresh }, NOW)).toBe(120)
  })
  it(`a floor map older than ${PINNACLE_ALERT_FLOOR_STALE_HOURS} h, or with no stamp, gives no ask`, () => {
    const stale = new Date(NOW - (PINNACLE_ALERT_FLOOR_STALE_HOURS + 1) * 3_600_000).toISOString()
    expect(pinnacleAlertAsk({ fmv_usd: 40, floor_ask: 30, floor_ask_updated_at: stale }, NOW)).toBeNull()
    expect(pinnacleAlertAsk({ fmv_usd: 40, floor_ask: 30, floor_ask_updated_at: null }, NOW)).toBeNull()
  })
  it("a zero or missing floor is no ask, never $0", () => {
    expect(pinnacleAlertAsk({ fmv_usd: 40, floor_ask: 0, floor_ask_updated_at: fresh }, NOW)).toBeNull()
    expect(pinnacleAlertAsk({ fmv_usd: 40, floor_ask: null, floor_ask_updated_at: fresh }, NOW)).toBeNull()
  })
})
