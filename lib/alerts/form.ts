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
  cadence: string
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
    cadence: form.cadence,
  }
}
