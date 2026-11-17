// Pure helpers for the deal-alert form (app/alerts/page.tsx — a ~940-line client
// monolith neither coverage gate measures). The payload builder is the alert-save
// contract: a bug in its empty-string → default/null coercions silently drops
// filter criteria from a saved alert. Bodies are byte-identical to the page's;
// the page imports these.

/** Split a comma-separated input into trimmed, non-empty tokens. */
export function csvToArr(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean)
}

/** Render an array back to a comma-space-joined string (null → ""). */
export function arrToCsv(a: string[] | null): string {
  return (a ?? []).join(", ")
}

/** Add v if absent, remove it if present. */
export function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

/** Structural shape of the alert form (only the fields the payload reads). */
export interface AlertFormState {
  id: string | null
  label: string
  channels: string[]
  collection_ids: string[]
  min_discount: string
  min_price: string
  max_price: string
  tiers: string[]
  parallel_names: string[]
  player_names: string
  set_names: string
  team_names: string
  min_serial: string
  max_serial: string
  require_jersey_serial: boolean
  require_last_mint: boolean
  require_never_sold: boolean
  require_low_ask: boolean
  badges: string[]
  notify_mode: string
}

/** Build the /api/alerts/subscriptions payload from the form. Empty numeric
 * inputs become null (min_discount defaults to 25); empty multi-selects become
 * null; CSV text fields split into arrays. */
export function alertPayloadFromForm(form: AlertFormState) {
  return {
    id: form.id ?? undefined,
    label: form.label,
    channels: form.channels,
    collection_ids: form.collection_ids.length ? form.collection_ids : null,
    min_discount: form.min_discount === "" ? 25 : Number(form.min_discount),
    min_price: form.min_price === "" ? null : Number(form.min_price),
    max_price: form.max_price === "" ? null : Number(form.max_price),
    tiers: form.tiers.length ? form.tiers : null,
    parallel_names: form.parallel_names.length ? form.parallel_names : null,
    player_names: csvToArr(form.player_names),
    set_names: csvToArr(form.set_names),
    team_names: csvToArr(form.team_names),
    min_serial: form.min_serial === "" ? null : Number(form.min_serial),
    max_serial: form.max_serial === "" ? null : Number(form.max_serial),
    require_jersey_serial: form.require_jersey_serial,
    require_last_mint: form.require_last_mint,
    require_never_sold: form.require_never_sold,
    require_low_ask: form.require_low_ask,
    badges: form.badges.length ? form.badges : null,
    notify_mode: form.notify_mode,
  }
}

/**
 * One-line description of what a saved subscription actually watches.
 *
 * ⚠ THE SUMMARY USED TO BE A BARE `≥${min_discount}% off`, WHICH DESCRIBES A
 * PRICE-ONLY ALERT AS "≥0% off". Since audit_20260816 a subscription with a
 * max_price and `min_discount = 0` has NO FMV condition at all — the scanner
 * serves it from `edition_current_ask` rather than the deals board — so "0% off"
 * is not a weak discount filter, it is the sentinel for "ignore FMV". Rendering
 * it as a percentage both looks like a bug and omits the only condition the
 * alert actually has (the price cap), on the very screen where a collector goes
 * to check what they asked for.
 *
 * Mirrors the scanner's own predicate: max_price present AND min_discount 0.
 */
export function subscriptionFilterSummary(s: {
  min_discount: number | null
  max_price?: number | null
  min_price?: number | null
  min_serial?: number | null
  max_serial?: number | null
  require_last_mint?: boolean | null
  require_jersey_serial?: boolean | null
}): string {
  const money = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const priceOnly = s.max_price !== null && s.max_price !== undefined && (s.min_discount ?? 25) === 0
  if (priceOnly) {
    // 2026-11-06: "any price $0.60" read as a contradiction on the alerts page
    // (an alert with a cap is not "any price"); say the bound.
    const hasFloor = s.min_price !== null && s.min_price !== undefined
    const range = hasFloor
      ? `${money(s.min_price as number)}–${money(s.max_price as number)}`
      : `≤${money(s.max_price as number)}`
    return [`price ${range} · FMV ignored`, ...serialParts(s)].join(" · ")
  }
  const parts = [`≥${s.min_discount ?? 25}% off`]
  if (s.max_price !== null && s.max_price !== undefined) parts.push(`≤${money(s.max_price)}`)
  if (s.min_price !== null && s.min_price !== undefined) parts.push(`≥${money(s.min_price)}`)
  return [...parts, ...serialParts(s)].join(" · ")
}

/**
 * The serial conditions of a saved alert, as the summary line shows them.
 *
 * ⚠ 2026-11-13: the line used to stop at price/discount, so a collector whose
 * "serial 111" alerts misfired could not see on /alerts that the range WAS saved
 * (support_conversations 12524) — and the concierge told them it was not. A
 * condition the alert runs on belongs on the line that describes the alert.
 */
function serialParts(s: {
  min_serial?: number | null
  max_serial?: number | null
  require_last_mint?: boolean | null
  require_jersey_serial?: boolean | null
}): string[] {
  const out: string[] = []
  const lo = s.min_serial ?? null
  const hi = s.max_serial ?? null
  if (lo !== null && hi !== null) out.push(lo === hi ? `serial #${lo}` : `serial #${lo}–#${hi}`)
  else if (lo !== null) out.push(`serial ≥#${lo}`)
  else if (hi !== null) out.push(`serial ≤#${hi}`)
  if (s.require_last_mint) out.push("last mint")
  if (s.require_jersey_serial) out.push("jersey serial")
  return out
}
