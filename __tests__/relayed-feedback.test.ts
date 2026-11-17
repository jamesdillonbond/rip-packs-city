// 2026-11-10: feedback that reaches the team outside the site is logged into
// the same queue (lib/feedback/relayed.ts + POST /api/admin/feedback), and the
// "shipped" email no longer claims the concierge for it.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildRelayedRow, isRelayedSession } from "@/lib/feedback/relayed"
import { buildFeedbackShippedHtml, buildFeedbackShippedText } from "@/lib/emails/feedback-shipped-email"

const NOW = new Date("2026-11-10T21:00:00Z")

describe("buildRelayedRow", () => {
  it("builds a queue row with a relayed_ session id, the channel named, and no email (the route resolves it)", () => {
    const r = buildRelayedRow({ summary: "Dashboard slow to load on mobile", feedback_type: "bug", channel: "text", username: "KnotBean" }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row.session_id).toBe("relayed_20261110_knotbean_dashboard-slow-to-load-on-mobile")
    expect(isRelayedSession(r.row.session_id)).toBe(true)
    expect(r.row.owner_key).toBe("knotbean")
    expect(r.row.feedback_status).toBe("new")
    expect(r.row.feedback_details).toContain("a text")
    expect(r.row.is_smoke_test).toBe(false)
    expect("user_email" in r.row).toBe(false)
  })
  it("refuses a missing summary, an unknown type/channel/status and a future date", () => {
    expect(buildRelayedRow({ summary: "", feedback_type: "bug", channel: "x" }, NOW).ok).toBe(false)
    expect(buildRelayedRow({ summary: "a real summary", feedback_type: "rant", channel: "x" }, NOW).ok).toBe(false)
    expect(buildRelayedRow({ summary: "a real summary", feedback_type: "bug", channel: "carrier pigeon" }, NOW).ok).toBe(false)
    expect(buildRelayedRow({ summary: "a real summary", feedback_type: "bug", channel: "x", status: "wontfix" }, NOW).ok).toBe(false)
    expect(buildRelayedRow({ summary: "a real summary", feedback_type: "bug", channel: "x", reported_at: "2026-12-01T00:00:00Z" }, NOW).ok).toBe(false)
  })
  it("a concierge session id is not relayed", () => {
    expect(isRelayedSession("rpc_de384072")).toBe(false)
    expect(isRelayedSession(null)).toBe(false)
  })
})

describe("the shipped email tells the truth about how the reader reached us", () => {
  const base = { feedbackType: "bug", summary: "Header menus cut off", note: "Fixed on Nov 9." }
  it("a concierge row says the concierge", () => {
    expect(buildFeedbackShippedText(base)).toContain("through the RPC concierge")
  })
  it("a relayed row does not claim the concierge", () => {
    const text = buildFeedbackShippedText({ ...base, relayed: true })
    const html = buildFeedbackShippedHtml({ ...base, relayed: true })
    expect(text).not.toContain("concierge")
    expect(html).not.toContain("concierge")
    expect(text).toContain("because you told us about it")
  })
  it("the PATCH notifier passes the row's session id through isRelayedSession", () => {
    const route = readFileSync(join(process.cwd(), "app", "api", "admin", "feedback", "[id]", "route.ts"), "utf8")
    expect(route).toContain("relayed: isRelayedSession(row.session_id)")
  })
})

describe("POST /api/admin/feedback", () => {
  const route = readFileSync(join(process.cwd(), "app", "api", "admin", "feedback", "route.ts"), "utf8")
  const post = route.slice(route.indexOf("export async function POST"))
  it("is admin-gated and resolves the email from the reader's account, never from the body", () => {
    expect(post).toContain("if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();")
    expect(post).toContain("auth.admin.getUserById")
    expect(post).not.toMatch(/body\.(user_)?email/)
  })
  it("derives ok from the inserted row", () => {
    expect(post).toContain('if (error || !data) {')
  })
})
