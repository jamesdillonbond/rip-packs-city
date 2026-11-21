import { commercialSenderLine } from "@/lib/emails/sender-identity"
import { alertSuggestionLine, alertSuggestionUrl, type AlertSuggestion } from "@/lib/emails/alert-suggestion"

// lib/emails/day1-onboarding-email.ts
//
// The ONE day-1 email a new member gets (app/api/cron/day1-onboarding, 2026-11-16,
// Trevor: "Figure out the day 1 email and additional funnel building"). Two
// versions, picked by get_day1_onboarding_candidates' segment:
//   no_wallet — signed up, never added a wallet: the one step that makes the
//               dashboard mean anything (3 of 24 signups in the 30 days to 11-16).
//   wallet    — added a wallet, never came back a second day (6 of 21): their own
//               collection's value, the same headline the dashboard shows.
//
// RULES THIS COPY OBEYS (founder, binding): RPC is read-only — nothing invites a
// purchase, trade or gift; no paid tier; no superiority claim; never the Team
// Captain designation; FMV confidence tiers are never shown. A price is called an
// ESTIMATE. A value we could not read is never printed as $0: with no value the
// wallet version drops the number and says the dashboard is ready.
//
// It is sent as COMMERCIAL mail (like the weekly digests): the footer carries the
// CAN-SPAM postal address via commercialSenderLine(), so the route may call this
// only after commercialSendBlockedReason() returned null, and every send carries
// an unsubscribe link.
//
// 2026-11-20: the wallet version can carry ONE alert suggestion — the player whose moments carry
// the most value in the member's wallet, linked to /alerts prefilled (lib/emails/alert-suggestion.ts).
// It replaces the generic "watch an edition" bullet; with no suggestion the email is unchanged.
//
// Email red is the hardcoded #e55a4c on purpose — email clients have no CSS
// custom properties.

const ACCENT = "#e55a4c"
const BG = "#0a0a0a"
const PANEL = "#18181b"
const PANEL_BORDER = "#27272a"
const TEXT = "#fafafa"
const TEXT_MUTED = "rgba(255,255,255,0.65)"
const TEXT_SUBTLE = "rgba(255,255,255,0.5)"
const SITE = "https://www.rippackscity.com"
const LOGO_URL = `${SITE}/rip-packs-city-logo.png`

export type Day1Segment = "no_wallet" | "wallet"

export interface Day1EmailOpts {
  segment: Day1Segment
  username?: string | null
  /** The dashboard headline value (fresh-priced moments only); null = not readable. */
  fmvUsd?: number | null
  momentCount?: number | null
  /** wallet segment only: the player to suggest an alert on; null/absent = no suggestion. */
  alertSuggestion?: AlertSuggestion | null
  unsubscribeUrl: string
}

/** The suggestion this email will carry, or null (no_wallet never carries one). */
export function day1AlertSuggestion(opts: Day1EmailOpts): AlertSuggestion | null {
  return opts.segment === "wallet" && opts.alertSuggestion ? opts.alertSuggestion : null
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

/** "$9,297" — whole dollars at or above $100, cents below; a negative is sign-first ("-$0.50"). */
export function formatUsd(v: number): string {
  const a = Math.abs(v)
  const opts = a >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }
  return `${v < 0 ? "-" : ""}$${a.toLocaleString("en-US", opts)}`
}

/** True only when there is a real, positive value AND a count to put it beside. */
export function hasValueLine(opts: Day1EmailOpts): boolean {
  return (
    opts.segment === "wallet" &&
    typeof opts.fmvUsd === "number" &&
    Number.isFinite(opts.fmvUsd) &&
    opts.fmvUsd > 0 &&
    typeof opts.momentCount === "number" &&
    opts.momentCount > 0
  )
}

export function day1CtaUrl(segment: Day1Segment): string {
  return `${SITE}/dashboard?utm_source=email&utm_medium=day1&utm_campaign=${segment === "no_wallet" ? "add_wallet" : "collection_value"}`
}

export function buildDay1Subject(opts: Day1EmailOpts): string {
  if (opts.segment === "no_wallet") return "One step left: add your Top Shot username"
  if (hasValueLine(opts)) return `Your collection: about ${formatUsd(opts.fmvUsd as number)} across ${(opts.momentCount as number).toLocaleString("en-US")} moments`
  return "Your Rip Packs City dashboard is ready"
}

