// lib/alerts/notify-mode.ts
//
// The repeat policy of a deal-alert subscription — alert_subscriptions.notify_mode,
// read by dispatch_due_deal_alerts (migration 20261015002500).
//
// ⚠ WHY THIS EXISTS. Until 2026-10-14 the dispatcher deduplicated on the UTC
// calendar day, so a listing that never changed was re-sent every evening (two
// subscribers got the same edition 14 days running; webz_80 reported it, beta
// 10792/10795). The form meanwhile offered "Cadence: Instant / Daily digest /
// Weekly digest", a setting NOTHING read. That column (`cadence`) is left in the
// table and no longer offered anywhere: a control whose choice changes nothing
// is a false promise. These three modes are exactly what the SQL implements —
// if you add one here, add it to the CHECK constraint and the dispatcher, and
// to the dispatch pin's case 9.

export const NOTIFY_MODES = ["new_listing", "once", "daily"] as const
export type NotifyMode = (typeof NOTIFY_MODES)[number]

export const DEFAULT_NOTIFY_MODE: NotifyMode = "new_listing"

/** Option text for the form's select. */
export const NOTIFY_MODE_LABEL: Record<NotifyMode, string> = {
  new_listing: "Once per listing (again on relist or new price)",
  once: "First match only",
  daily: "Every day while it matches",
}

/** One line under the select, describing the chosen mode exactly. */
export const NOTIFY_MODE_HINT: Record<NotifyMode, string> = {
  new_listing:
    "A listing that sits unchanged is sent once. A different moment or a new ask on the same edition is sent as new.",
  once: "Each edition (or special serial) is sent the first time it matches, then never again — even if the price drops.",
  daily: "Re-sent once a day for as long as the listing still matches.",
}

/** Short form for the one-line subscription summary. */
export const NOTIFY_MODE_SHORT: Record<NotifyMode, string> = {
  new_listing: "once per listing",
  once: "first match only",
  daily: "daily reminder",
}

export function isNotifyMode(v: unknown): v is NotifyMode {
  return typeof v === "string" && (NOTIFY_MODES as readonly string[]).includes(v)
}

/** A stored or submitted value, or the default when it is absent/unknown. */
export function notifyModeOr(v: unknown): NotifyMode {
  return isNotifyMode(v) ? v : DEFAULT_NOTIFY_MODE
}
