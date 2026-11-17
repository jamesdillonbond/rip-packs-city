// app/trades/trade-ui.ts
//
// Shared styles and the one fetch helper the trade pages use. Every call reports
// failure as data ({ ok: false, status, body }) with the route's own copy, so the
// page can show WHY (the chain was unreachable, a Moment is locked, the proposal
// changed) instead of a generic error — and never renders a failed read as a fact.

import type { RoomState } from "@/lib/trade-room/store"
import { usdSignFirst } from "@/lib/usd-format"

export const DISPLAY = "var(--font-display)"
export const MONO = "var(--font-mono)"

export const card: React.CSSProperties = { background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: 14 }
export const muted: React.CSSProperties = { color: "var(--rpc-text-muted)", fontSize: 13 }
export const btn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-surface-raised)",
  color: "var(--rpc-text-primary)",
  fontFamily: MONO,
  fontSize: 13,
  cursor: "pointer",
}
export const btnPrimary: React.CSSProperties = { ...btn, background: "var(--rpc-red-fill)", borderColor: "var(--rpc-red-fill)", color: "#fff", fontWeight: 700 }
export const label: React.CSSProperties = { fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }

export type Called = { ok: boolean; status: number; body: Record<string, unknown> | null }

export async function call(url: string, init?: RequestInit): Promise<Called> {
  try {
    const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" })
    let body: Record<string, unknown> | null
    try {
      body = (await r.json()) as Record<string, unknown>
    } catch {
      return { ok: false, status: r.status, body: { error: r.status === 200 ? "The server answered with something that isn't JSON (are you still signed in?)." : `HTTP ${r.status}: unreadable response` } }
    }
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : String(e) } }
  }
}

/** The route's error copy, or a status line; never empty. */
export function errorOf(r: Called): string {
  const e = r.body?.error
  return typeof e === "string" && e ? e : `HTTP ${r.status}`
}

export function stateLabel(s: RoomState): string {
  switch (s) {
    case "open":
      return "Waiting for the other side"
    case "building":
      return "Building"
    case "accepted":
      return "Both accepted"
    case "signing":
      return "Signing"
    case "sealed":
      return "Sealed on chain"
    case "cancelled":
      return "Cancelled"
    case "expired":
      return "Expired"
  }
}

export function fmtUsd(n: number): string {
  const neg = usdSignFirst(n, fmtUsd)
  if (neg !== null) return neg
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function shortAddr(a: string | null): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"
}
