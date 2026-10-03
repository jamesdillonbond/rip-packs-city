// lib/emails/feedback-shipped-email.ts
//
// "Your request shipped" — sent ONCE when the team moves a logged bug /
// feature request to `shipped` in /admin/feedback (2026-10-03). Closes the
// loop the concierge opened: the reader asked for something, the team built
// it, and until now nobody told them unless they came back and asked.
//
// Pure builders (no I/O) so the copy is unit-testable; the sender lives in
// app/api/admin/feedback/[id]/route.ts. Same inline-style conventions and
// palette as welcome-email.ts (email red #e55a4c is hardcoded on purpose —
// mail clients have no CSS custom properties).

const ACCENT = "#e55a4c"
const BG = "#0a0a0a"
const PANEL = "#18181b"
const PANEL_BORDER = "#27272a"
const TEXT = "#fafafa"
const TEXT_MUTED = "rgba(255,255,255,0.65)"
const TEXT_SUBTLE = "rgba(255,255,255,0.45)"
const SITE_URL = "https://www.rippackscity.com"

export interface FeedbackShippedOpts {
  feedbackType: "bug" | "feature_request" | "general_feedback" | "confusion" | string | null
  summary: string
  /** The page the report was about, when the row carries one. */
  pageContext?: string | null
  /** A line from the team (the row's admin_note), shown verbatim when present. */
  note?: string | null
  /** A page to look at, when the team supplied one; absolute URL. */
  link?: string | null
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function feedbackTypeLabel(t: string | null | undefined): string {
  switch (t) {
    case "bug": return "bug report"
    case "feature_request": return "feature request"
    case "confusion": return "report"
    default: return "feedback"
  }
}

export function buildFeedbackShippedSubject(opts: FeedbackShippedOpts): string {
  const head = opts.feedbackType === "bug" ? "Fixed" : "Shipped"
  const summary = opts.summary.trim().slice(0, 90)
  return `${head}: ${summary}`
}

export function buildFeedbackShippedText(opts: FeedbackShippedOpts): string {
  const what = feedbackTypeLabel(opts.feedbackType)
  const lines = [
    `Your ${what} on Rip Packs City just shipped.`,
    ``,
    `"${opts.summary.trim()}"`,
  ]
  if (opts.note?.trim()) lines.push(``, `From the team: ${opts.note.trim()}`)
  if (opts.link) lines.push(``, `Have a look: ${opts.link}`)
  lines.push(``, `You're getting this once because you asked for it through the RPC concierge. Reply to this email if it isn't right.`, ``, SITE_URL)
  return lines.join("\n")
}

export function buildFeedbackShippedHtml(opts: FeedbackShippedOpts): string {
  const what = feedbackTypeLabel(opts.feedbackType)
  const head = opts.feedbackType === "bug" ? "Fixed" : "Shipped"
  const note = opts.note?.trim()
  const link = opts.link && /^https:\/\//.test(opts.link) ? opts.link : null
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr><td style="padding:0 0 16px;">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${ACCENT};font-weight:700;">${esc(head)}</div>
            <div style="font-size:22px;font-weight:700;line-height:1.25;margin-top:6px;">Your ${esc(what)} just shipped</div>
          </td></tr>
          <tr><td style="background:${PANEL};border:1px solid ${PANEL_BORDER};border-radius:12px;padding:18px 20px;">
            <div style="font-size:12px;color:${TEXT_SUBTLE};text-transform:uppercase;letter-spacing:0.08em;">What you asked for</div>
            <div style="font-size:16px;line-height:1.45;margin-top:6px;color:${TEXT};">&ldquo;${esc(opts.summary.trim())}&rdquo;</div>
            ${opts.pageContext ? `<div style="font-size:12px;color:${TEXT_SUBTLE};margin-top:8px;">Page: ${esc(opts.pageContext)}</div>` : ""}
            ${note ? `<div style="font-size:14px;line-height:1.5;margin-top:14px;color:${TEXT_MUTED};"><span style="color:${TEXT};font-weight:600;">From the team:</span> ${esc(note)}</div>` : ""}
            ${link ? `<div style="margin-top:18px;"><a href="${esc(link)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:8px;">Have a look &rarr;</a></div>` : ""}
          </td></tr>
          <tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.5;color:${TEXT_SUBTLE};">
            You&rsquo;re getting this once because you asked for it through the RPC concierge. Reply to this email if it isn&rsquo;t right.
            <br/><a href="${SITE_URL}" style="color:${TEXT_MUTED};">rippackscity.com</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}

// ── Digest: several shipped items for ONE reader, one email ──────────────────
// Used by POST /api/admin/feedback/notify-shipped-backlog for rows that reached
// `shipped` before the per-transition email existed (2026-10-03). The row's
// admin_note is NOT quoted here: those were written as internal log lines
// (commit hashes, migration ids). A per-reader `note` may be passed instead.

export interface FeedbackShippedDigestItem {
  feedbackType: string | null
  summary: string
  shippedAt?: string | null
}

export interface FeedbackShippedDigestOpts {
  items: FeedbackShippedDigestItem[]
  note?: string | null
}

export function buildFeedbackShippedDigestSubject(opts: FeedbackShippedDigestOpts): string {
  const n = opts.items.length
  return n === 1 ? buildFeedbackShippedSubject({ feedbackType: opts.items[0].feedbackType, summary: opts.items[0].summary }) : `${n} things you asked for just shipped`
}

export function buildFeedbackShippedDigestText(opts: FeedbackShippedDigestOpts): string {
  const lines = [`${opts.items.length} things you asked for through the RPC concierge have shipped:`, ``]
  for (const it of opts.items) lines.push(`- [${feedbackTypeLabel(it.feedbackType)}] ${it.summary.trim()}`)
  if (opts.note?.trim()) lines.push(``, `From the team: ${opts.note.trim()}`)
  lines.push(``, `You're getting this once because you asked for these through the RPC concierge. Reply to this email if anything isn't right.`, ``, SITE_URL)
  return lines.join("\n")
}

export function buildFeedbackShippedDigestHtml(opts: FeedbackShippedDigestOpts): string {
  const note = opts.note?.trim()
  const rows = opts.items
    .map(
      (it) => `<tr><td style="padding:8px 0;border-top:1px solid ${PANEL_BORDER};">
        <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${TEXT_SUBTLE};">${esc(feedbackTypeLabel(it.feedbackType))}${it.feedbackType === "bug" ? " &middot; fixed" : " &middot; shipped"}</div>
        <div style="font-size:15px;line-height:1.4;color:${TEXT};margin-top:2px;">${esc(it.summary.trim())}</div>
      </td></tr>`,
    )
    .join("")
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr><td style="padding:0 0 16px;">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${ACCENT};font-weight:700;">Shipped</div>
            <div style="font-size:22px;font-weight:700;line-height:1.25;margin-top:6px;">${opts.items.length} things you asked for just shipped</div>
            <div style="font-size:14px;line-height:1.5;color:${TEXT_MUTED};margin-top:8px;">Every one of these came in through the concierge. Thank you &mdash; this is what the beta is for.</div>
          </td></tr>
          <tr><td style="background:${PANEL};border:1px solid ${PANEL_BORDER};border-radius:12px;padding:10px 20px 14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
            ${note ? `<div style="font-size:14px;line-height:1.5;margin-top:14px;color:${TEXT_MUTED};"><span style="color:${TEXT};font-weight:600;">From the team:</span> ${esc(note)}</div>` : ""}
          </td></tr>
          <tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.5;color:${TEXT_SUBTLE};">
            You&rsquo;re getting this once because you asked for these through the RPC concierge. Reply to this email if anything isn&rsquo;t right.
            <br/><a href="${SITE_URL}" style="color:${TEXT_MUTED};">rippackscity.com</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}
