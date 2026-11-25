// lib/pinnacle/capsule-mints.ts — the mint-record read behind PinnacleCapsuleNotice (see capsule-drops.ts).
// Reads ~900 buffers via idx_pinnacle_mint_events_minted_at (measured 11-24: 165 ms cold for Mugs Vol.1).

import { supabaseAdmin } from "@/lib/supabase"
import { PINNACLE_CUSTODY_ADDRESS, type PinnacleCapsuleDrop } from "@/lib/pinnacle/capsule-drops"

export type CapsuleMintRead = { ok: true; mintedToBuyers: number } | { ok: false }

type Db = typeof supabaseAdmin

/**
 * Capsule pins minted straight to buyer wallets inside the sale window. A FLOOR on capsules sold: pins
 * pre-minted to custody and handed over later arrive by deposit, not mint, and are not counted.
 * A failed read is { ok: false } — never a 0.
 */
export async function fetchCapsuleMintedToBuyers(capsule: PinnacleCapsuleDrop, db: Db = supabaseAdmin): Promise<CapsuleMintRead> {
  try {
    const { count, error } = await db
      .from("pinnacle_mint_events")
      .select("nft_id", { count: "exact", head: true })
      .gte("minted_at", capsule.saleStart)
      .lt("minted_at", capsule.saleEnd)
      .like("render_id", `${capsule.renderPrefix}%`)
      .neq("to_wallet", PINNACLE_CUSTODY_ADDRESS)
    if (error || typeof count !== "number") return { ok: false }
    return { ok: true, mintedToBuyers: count }
  } catch {
    return { ok: false }
  }
}
