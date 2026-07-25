// lib/emails/signup-reminder-email.ts
//
// Re-engagement email for approved allow_list users who never completed first
// login — the cold-signup "chase" pattern (approved + prewarmed + welcomed, but
// never clicked the magic link). Sent by app/api/cron/signup-reminder, which is
// INERT unless SIGNUP_REMINDER_ENABLED=1. Same dark palette as the welcome
// email; a single inline-styled HTML string so it survives major mail clients
// without external CSS.

const ACCENT = "#e55a4c"
const BG = "#0a0a0a"
const PANEL = "#18181b"
const PANEL_BORDER = "#27272a"
const TEXT = "#fafafa"
const TEXT_MUTED = "rgba(255,255,255,0.65)"
const TEXT_SUBTLE = "rgba(255,255,255,0.45)"

const LOGO_URL = "https://www.rippackscity.com/rip-packs-city-logo.png"
const LOGIN_URL = "https://www.rippackscity.com/login"

export type ReminderStage = "nudge1" | "nudge2"

export interface SignupReminderOpts {
  email: string
  wallet_addr?: string | null
  username?: string | null
  stage?: ReminderStage | string
  unsubscribeUrl?: string | null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// 0x1234…abcd — never render a full wallet in email body.
export function shortWallet(w?: string | null): string | null {
  if (!w) return null
  const s = w.trim()
  if (s.length <= 12) return s
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

export function buildSignupReminderSubject(opts: SignupReminderOpts): string {
  return opts.stage === "nudge2"
    ? "Still there? Your Rip Packs City dashboard is ready"
    : "One step left — your Rip Packs City dashboard is ready"
}

export function buildSignupReminderHtml(opts: SignupReminderOpts): string {
  const wallet = shortWallet(opts.wallet_addr)
  const who = opts.username ? escapeHtml(opts.username) : null

  const loadedLine = wallet
    ? `We've already loaded ${
        who ? `<strong style="color:${TEXT};">${who}</strong>'s ` : "your "
      }collection (<span style="color:${TEXT};">${escapeHtml(
        wallet
      )}</span>) — it's waiting on your first sign-in.`
    : `Your dashboard is set up and waiting on your first sign-in.`

  const unsub = opts.unsubscribeUrl
    ? `<a href="${opts.unsubscribeUrl}" style="color:${TEXT_SUBTLE};text-decoration:underline;">Stop these reminders</a>`
    : ""

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Your Rip Packs City dashboard is ready</title>
  </head>
  <body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Your account is approved — one sign-in and your collection is right there.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
            <tr>
              <td align="center" style="padding-bottom:20px;">
                <img src="${LOGO_URL}" alt="Rip Packs City" width="56" height="56" style="display:block;border:0;outline:none;border-radius:12px;" />
              </td>
            </tr>
            <tr>
              <td style="background:${PANEL};border:1px solid ${PANEL_BORDER};border-radius:14px;padding:32px 28px;">
                <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:${ACCENT};font-weight:700;margin-bottom:10px;">
                  Rip Packs City
                </div>
                <h1 style="margin:0 0 12px 0;font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-0.01em;color:${TEXT};">
                  You're one click from your collection
                </h1>
                <p style="margin:0 0 18px 0;font-size:15px;line-height:1.55;color:${TEXT_MUTED};">
                  ${loadedLine}
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:8px auto 20px auto;">
                  <tr>
                    <td align="center" style="background:${ACCENT};border-radius:8px;">
                      <a href="${LOGIN_URL}" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#0a0a0a;text-decoration:none;">
                        Sign in to Rip Packs City
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 24px 0;font-size:13px;line-height:1.55;color:${TEXT_SUBTLE};text-align:center;">
                  Use the same email you signed up with — we'll send a one-time magic link. No password.
                </p>

                <div style="height:1px;background:${PANEL_BORDER};margin:8px 0 20px 0;"></div>

                <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${TEXT_SUBTLE};font-weight:700;margin-bottom:10px;">
                  What's inside
                </div>
                <ul style="margin:0;padding:0 0 0 18px;color:${TEXT_MUTED};font-size:14px;line-height:1.7;">
                  <li>Your full collection with live FMV and pack ROI.</li>
                  <li>The <strong style="color:${TEXT};">Sniper</strong> — listings priced under FMV in real time.</li>
                  <li>Look up <strong style="color:${TEXT};">any wallet</strong> or edition across every collection.</li>
                </ul>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 12px 8px 12px;font-size:11px;line-height:1.6;color:${TEXT_SUBTLE};">
                Sent by Rip Packs City · <a href="https://www.rippackscity.com" style="color:${TEXT_SUBTLE};text-decoration:underline;">rippackscity.com</a>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 12px 24px 12px;font-size:11px;line-height:1.6;color:${TEXT_SUBTLE};">
                You're receiving this because you requested access at rippackscity.com.${unsub ? ` ${unsub}` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

export function buildSignupReminderText(opts: SignupReminderOpts): string {
  const wallet = shortWallet(opts.wallet_addr)
  const lines: string[] = [
    "You're one click from your collection",
    "",
    wallet
      ? `We've already loaded ${opts.username ? `${opts.username}'s ` : "your "}collection (${wallet}) — it's waiting on your first sign-in.`
      : "Your dashboard is set up and waiting on your first sign-in.",
    "",
    `Sign in: ${LOGIN_URL}`,
    "",
    "Use the same email you signed up with — we'll send a one-time magic link. No password.",
    "",
    "What's inside:",
    "  - Your full collection with live FMV and pack ROI.",
    "  - The Sniper — listings priced under FMV in real time.",
    "  - Look up any wallet or edition across every collection.",
    "",
    "— Rip Packs City · rippackscity.com",
  ]
  if (opts.unsubscribeUrl) {
    lines.push("", `Stop these reminders: ${opts.unsubscribeUrl}`)
  }
  return lines.join("\n")
}
