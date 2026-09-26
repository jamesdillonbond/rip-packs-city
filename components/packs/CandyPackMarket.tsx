"use client"

// CandyPackMarket — the Candy MLB Packs body (standalone /candy-mlb/packs and
// the Market tab's Packs sub-section, via PackMarketView). Reads
// /api/candy-pack-market, which serves Candy's native pack plane — one sealed
// product on Magic Eden, none of it in the Flow `pack_distributions` board.
//
// Honesty rules this component keeps (see the route header for the why):
//   · the headline floor is the CONFIRMED floor; unconfirmed asks are counted and
//     shown last, labelled, never as "the price"
//   · each panel has three states — failed, empty, rows — and a failed read
//     renders as "couldn't load", never as "none"
//   · "Typical pull" leads the EV block; the chase-inclusive mean is secondary

import { useEffect, useState } from "react"
import { getOwnerKeyForChain, ownerKeyMatchesChain } from "@/lib/owner-key"
import MomentMedia from "@/components/MomentMedia"

interface PackMarketResponse {
  product: { name: string; imageUrl: string | null; retailUsd: number | null; declaredSupply: number | null }
  supply: {
    indexed: number | null
    duplicateSerials: number | null
    treasuryHeld: number | null
    collectorHeld: number | null
    collectorWallets: number | null
    burnt: number | null
    refreshedAt: string | null
  }
  market: {
    confirmedFloorUsd: number | null
    confirmedFloorSol: number | null
    confirmedAsks: number | null
    unconfirmedAsks: number | null
    confirmedWithinHours: number
    salesAll: number | null
    sales7d: number | null
    median7dUsd: number | null
    lastSaleAt: string | null
    lastSaleUsd: number | null
  }
  ev: {
    iconSlots: number | null
    rainbowChance: number | null
    packCostUsd: number | null
    typicalPullUsd: number | null
    actualEvUsd: number | null
    rainbowPriced: number | null
    rainbowTotal: number | null
    commonPriced: number | null
    commonTotal: number | null
    note: string | null
  } | null
  ev_error: boolean
  asks: { priceUsd: number | null; priceSol: number | null; lastSeenAt: string | null; confirmed: boolean }[] | null
  asks_error: boolean
  sales: { serial: number | null; priceUsd: number | null; priceSol: number | null; marketplace: string | null; soldAt: string | null }[] | null
  sales_error: boolean
  owned: { wallet: string; count: number; serials: number[] } | null
  owned_error: string | null
}

const mono = "var(--font-mono)"
const display = "var(--font-display)"

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return "$" + n.toFixed(2)
}

function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}

/** Absolute PT date — the reader's clock never enters render. */
function ptDate(iso: string | null): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

