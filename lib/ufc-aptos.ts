// lib/ufc-aptos.ts
//
// UFC Strike moved from Flow to Aptos (Trevor 2026-11-15: Aptos extends the existing ufc_strike
// collection). The binder shows both halves of a collector's UFC holdings (2026-11-16, gates B
// and C in claude/ufc-reopen-on-aptos-plan-2026-11-16.md):
//   - moments still on Flow, at the edition's current FMV, with FLOW_MIGRATE_NOTE (they cannot
//     trade until migrated: the Flow marketplace closed 2026-05-13);
//   - moments already on Aptos, from /api/ufc/aptos-holdings, labelled "On Aptos".
//
// ⚠ DELIBERATELY SEPARATE FROM lib/market-closed.ts. The reopen flip removes UFC from
// CLOSED_MARKETS (and the DB's market_closed_at); the Flow note must outlive that, because Flow
// moments stay untradeable whether or not the Aptos market is "open" on RPC. So the binder asks
// THIS module, not closedMarket(), whether to value Flow holdings and show the note.

export const FLOW_MIGRATE_NOTE = "Still on Flow — migrate to Aptos to trade"
export const ON_APTOS_LABEL = "On Aptos"

const UFC_SLUGS = new Set(["ufc", "ufc-strike"])

/** True for the UFC Strike binder: Flow holdings at current FMV + an On Aptos section. */
export function isUfcAptosBinder(collectionSlug: string | null | undefined): boolean {
  return !!collectionSlug && UFC_SLUGS.has(collectionSlug)
}

// ── Aptos wallets and venues on sales rows (2026-11-25) ──────────────────────────────────────
//
// UFC sales ingested from Aptos (sales.source = 'aptos_indexer_v1') carry 64-hex Aptos account
// addresses. The sales tables linked every buyer/seller into RPC's wallet analyzer,
// /<collection>/collection?wallet=<addr>, which reads FLOW wallets — an Aptos address there is
// a link to a wallet page that cannot describe that collector. Aptos addresses go to the Aptos
// explorer instead, and UFC's own two wallets are named (78 % of UFC's single Rarible listings
// on 2026-11-15 came from the store wallet).

const APTOS_ACCOUNT_RE = /^0x[0-9a-fA-F]{64}$/

/** A full-length Aptos account address (0x + 64 hex). Flow (16 hex) and EVM (40 hex) never match. */
export function isAptosAccountAddress(value: string | null | undefined): boolean {
  return !!value && APTOS_ACCOUNT_RE.test(value.trim())
}

/** UFC Strike's own Aptos wallets, by lowercase address. */
export const UFC_APTOS_KNOWN_WALLETS: Readonly<Record<string, string>> = {
  "0x8a94446716e60160571b930bd1097b31c7788decbe4d375802bebfc79d928e7f": "UFC Strike store",
  "0x80f686c7bba12a0fce839ff160cb69774715497288996b861528727ccd256cdb": "UFC Strike",
}

/**
 * Display for an Aptos address in a buyer/seller cell, or null when the address is not Aptos
 * (the caller keeps its own Flow/EVM/Solana path untouched).
 */
export function aptosWalletDisplay(
  address: string | null | undefined,
  name?: string | null,
): { label: string; href: string; title: string } | null {
  if (!address || !isAptosAccountAddress(address)) return null
  const a = address.trim().toLowerCase()
  const known = UFC_APTOS_KNOWN_WALLETS[a]
  const label = known ?? (name ? `@${name}` : `${a.slice(0, 6)}…${a.slice(-4)}`)
  return {
    label,
    href: `https://explorer.aptoslabs.com/account/${a}?network=mainnet`,
    title: `${known ? `${known} · ` : ""}${a} (Aptos)`,
  }
}

/** "Aptos · Rarible" for a sale ingested from Aptos; null for every other sale. */
export function aptosSaleVenue(source: string | null | undefined, marketplace: string | null | undefined): string | null {
  if (source !== "aptos_indexer_v1") return null
  const m = (marketplace ?? "").toLowerCase()
  const venue = m === "rarible" ? "Rarible" : m === "tradeport" ? "Tradeport" : null
  return venue ? `Aptos · ${venue}` : "Aptos"
}

/**
 * Empty-state copy for the UFC binder's main moment table (2026-11-26). That table lists FLOW holdings only;
 * Aptos holdings render in their own "On Aptos" panel above it. The generic "No moments found for this wallet on
 * this collection." sat directly under a linked collector's 1,855 Aptos Moments (RRX69, live 2026-11-26) — a false
 * "you hold none" claim. This says what the table covers and promises nothing about the Aptos panel, which is
 * absent for wallets RPC has not linked yet.
 */
export const UFC_FLOW_TABLE_EMPTY =
  "No UFC Strike moments found on Flow for this wallet. This table lists Flow holdings only — UFC Strike moved to Aptos."
