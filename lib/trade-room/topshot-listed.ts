// lib/trade-room/topshot-listed.ts
//
// "Which Top Shot Moments has this account LISTED for sale on Top Shot's marketplace?"
//
// A listed Moment stays in the owner's MomentCollection — TopShotMarketV3's SaleCollection holds a
// capability to that collection, not the Moment itself — so the held/locked read
// (lib/giveaways/topshot-holdings.ts) reports it as held and unlocked, and the swap can withdraw it.
// Trading it would leave a dead listing behind on Top Shot. The trade room therefore refuses a
// listed Moment by name ("delist it first") at the two gates every trade passes — saving picks and
// planning the signature — and marks it in the picker (docs/strategy/features/trading.md, the
// 10-31 live-test lesson: "the picker should read the sale collection too").
//
// Verified against deployed mainnet source 2026-11-04 (Flow REST `?expand=contracts` on
// 0xc1e4f4f4c4257510): `TopShotMarketV3.SaleCollection: Market.SalePublic`, published at
// `/public/topshotSalev3Collection`; `getIDs()` returns the V3 prices' keys plus any V1
// SaleCollection ids it wraps. Live read the same day: 22 ids listed on Trevor's Dapper account,
// each one also "held, unlocked" in the lock read.
//
// An account with no sale collection lists nothing (empty set). A failed read THROWS — callers turn
// it into the room's 503, never into "not listed".

import { FLOW_SCRIPTS_URL } from "@/lib/giveaways/topshot-holdings"

export const TOPSHOT_LISTED_SCRIPT = `
import Market from 0xc1e4f4f4c4257510

access(all) fun main(addr: Address): [UInt64] {
    if let sale = getAccount(addr).capabilities.borrow<&{Market.SalePublic}>(/public/topshotSalev3Collection) {
        return sale.getIDs()
    }
    return []
}
`.trim()

const TIMEOUT_MS = 20_000

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64")
}

/** Every Top Shot Moment id `address` has listed for sale right now. Throws on any failed read. */
export async function readTopShotListed(address: string, fetchImpl: FetchLike = fetch): Promise<Set<string>> {
  if (!/^0x[0-9a-f]{16}$/.test(address)) throw new Error(`not a Flow address: ${address}`)
  const body = {
    script: b64(TOPSHOT_LISTED_SCRIPT),
    arguments: [b64(JSON.stringify({ type: "Address", value: address }))],
  }
  const res = await fetchImpl(FLOW_SCRIPTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`listed read HTTP ${res.status}`)
  const raw = (await res.text()).trim().replace(/^"|"$/g, "")
  let v: { type?: string; value?: Array<{ value?: unknown }> }
  try {
    v = JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
  } catch {
    throw new Error("listed read: undecodable body")
  }
  if (v?.type !== "Array" || !Array.isArray(v.value)) throw new Error("listed read: unexpected shape")
  const out = new Set<string>()
  for (const x of v.value) {
    const id = String(x?.value ?? "")
    if (!/^[0-9]{1,20}$/.test(id)) throw new Error("listed read: unexpected id")
    out.add(id)
  }
  return out
}

/** The ids among `ids` that are listed — the caller names them. */
export function listedAmong(listed: ReadonlySet<string>, ids: readonly string[]): string[] {
  return ids.filter((id) => listed.has(id))
}

/** The room's refusal copy for listed picks. */
export function listedMessage(ids: readonly string[]): string {
  return `Listed for sale on Top Shot (cancel the listing first): ${ids.join(", ")}.`
}
