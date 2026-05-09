// lib/emails/welcome-email.ts
//
// Welcome email rendered after an allow_list row is approved AND its prewarm
// run finishes. Mirrors the dark-theme magic-link palette: black background,
// dark panel, #e55a4c accent. The HTML is a single string with inline styles
// so it survives the major mail clients without external CSS.

const ACCENT = "#e55a4c"
const BG = "#0a0a0a"
const PANEL = "#18181b"
const PANEL_BORDER = "#27272a"
const TEXT = "#fafafa"
const TEXT_MUTED = "rgba(255,255,255,0.65)"
const TEXT_SUBTLE = "rgba(255,255,255,0.45)"
const SUCCESS = "#34d399"
const WARN = "#f59e0b"
const ERROR = "#f87171"

const LOGO_URL = "https://www.rippackscity.com/rip-packs-city-logo.png"
const LOGIN_URL = "https://www.rippackscity.com/login"

export type PrewarmStatusValue =
  | "complete"
  | "in_progress"
  | "deferred"
  | "failed"
  | "skipped"

export interface PrewarmCollectionMeta {
  scanned: boolean
  found: number
}

// Per-collection status values plus an optional `_meta` bag of structured
// per-collection telemetry (scanned/found counts) the orchestrator writes so
// "scanned and empty" is distinguishable from a silent scan failure. Keys
// other than the known collection labels are ignored by the email renderer.
export type PrewarmSummary = {
  _meta?: Record<string, PrewarmCollectionMeta>
} & Record<string, PrewarmStatusValue | string | Record<string, PrewarmCollectionMeta> | undefined>

export interface WelcomeEmailOpts {
  email: string
  wallet_addr?: string | null
  username?: string | null
  collections?: string[] | null
  prewarm_summary?: PrewarmSummary | null
}

const COLLECTION_LABELS: Record<string, string> = {
  nba_top_shot: "NBA Top Shot",
  nfl_all_day: "NFL All Day",
  laliga_golazos: "LaLiga Golazos",
  disney_pinnacle: "Disney Pinnacle",
  ufc_strike: "UFC Strike",
}

function labelFor(key: string): string {
  return COLLECTION_LABELS[key] ?? key
}

interface BadgeSpec {
  text: string
  fg: string
  bg: string
  border: string
}

