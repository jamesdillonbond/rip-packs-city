// lib/emails/account-welcome-email.ts
//
// The ONE-TIME, TRANSACTIONAL welcome for a newly created account (platform
// review 2026-10-11, M2). Distinct from lib/emails/welcome-email.ts, which is the
// early-access/prewarm template ("your early access is approved", wallet seeding
// summary) and does not describe the open-signup funnel.
//
// RULES THIS COPY OBEYS (founder, binding):
//   * RPC is READ-ONLY — nothing here invites a purchase, trade, cart or gift.
//   * No paid tier, no "Pro", no "upgrade", no "beta" paywall framing.
//   * No superiority claim over any other site; no "most accurate".
//   * Never lead with the Trail Blazers Team Captain designation (not mentioned).
//   * It is transactional: it says the account exists and how to use it. It is
//     sent at most once per account (claim_welcome_email), and it carries a
//     manage/preferences link and the real From address the other emails use.
//
// Email red is the hardcoded #e55a4c on purpose — email clients have no CSS
// custom properties (CLAUDE.md: web red is the token; email red is this hex).

const ACCENT = "#e55a4c"
const BG = "#0a0a0a"
const PANEL = "#18181b"
const PANEL_BORDER = "#27272a"
const TEXT = "#fafafa"
const TEXT_MUTED = "rgba(255,255,255,0.65)"
const TEXT_SUBTLE = "rgba(255,255,255,0.45)"

const SITE = "https://www.rippackscity.com"
const LOGO_URL = `${SITE}/rip-packs-city-logo.png`

/** Where "manage your account" points. /profile is the signed-in account page. */
export const ACCOUNT_WELCOME_MANAGE_URL = `${SITE}/profile`

export interface AccountWelcomeOpts {
  /** The address the account was created with — shown so the reader can tell it is theirs. */
  email: string
  /** Override for tests / a future preferences surface. Defaults to /profile. */
  manageUrl?: string
}

export function buildAccountWelcomeSubject(): string {
  return "Your Rip Packs City account is ready"
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function buildAccountWelcomeHtml(opts: AccountWelcomeOpts): string {
  const manage = opts.manageUrl ?? ACCOUNT_WELCOME_MANAGE_URL
  const email = escapeHtml(opts.email)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Your Rip Packs City account is ready</title>
  </head>
  <body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Your account exists. Sign in with ${email} any time — here is what you can look up.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${PANEL};border:1px solid ${PANEL_BORDER};border-radius:12px;">
            <tr>
              <td align="center" style="padding:28px 24px 8px 24px;">
                <img src="${LOGO_URL}" width="56" height="56" alt="Rip Packs City" style="display:block;border:0;outline:none;text-decoration:none;" />
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 24px 0 24px;font-size:22px;font-weight:700;letter-spacing:0.02em;color:${TEXT};">
                Your account is ready
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 0 28px;font-size:15px;line-height:1.7;color:${TEXT_MUTED};">
                An account was just created at Rip Packs City with <strong style="color:${TEXT};">${email}</strong>.
                Sign in any time with a magic link to that address — there is no password to keep.
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 0 28px;font-size:15px;line-height:1.7;color:${TEXT_MUTED};">
                What you can look up here:
                <ul style="margin:8px 0 0 0;padding:0 0 0 18px;color:${TEXT_MUTED};font-size:14px;line-height:1.7;">
                  <li><strong style="color:${TEXT};">Any wallet</strong> — its moments, an estimated value for each, and how that estimate was graded.</li>
                  <li><strong style="color:${TEXT};">Pack EV</strong> — what a pack's typical pull has been worth against its price.</li>
                  <li><strong style="color:${TEXT};">How we price</strong> — every estimate links to the method behind it and the share of our prices backed by recent sales, per collection.</li>
                </ul>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 28px 8px 28px;">
                <a href="${SITE}/login" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.04em;padding:12px 22px;border-radius:8px;">Sign in</a>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 0 28px;font-size:13px;line-height:1.7;color:${TEXT_SUBTLE};">
                Prices on Rip Packs City are estimates from public marketplace data, graded by how much recent sales back them. They are not appraisals or advice.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 12px 6px 12px;font-size:11px;line-height:1.6;color:${TEXT_SUBTLE};">
                Sent by Rip Packs City · <a href="${SITE}" style="color:${TEXT_SUBTLE};text-decoration:underline;">rippackscity.com</a>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 12px 24px 12px;font-size:11px;line-height:1.6;color:${TEXT_SUBTLE};">
                This is a one-time notice that an account was created with this address. We do not send marketing email.
                <a href="${manage}" style="color:${TEXT_SUBTLE};text-decoration:underline;">Manage your account and email preferences</a>.
                If this was not you, ignore this message — nothing can be done with the account without access to this inbox.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

export function buildAccountWelcomeText(opts: AccountWelcomeOpts): string {
  const manage = opts.manageUrl ?? ACCOUNT_WELCOME_MANAGE_URL
  return [
    "Your Rip Packs City account is ready",
    "",
    `An account was just created at Rip Packs City with ${opts.email}.`,
    "Sign in any time with a magic link to that address — there is no password to keep.",
    "",
    "What you can look up here:",
    "- Any wallet: its moments, an estimated value for each, and how that estimate was graded.",
    "- Pack EV: what a pack's typical pull has been worth against its price.",
    "- How we price: every estimate links to the method behind it and the share of our prices backed by recent sales, per collection.",
    "",
    `Sign in: ${SITE}/login`,
    "",
    "Prices on Rip Packs City are estimates from public marketplace data, graded by how much recent sales back them. They are not appraisals or advice.",
    "",
    "This is a one-time notice that an account was created with this address. We do not send marketing email.",
    `Manage your account and email preferences: ${manage}`,
    "If this was not you, ignore this message — nothing can be done with the account without access to this inbox.",
    "",
    "— Rip Packs City · rippackscity.com",
  ].join("\n")
}
