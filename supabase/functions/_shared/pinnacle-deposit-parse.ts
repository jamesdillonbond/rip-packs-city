// Shared pure logic for the Pinnacle ownership-discovery edge functions —
// pinnacle-owner-discovery, pinnacle-owner-discovery-forward, and
// ingest-pinnacle-mints. Each carries an inline `extractDeposit` that turns a
// base64 JSON-CDC Deposit-event payload into { nftId, to }, which is what
// establishes who owns a Pinnacle NFT. A regression here mis-attributes (or
// drops) ownership, so the decision is worth pinning.
//
// The three inline copies are FUNCTIONALLY identical (they differ only in local
// var names + the log-prefix string), so this is the canonical extraction; the
// drift guard in __tests__/edge-pinnacle-deposit-parse.test.ts pins the
// load-bearing invariants (0x-address gate + lowercasing + unwrapCdc) in each
// inline copy rather than a byte match, so a var-name difference doesn't false-
// alarm but a dropped guard does.
//
// It reuses the FULL unwrapCdc from _shared/cdc.ts (a Deposit is an Event
// composite, so the Struct/Event field-flattening branch is required). Note the
// separate reduced unwrapCdc variant in sales-serial-backfill /
// backfill-allday-listing-serials / scan-ufc-wallet OMITS those composite
// branches — that is a DIFFERENT function and is deliberately not unified here.

import { unwrapCdc } from "./cdc"

/**
 * Decode a base64 JSON-CDC Deposit-event payload to { nftId, to }. Returns null
 * (never throws) when: the base64/JSON is malformed, `id` or `to` is absent, or
 * `to` isn't a 0x address. `to` is lowercased so ownership keys are canonical.
 */
export function extractPinnacleDeposit(payloadBase64: string): { nftId: string; to: string } | null {
  try {
    const raw = JSON.parse(atob(payloadBase64))
    const unwrapped = unwrapCdc(raw) as Record<string, unknown>
    const idField = unwrapped?.id
    const toField = unwrapped?.to
    if (idField === undefined || idField === null) return null
    if (toField === undefined || toField === null) return null
    const nftId = String(idField)
    const to = String(toField).toLowerCase()
    if (!nftId || !to.startsWith("0x")) return null
    return { nftId, to }
  } catch {
    return null
  }
}
