"use client"

// BuybackDashboard — analytics for the Top Shot secondary-buyback wallets.
//
// Renders four calendar-to-date windows over /api/analytics/buyback. The whole
// component is built around one rule: a failed read and an unpriced acquisition
// must never render as a number.
//
//   * fetchJson (not a bare `.catch`) so a 5xx / network failure / HTML login
//     body reaches the render layer as `ok: false` rather than an empty array
//     that reads as "the buyback wallets bought nothing".
//   * every dollar figure goes through walletSpendDisplay / formatUsd, which
//     return an em-dash for an absent figure instead of $0.00.
//   * the spend-coverage notice renders whenever any acquisition in the window
//     is unpriced, and is SUPPRESSED when all of them are priced (a permanent
//     caveat is its own false claim).

import { useEffect, useState } from "react"
import { ShieldAlert, Info, AlertTriangle } from "lucide-react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import {
  BUYBACK_PERIOD_LABELS,
  formatCount,
  formatUsd,
  observationNotice,
  spendCoverageNotice,
  walletLabel,
  walletSpendDisplay,
  NO_FIGURE,
  type BuybackPayload,
  type BuybackPeriod,
} from "@/lib/analytics/buyback"

const PERIODS: BuybackPeriod[] = ["week", "month", "year", "all"]

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section
      className="rounded-lg p-4"
      style={{
        background: "var(--rpc-surface)",
        border: "1px solid var(--rpc-border)",
      }}
    >
      <h3
        className="text-sm uppercase tracking-wide"
        style={{ fontFamily: "var(--font-display)", color: "var(--rpc-text-primary)" }}
      >
        {title}
      </h3>
      {subtitle ? (
        <p className="mt-1 text-xs" style={{ color: "var(--rpc-text-muted)" }}>
          {subtitle}
        </p>
      ) : null}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border-subtle)" }}
    >
      <div className="text-xs uppercase tracking-wide" style={{ color: "var(--rpc-text-muted)" }}>
        {label}
      </div>
      <div
        className="mt-1 text-2xl"
        style={{ fontFamily: "var(--font-display)", color: "var(--rpc-text-primary)" }}
      >
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-[11px]" style={{ color: "var(--rpc-text-ghost)" }}>
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export default function BuybackDashboard() {
  const [period, setPeriod] = useState<BuybackPeriod>("month")
  const [data, setData] = useState<BuybackPayload | null>(null)
  const [loading, setLoading] = useState(true)
  // Distinct from `data === null`: this says we ASKED and did not get an answer.
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const res = await fetchJson<BuybackPayload>(
        `/api/analytics/buyback?period=${period}&limit=10`
      )
      if (cancelled) return
      setLoading(false)
      if (!res.ok || res.json == null) {
        // Clear the stale payload as well as raising the flag: leaving the
        // previous period's numbers on screen under the new period's label
        // would attribute one window's activity to another.
        setFailed(true)
        setData(null)
        return
      }
      setFailed(false)
      setData(res.json)
    })()
    return () => {
      cancelled = true
    }
  }, [period])

  const coverageNotice = data ? spendCoverageNotice(data.totals, data.coverage) : null
  const obsNotice = data ? observationNotice(data.period, data.coverage) : null

  return (
    <div className="space-y-4">
      <header>
        <h1
          className="text-2xl uppercase tracking-wide flex items-center gap-2"
          style={{ fontFamily: "var(--font-display)", color: "var(--rpc-text-primary)" }}
        >
          <ShieldAlert size={20} style={{ color: "var(--rpc-red)" }} aria-hidden />
          Top Shot Buyback Wallets
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--rpc-text-secondary)" }}>
          Top Shot repurchases moments off the secondary market and re-stuffs them into future
          packs. What these wallets accumulate is a curatorial signal about which players and sets
          are being elevated.
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Time period">
        {PERIODS.map((p) => {
          const active = p === period
          return (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setPeriod(p)}
              className="rounded px-3 py-1.5 text-xs uppercase tracking-wide transition-colors"
              style={{
                background: active ? "var(--rpc-red-bg)" : "var(--rpc-surface)",
                border: `1px solid ${active ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
                color: active ? "var(--rpc-red)" : "var(--rpc-text-secondary)",
                fontFamily: "var(--font-display)",
              }}
            >
              {BUYBACK_PERIOD_LABELS[p]}
            </button>
          )
        })}
      </div>

      {/* A failed read states that it failed. It never falls through to the
          panels below, which would render "no acquisitions" from an outage. */}
      {failed ? (
        <div
          className="rounded-lg p-4 flex items-start gap-2"
          style={{
            background: "var(--rpc-red-bg)",
            border: "1px solid var(--rpc-red-border)",
            color: "var(--rpc-text-primary)",
          }}
        >
          <AlertTriangle size={16} style={{ color: "var(--rpc-red)" }} aria-hidden />
          <div className="text-sm">
            <strong>Buyback analytics could not be loaded.</strong>
            <div className="mt-1" style={{ color: "var(--rpc-text-secondary)" }}>
              This is a problem on our side, not a report that the buyback wallets were inactive.
              Try again shortly.
            </div>
          </div>
        </div>
      ) : loading && !data ? (
        <p className="text-sm" style={{ color: "var(--rpc-text-muted)" }}>
          Loading buyback activity…
        </p>
      ) : data ? (
        <>
          <p className="text-xs" style={{ color: "var(--rpc-text-muted)" }}>
            Window: <strong>{data.window_start ?? NO_FIGURE}</strong> to{" "}
            <strong>{data.window_end ?? NO_FIGURE}</strong> (UTC, {data.coverage.date_grain} grain)
          </p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Moments acquired" value={formatCount(data.totals.acquisitions)} />
            <Kpi label="Distinct editions" value={formatCount(data.totals.distinct_editions)} />
            <Kpi label="Active days" value={formatCount(data.totals.active_days)} />
            <Kpi
              label="Priced spend"
              value={
                data.totals.spend_known ? formatUsd(data.totals.spend_usd) : NO_FIGURE
              }
              hint={`across ${formatCount(data.totals.priced_acquisitions)} priced buy(s)`}
            />
          </div>

          {coverageNotice ? (
            <div
              className="rounded-lg p-3 flex items-start gap-2"
              style={{
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-warning)",
              }}
            >
              <Info size={16} style={{ color: "var(--rpc-warning)" }} aria-hidden />
              <div className="text-xs">
                <strong style={{ color: "var(--rpc-text-primary)" }}>
                  {coverageNotice.headline}
                </strong>
                <div className="mt-1" style={{ color: "var(--rpc-text-secondary)" }}>
                  {coverageNotice.detail}
                </div>
              </div>
            </div>
          ) : null}

          {obsNotice ? (
            <p className="text-xs" style={{ color: "var(--rpc-text-ghost)" }}>
              {obsNotice}
            </p>
          ) : null}

          <Panel title="By wallet">
            {data.wallets.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--rpc-text-muted)" }}>
                No buyback activity in this window.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ color: "var(--rpc-text-muted)" }} className="text-left text-xs uppercase">
                      <th className="py-1 pr-3">Wallet</th>
                      <th className="py-1 pr-3 text-right">Moments</th>
                      <th className="py-1 pr-3 text-right">Editions</th>
                      <th className="py-1 pr-3 text-right">Priced buys</th>
                      <th className="py-1 text-right">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.wallets.map((w) => {
                      const spend = walletSpendDisplay(w)
                      return (
                        <tr key={w.address} style={{ borderTop: "1px solid var(--rpc-border-subtle)" }}>
                          <td className="py-2 pr-3" style={{ color: "var(--rpc-text-primary)" }}>
                            {walletLabel(w.address, w.username)}
                          </td>
                          <td className="py-2 pr-3 text-right" style={{ color: "var(--rpc-text-primary)" }}>
                            {formatCount(w.acquisitions)}
                          </td>
                          <td className="py-2 pr-3 text-right" style={{ color: "var(--rpc-text-secondary)" }}>
                            {formatCount(w.distinct_editions)}
                          </td>
                          <td className="py-2 pr-3 text-right" style={{ color: "var(--rpc-text-secondary)" }}>
                            {formatCount(w.priced_acquisitions)}
                          </td>
                          <td className="py-2 text-right">
                            <span style={{ color: "var(--rpc-text-primary)" }}>{spend.text}</span>
                            {spend.note ? (
                              <div className="text-[11px]" style={{ color: "var(--rpc-text-ghost)" }}>
                                {spend.note}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="Most acquired moments"
            subtitle="By number of copies taken off the market in this window — the clearest read on what Top Shot is accumulating."
          >
            {data.top_editions_by_count.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--rpc-text-muted)" }}>
                No acquisitions resolved to an edition in this window.
              </p>
            ) : (
              <ol className="space-y-1">
                {data.top_editions_by_count.map((e, i) => (
                  <li
                    key={e.edition_id ?? i}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span style={{ color: "var(--rpc-text-primary)" }}>
                      {e.player_name ?? "Unknown player"}
                      <span style={{ color: "var(--rpc-text-muted)" }}>
                        {" "}
                        · {e.set_name ?? "Unknown set"}
                        {e.tier ? ` · ${e.tier}` : ""}
                      </span>
                    </span>
                    <span style={{ color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)" }}>
                      {formatCount(e.acquisitions)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="Top sellers by value"
              subtitle={`Priced marketplace purchases only (${formatCount(
                data.coverage.counterparty_known_for
              )} in this window). Direct transfers record no counterparty.`}
            >
              {data.top_sellers_by_spend.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--rpc-text-muted)" }}>
                  No priced purchases with a known seller in this window.
                </p>
              ) : (
                <ol className="space-y-1">
                  {data.top_sellers_by_spend.map((s) => (
                    <li key={s.seller_address} className="flex justify-between gap-3 text-sm">
                      <span style={{ color: "var(--rpc-text-primary)" }}>
                        {walletLabel(s.seller_address, s.username)}
                      </span>
                      <span style={{ color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)" }}>
                        {formatUsd(s.spend_usd)}{" "}
                        <span style={{ color: "var(--rpc-text-ghost)" }}>
                          ({formatCount(s.purchases)})
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            <Panel
              title="Top sellers by transactions"
              subtitle="Same priced-purchase scope, ranked by number of moments sold to the buyback wallets."
            >
              {data.top_sellers_by_count.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--rpc-text-muted)" }}>
                  No priced purchases with a known seller in this window.
                </p>
              ) : (
                <ol className="space-y-1">
                  {data.top_sellers_by_count.map((s) => (
                    <li key={s.seller_address} className="flex justify-between gap-3 text-sm">
                      <span style={{ color: "var(--rpc-text-primary)" }}>
                        {walletLabel(s.seller_address, s.username)}
                      </span>
                      <span style={{ color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)" }}>
                        {formatCount(s.purchases)}{" "}
                        <span style={{ color: "var(--rpc-text-ghost)" }}>
                          ({formatUsd(s.spend_usd)})
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </div>

          <Panel
            title="Most expensive moments bought"
            subtitle="Ranked by dollars actually paid — priced marketplace purchases only."
          >
            {data.top_editions_by_spend.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--rpc-text-muted)" }}>
                No priced purchases in this window.
              </p>
            ) : (
              <ol className="space-y-1">
                {data.top_editions_by_spend.map((e, i) => (
                  <li
                    key={e.edition_id ?? i}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span style={{ color: "var(--rpc-text-primary)" }}>
                      {e.player_name ?? "Unknown player"}
                      <span style={{ color: "var(--rpc-text-muted)" }}>
                        {" "}
                        · {e.set_name ?? "Unknown set"}
                        {e.tier ? ` · ${e.tier}` : ""}
                      </span>
                    </span>
                    <span style={{ color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)" }}>
                      {formatUsd(e.spend_usd)}{" "}
                      <span style={{ color: "var(--rpc-text-ghost)" }}>
                        ({formatCount(e.priced_acquisitions)})
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  )
}
