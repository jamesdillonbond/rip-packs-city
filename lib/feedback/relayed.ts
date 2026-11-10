// lib/feedback/relayed.ts
//
// Feedback that reaches the team OUTSIDE the site — Discord, X, a text, an
// email to Trevor — logged into the same queue as concierge feedback
// (support_conversations), so it gets a status and its reader hears when it
// ships (2026-11-10). Before this, relayed feedback was fixed and never logged:
// the 11-08 Dame Time picker complaints, KnotBean's slow first load and
// spitehouse's missing sixth Dame all shipped with no row, no status and no
// reply. The admin route POST /api/admin/feedback calls buildRelayedRow.

export const RELAYED_CHANNELS = ["discord", "x", "text", "email", "in_person", "other"] as const
export type RelayedChannel = (typeof RELAYED_CHANNELS)[number]

export const RELAYED_TYPES = ["bug", "feature_request", "general_feedback", "confusion", "praise"] as const
export const RELAYED_STATUSES = ["new", "reviewed", "in_progress", "shipped"] as const

export const CHANNEL_LABEL: Record<RelayedChannel, string> = {
  discord: "Discord",
  x: "X",
  text: "a text",
  email: "email",
  in_person: "in person",
  other: "a message to the team",
}

export type RelayedInput = {
  summary: string
  message?: string | null
  feedback_type: string
  channel: string
  username?: string | null
  page_context?: string | null
  status?: string | null
  admin_note?: string | null
  /** When the reader said it (ISO); defaults to now. */
  reported_at?: string | null
}

export type RelayedRow = {
  session_id: string
  user_message: string
  bot_response: string
  category: string
  feedback_type: string
  feedback_summary: string
  feedback_details: string
  feedback_status: string
  owner_key: string | null
  page_context: string | null
  admin_note: string | null
  is_smoke_test: false
  created_at: string
}

export type RelayedResult = { ok: true; row: RelayedRow } | { ok: false; error: string }

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item"
}

/** Validates the admin's input and builds the row. Pure: the route resolves
 *  the reader's email separately (from their account) and inserts. */
export function buildRelayedRow(input: RelayedInput, now: Date = new Date()): RelayedResult {
  const summary = String(input.summary ?? "").trim()
  if (summary.length < 5) return { ok: false, error: "summary is required (one line, what they asked for)" }
  if (summary.length > 200) return { ok: false, error: "summary must be 200 characters or fewer" }
  const type = String(input.feedback_type ?? "")
  if (!(RELAYED_TYPES as readonly string[]).includes(type)) return { ok: false, error: `feedback_type must be one of: ${RELAYED_TYPES.join(", ")}` }
  const channel = String(input.channel ?? "")
  if (!(RELAYED_CHANNELS as readonly string[]).includes(channel)) return { ok: false, error: `channel must be one of: ${RELAYED_CHANNELS.join(", ")}` }
  const status = String(input.status ?? "new")
  if (!(RELAYED_STATUSES as readonly string[]).includes(status)) return { ok: false, error: `status must be one of: ${RELAYED_STATUSES.join(", ")}` }
  let at = now
  if (input.reported_at) {
    const d = new Date(input.reported_at)
    if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime() + 60_000) return { ok: false, error: "reported_at must be a past date" }
    at = d
  }
  const username = input.username ? String(input.username).trim().toLowerCase() || null : null
  const message = String(input.message ?? "").trim() || summary
  const label = CHANNEL_LABEL[channel as RelayedChannel]
  return {
    ok: true,
    row: {
      session_id: `relayed_${at.toISOString().slice(0, 10).replace(/-/g, "")}_${slug(username ?? channel)}_${slug(summary)}`,
      user_message: message.slice(0, 4000),
      bot_response: `[${type}] ${summary}`,
      category: "beta_feedback",
      feedback_type: type,
      feedback_summary: summary,
      feedback_details: `Source: ${label} (relayed, logged by the team in /admin/feedback).`,
      feedback_status: status,
      owner_key: username,
      page_context: input.page_context ? String(input.page_context).trim().slice(0, 200) || null : null,
      admin_note: input.admin_note ? String(input.admin_note).trim().slice(0, 600) || null : null,
      is_smoke_test: false,
      created_at: at.toISOString(),
    },
  }
}

/** True when a row came in outside the concierge (its session id says so). */
export function isRelayedSession(sessionId: string | null | undefined): boolean {
  return typeof sessionId === "string" && sessionId.startsWith("relayed_")
}
