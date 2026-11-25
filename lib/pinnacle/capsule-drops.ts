// lib/pinnacle/capsule-drops.ts
//
// Disney Pinnacle MYSTERY-CAPSULE drops (2026-11-24). A capsule sale is NOT a PackNFT product: each $9.99 capsule
// mints its open-edition pin straight to the buyer (Pinnacle.Minted → buyer wallet, no PackNFT.Opened, so nothing
// reaches pinnacle_pack_opens). Only the hidden LE "chaser" capsules travel as PackNFTs, under their own dist.
// Measured 11-24 9:30 PM PT: Walt Disney Mugs Vol.1 — 7,503 mug pins minted (1,980 pre-minted to Dapper custody
// 0xedf9df96c92f4595 on 11-08, 5,523 minted to buyers), 0 in pinnacle_pack_opens; dist 8922 holds only the 98
// Friends-Giving Vol.2 chasers, all opened 11-09 9:00 AM → 2:45 PM PT.
//
// So a chaser dist's opens are a CHASE-ONLY subset of what buyers got: its realized average would read as a
// guaranteed 4× pack. Every surface that values a drop from its opens must treat these dists as chase-only
// (get_pinnacle_pack_reality excludes 8922 in SQL — keep the two lists in step).

// Pure (no DB import) so client-safe helpers like pin-insight-chips can use it; the mint read is capsule-mints.ts.

export interface PinnacleCapsuleDrop {
  /** The PackNFT dist that carries only the hidden chaser capsules. */
  chaserDistId: string
  /** The capsule product as the issuer names it. */
  capsuleName: string
  /** render_id prefix of the capsule's open-edition pins (pinnacle_catalog / pinnacle_mint_events). */
  renderPrefix: string
  /** Sale window (UTC ISO) — bounds the mint read to the minted_at index. */
  saleStart: string
  saleEnd: string
}

/** Dapper's custody account that receives pre-minted pins before they are sold or packed. */
export const PINNACLE_CUSTODY_ADDRESS = "0xedf9df96c92f4595"

export const PINNACLE_CAPSULE_DROPS: readonly PinnacleCapsuleDrop[] = [
  {
    chaserDistId: "8922",
    capsuleName: "Walt Disney Mugs Vol.1",
    renderPrefix: "OEV1-WDMG-",
    // On sale Mon 11/9 9 AM PT → Mon 11/23 9 AM PT (disneypinnacle.com/releases, verified 11-08).
    saleStart: "2026-11-09T17:00:00Z",
    saleEnd: "2026-11-23T17:00:00Z",
  },
]

export function pinnacleCapsuleForDist(distId: string): PinnacleCapsuleDrop | null {
  return PINNACLE_CAPSULE_DROPS.find((c) => c.chaserDistId === String(distId)) ?? null
}

/** True for a dist whose opens are only a capsule sale's hidden chasers. */
export function isPinnacleChaseOnlyDist(distId: string): boolean {
  return pinnacleCapsuleForDist(distId) !== null
}
