// Pure counterparty-decode logic for the sales-counterparty-backfill worker.
//
// Extracted VERBATIM from index.ts (decodePayload / fields / the event loop +
// multi-moment guard that lived inside decodeOne) so the parsing — which decides
// what buyer/seller gets written into the partitioned `sales` table — can be
// pinned by unit tests without a live Flow REST round-trip. index.ts imports
// these; the only thing that stays in decodeOne is the fetch.
//
// THE RULES THIS ENCODES (see the long comment block in index.ts for why):
//   * SELLER = the `.from` of the single <TopShot|AllDay|UFC_NFT>.Withdraw. The
//     `$` anchor keeps it off NonFungibleToken.Withdrawn and the *FungibleToken*
//     money legs. MomentPurchased.seller, when present, takes precedence as a
//     corroborating signal.
//   * BUYER = the `.to` of a TopShot.Deposit ONLY. AllDay/UFC deposit to a Dapper
//     custodian that re-forwards in a later tx, so their buyer is left NULL
//     rather than write the intermediate — the exact footgun this module pins.
//   * MULTI-MOMENT GUARD: more than one moment Withdraw (or TS Deposit) in the tx
//     means we can't tell which moment this sale row refers to, so we write
//     nothing rather than attach a plausible-looking lie.

export interface CdcEvent {
  type?: string
  payload: string
}

export function decodePayload(ev: { payload: string }): unknown {
  try {
    // atob is available in Workers (and in Node/vitest); payloads are base64 JSON-CDC.
    return JSON.parse(atob(ev.payload))
  } catch {
    return null
  }
}

// JSON-CDC composite -> flat {fieldName: value}. Unwraps one level (the Optional
// or type wrapper), so an Optional<Address> field like Withdraw.from becomes
// `{type:"Address", value:"0x…"}` and callers read `.value` off it.
export function fields(cdc: any): Record<string, any> {
  const out: Record<string, any> = {}
  for (const f of cdc?.value?.fields ?? []) out[f.name] = f.value?.value ?? f.value
  return out
}

/**
 * Decode buyer/seller from a transaction's already-fetched events array.
 * Returns both NULL when the multi-moment guard trips.
 */
export function decodeCounterparties(events: CdcEvent[]): { seller: string | null; buyer: string | null } {
  const withdraws: string[] = []
  const tsDeposits: string[] = []
  let purchaseSeller: string | null = null
  for (const ev of events ?? []) {
    const t: string = ev.type ?? ""
    if (/\.(TopShot|AllDay|UFC_NFT)\.Withdraw$/.test(t)) {
      const v = fields(decodePayload(ev)).from?.value
      if (v) withdraws.push(v)
    }
    if (/\.TopShot\.Deposit$/.test(t)) {
      const v = fields(decodePayload(ev)).to?.value
      if (v) tsDeposits.push(v)
    }
    if (/MomentPurchased$/.test(t)) {
      purchaseSeller = fields(decodePayload(ev)).seller?.value ?? purchaseSeller
    }
  }

  // MULTI-MOMENT GUARD — see index.ts: we hold a sale_id but not its nft_id, so
  // a tx moving >1 moment could mis-attribute. Prefer NULL (retried later) over a lie.
  if (withdraws.length > 1 || tsDeposits.length > 1) return { seller: null, buyer: null }

  return { seller: purchaseSeller ?? withdraws[0] ?? null, buyer: tsDeposits[0] ?? null }
}
