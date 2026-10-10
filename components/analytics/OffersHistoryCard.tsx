"use client"

// Wallet offers card for the collection analytics page: the offers this wallet
// has MADE (on-chain Dapper OffersV2), with open / filled / cancelled totals.
// Read-only — RPC never makes or accepts an offer.
//
// THREE states, never two (CLAUDE.md "Honesty"): a failed read says so; a read
// that worked and found nothing says "no offers recorded"; rows render. A
// collection without offer tracking (`supported: false`) renders NOTHING rather
// than a "no offers" claim nobody measured.
import { useEffect, useState } from "react"
import { fmt, relativeDate } from "@/lib/analytics/format"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { getEntityLabels } from "@/lib/entity-labels"

type OfferRow = {
  offer_type: string | null
  amount_usd: number | null
  status: string | null
  created_at: string | null
  resolved_at: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
}

type OffersResponse = {
  supported: boolean
  tracked_since?: string
  summary: { total: number; open: number; filled: number; cancelled: number } | null
  rows: OfferRow[]
}

const STATUS_LABEL: Record<string, string> = { open: "Open", filled: "Accepted", cancelled: "Cancelled / expired" }
const STATUS_COLOR: Record<string, string> = {
  open: "var(--rpc-text-primary)",
  filled: "var(--rpc-success)",
  cancelled: "var(--rpc-text-muted)",
}
const TYPE_LABEL: Record<string, string> = { edition: "Edition", subedition: "Parallel", serial: "Serial" }

function trackedSinceLabel(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

export default function OffersHistoryCard({ wallet, urlSlug }: { wallet: string; urlSlug: string }) {
  // The result is stored WITH the request it answers, so a wallet/collection
  // change reads as loading (key mismatch) without a setState inside the effect.
  const key = `${wallet}|${urlSlug}`
  const [result, setResult] = useState<
    { key: string; status: "failed" } | { key: string; status: "ok"; data: OffersResponse } | null
  >(null)

  useEffect(() => {
    let cancelled = false
    fetchJson<OffersResponse>(
      `/api/wallet-offers?wallet=${encodeURIComponent(wallet)}&collection=${encodeURIComponent(urlSlug)}&limit=25`,
    ).then((r) => {
      if (cancelled) return
      if (!r.ok || !r.json) setResult({ key: `${wallet}|${urlSlug}`, status: "failed" })
      else setResult({ key: `${wallet}|${urlSlug}`, status: "ok", data: r.json })
    })
    return () => { cancelled = true }
  }, [wallet, urlSlug])

  if (!result || result.key !== key) return null
  const state = result
  if (state.status === "ok" && !state.data.supported) return null

  const since = state.status === "ok" ? trackedSinceLabel(state.data.tracked_since) : null

  return (
    <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <h2 className="mb-1 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
        Offers Made
      </h2>
      <div className="mb-3 text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
        On-chain offers this wallet has placed{since ? `, tracked since ${since}` : ""}.
      </div>

      {state.status === "failed" ? (
        <div className="text-sm" style={{ color: "var(--rpc-text-secondary)" }}>
          Couldn&apos;t load offers right now. This is a loading error, not an empty history. Try again shortly.
        </div>
      ) : state.data.rows.length === 0 ? (
        <div className="text-sm" style={{ color: "var(--rpc-text-secondary)" }}>
          No offers recorded for this wallet{since ? ` since ${since}` : ""}.
        </div>
      ) : (
        <>
          {state.data.summary && (
            <div className="mb-3 flex flex-wrap gap-4 text-[11px] uppercase tracking-widest" style={{ fontFamily: "var(--font-mono)" }}>
              <span style={{ color: "var(--rpc-text-muted)" }}>Total <b style={{ color: "var(--rpc-text-primary)" }}>{state.data.summary.total.toLocaleString("en-US")}</b></span>
              <span style={{ color: "var(--rpc-text-muted)" }}>Open <b style={{ color: STATUS_COLOR.open }}>{state.data.summary.open.toLocaleString("en-US")}</b></span>
              <span style={{ color: "var(--rpc-text-muted)" }}>Accepted <b style={{ color: STATUS_COLOR.filled }}>{state.data.summary.filled.toLocaleString("en-US")}</b></span>
              <span style={{ color: "var(--rpc-text-muted)" }}>Cancelled / expired <b style={{ color: "var(--rpc-text-secondary)" }}>{state.data.summary.cancelled.toLocaleString("en-US")}</b></span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
              <thead>
                <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
                  <th className="py-1.5 pr-2">Type</th>
                  <th className="py-1.5 pr-2">{getEntityLabels(urlSlug).player}</th>
                  <th className="py-1.5 pr-2">Set</th>
                  <th className="py-1.5 pr-2">Serial</th>
                  <th className="py-1.5 pr-2 text-right">Offer</th>
                  <th className="py-1.5 pr-2">Status</th>
                  <th className="py-1.5 text-right">Made</th>
                </tr>
              </thead>
              <tbody>
                {state.data.rows.map((o, i) => (
                  <tr key={i} className="border-b border-[color:var(--rpc-border)]">
                    <td className="py-1.5 pr-2 text-[10px] uppercase text-[color:var(--rpc-text-secondary)]">{(o.offer_type && TYPE_LABEL[o.offer_type]) ?? o.offer_type ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-[color:var(--rpc-text-primary)]">{o.player_name ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{o.set_name ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{o.serial_number ? `#${o.serial_number}` : "—"}</td>
                    <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-primary)]">{o.amount_usd != null ? fmt(o.amount_usd) : "—"}</td>
                    <td className="py-1.5 pr-2 text-[10px] uppercase" style={{ color: (o.status && STATUS_COLOR[o.status]) || "var(--rpc-text-muted)" }}>
                      {(o.status && STATUS_LABEL[o.status]) ?? o.status ?? "—"}
                    </td>
                    <td className="py-1.5 text-right text-[color:var(--rpc-text-muted)]">{o.created_at ? relativeDate(o.created_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