function badgeFor(status: string): BadgeSpec {
  switch (status) {
    case "complete":
      return {
        text: "✓ Loaded",
        fg: SUCCESS,
        bg: "rgba(52,211,153,0.10)",
        border: "rgba(52,211,153,0.45)",
      }
    case "in_progress":
      return {
        text: "Loading…",
        fg: WARN,
        bg: "rgba(245,158,11,0.10)",
        border: "rgba(245,158,11,0.45)",
      }
    case "deferred":
      return {
        text: "Coming soon",
        fg: TEXT_MUTED,
        bg: "rgba(255,255,255,0.05)",
        border: "rgba(255,255,255,0.18)",
      }
    case "failed":
      return {
        text: "✗ Failed — we'll retry",
        fg: ERROR,
        bg: "rgba(248,113,113,0.10)",
        border: "rgba(248,113,113,0.45)",
      }
    case "skipped":
      return {
        text: "Skipped",
        fg: TEXT_SUBTLE,
        bg: "rgba(255,255,255,0.04)",
        border: "rgba(255,255,255,0.14)",
      }
    default:
      return {
        text: status,
        fg: TEXT_MUTED,
        bg: "rgba(255,255,255,0.05)",
        border: "rgba(255,255,255,0.18)",
      }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Email rows show collection-status only. Internal metadata stuffed into
// the summary by the prewarm orchestrator (e.g. username_resolution_failure)
// is filtered out here so it doesn't render as a row labelled with a raw
// snake_case key in the user's welcome email.
function renderCollectionRows(summary: PrewarmSummary): string {
  const keys = Object.keys(summary).filter((k) => k in COLLECTION_LABELS)
  if (keys.length === 0) {
    return `<p style="margin:0;color:${TEXT_MUTED};font-size:14px;line-height:1.55;">
      Your dashboard is ready. Sign in to start exploring.
    </p>`
  }
  return keys
    .map((key) => {
      const status = String(summary[key] ?? "deferred")
      const badge = badgeFor(status)
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid ${PANEL_BORDER};color:${TEXT};font-size:14px;font-weight:600;letter-spacing:0.01em;">
            ${escapeHtml(labelFor(key))}
          </td>
          <td style="padding:10px 0;border-bottom:1px solid ${PANEL_BORDER};text-align:right;">
            <span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${badge.fg};background:${badge.bg};border:1px solid ${badge.border};">
              ${escapeHtml(badge.text)}
            </span>
          </td>
        </tr>`
    })
    .join("")
}

export function buildWelcomeEmailSubject(_opts: WelcomeEmailOpts): string {
  return "You're in — sign in to Rip Packs City"
}

export function buildWelcomeEmailHtml(opts: WelcomeEmailOpts): string {
  const summary = opts.prewarm_summary ?? {}

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>You're in at Rip Packs City</title>
  </head>
  <body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Your early access is approved. Sign in with the same email you signed up with.
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
                  Welcome to RPC
                </h1>
                <p style="margin:0 0 20px 0;font-size:15px;line-height:1.55;color:${TEXT_MUTED};">
                  Your early access is approved and your dashboard is ready.
                </p>

                <div style="height:1px;background:${PANEL_BORDER};margin:8px 0 20px 0;"></div>

                <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${TEXT_SUBTLE};font-weight:700;margin-bottom:10px;">
                  What's loaded for you
                </div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                  ${renderCollectionRows(summary)}
                </table>

                <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:8px auto 22px auto;">
                  <tr>
                    <td align="center" style="background:${ACCENT};border-radius:8px;">
                      <a href="${LOGIN_URL}" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#0a0a0a;text-decoration:none;">
                        Sign in to Rip Packs City
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 24px 0;font-size:13px;line-height:1.55;color:${TEXT_SUBTLE};text-align:center;">
                  Sign in with the same email you used to sign up. We'll send a one-time magic link.
                </p>

                <div style="height:1px;background:${PANEL_BORDER};margin:8px 0 20px 0;"></div>

                <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${TEXT_SUBTLE};font-weight:700;margin-bottom:10px;">
                  What's next
                </div>
                <ul style="margin:0;padding:0 0 0 18px;color:${TEXT_MUTED};font-size:14px;line-height:1.7;">
                  <li>Hit the <strong style="color:${TEXT};">Sniper</strong> to spot listings priced under FMV in real time.</li>
                  <li>Look up <strong style="color:${TEXT};">any wallet</strong> to see its full collection, FMV, and pack ROI.</li>
                  <li>Check <strong style="color:${TEXT};">Pack EV</strong> to see whether the next drop is worth ripping.</li>
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
                You're receiving this because you requested early access at rippackscity.com.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

export function buildWelcomeEmailText(opts: WelcomeEmailOpts): string {
  const summary = opts.prewarm_summary ?? {}
  const keys = Object.keys(summary).filter((k) => k in COLLECTION_LABELS)
  const lines: string[] = [
    "Welcome to Rip Packs City",
    "",
    "Your early access is approved and your dashboard is ready.",
    "",
  ]

  if (keys.length > 0) {
    lines.push("What's loaded for you:")
    for (const key of keys) {
      const status = String(summary[key] ?? "deferred")
      const badge = badgeFor(status).text.replace(/[✓✗]/g, "").trim()
      lines.push(`  - ${labelFor(key)}: ${badge}`)
    }
    lines.push("")
  }

  lines.push(
    `Sign in: ${LOGIN_URL}`,
    "",
    "Use the same email you signed up with — we'll send a one-time magic link.",
    "",
    "What's next:",
    "  - Hit the Sniper to spot listings priced under FMV in real time.",
    "  - Look up any wallet to see its full collection, FMV, and pack ROI.",
    "  - Check Pack EV to see whether the next drop is worth ripping.",
    "",
    "— Rip Packs City · rippackscity.com"
  )

  return lines.join("\n")
}
