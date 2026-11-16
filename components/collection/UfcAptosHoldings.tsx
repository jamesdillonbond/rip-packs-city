"use client"

// UFC Strike moments this collector holds ON APTOS (2026-11-16, Trevor's gate B,
// claude/ufc-reopen-on-aptos-plan-2026-11-16.md). Data: /api/ufc/aptos-holdings.
//
// ⛔ Three states, never two (CLAUDE.md "Honesty"):
//   - loading / not linked   → renders NOTHING. A collector who migrated Aug–Oct 2025 is not
//                              linked until the Dune backfill; "no Aptos moments" or $0 would be a
//                              false claim about them.
//   - read failed            → one quiet line saying it could not load. Never a $0.
//   - linked with moments    → the section, valued at current FMV; unpriced moments are counted,
//                              not valued at 0.
//
// The parent mounts this with key={wallet}, so a new wallet starts from a fresh state; the
// result is also tagged with the wallet it answers, so a late answer for an older wallet is
// never shown (state is only set from the fetch callback, never synchronously in the effect).

import { useEffect, useState } from "react"
import { formatCount, formatCurrency } from "@/lib/format"
import { ON_APTOS_LABEL } from "@/lib/ufc-aptos"

type Moment = {
  token_data_id: string
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
}

type Linked = { linked: true; count: number; capped: boolean; priced: number; unpriced: number; total_fmv: number | null; moments: Moment[] }
type Payload = { linked: false } | Linked
type Result = { wallet: string; ok: true; data: Payload } | { wallet: string; ok: false }

const SHOW = 24
const FLOW_ADDRESS = /^0x[0-9a-fA-F]{16}$/

export default function UfcAptosHoldings({ wallet }: { wallet: string }) {
  const [result, setResult] = useState<Result | null>(null)
  const [expanded, setExpanded] = useState(false)
  const valid = FLOW_ADDRESS.test(wallet)

  useEffect(() => {
    if (!valid) return
    let live = true
    fetch("/api/ufc/aptos-holdings?wallet=" + encodeURIComponent(wallet))
      .then(async (r) => {
        const next: Result = r.ok ? { wallet, ok: true, data: (await r.json()) as Payload } : { wallet, ok: false }
        if (live) setResult(next)
      })
      .catch(() => { if (live) setResult({ wallet, ok: false }) })
    return () => { live = false }
  }, [wallet, valid])

  if (!valid || !result || result.wallet !== wallet) return null
  if (!result.ok) {
    return (
      <p className="text-xs" style={{ color: "var(--rpc-text-muted)", margin: "8px 0" }} data-testid="ufc-aptos-failed">
        Couldn&apos;t check this wallet&apos;s UFC Strike moments on Aptos right now.
      </p>
    )
  }
  if (!result.data.linked || result.data.count === 0) return null
  const d: Linked = result.data

  const shown: Moment[] = expanded ? d.moments : d.moments.slice(0, SHOW)
  return (
    <section className="rpc-stat-tile" style={{ margin: "12px 0" }} data-testid="ufc-aptos-holdings" aria-label={ON_APTOS_LABEL}>
      <div className="rpc-stat-eyebrow">
        <span>{ON_APTOS_LABEL} · current FMV</span>
      </div>
      <div className="rpc-stat-value">{d.total_fmv === null ? "—" : formatCurrency(d.total_fmv)}</div>
      <div className="rpc-stat-caption" style={{ lineHeight: 1.5 }}>
        {formatCount(d.count)} moment{d.count === 1 ? "" : "s"} migrated to Aptos
        {d.unpriced > 0 ? ` · ${formatCount(d.unpriced)} without a current FMV, not counted in the total` : ""}
        {d.capped ? " · showing the first 20,000" : ""}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 6 }}>
        {shown.map((m: Moment) => (
          <li key={m.token_data_id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.player_name ?? m.name ?? m.set_name ?? "UFC Strike moment"}
              {m.set_name && (m.player_name ?? m.name) ? <span style={{ color: "var(--rpc-text-muted)" }}> · {m.set_name}</span> : null}
              {m.serial_number != null ? (
                <span style={{ color: "var(--rpc-text-muted)" }}>
                  {" "}#{m.serial_number}{m.circulation_count ? "/" + formatCount(m.circulation_count) : ""}
                </span>
              ) : null}
            </span>
            <span style={{ flexShrink: 0 }}>{m.fmv_usd === null ? "—" : formatCurrency(m.fmv_usd)}</span>
          </li>
        ))}
      </ul>
      {d.moments.length > SHOW && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ marginTop: 8, fontSize: 12, color: "var(--rpc-text-muted)", background: "none", border: 0, padding: 0, cursor: "pointer" }}
        >
          {expanded ? "Show fewer" : `Show all ${formatCount(d.moments.length)}`}
        </button>
      )}
    </section>
  )
}
