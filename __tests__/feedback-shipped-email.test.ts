import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildFeedbackShippedSubject,
  buildFeedbackShippedHtml,
  buildFeedbackShippedText,
} from "@/lib/emails/feedback-shipped-email"

// The "your request shipped" email (2026-10-03). Source under test:
// app/api/admin/feedback/[id]/route (the sender) + lib/emails/feedback-shipped-email.

describe("feedback-shipped email builders", () => {
  const opts = {
    feedbackType: "feature_request",
    summary: 'Team checklist: tier toggle to show/hide specific tiers (e.g. hide Ultimates) <script>x</script>',
    pageContext: "team (nba-top-shot)",
    note: 'Live on the team page — "Hide tiers" under the view toggle & more',
    link: "https://www.rippackscity.com/nba-top-shot/team/detroit-pistons",
  }
  it("subject says Shipped for a request and Fixed for a bug, bounded", () => {
    expect(buildFeedbackShippedSubject(opts)).toMatch(/^Shipped: Team checklist: tier toggle/)
    expect(buildFeedbackShippedSubject({ ...opts, feedbackType: "bug" })).toMatch(/^Fixed: /)
    expect(buildFeedbackShippedSubject({ ...opts, summary: "x".repeat(300) }).length).toBeLessThan(110)
  })
  it("escapes user-supplied text in the HTML and keeps the text version plain", () => {
    const html = buildFeedbackShippedHtml(opts)
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&quot;Hide tiers&quot;")
    expect(html).toContain("From the team:")
    expect(html).toContain('href="https://www.rippackscity.com/nba-top-shot/team/detroit-pistons"')
    expect(html).toContain("#e55a4c")
    const text = buildFeedbackShippedText(opts)
    expect(text).toContain("From the team: Live on the team page")
    expect(text).toContain("Reply to this email")
  })
  it("renders without a note or link and refuses a non-https link", () => {
    const html = buildFeedbackShippedHtml({ feedbackType: "bug", summary: "Badges missing", link: "javascript:alert(1)" })
    expect(html).not.toContain("From the team")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("Have a look")
  })
})

describe("the admin PATCH sends it once, on the transition to shipped, never for smoke rows", () => {
  const src = readFileSync(join(process.cwd(), "app/api/admin/feedback/[id]/route.ts"), "utf8")
  it("reads the pre-update status, gates on shipped_notified_at and is_smoke_test, stamps the receipt", () => {
    expect(src).toContain('wasShipped = before?.feedback_status === "shipped"')
    expect(src).toContain('if (update.feedback_status === "shipped" && !wasShipped) {')
    expect(src).toContain('if (row.shipped_notified_at) return { attempted: false, sent: false, reason: "already notified" };')
    expect(src).toContain('if (row.is_smoke_test) return { attempted: false, sent: false, reason: "smoke/probe row" };')
    expect(src).toContain('.update({ shipped_notified_at: new Date().toISOString() })')
    expect(src).toContain('.is("shipped_notified_at", null)')
    // a send failure is reported, never swallowed into a 200 that claims a closed loop
    expect(src).toContain("notify ? { row, notify } : { row }")
    // the reader's email never rides out in the admin response row
    expect(src).toContain("const { user_email: _email, ...row } = data")
  })
})
