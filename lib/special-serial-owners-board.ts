// lib/special-serial-owners-board.ts
//
// Shared types + fetch for the Special Serial Owners board. Backed by the
// SECDEF RPC public.get_special_serial_owners_board(...), which reads the live
// view public.topshot_special_serial_owners (the current tracked-wallet holder
// of every canonical Top Shot special serial: the #1 mint, the perfect mint
// #N/N, and the jersey-match serial). The view reads wallet_moments_cache, so it
// is only consumable through the service_role-defined RPC — the route calls it
// via the service-role client (supabaseAdmin).
//
// The PAGE (/special-serial-owners) is auth-gated (Trevor's 2026-06-19 holder-
// exposure decision); this module is shared so the route + the concierge tool
// read one normalized row shape.

export type SpecialSerialTag = "#1" | "perfect" | "jersey"
export type OwnersSortKey = "fmv" | "recent"

export const VALID_TAGS: SpecialSerialTag[] = ["#1", "perfect", "jersey"]
export const VALID_TIERS = new Set(["COMMON", "RARE", "FANDOM", "LEGENDARY", "ULTIMATE"])

export type OwnerRow = {
  edition_id: string | null
  edition_key: string | null // setID:playID — TS entity-page slug
  player_name: string | null
  set_name: string | null
  tier: string | null
  series: number | null
  team_name: string | null
  circulation_count: number | null
  serial: number | null
  tag: SpecialSerialTag | string | null
  holder_address: string | null
  // Resolved @username for holder_address, attached by the public route (Item 7,
  // 2026-06-22 audit). Null when the wallet has no known username.
  holder_username: string | null
  nft_id: string | null
  holder_seen_at: string | null
  edition_fmv: number | null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeRow(raw: Record<string, unknown>): OwnerRow {
  return {
    edition_id: (raw.edition_id as string) ?? null,
    edition_key: (raw.edition_key as string) ?? null,
    player_name: (raw.player_name as string) ?? null,
    set_name: (raw.set_name as string) ?? null,
    tier: (raw.tier as string) ?? null,
    series: num(raw.series),
    team_name: (raw.team_name as string) ?? null,
    circulation_count: num(raw.circulation_count),
    serial: num(raw.serial),
    tag: (raw.tag as string) ?? null,
    holder_address: (raw.holder_address as string) ?? null,
    holder_username: (raw.holder_username as string) ?? null,
    nft_id: (raw.nft_id as string) ?? null,
    holder_seen_at: (raw.holder_seen_at as string) ?? null,
    edition_fmv: num(raw.edition_fmv),
  }
}

export type OwnersFetchOpts = {
  tag?: SpecialSerialTag | null
  tier?: string | null
  player?: string | null
  holder?: string | null
  sort?: OwnersSortKey
  limit?: number
  offset?: number
}

// Calls the SECDEF board RPC. `supabase` must be the service-role client
// (supabaseAdmin) — the RPC is granted to service_role only.
export async function fetchSpecialSerialOwners(
  supabase: any,
  opts: OwnersFetchOpts
): Promise<OwnerRow[]> {
  const { data, error } = await supabase.rpc("get_special_serial_owners_board", {
    p_tag: opts.tag ?? null,
    p_tier: opts.tier ?? null,
    p_player: opts.player ?? null,
    p_holder: opts.holder ?? null,
    p_sort: opts.sort ?? "fmv",
    p_limit: opts.limit ?? 100,
    p_offset: opts.offset ?? 0,
  })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<Record<string, unknown>>).map(normalizeRow)
}