function lines(opts: Day1EmailOpts): { greeting: string; lead: string; bullets: string[]; cta: string } {
  const name = opts.username?.trim()
  const greeting = name ? `Hi ${name},` : "Hi,"
  if (opts.segment === "no_wallet") {
    return {
      greeting,
      lead: "You made a Rip Packs City account but haven't added a wallet yet. Add your Top Shot username (or a Flow wallet address) and your dashboard fills in.",
      bullets: [
        "Every moment you hold, with an estimated value for each.",
        "How each estimate was priced, linked from the moment.",
        "Trophy cases for your best pieces, and price alerts on editions you want.",
      ],
      cta: "Add your username",
    }
  }
  const lead = hasValueLine(opts)
    ? `Your dashboard values your collection at about ${formatUsd(opts.fmvUsd as number)} across ${(opts.momentCount as number).toLocaleString("en-US")} moments. That figure is an estimate from recent marketplace data, not an appraisal.`
    : "Your wallet is saved and your dashboard is ready."
  const bullets = [
    "See which of your moments carry the most value, and how each estimate was priced.",
    "Build a trophy case of your best pieces and share it.",
  ]
  if (!day1AlertSuggestion(opts)) bullets.push("Watch an edition you want and get an alert when its lowest ask drops to your price.")
  return { greeting, lead, bullets, cta: "Open your dashboard" }
}

export function buildDay1Text(opts: Day1EmailOpts): string {
  const l = lines(opts)
  const alert = day1AlertSuggestion(opts)
  return [
    l.greeting,
    "",
    l.lead,
    "",
    ...l.bullets.map((b) => `- ${b}`),
    "",
    `${l.cta}: ${day1CtaUrl(opts.segment)}`,
    ...(alert ? ["", `${alertSuggestionLine(alert)} Set it up: ${alertSuggestionUrl(SITE, alert, "day1")}`] : []),
    "",
    "You're getting this once, a day or two after you joined. We won't send it again.",
    `Unsubscribe: ${opts.unsubscribeUrl}`,
    commercialSenderLine(),
  ].join("\n")
}

export function buildDay1Html(opts: Day1EmailOpts): string {
  const l = lines(opts)
  const cta = day1CtaUrl(opts.segment)
  const alert = day1AlertSuggestion(opts)
  const alertHtml = alert
    ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid ${PANEL_BORDER};font-size:14px;line-height:1.5;color:${TEXT_MUTED};">${esc(alertSuggestionLine(alert))} <a href="${esc(alertSuggestionUrl(SITE, alert, "day1"))}" style="color:${TEXT};font-weight:700;text-decoration:underline;">Set up the alert &rarr;</a></div>`
    : ""
  const bullets = l.bullets.map((b) => `<li style="margin:0 0 6px;">${esc(b)}</li>`).join("")
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr><td style="padding:0 0 18px;"><img src="${LOGO_URL}" alt="Rip Packs City" width="44" height="44" style="display:block;border:0;" /></td></tr>
          <tr><td style="background:${PANEL};border:1px solid ${PANEL_BORDER};border-radius:12px;padding:20px 22px;">
            <div style="font-size:15px;line-height:1.55;color:${TEXT};">${esc(l.greeting)}</div>
            <div style="font-size:15px;line-height:1.55;margin-top:10px;color:${TEXT};">${esc(l.lead)}</div>
            <ul style="font-size:14px;line-height:1.5;color:${TEXT_MUTED};margin:14px 0 0;padding-left:18px;">${bullets}</ul>
            <div style="margin-top:18px;"><a href="${esc(cta)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:8px;">${esc(l.cta)} &rarr;</a></div>
            ${alertHtml}
          </td></tr>
          <tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.5;color:${TEXT_SUBTLE};">
            You&rsquo;re getting this once, a day or two after you joined. We won&rsquo;t send it again.
            <a href="${esc(opts.unsubscribeUrl)}" style="color:${TEXT_SUBTLE};text-decoration:underline;">Unsubscribe</a>
            <br/>${esc(commercialSenderLine())}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}
