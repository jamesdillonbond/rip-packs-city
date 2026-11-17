// lib/giveaways/linked-accounts.ts
//
// The accounts a connected Flow Wallet can draw a giveaway pool from: itself and
// every Hybrid Custody child it has REDEEMED (Trevor, 2026-10-03: "sign in with my
// flow wallet there, so then it pulls all my assets across both wallets"). Read
// from the chain on every call — the source of truth for which accounts are linked.

import { LINKED_ACCOUNTS_SCRIPT } from "@/lib/giveaways/deliver-cadence"
import { addr, runFlowScript, type CdcValue } from "@/lib/giveaways/flow-script"
import { GiveawayError } from "@/lib/giveaways/store"

export interface SponsorAccount {
  address: string
  role: "flow_wallet" | "linked"
  /** Top Shot moments held there now; null = no Top Shot collection. */
  topshot_count: number | null
  /** The account's on-chain name (e.g. "Dapper Wallet", "Creator Hub"), or null. */
  name: string | null
  /** A Dapper-created account (publishes a Dapper Utility Coin receiver). */
  dapper: boolean
}

/** On-chain names are anyone's text: one line, bounded. */
function cleanName(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40)
  return s ? s : null
}

export async function discoverAccounts(parent: string, run: typeof runFlowScript = runFlowScript): Promise<SponsorAccount[]> {
  const v: CdcValue = await run(LINKED_ACCOUNTS_SCRIPT, [addr(parent)])
  if (v?.type !== "Dictionary" || !Array.isArray(v.value)) {
    throw new GiveawayError("The linked-accounts lookup returned an unexpected shape.", 502, "flow_shape")
  }
  const out: SponsorAccount[] = []
  for (const entry of v.value as { key: CdcValue; value: CdcValue }[]) {
    const address = String(entry?.key?.value ?? "").toLowerCase()
    const fields = Array.isArray(entry?.value?.value) ? (entry.value.value as CdcValue[]).map((f) => String(f?.value ?? "")) : []
    const n = fields[0] != null && /^-?\d+$/.test(fields[0]) ? Number(fields[0]) : NaN
    if (!/^0x[0-9a-f]{16}$/.test(address) || fields.length !== 3 || !Number.isInteger(n)) {
      throw new GiveawayError("The linked-accounts lookup returned an unexpected shape.", 502, "flow_shape")
    }
    out.push({
      address,
      role: address === parent ? "flow_wallet" : "linked",
      topshot_count: n < 0 ? null : n,
      name: cleanName(fields[1]),
      dapper: fields[2] === "dapper",
    })
  }
  if (!out.some((a) => a.role === "flow_wallet")) {
    throw new GiveawayError("The linked-accounts lookup did not include the connected wallet.", 502, "flow_shape")
  }
  // the connected wallet first, then linked accounts by address (stable for the UI)
  return out.sort((a, b) => (a.role === b.role ? a.address.localeCompare(b.address) : a.role === "flow_wallet" ? -1 : 1))
}
