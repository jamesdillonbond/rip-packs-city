// lib/entity/checklist-wallet.ts
// The wallet a team checklist (/[collection]/team/[slug]) tracks, parsed for the
// collection's OWN chain. Shared by TeamChecklist.tsx and the two
// /api/entity/team-checklist* routes so the client and the server cannot
// disagree about what a valid key is.
//
// Why this exists (2026-09-25): both routes and the component hard-coded
// `/^0x[0-9a-f]{16}$/` on a `.toLowerCase()`d value. On a Candy MLB (Solana)
// team page that refused every real holder's key ("Enter a valid 0x Flow
// address") — and had one got through, the lowercase fold would have DESTROYED
// it: base58 is case-sensitive, so the exact-match `wmc.wallet_address = p_wallet`
// in get_team_checklist(_progress) would match nothing and read "0 owned".
//
// ⛔ The Flow path is UNCHANGED byte-for-byte (lowercase, 0x + 16 hex, anything
// else silently tracked as no wallet). Only a Solana collection gets the new arm,
// and there a wrong-chain key is REFUSED rather than dropped: a Flow key holds no
// Candy by construction, and a checklist with no owned flags under a "Tracking
// 0x…" header would read as "you own none of these".

import { chainKindForDbChain, isSolanaAddress } from "@/lib/address"

const FLOW_WALLET_RE = /^0x[0-9a-f]{16}$/

export type ChecklistWalletParse =
  | { ok: true; wallet: string | null }
  | { ok: false; error: string }

export function isSolanaChecklist(dbChain: string | null | undefined): boolean {
  return chainKindForDbChain(dbChain) === "solana"
}

export function parseChecklistWallet(raw: string | null | undefined, dbChain: string | null | undefined): ChecklistWalletParse {
  const trimmed = (raw ?? "").trim()
  if (isSolanaChecklist(dbChain)) {
    if (!trimmed) return { ok: true, wallet: null }
    // VERBATIM — never folded.
    if (isSolanaAddress(trimmed)) return { ok: true, wallet: trimmed }
    return { ok: false, error: "This collection is on Solana — enter a Solana wallet address." }
  }
  const lower = trimmed.toLowerCase()
  return { ok: true, wallet: FLOW_WALLET_RE.test(lower) ? lower : null }
}

/** localStorage slot for the tracked wallet. Flow keeps the historical key. */
export function checklistWalletStorageKey(dbChain: string | null | undefined): string {
  return isSolanaChecklist(dbChain) ? "rpc_checklist_wallet_solana" : "rpc_checklist_wallet"
}
