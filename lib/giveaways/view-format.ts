// lib/giveaways/view-format.ts
//
// Pure display helpers for the giveaway pages, kept in lib/ so the coverage
// gate measures them.

import { usdSignFirst } from "@/lib/usd-format"

/** "$12.34"; an absent value is an em dash, never "$0". */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const fmt = (m: number) => `$${m.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return usdSignFirst(n, fmt) ?? fmt(n)
}

/** A timestamp in Pacific time, e.g. "Sep 29, 2026, 12:40 PM PT". */
export function ptTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return (
    d.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) + " PT"
  )
}

export type DropStatusLabel = "sealed" | "open" | "closed"

export function statusLabel(status: DropStatusLabel, claimed: number, packs: number): string {
  if (status === "sealed") return "Coming soon: claims haven't opened yet"
  if (status === "closed") return `Closed · ${claimed} of ${packs} packs claimed`
  const left = packs - claimed
  return left > 0 ? `Open · ${left} of ${packs} packs left` : `Open · all ${packs} packs claimed`
}

/** The shell command that re-computes the published commitment. */
export function verifyCommand(salt: string, manifest: string): string {
  return `printf '%s' '${salt}|${manifest}' | sha256sum`
}

export type DeliveryState = "delivered" | "awaiting"

export function deliveryLabel(delivered: boolean, lastChecked: string | null): string {
  if (delivered) return "Delivered: in your Top Shot account"
  return lastChecked ? `Awaiting the sponsor's gift (last checked ${ptTime(lastChecked)})` : "Awaiting the sponsor's gift"
}

/**
 * Readable text for anything a wallet throws. FCL and WalletConnect reject with
 * plain objects ({ code, message }) and bare strings as often as with Errors, and
 * `String(obj)` renders "[object Object]" — the admin would see no reason at all.
 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (typeof e === "string") return e || "(empty error)"
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; code?: unknown; reason?: unknown }
    const msg = typeof o.message === "string" && o.message ? o.message : typeof o.reason === "string" && o.reason ? o.reason : null
    if (msg) return o.code != null ? `${msg} (code ${String(o.code)})` : msg
    try {
      return JSON.stringify(e)
    } catch {
      return Object.prototype.toString.call(e)
    }
  }
  return String(e)
}

export interface AccountLineInput {
  address: string
  role: "flow_wallet" | "linked"
  name?: string | null
  dapper?: boolean
  onchain_count: number | null
  cache_count: number
  giftable: number
}

export interface AccountKindInput {
  role: "flow_wallet" | "linked"
  /** The account's on-chain name, when it has one ("Dapper Wallet", "Creator Hub"). */
  name?: string | null
  /** A Dapper-created account, read on chain (lib/giveaways/linked-accounts.ts). */
  dapper?: boolean
}

/**
 * What kind of account this is, in a collector's words (Trevor, 2026-10-03:
 * "specifically call out which is the dapper wallet"): "Dapper wallet", "Flow
 * Wallet", or a linked account under its own on-chain name.
 */
export function accountKind(a: AccountKindInput): string {
  if (a.dapper) return "Dapper wallet"
  if (a.role === "flow_wallet") return "Flow Wallet"
  return a.name ? `Linked account “${a.name}”` : "Linked account"
}

/** "Dapper wallet 0xbd94cade097e50ac" / "Flow Wallet 0x3d0b274c80263484": always the FULL address. */
export function accountName(a: AccountKindInput & { address: string }): string {
  return `${accountKind(a)} ${a.address}`
}

/**
 * One line per account the pool can draw from. An account holding moments on
 * chain that RPC hasn't indexed reads as NOT INDEXED — never as empty — because
 * the picker lists cached moments only.
 */
export function accountLine(a: AccountLineInput): string {
  const name = accountName(a)
  if (a.onchain_count == null) return `${name}: no Top Shot collection`
  if (a.onchain_count === 0) return `${name}: 0 Top Shot moments`
  const held = `${a.onchain_count.toLocaleString("en-US")} Top Shot moments on chain`
  if (a.cache_count === 0) return `${name}: ${held}, not indexed by RPC yet, so none can be picked here`
  return `${name}: ${held} · ${a.giftable.toLocaleString("en-US")} unlocked and giftable now`
}