function Tile({ label, value, sub, lead }: { label: string; value: string; sub?: string; lead?: boolean }) {
  return (
    <div
      style={{
        background: "var(--rpc-surface)",
        border: `1px solid ${lead ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
        borderRadius: 8,
        padding: "12px 14px",
        minWidth: 150,
        flex: "1 1 150px",
      }}
    >
      <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>{label}</div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 22, color: "var(--rpc-text-primary)", marginTop: 4 }}>{value}</div>
      {sub ? <div style={{ fontFamily: mono, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>{sub}</div> : null}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontFamily: display, fontWeight: 800, fontSize: 16, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 10px" }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>{children}</div>
}

const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)" }
const td: React.CSSProperties = { padding: "6px 8px", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle)" }

export default function CandyPackMarket() {
  const [data, setData] = useState<PackMarketResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Wallet: an explicit ?wallet= wins; else the Solana-scoped owner key, and only
  // if it really is a Solana key (a Flow key must never reach this read).
  // Resolved inside the fetch effect (no synchronous setState in an effect).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const fromUrl = (p.get("wallet") || p.get("address") || "").trim()
    const k = fromUrl ? "" : getOwnerKeyForChain("solana")
    const wallet = fromUrl || (k && ownerKeyMatchesChain(k, "solana") ? k : "")
    let cancelled = false
    const url = "/api/candy-pack-market" + (wallet ? "?wallet=" + encodeURIComponent(wallet) : "")
    fetch(url)
      .then(async (r) => {
        let body: unknown = undefined
        try {
          body = await r.json()
        } catch {
          body = undefined
        }
        if (cancelled) return
        // An unparseable body is a FAILED read — never an empty board.
        if (!r.ok || !body || typeof body !== "object") {
          const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined
          setError(typeof e === "string" ? e : "Pack market is unavailable right now.")
          return
        }
        setData(body as PackMarketResponse)
      })
      .catch(() => {
        if (!cancelled) setError("Pack market is unavailable right now.")
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <div role="alert" style={{ padding: "16px 20px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 8 }}>
        <div style={{ fontFamily: display, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>Couldn&apos;t load packs</div>
        <Note>{error}</Note>
      </div>
    )
  }
  if (!data) {
    return (
      <div aria-busy="true" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rpc-skeleton" style={{ width: 150, height: 72, borderRadius: 8 }} />
        ))}
      </div>
    )
  }

  const { product, supply, market, ev } = data
  const soldOut7d = market.sales7d === 0

  return (
    <div>
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        {product.imageUrl ? (
          <div style={{ width: 72, height: 72, borderRadius: 8, overflow: "hidden", flex: "0 0 auto" }}>
            <MomentMedia thumbnailUrl={product.imageUrl} alt={`${product.name} pack`} size={72} rounded={8} />
          </div>
        ) : null}
        <div>
          <h1 style={{ fontFamily: display, fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
            Candy MLB — Pack Market
          </h1>
          <Note>
            {product.name} · {usd(product.retailUsd)} retail · {count(product.declaredSupply)} packs · sealed packs trade on Magic Eden (Solana)
          </Note>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Tile
          lead
          label="Lowest confirmed ask"
          value={usd(market.confirmedFloorUsd)}
          sub={
            market.confirmedAsks === null
              ? "asks couldn't load"
              : market.confirmedAsks === 0
                ? `no ask seen in the last ${market.confirmedWithinHours}h`
                : `${count(market.confirmedAsks)} ask${market.confirmedAsks === 1 ? "" : "s"} seen in the last ${market.confirmedWithinHours}h`
          }
        />
        <Tile label="Last sale" value={usd(market.lastSaleUsd)} sub={ptDate(market.lastSaleAt)} />
        <Tile
          label="Median sale, 7 days"
          value={soldOut7d ? "—" : usd(market.median7dUsd)}
          sub={soldOut7d ? "no pack sales in 7 days" : `${count(market.sales7d)} sales`}
        />
        <Tile label="Sales recorded" value={count(market.salesAll)} sub="all time" />
      </div>

      <Section title="Pull value">
        {ev ? (
          <>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
              <Tile lead label="Typical pull" value={usd(ev.typicalPullUsd)} sub="what the median pack holds" />
              <Tile label="Actual EV (mean)" value={usd(ev.actualEvUsd)} sub="includes the Rainbow chase" />
              <Tile label="Pack cost" value={usd(ev.packCostUsd)} />
            </div>
            <Note>
              A pack is {count(ev.iconSlots)} ICONs with a{" "}
              {ev.rainbowChance === null ? "—" : `${Math.round(ev.rainbowChance * 100)}%`} chance at a /15 Rainbow parallel. The median
              pack pulls no Rainbow, so read the typical pull first — the mean is dragged up by a card most packs never hold. Priced from
              RPC FMV (Rainbow {count(ev.rainbowPriced)}/{count(ev.rainbowTotal)}, commons {count(ev.commonPriced)}/{count(ev.commonTotal)});
              on a thin market that is indicative pull value, not what ten cards would sell for.
            </Note>
          </>
        ) : (
          <Note>{data.ev_error ? "The pull-value model couldn't load right now." : "No pull-value model is available."}</Note>
        )}
      </Section>

      <Section title="Supply">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
          <Tile label="Held by collectors" value={count(supply.collectorHeld)} sub={`${count(supply.collectorWallets)} wallets`} />
          <Tile label="In Candy's treasury wallet" value={count(supply.treasuryHeld)} />
          <Tile label="Pack assets indexed" value={count(supply.indexed)} sub={`${count(product.declaredSupply)} declared`} />
        </div>
        <Note>
          Counted from the chain, refreshed {ptDate(supply.refreshedAt)}.
          {supply.duplicateSerials ? ` ${count(supply.duplicateSerials)} pack serial number${supply.duplicateSerials === 1 ? " is" : "s are"} carried by more than one asset, which is why indexed can exceed declared.` : ""}
        </Note>
      </Section>

      <Section title="Asks">
        {data.asks === null ? (
          <Note>Asks couldn&apos;t load right now.</Note>
        ) : data.asks.length === 0 ? (
          <Note>No active pack asks are indexed.</Note>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 360 }}>
                <thead>
                  <tr>
                    <th style={th}>Ask</th>
                    <th style={th}>SOL</th>
                    <th style={th}>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.asks.map((a, i) => (
                    <tr key={i} style={{ opacity: a.confirmed ? 1 : 0.55 }}>
                      <td style={td}>{usd(a.priceUsd)}</td>
                      <td style={td}>{a.priceSol === null ? "—" : a.priceSol.toFixed(3)}</td>
                      <td style={td}>
                        {ptDate(a.lastSeenAt)}
                        {a.confirmed ? "" : " · unconfirmed"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.market.unconfirmedAsks ? (
              <div style={{ marginTop: 8 }}>
                <Note>
                  {count(data.market.unconfirmedAsks)} ask{data.market.unconfirmedAsks === 1 ? "" : "s"} have not been seen in the last{" "}
                  {market.confirmedWithinHours}h — they may already be gone, so they are listed last and never used as the lowest ask.
                </Note>
              </div>
            ) : null}
          </>
        )}
      </Section>

      <Section title="Recent pack sales">
        {data.sales === null ? (
          <Note>Sales couldn&apos;t load right now.</Note>
        ) : data.sales.length === 0 ? (
          <Note>No pack sales are recorded.</Note>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 360 }}>
              <thead>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>Pack #</th>
                  <th style={th}>Price</th>
                </tr>
              </thead>
              <tbody>
                {data.sales.map((s, i) => (
                  <tr key={i}>
                    <td style={td}>{ptDate(s.soldAt)}</td>
                    <td style={td}>{s.serial === null ? "—" : `#${s.serial}`}</td>
                    <td style={td}>{usd(s.priceUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="My sealed packs">
        {data.owned_error ? (
          <Note>{data.owned_error}</Note>
        ) : data.owned ? (
          <Note>
            {data.owned.count === 0
              ? "This wallet holds no sealed Candy packs."
              : `This wallet holds ${count(data.owned.count)} sealed pack${data.owned.count === 1 ? "" : "s"}${
                  data.owned.serials.length ? `: ${data.owned.serials.slice(0, 30).map((n) => `#${n}`).join(", ")}${data.owned.serials.length > 30 ? "…" : ""}` : ""
                }.`}
          </Note>
        ) : (
          <Note>Load a Solana wallet on the Collection tab to see your sealed packs here.</Note>
        )}
      </Section>
    </div>
  )
}
