// lib/giveaways/checklist.ts
//
// The admin's delivery checklist: one row per pool Moment, ordered by pack
// then slot, carrying who to gift it to and what the last chain check said.

import type { ClaimRow, PoolRow } from "@/lib/giveaways/store"

export type ChecklistState = "unsealed" | "unclaimed" | "unchecked" | "awaiting" | "delivered" | "missing"

export interface ChecklistRow {
  moment_id: string
  pack_no: number | null
  slot: number | null
  username: string | null
  player_name: string | null
  serial_number: number | null
  fmv_usd: number | null
  state: ChecklistState
  stateLabel: string
}

const LABEL: Record<ChecklistState, string> = {
  unsealed: "not sealed",
  unclaimed: "pack unclaimed",
  unchecked: "claimed · gift it, then Verify",
  awaiting: "awaiting your gift (you still hold it)",
  delivered: "delivered",
  missing: "MISSING: neither you nor the claimer holds it",
}

export function checklistState(m: PoolRow, claimed: boolean): ChecklistState {
  if (m.pack_no == null) return "unsealed"
  if (!claimed) return "unclaimed"
  if (m.delivered_at) return "delivered"
  if (m.last_checked_at == null) return "unchecked"
  if (m.last_check_recipient_holds) return "delivered"
  return m.last_check_admin_holds ? "awaiting" : "missing"
}

export function checklistRows(pool: readonly PoolRow[], claims: readonly ClaimRow[]): ChecklistRow[] {
  const byPack = new Map(claims.map((c) => [c.pack_no, c]))
  return pool
    .slice()
    .sort((a, b) => (a.pack_no ?? 1e9) - (b.pack_no ?? 1e9) || (a.slot ?? 0) - (b.slot ?? 0) || a.moment_id.localeCompare(b.moment_id))
    .map((m) => {
      const claim = m.pack_no != null ? byPack.get(m.pack_no) : undefined
      const state = checklistState(m, claim != null)
      return {
        moment_id: m.moment_id,
        pack_no: m.pack_no,
        slot: m.slot,
        username: claim?.topshot_username ?? null,
        player_name: m.player_name,
        serial_number: m.serial_number,
        fmv_usd: m.fmv_usd,
        state,
        stateLabel: LABEL[state],
      }
    })
}
