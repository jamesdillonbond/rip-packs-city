// lib/storage-fix/view.ts
//
// Pure display helpers for /admin/storage-fix, kept in lib/ so the coverage gate measures
// them. Times are Pacific (CLAUDE.md: every time Trevor reads is PT).

import { ptTime } from "@/lib/giveaways/view-format"
import type { History, StorageCheck } from "@/lib/storage-fix/check"

/** "101,541 bytes (0.10 MB)". */
export function bytes(n: number): string {
  const mb = n / 1_000_000
  return `${Math.round(n).toLocaleString("en-US")} bytes (${mb.toFixed(mb < 10 ? 2 : 1)} MB)`
}

/** A FLOW amount without trailing zeros: "0.01000000" → "0.01". */
export function flow(amount: string | number | null | undefined): string {
  const n = Number(amount)
  if (amount == null || !Number.isFinite(n)) return "—"
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 8 })} FLOW`
}

export const flowscanTx = (txId: string) => `https://www.flowscan.io/tx/${txId}`
export const flowscanAccount = (address: string) => `https://www.flowscan.io/account/${address}`

/** One line saying whether, when and by whom the account was last topped up. */
export function historyLine(h: History): string {
  if (h.status === "unavailable") return `Couldn't read the top-up history (${h.reason}). This does NOT mean it was never topped up.`
  const back = h.searchedBackTo.at ? ptTime(h.searchedBackTo.at) : `block ${h.searchedBackTo.height.toLocaleString("en-US")}`
  if (h.status === "none") return `Storage capacity has not changed since ${back}.`
  const c = h.change
  const who = c.byDapper
    ? "Dapper itself (its forwarder account)"
    : c.payer
      ? `${c.payer}${c.viaDapperForwarder ? " through Dapper's forwarder" : ""}`
      : "an unidentified transaction"
  const amount = c.amountFlow != null ? `${flow(c.amountFlow)} ` : ""
  return `Last topped up ${ptTime(c.at)}: ${amount}from ${who}. Capacity ${bytes(c.capacityBefore)} → ${bytes(c.capacityAfter)}.`
}

/** The verdict at the top of the result. */
export function verdict(c: StorageCheck): { tone: "ok" | "warn" | "bad"; text: string } {
  const free = c.plan.headroomBytes
  if (c.plan.stuck) {
    return {
      tone: "bad",
      text:
        free < 0
          ? `Stuck: using ${bytes(c.state.usedBytes)} of ${bytes(c.state.capacityBytes)}. Any transaction that adds data will fail with error 1103.`
          : `Nearly stuck: only ${bytes(free)} free. The next item it receives will likely fail with error 1103.`,
    }
  }
  const recent = c.history.status === "found" ? ` ${c.history.change.byDapper ? "Dapper already fixed it." : "It was topped up recently."}` : ""
  return { tone: "ok", text: `Not stuck: ${bytes(free)} free.${recent} No refill needed.` }
}
