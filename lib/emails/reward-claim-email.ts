// lib/emails/reward-claim-email.ts
//
// "Your <challenge> reward pack is waiting" — a ONE-TIME, TRANSACTIONAL note to a
// member who completed a trophy challenge and has not claimed the reward pack they
// earned (2026-11-15 activity review: 6 of 27 Dame Time finishers never claimed, and
// none of the six ever opened /giveaways). It tells the reader about something on
// their own account; it sells nothing.
//
// RULES THIS COPY OBEYS (founder, binding): RPC is read-only — the only action is
// claiming a free pack already earned; no paid tier; no superiority claim; never the
// Team Captain designation. Email red is the hardcoded #e55a4c on purpose — email
// clients have no CSS custom properties.
//
// Pure builders (no I/O) so the copy is unit-testable.

import { SENDER_LINE } from "@/lib/emails/sender-identity"

const ACCENT = "#e55a4c"
const BG = "#0a0a0a"
const PANEL = "#18181b"
const PANEL_BORDER = "#27272a"
const TEXT = "#fafafa"
const TEXT_MUTED = "rgba(255,255,255,0.65)"
const TEXT_SUBTLE = "rgba(255,255,255,0.5)"
const SITE_URL = "https://www.rippackscity.com"

export interface RewardClaimEmailOpts {
  /** The member's RPC username, when known; the greeting drops it otherwise. */
  username?: string | null
  challengeTitle: string
  dropTitle: string
  dropSlug: string
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function rewardClaimUrl(dropSlug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(dropSlug)) throw new Error(`bad drop slug: ${dropSlug}`)
  return `${SITE_URL}/giveaways/${dropSlug}`
}

export function buildRewardClaimSubject(opts: RewardClaimEmailOpts): string {
  return `Your ${opts.challengeTitle} reward pack is waiting`
}

export function buildRewardClaimText(opts: RewardClaimEmailOpts): string {
  const hi = opts.username?.trim() ? `Hi ${opts.username.trim()},` : `Hi,`
  return [
    hi,
    ``,
    `You completed ${opts.challengeTitle}, so one ${opts.dropTitle} is yours. It hasn't been claimed yet, and it isn't sent until you claim it.`,
    ``,
    `Claim it here: ${rewardClaimUrl(opts.dropSlug)}`,
    ``,
    `It's also waiting at the top of your dashboard.`,
    ``,
    `You're getting this once because you earned this pack. Reply to this email if anything isn't right.`,
    SENDER_LINE,
  ].join("\n")
}

export function buildRewardClaimHtml(opts: RewardClaimEmailOpts): string {
  const url = rewardClaimUrl(opts.dropSlug)
  const hi = opts.username?.trim() ? `Hi ${esc(opts.username.trim())},` : `Hi,`
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr><td style="padding:0 0 16px;">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${ACCENT};font-weight:700;">${esc(opts.challengeTitle)} reward</div>
            <div style="font-size:22px;font-weight:700;line-height:1.25;margin-top:6px;">Your reward pack is waiting</div>
          </td></tr>
          <tr><td style="background:${PANEL};border:1px solid ${PANEL_BORDER};border-radius:12px;padding:18px 20px;">
            <div style="font-size:15px;line-height:1.55;color:${TEXT};">${hi}</div>
            <div style="font-size:15px;line-height:1.55;margin-top:10px;color:${TEXT_MUTED};">You completed <span style="color:${TEXT};font-weight:600;">${esc(opts.challengeTitle)}</span>, so one ${esc(opts.dropTitle)} is yours. It hasn&rsquo;t been claimed yet, and it isn&rsquo;t sent until you claim it.</div>
            <div style="margin-top:18px;"><a href="${esc(url)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:8px;">Claim your pack &rarr;</a></div>
            <div style="font-size:13px;line-height:1.5;margin-top:14px;color:${TEXT_SUBTLE};">It&rsquo;s also waiting at the top of your dashboard.</div>
          </td></tr>
          <tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.5;color:${TEXT_SUBTLE};">
            You&rsquo;re getting this once because you earned this pack. Reply to this email if anything isn&rsquo;t right.
            <br/>${esc(SENDER_LINE)}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}
