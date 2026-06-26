// lib/chains/panini/feed.ts
//
// Panini Blockchain — Plane-A read client for the "2026 Panini Prizm FIFA World
// Cup" digital product (collection panini_blockchain, id d1a0a7f5…, inert
// is_active=false). Plane A is the ONLY real source for this product: packs do
// not bridge to Ethereum, so pack-state / circulation can never come from chain
// (see docs/handoff-2026-06-25-panini-blockchain-buildout.md §1).
//
// Two modes, selected by PANINI_FEED_MODE (unset => INERT, fetch returns []):
//   'cryptoslam' — CryptoSlam commercial NFT API (recommended primary; already
//                  indexes Panini Blockchain live, per-card, with serials).
//   'onepanini'  — nft.paniniamerica.net/onepanini via a proxy worker (fallback;
//                  the gateway is bot-protected and 426s naive calls, so the
//                  app's request format must be replicated behind PANINI_PROXY_URL).
//
// Auth surfaces are their OWN rotation domains — NEVER share TS_PROXY_SECRET /
// INGEST_SECRET_TOKEN (see "Worker auth surfaces" in CLAUDE.md):
//   CRYPTOSLAM_API_KEY  — CryptoSlam NFT API key (direct egress; not a Flow/TS host)
//   PANINI_PROXY_URL / PANINI_PROXY_SECRET — the onepanini proxy worker (X-Proxy-Secret)
//
// This is the read path only. Nothing here mutates state.

export type PaniniFeedMode = "cryptoslam" | "onepanini" | ""

// One edition as RPC consumes it. `circulation` = cards pulled out of packs into
// wallets (the platform's per-edition circulation); `mintCap` = the serial cap
// (#/N). still_in_packs is derived downstream as mintCap − circulation.
export interface PaniniRawEdition {
  id: string // Panini edition id (feed-native; becomes panini_editions.id)
  player: string
  nation?: string
  set: string // 'Base', 'Color Blast', 'Scorers Club', …
  parallel: string // 'Silver','Red','Blue','Cracked Ice','Gold','Zebra','Black','Aguila',…
  rarity?: string // Panini sheet label: Uncommon/Rare/Ultra Rare/Epic/Legendary
  mintCap: number
  circulation: number // pulled-out-of-packs count
  isFotlExclusive?: boolean
  serial?: number
  thumbnailUrl?: string
  videoUrl?: string
  floorAskUsd?: number
}

const MODE = (process.env.PANINI_FEED_MODE ?? "") as PaniniFeedMode

const CRYPTOSLAM_API_KEY = process.env.CRYPTOSLAM_API_KEY || ""
const PANINI_PROXY_URL = process.env.PANINI_PROXY_URL || ""
const PANINI_PROXY_SECRET = process.env.PANINI_PROXY_SECRET || ""

/** True once a feed mode is configured. Routes guard on this so an accidental
 * run before go-live is a clean no-op instead of hitting an unconfigured feed. */
export function paniniFeedEnabled(): boolean {
  if (MODE === "cryptoslam") return !!CRYPTOSLAM_API_KEY
  if (MODE === "onepanini") return !!PANINI_PROXY_URL && !!PANINI_PROXY_SECRET
  return false
}

export function paniniFeedMode(): PaniniFeedMode {
  return MODE
}

/**
 * Fetch every WC2026 Prizm edition at edition+serial grain. INERT until a feed
 * mode + creds are configured AND the per-mode discovery TODO is filled.
 */
export async function fetchPaniniEditions(): Promise<PaniniRawEdition[]> {
  if (!paniniFeedEnabled()) return [] // INERT

  if (MODE === "cryptoslam") {
    // TODO(go-live discovery): CryptoSlam NFT API contract — auth header shape,
    // the Panini WC2026 collection/set params, and paging. Confirm it carries
    // WC2026 Prizm at edition+serial grain before the first production run, then
    // map mints (+ unminted caps) → PaniniRawEdition. Endpoint family:
    //   web-api.cryptoslam.io/v1/mints/Panini America/{nav,search}
    //   (commercial: cryptoslam.io/products/api)
    return []
  }

  if (MODE === "onepanini") {
    // TODO(go-live discovery): replicate the app's exact /onepanini request
    // format (headers + encoded body) captured from a logged-in session. NEVER
    // call nft.paniniamerica.net from Vercel egress — always via PANINI_PROXY_URL.
    //
    // const resp = await fetch(PANINI_PROXY_URL, {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json", "X-Proxy-Secret": PANINI_PROXY_SECRET },
    //   body: JSON.stringify({ /* captured onepanini query */ }),
    // })
    return []
  }

  return []
}
